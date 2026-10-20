using System.Text.RegularExpressions;
using Dapper;
using Npgsql;

namespace MedLink.Api.Hospitals;

/// <summary>
/// Approved slug policy: old slugs redirect (301) for 90 days, then show "link changed";
/// a slug is reserved forever; at most one change per 30 days. Bookings use the hospital ID, never the slug.
/// </summary>
public static partial class SlugPolicy
{
    public static readonly TimeSpan RedirectFor = TimeSpan.FromDays(90);
    public static readonly TimeSpan MinChangeInterval = TimeSpan.FromDays(30);

    [GeneratedRegex("^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$")]
    private static partial Regex Format();

    public static bool IsValidFormat(string? slug) => slug is not null && Format().IsMatch(slug);

    /// <returns>"ok", "current", "bad" or "taken".</returns>
    public static async Task<string> CheckAsync(NpgsqlConnection conn, NpgsqlTransaction tx, string? slug, string? selfHospitalId)
    {
        if (!IsValidFormat(slug)) return "bad";
        if (await conn.ExecuteScalarAsync<bool>("SELECT EXISTS (SELECT 1 FROM reserved_slugs WHERE slug = @slug)", new { slug }, tx))
            return "taken";
        var owner = await conn.QuerySingleOrDefaultAsync<(string HospitalId, bool IsPrimary)?>(
            "SELECT hospital_id, is_primary FROM hospital_slugs WHERE slug = @slug", new { slug }, tx);
        if (owner is null) return "ok";
        if (owner.Value.HospitalId != selfHospitalId) return "taken";
        return owner.Value.IsPrimary ? "current" : "ok";
    }

    public sealed record ChangeResult(string? Error, string? OldSlug = null, DateTimeOffset? NextChangeAt = null);

    public static async Task<ChangeResult> ChangeAsync(NpgsqlConnection conn, NpgsqlTransaction tx, string hospitalId, string newSlug, DateTimeOffset now)
    {
        var state = await CheckAsync(conn, tx, newSlug, hospitalId);
        if (state == "current") return new ChangeResult(null);
        if (state != "ok") return new ChangeResult(state == "bad" ? "SLUG_INVALID" : "SLUG_TAKEN");

        var lastChange = await conn.ExecuteScalarAsync<DateTime?>(
            "SELECT max(retired_at) FROM hospital_slugs WHERE hospital_id = @hospitalId", new { hospitalId }, tx);
        if (lastChange is { } lc)
        {
            var next = new DateTimeOffset(DateTime.SpecifyKind(lc, DateTimeKind.Utc)) + MinChangeInterval;
            if (next > now) return new ChangeResult("SLUG_CHANGE_TOO_SOON", NextChangeAt: next);
        }

        var old = await conn.ExecuteScalarAsync<string>("""
            UPDATE hospital_slugs SET is_primary = false, retired_at = @now, redirect_until = @until
            WHERE hospital_id = @hospitalId AND is_primary
            RETURNING slug
            """, new { hospitalId, now = now.UtcDateTime, until = (now + RedirectFor).UtcDateTime }, tx);

        // Reclaiming one of this hospital's own old slugs re-activates that row; otherwise insert a new one.
        var reclaimed = await conn.ExecuteAsync("""
            UPDATE hospital_slugs SET is_primary = true, retired_at = NULL, redirect_until = NULL
            WHERE slug = @newSlug AND hospital_id = @hospitalId
            """, new { newSlug, hospitalId }, tx);
        if (reclaimed == 0)
            await conn.ExecuteAsync("INSERT INTO hospital_slugs (slug, hospital_id, is_primary) VALUES (@newSlug, @hospitalId, true)",
                new { newSlug, hospitalId }, tx);
        return new ChangeResult(null, old);
    }
}
