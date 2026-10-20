using System.Text.Json;
using Dapper;
using Npgsql;

namespace MedLink.Api.Audit;

/// <summary>
/// Append-only audit trail. Never pass passwords, tokens, links, patient data or emails in <c>meta</c>.
/// </summary>
public static class AuditLog
{
    public static Task WriteAsync(NpgsqlConnection conn, NpgsqlTransaction tx, string? actorId, string? hospitalId,
        string action, string target, object? meta = null) =>
        conn.ExecuteAsync("""
            INSERT INTO audit_log (actor_id, hospital_id, action, target, meta_json)
            VALUES (@actorId, @hospitalId, @action, @target, @meta::jsonb)
            """,
            new { actorId, hospitalId, action, target, meta = JsonSerializer.Serialize(meta ?? new { }) }, tx);
}
