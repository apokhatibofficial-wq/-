using Dapper;
using Npgsql;

namespace MedLink.Api.Data;

/// <summary>
/// Database context for one unit of work. Every transaction sets the RLS context
/// (<c>app.scope</c>, <c>app.hospital_id</c>) from the server-side principal, never from the request.
/// </summary>
public readonly record struct DbScope(string Scope, string? HospitalId)
{
    /// <summary>Authentication pipeline only (login, session lookup, one-time links, CLI).</summary>
    public static DbScope System => new("system", null);
    public static DbScope Company => new("company", null);
    public static DbScope Hospital(string hospitalId) =>
        string.IsNullOrEmpty(hospitalId) ? throw new ArgumentException("hospital id required") : new("hospital", hospitalId);
}

public sealed class Db(NpgsqlDataSource dataSource)
{
    static Db()
    {
        DefaultTypeMap.MatchNamesWithUnderscores = true;
    }

    public async Task<T> RunAsync<T>(DbScope scope, Func<NpgsqlConnection, NpgsqlTransaction, Task<T>> work, CancellationToken ct = default)
    {
        await using var conn = await dataSource.OpenConnectionAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        await conn.ExecuteAsync(
            "SELECT set_config('app.scope', @s, true), set_config('app.hospital_id', @h, true)",
            new { s = scope.Scope, h = scope.HospitalId ?? "" }, tx);
        var result = await work(conn, tx);
        await tx.CommitAsync(ct);
        return result;
    }

    public Task RunAsync(DbScope scope, Func<NpgsqlConnection, NpgsqlTransaction, Task> work, CancellationToken ct = default) =>
        RunAsync<bool>(scope, async (c, t) => { await work(c, t); return true; }, ct);
}

public static class PgErrors
{
    public static bool IsUniqueViolation(this PostgresException e) => e.SqlState == PostgresErrorCodes.UniqueViolation;
}
