using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using Dapper;
using Npgsql;

namespace MedLink.Api.Data;

/// <summary>
/// Applies the versioned SQL files in Data/Migrations in order, each in its own transaction.
/// Runs as the database owner; the API itself only ever connects as <c>medlink_app</c>.
/// </summary>
public static class Migrator
{
    public static async Task<IReadOnlyList<string>> MigrateAsync(string ownerConnectionString, string? appPassword, TextWriter? output = null)
    {
        var applied = new List<string>();
        await using var conn = new NpgsqlConnection(ownerConnectionString);
        await conn.OpenAsync();

        await conn.ExecuteAsync("""
            CREATE TABLE IF NOT EXISTS schema_migrations (
              version    text PRIMARY KEY,
              checksum   text NOT NULL,
              applied_at timestamptz NOT NULL DEFAULT now())
            """);
        // Serialise concurrent migrators.
        await conn.ExecuteAsync("SELECT pg_advisory_lock(7240001)");
        try
        {
            var done = (await conn.QueryAsync<(string Version, string Checksum)>(
                "SELECT version, checksum FROM schema_migrations")).ToDictionary(r => r.Version, r => r.Checksum);

            foreach (var (version, sql) in LoadScripts())
            {
                var checksum = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(sql)));
                if (done.TryGetValue(version, out var existing))
                {
                    if (existing != checksum)
                        throw new InvalidOperationException($"Migration {version} was changed after it was applied. Add a new migration instead.");
                    continue;
                }
                await using var tx = await conn.BeginTransactionAsync();
                await conn.ExecuteAsync(sql, transaction: tx);
                await conn.ExecuteAsync("INSERT INTO schema_migrations (version, checksum) VALUES (@version, @checksum)",
                    new { version, checksum }, tx);
                await tx.CommitAsync();
                applied.Add(version);
                output?.WriteLine($"applied {version}");
            }

            if (!string.IsNullOrEmpty(appPassword))
            {
                // ALTER ROLE cannot take a bind parameter; quote_literal-style escaping via format(%L).
                var stmt = await conn.ExecuteScalarAsync<string>(
                    "SELECT format('ALTER ROLE medlink_app LOGIN PASSWORD %L', @p::text)", new { p = appPassword });
                await conn.ExecuteAsync(stmt!);
                var dbName = new NpgsqlConnectionStringBuilder(ownerConnectionString).Database;
                await conn.ExecuteAsync($"GRANT CONNECT ON DATABASE \"{dbName!.Replace("\"", "\"\"")}\" TO medlink_app");
            }
        }
        finally
        {
            await conn.ExecuteAsync("SELECT pg_advisory_unlock(7240001)");
        }
        return applied;
    }

    private static IEnumerable<(string Version, string Sql)> LoadScripts()
    {
        var asm = Assembly.GetExecutingAssembly();
        foreach (var name in asm.GetManifestResourceNames().Where(n => n.EndsWith(".sql")).Order(StringComparer.Ordinal))
        {
            using var s = asm.GetManifestResourceStream(name)!;
            using var r = new StreamReader(s, Encoding.UTF8);
            var file = name[(name.IndexOf(".Migrations.", StringComparison.Ordinal) + ".Migrations.".Length)..];
            yield return (Path.GetFileNameWithoutExtension(file), r.ReadToEnd());
        }
    }
}
