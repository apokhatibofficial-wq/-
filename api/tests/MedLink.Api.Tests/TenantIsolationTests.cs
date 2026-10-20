using System.Net;
using Dapper;
using MedLink.Api.Auth;
using MedLink.Api.Tests.Infrastructure;
using Npgsql;

namespace MedLink.Api.Tests;

[Collection("medlink")]
public sealed class TenantIsolationTests(MedLinkFixture fx) : IDisposable
{
    private readonly TestApi api = new(fx);
    public void Dispose() => api.Dispose();

    [Fact(DisplayName = "Acceptance 3: hospital A cannot read hospital B through the API, even with tampered IDs")]
    public async Task ApiIsolation()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var (aId, _, aAdmin, a) = await api.HospitalAsync(owner);
        var (bId, _, bAdmin, _) = await api.HospitalAsync(owner);

        var me = await a.Get($"/hospital/me?hospitalId={bId}");
        Assert.Equal(aId, me.Body.GetProperty("id").GetString());

        var users = await a.Get($"/hospital/users?hospitalId={bId}&hospital_id={bId}");
        Assert.Equal(HttpStatusCode.OK, users.Status);
        var emails = users.Body.GetProperty("users").EnumerateArray().Select(u => u.GetProperty("email").GetString()).ToList();
        Assert.Contains(aAdmin.Email, emails);
        Assert.DoesNotContain(bAdmin.Email, emails);

        // Asking for B's user by its real ID: not found, not forbidden (no existence leak).
        Assert.Equal(HttpStatusCode.NotFound, (await a.Get($"/hospital/users/{bAdmin.Id}")).Status);
        Assert.Equal(HttpStatusCode.OK, (await a.Get($"/hospital/users/{aAdmin.Id}")).Status);

        // A hospital session cannot use the company routes for B either.
        Assert.Equal(HttpStatusCode.Forbidden, (await a.Get($"/admin/hospitals/{bId}")).Status);
    }

    [Fact(DisplayName = "Acceptance 3: row-level security stops hospital A's context from seeing or changing B's rows")]
    public async Task RlsIsolation()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var (aId, _, _, _) = await api.HospitalAsync(owner);
        var (bId, bSlug, bAdmin, _) = await api.HospitalAsync(owner);

        await using var app = await fx.AppAsync();
        await using var tx = await app.BeginTransactionAsync();
        await app.ExecuteAsync("SELECT set_config('app.scope', 'hospital', true), set_config('app.hospital_id', @aId, true)", new { aId }, tx);

        Assert.Equal(0, await app.ExecuteScalarAsync<int>("SELECT count(*) FROM hospitals WHERE id = @bId", new { bId }, tx));
        Assert.Equal(0, await app.ExecuteScalarAsync<int>("SELECT count(*) FROM users WHERE hospital_id = @bId", new { bId }, tx));
        Assert.Equal(0, await app.ExecuteScalarAsync<int>("SELECT count(*) FROM users WHERE id = @id", new { id = bAdmin.Id }, tx));
        Assert.Equal(0, await app.ExecuteScalarAsync<int>("SELECT count(*) FROM hospital_slugs WHERE slug = @bSlug", new { bSlug }, tx));
        Assert.Equal(0, await app.ExecuteScalarAsync<int>("SELECT count(*) FROM sessions s WHERE s.user_id = @id", new { id = bAdmin.Id }, tx));
        Assert.Equal(0, await app.ExecuteScalarAsync<int>("SELECT count(*) FROM user_roles WHERE user_id = @id", new { id = bAdmin.Id }, tx));
        Assert.Equal(0, await app.ExecuteScalarAsync<int>("SELECT count(*) FROM audit_log WHERE hospital_id = @bId", new { bId }, tx));
        Assert.Equal(1, await app.ExecuteScalarAsync<int>("SELECT count(*) FROM hospitals", transaction: tx));

        // Writes into B silently match no rows; inserting a row for B is refused by the policy.
        Assert.Equal(0, await app.ExecuteAsync("UPDATE hospitals SET name_en = 'pwned' WHERE id = @bId", new { bId }, tx));
        Assert.Equal(0, await app.ExecuteAsync("UPDATE users SET status = 'disabled' WHERE id = @id", new { id = bAdmin.Id }, tx));
        await app.ExecuteAsync("SAVEPOINT s1", transaction: tx);
        var ex = await Assert.ThrowsAsync<PostgresException>(() => app.ExecuteAsync(
            "INSERT INTO audit_log (hospital_id, action, target) VALUES (@bId, 'x', 'x')", new { bId }, tx));
        Assert.Equal(PostgresErrorCodes.InsufficientPrivilege, ex.SqlState);
        await tx.RollbackAsync();
    }

    [Fact(DisplayName = "With no request context set, the application role sees nothing at all")]
    public async Task NoContextNoRows()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        await api.HospitalAsync(owner);
        await using var app = await fx.AppAsync();
        foreach (var table in new[] { "hospitals", "hospital_slugs", "users", "user_roles", "sessions", "one_time_links", "audit_log" })
            Assert.Equal(0, await app.ExecuteScalarAsync<int>($"SELECT count(*) FROM {table}"));
    }

    [Fact(DisplayName = "The application role cannot bypass RLS, edit or delete the audit log, or delete slugs")]
    public async Task AppRoleLimits()
    {
        await using var app = await fx.AppAsync();
        Assert.False(await app.ExecuteScalarAsync<bool>("SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user"));
        foreach (var sql in new[]
                 {
                     "UPDATE audit_log SET action = 'x'",
                     "DELETE FROM audit_log",
                     "DELETE FROM hospital_slugs",
                     "DELETE FROM users",
                     "ALTER TABLE users DISABLE ROW LEVEL SECURITY",
                     "SET row_security = off; SELECT count(*) FROM users",
                 })
        {
            await using var tx = await app.BeginTransactionAsync();
            await app.ExecuteAsync("SELECT set_config('app.scope', 'system', true)", transaction: tx);
            var ex = await Assert.ThrowsAsync<PostgresException>(() => app.ExecuteAsync(sql, transaction: tx));
            Assert.Contains(ex.SqlState, new[] { PostgresErrorCodes.InsufficientPrivilege, "42501" });
            await tx.RollbackAsync();
        }
    }
}
