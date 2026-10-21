using System.Net;
using Dapper;
using MedLink.Api.Auth;
using MedLink.Api.Data;
using MedLink.Api.Jobs;
using MedLink.Api.Tests.Infrastructure;
using Microsoft.Extensions.DependencyInjection;

namespace MedLink.Api.Tests;

[Collection("medlink")]
public sealed class JobsTests(MedLinkFixture fx) : IDisposable
{
    private readonly TestApi api = new(fx);
    public void Dispose() => api.Dispose();
    private Db Db => api.Factory.Services.GetRequiredService<Db>();

    /// <summary>A booking whose slot started `minutesAgo` minutes ago (negative = in the future). Returns id and ref.</summary>
    private async Task<(string Id, string Ref, string Qr)> BookingAtAsync(BookingHospital h, double minutesAgo, string name = "مريض تجريبي للمهام")
    {
        var slot = await BookingSetup.SlotAsync(api.Anonymous(), h);
        var r = await BookingSetup.BookAsync(api, h, slot, name: name, phone: "+963944000555");
        Assert.Equal(HttpStatusCode.Created, r.Status);
        var reference = r.Body.GetProperty("ref").GetString()!;
        var qr = r.Body.GetProperty("qr").GetString()!;
        fx.Secrets.Add(qr);
        await using var db = await fx.OwnerAsync();
        await db.ExecuteAsync("UPDATE bookings SET slot_start = date_trunc('minute', now()) - make_interval(secs => @s) WHERE ref = @reference",
            new { s = minutesAgo * 60, reference });
        return ((await db.ExecuteScalarAsync<string>("SELECT id FROM bookings WHERE ref = @reference", new { reference }))!, reference, qr);
    }

    private async Task<string> StatusAsync(string id)
    {
        await using var db = await fx.OwnerAsync();
        return (await db.ExecuteScalarAsync<string>("SELECT status FROM bookings WHERE id = @id", new { id }))!;
    }

    [Fact(DisplayName = "Acceptance 10: no-show is recorded after the grace period (per hospital), once, by the server")]
    public async Task NoShow()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var h = await BookingSetup.CreateAsync(api, owner);
        var (reception, _) = await api.StaffAsync(h.Admin, Roles.Reception);
        var late = await BookingAtAsync(h, 45);          // 45 min ago, grace 30 → no-show
        var inGrace = await BookingAtAsync(h, 20);       // still within the grace period
        var arrived = await BookingAtAsync(h, 50);
        var corrected = await BookingAtAsync(h, 55);
        var cancelled = await BookingAtAsync(h, 60);
        var old = await BookingAtAsync(h, 60 * 24 * 8);  // 8 days ago: not touched any more
        await using (var db = await fx.OwnerAsync())
            await db.ExecuteAsync("UPDATE bookings SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'اختبار' WHERE id = @id", new { id = cancelled.Id });
        Assert.Equal(HttpStatusCode.OK, (await reception.Post($"/hospital/bookings/{arrived.Id}/attendance", new { type = "arrived" })).Status);
        Assert.Equal(HttpStatusCode.OK, (await reception.Post($"/hospital/bookings/{corrected.Id}/attendance", new { type = "waiting", reason = "ينتظر في الصالة" })).Status);

        var now = DateTimeOffset.UtcNow;
        // Two instances at the same moment: the advisory lock and the unique index allow one mark.
        var counts = await Task.WhenAll(MaintenanceJobs.NoShowAsync(Db, now), MaintenanceJobs.NoShowAsync(Db, now));
        Assert.Equal(1, counts.Sum());
        Assert.Equal("no_show", await StatusAsync(late.Id));
        foreach (var (id, expected) in new[] { (inGrace.Id, "waiting"), (arrived.Id, "arrived"), (corrected.Id, "waiting"), (cancelled.Id, "cancelled"), (old.Id, "waiting") })
            Assert.Equal(expected, await StatusAsync(id));
        await using (var db = await fx.OwnerAsync())
        {
            var ev = await db.QuerySingleAsync<(string Source, string? Actor, DateTime At, DateTime Slot)>("""
                SELECT e.source, e.actor_id AS actor, e.at, b.slot_start AS slot FROM attendance_events e JOIN bookings b ON b.id = e.booking_id WHERE b.id = @id
                """, new { id = late.Id });
            Assert.Equal(("auto", (string?)null), (ev.Source, ev.Actor));
            Assert.Equal(ev.Slot.AddMinutes(30), ev.At, TimeSpan.FromSeconds(1));
            Assert.Equal(1, await db.ExecuteScalarAsync<int>("SELECT last_count FROM job_runs WHERE job = 'no_show'"));
        }
        Assert.Equal(0, await MaintenanceJobs.NoShowAsync(Db, now.AddMinutes(1)));

        // The hospital's own grace period: 60 minutes leaves a 45-minute-old booking waiting.
        Assert.Equal(HttpStatusCode.OK, (await h.Admin.Patch("/hospital/settings", new { noShowGraceMin = 60 })).Status);
        var other = await BookingAtAsync(h, 46);
        Assert.Equal(0, await MaintenanceJobs.NoShowAsync(Db, DateTimeOffset.UtcNow));
        Assert.Equal("waiting", await StatusAsync(other.Id));

        // The patient arrives late anyway: arrival beats the automatic no-show (scanner).
        var (scanner, _) = await api.StaffAsync(h.Admin, Roles.Scanner);
        Assert.Equal("ok", (await scanner.Post("/scan/qr", new { code = late.Qr })).Body.GetProperty("kind").GetString());
    }

    [Fact(DisplayName = "Retention: after the hospital's period, names, phones, answers and reasons are removed; status and times stay")]
    public async Task Retention()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var h = await BookingSetup.CreateAsync(api, owner);
        Assert.Equal(HttpStatusCode.OK, (await h.Admin.Patch("/hospital/settings", new { retentionMonths = 1 })).Status);
        var (reception, _) = await api.StaffAsync(h.Admin, Roles.Reception);
        var oldOne = await BookingAtAsync(h, 0, "مريض قديم");
        var recent = await BookingAtAsync(h, 60 * 24 * 10, "مريض حديث");
        Assert.Equal(HttpStatusCode.OK, (await reception.Post($"/hospital/bookings/{oldOne.Id}/attendance", new { type = "no_show", reason = "قال مريض قديم إنه لن يأتي" })).Status);
        await using (var db = await fx.OwnerAsync())
        {
            await db.ExecuteAsync("""
                UPDATE bookings SET slot_start = now() - interval '45 days' WHERE id = @id;
                INSERT INTO booking_answers (booking_id, hospital_id, question_id, value_json) VALUES (@id, @h, 'q1', '"جواب"');
                """, new { id = oldOne.Id, h = h.HospitalId });
        }

        Assert.Equal(1, await MaintenanceJobs.RetentionAsync(Db, DateTimeOffset.UtcNow));
        await using (var db = await fx.OwnerAsync())
        {
            var b = await db.QuerySingleAsync<(string? Name, string? Phone, string Status, DateTime? Anon)>(
                "SELECT patient_name AS name, phone, status, anonymized_at AS anon FROM bookings WHERE id = @id", new { id = oldOne.Id });
            Assert.Equal(((string?)null, (string?)null, "no_show"), (b.Name, b.Phone, b.Status));
            Assert.NotNull(b.Anon);
            Assert.Equal(0, await db.ExecuteScalarAsync<int>("SELECT count(*) FROM booking_answers WHERE booking_id = @id", new { id = oldOne.Id }));
            var ev = await db.QuerySingleAsync<(string Type, string? Reason, DateTime? Redacted)>(
                "SELECT type, reason, redacted_at AS redacted FROM attendance_events WHERE booking_id = @id", new { id = oldOne.Id });
            Assert.Equal(("no_show", (string?)null), (ev.Type, ev.Reason));
            Assert.NotNull(ev.Redacted);
            Assert.Equal("مريض حديث", await db.ExecuteScalarAsync<string>("SELECT patient_name FROM bookings WHERE id = @id", new { id = recent.Id }));
            Assert.Equal(1, await db.ExecuteScalarAsync<int>("SELECT count(*) FROM audit_log WHERE action = 'retention_purge'"));
            // Nothing personal is left anywhere for that booking (including the audit log).
            var dump = string.Join("\n", await db.QueryAsync<string>("SELECT row_to_json(a)::text FROM audit_log a"))
                + await db.ExecuteScalarAsync<string>("SELECT row_to_json(b)::text FROM bookings b WHERE id = @id", new { id = oldOne.Id });
            Assert.DoesNotContain("مريض قديم", dump);
        }
        Assert.Equal(0, await MaintenanceJobs.RetentionAsync(Db, DateTimeOffset.UtcNow));

        // The ticket of an anonymised booking is no longer valid at the scanner.
        var (scanner, _) = await api.StaffAsync(h.Admin, Roles.Scanner);
        Assert.Equal("bad", (await scanner.Post("/scan/qr", new { code = oldOne.Qr })).Body.GetProperty("kind").GetString());

        // Events stay append-only for the app: no other change than clearing a reason, once.
        await using var app = await fx.AppAsync();
        await using var t = await app.BeginTransactionAsync();
        await app.ExecuteAsync("SELECT set_config('app.scope', 'system', true)", transaction: t);
        var e1 = await Assert.ThrowsAsync<Npgsql.PostgresException>(() => app.ExecuteAsync("UPDATE attendance_events SET type = 'arrived' WHERE booking_id = @id", new { id = oldOne.Id }, t));
        Assert.Equal("42501", e1.SqlState);
    }

    [Fact(DisplayName = "Retention: a redacted reason cannot be rewritten, and reasons cannot be edited outside redaction")]
    public async Task EventsStayAppendOnly()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var h = await BookingSetup.CreateAsync(api, owner);
        var b = await BookingAtAsync(h, 10);
        Assert.Equal(HttpStatusCode.OK, (await h.Admin.Post($"/hospital/bookings/{b.Id}/attendance", new { type = "arrived", reason = "تصحيح للاختبار" })).Status);
        await using var app = await fx.AppAsync();
        async Task<string> Try(string sql)
        {
            await using var t = await app.BeginTransactionAsync();
            await app.ExecuteAsync("SELECT set_config('app.scope', 'system', true)", transaction: t);
            try { await app.ExecuteAsync(sql, new { id = b.Id }, t); await t.CommitAsync(); return "ok"; }
            catch (Npgsql.PostgresException e) { return e.SqlState; }
        }
        Assert.Equal("42501", await Try("UPDATE attendance_events SET reason = 'نص آخر' WHERE booking_id = @id"));
        Assert.Equal("ok", await Try("UPDATE attendance_events SET reason = NULL, redacted_at = now() WHERE booking_id = @id"));
        Assert.Equal("42501", await Try("UPDATE attendance_events SET redacted_at = now() WHERE booking_id = @id"));
    }

    [Fact(DisplayName = "Cleanup: old used or expired links and ended sessions are deleted; current ones stay")]
    public async Task Cleanup()
    {
        var (owner, ownerUser) = await api.CompanyUserAsync(Roles.Owner);
        await using (var db = await fx.OwnerAsync())
        {
            await db.ExecuteAsync("""
                INSERT INTO one_time_links (id, user_id, purpose, token_hash, expires_at, used_at)
                VALUES ('lnk_' || substr(md5(random()::text), 1, 20), @u, 'reset', sha256(random()::text::bytea), now() - interval '10 days', NULL),
                       ('lnk_' || substr(md5(random()::text), 1, 20), @u, 'reset', sha256(random()::text::bytea), now() + interval '1 hour', NULL);
                INSERT INTO sessions (id, user_id, token_hash, client, created_at, last_seen_at, expires_at, absolute_expires_at, revoked_at, revoke_reason)
                VALUES ('ses_' || substr(md5(random()::text), 1, 20), @u, sha256(random()::text::bytea), 'web',
                        now() - interval '50 days', now() - interval '41 days', now() - interval '43 days', now() - interval '43 days', now() - interval '40 days', 'test');
                """, new { u = ownerUser.Id });
        }
        var before = await Counts();
        var n = await MaintenanceJobs.CleanupAsync(Db, DateTimeOffset.UtcNow);
        var after = await Counts();
        Assert.True(n >= 2);
        Assert.Equal(before.Links - 1 - (before.OldLinks - 1), after.Links);
        Assert.Equal(0, after.OldLinks);
        Assert.Equal(0, after.OldSessions);
        Assert.Equal(HttpStatusCode.OK, (await owner.Get("/auth/me")).Status);

        async Task<(int Links, int OldLinks, int OldSessions)> Counts()
        {
            await using var db = await fx.OwnerAsync();
            return (await db.ExecuteScalarAsync<int>("SELECT count(*) FROM one_time_links"),
                await db.ExecuteScalarAsync<int>("SELECT count(*) FROM one_time_links WHERE greatest(coalesce(used_at, expires_at), expires_at) < now() - interval '7 days'"),
                await db.ExecuteScalarAsync<int>("SELECT count(*) FROM sessions WHERE revoked_at < now() - interval '30 days'"));
        }
    }

    [Fact(DisplayName = "Retention runs nightly after 03:00 Syria time, once per day")]
    public async Task RetentionSchedule()
    {
        await using (var db = await fx.OwnerAsync()) await db.ExecuteAsync("DELETE FROM job_runs WHERE job = 'retention'");
        // 2026-10-21 02:30 / 03:30 in Damascus (UTC+3).
        var before3 = new DateTimeOffset(2026, 10, 20, 23, 30, 0, TimeSpan.Zero);
        var after3 = new DateTimeOffset(2026, 10, 21, 0, 30, 0, TimeSpan.Zero);
        Assert.False(await MaintenanceJobs.RetentionDueAsync(Db, before3));
        Assert.True(await MaintenanceJobs.RetentionDueAsync(Db, after3));
        await MaintenanceJobs.RetentionAsync(Db, after3);
        Assert.False(await MaintenanceJobs.RetentionDueAsync(Db, after3.AddHours(5)));
        Assert.True(await MaintenanceJobs.RetentionDueAsync(Db, after3.AddDays(1)));
    }

    [Fact(DisplayName = "The background service runs the no-show job by itself when enabled")]
    public async Task ServiceRuns()
    {
        using var withJobs = new TestApi(fx, jobs: true);
        var (owner, _) = await withJobs.CompanyUserAsync(Roles.Owner);
        var h = await BookingSetup.CreateAsync(withJobs, owner);
        var slot = await BookingSetup.SlotAsync(withJobs.Anonymous(), h);
        var reference = (await BookingSetup.BookAsync(withJobs, h, slot)).Body.GetProperty("ref").GetString()!;
        await using var db = await fx.OwnerAsync();
        await db.ExecuteAsync("UPDATE bookings SET slot_start = now() - interval '2 hours' WHERE ref = @reference", new { reference });
        // A fresh factory starts the service: its first run is immediate.
        using var fresh = new TestApi(fx, jobs: true);
        _ = fresh.Factory.Services;
        for (var i = 0; i < 100 && await db.ExecuteScalarAsync<string>("SELECT status FROM bookings WHERE ref = @reference", new { reference }) != "no_show"; i++)
            await Task.Delay(100);
        Assert.Equal("no_show", await db.ExecuteScalarAsync<string>("SELECT status FROM bookings WHERE ref = @reference", new { reference }));
    }
}
