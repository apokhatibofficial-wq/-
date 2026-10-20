using System.Net;
using Dapper;
using MedLink.Api.Auth;
using MedLink.Api.Tests.Infrastructure;
using Npgsql;

namespace MedLink.Api.Tests;

[Collection("medlink")]
public sealed class PlatformSettingsTests(MedLinkFixture fx) : IDisposable
{
    private readonly TestApi api = new(fx);
    public void Dispose() => api.Dispose();

    private static readonly object OwnerDefaults = new { defaultTimezone = "Asia/Damascus", bookingWindowDays = 14, minNoticeMin = 30, patientCanCancel = false, perPhoneDailyLimit = 0 };

    [Fact(DisplayName = "System settings start with the owner's values: Syria, 14 days, 30 minutes, no patient cancellation, no per-phone limit")]
    public async Task Defaults()
    {
        await using var db = await fx.OwnerAsync();
        var row = await db.QuerySingleAsync<(string Tz, int W, int N, bool Cancel, int Limit)>(
            "SELECT default_timezone, booking_window_days, min_notice_min, patient_can_cancel, per_phone_daily_limit FROM platform_settings");
        Assert.Equal(("Asia/Damascus", 14, 30, false, 0), row);
        Assert.Equal(1, await db.ExecuteScalarAsync<int>("SELECT count(*) FROM platform_settings"));
    }

    [Fact(DisplayName = "Only an Owner changes system settings; all company roles can read them; hospitals cannot reach them")]
    public async Task Permissions()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var (support, _) = await api.CompanyUserAsync(Roles.Support);
        var (viewer, _) = await api.CompanyUserAsync(Roles.Viewer);
        var (_, _, _, hadmin) = await api.HospitalAsync(owner);

        foreach (var c in new[] { owner, support, viewer })
            Assert.Equal(HttpStatusCode.OK, (await c.Get("/admin/settings")).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await hadmin.Get("/admin/settings")).Status);
        foreach (var c in new[] { support, viewer, hadmin })
            Assert.Equal(HttpStatusCode.Forbidden, (await c.Patch("/admin/settings", new { bookingWindowDays = 30 })).Status);
    }

    [Fact(DisplayName = "System settings are validated, audited, and a new default time zone applies to new hospitals")]
    public async Task EditAndApply()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        try
        {
            foreach (var bad in new object[] { new { defaultTimezone = "Nowhere/City" }, new { bookingWindowDays = 0 }, new { bookingWindowDays = 400 },
                         new { minNoticeMin = -1 }, new { minNoticeMin = 2000 }, new { perPhoneDailyLimit = 51 } })
                Assert.Equal((HttpStatusCode)422, (await owner.Patch("/admin/settings", bad)).Status);

            var r = await owner.Patch("/admin/settings", new { defaultTimezone = "Europe/Istanbul", bookingWindowDays = 21, minNoticeMin = 60 });
            Assert.Equal(HttpStatusCode.OK, r.Status);
            Assert.Equal(21, r.Body.GetProperty("bookingWindowDays").GetInt32());
            Assert.False(r.Body.GetProperty("patientCanCancel").GetBoolean()); // untouched fields keep their value

            var created = await owner.Post("/admin/hospitals", new { nameAr = "م", nameEn = "Default zone", adminEmail = TestApi.NewEmail("z"), slug = "dz-" + Guid.NewGuid().ToString("N")[..8] });
            var id = created.Body.GetProperty("id").GetString();
            Assert.Equal("Europe/Istanbul", (await owner.Get($"/admin/hospitals/{id}")).Body.GetProperty("hospital").GetProperty("timezone").GetString());

            await using var db = await fx.OwnerAsync();
            Assert.True(await db.ExecuteScalarAsync<int>("SELECT count(*) FROM audit_log WHERE action = 'platform_settings'") >= 1);
        }
        finally
        {
            Assert.Equal(HttpStatusCode.OK, (await owner.Patch("/admin/settings", OwnerDefaults)).Status);
        }
    }

    [Fact(DisplayName = "Per-hospital booking rules: set from the console, shown read-only to the hospital, reset to the company value with null")]
    public async Task HospitalOverride()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var (support, _) = await api.CompanyUserAsync(Roles.Support);
        var (hid, _, _, hadmin) = await api.HospitalAsync(owner);

        var me = await hadmin.Get("/hospital/me");
        Assert.Equal(14, me.Body.GetProperty("bookingRules").GetProperty("windowDays").GetInt32());
        Assert.Equal(30, me.Body.GetProperty("bookingRules").GetProperty("minNoticeMin").GetInt32());
        Assert.False(me.Body.GetProperty("bookingRules").GetProperty("overridden").GetBoolean());

        Assert.Equal(HttpStatusCode.Forbidden, (await support.Put($"/admin/hospitals/{hid}/booking-rules", new { bookingWindowDays = 7, minNoticeMin = 120 })).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await hadmin.Put($"/admin/hospitals/{hid}/booking-rules", new { bookingWindowDays = 7, minNoticeMin = 120 })).Status);
        Assert.Equal((HttpStatusCode)422, (await owner.Put($"/admin/hospitals/{hid}/booking-rules", new { bookingWindowDays = 0, minNoticeMin = (int?)null })).Status);

        var set = await owner.Put($"/admin/hospitals/{hid}/booking-rules", new { bookingWindowDays = 7, minNoticeMin = (int?)null });
        Assert.Equal(HttpStatusCode.OK, set.Status);
        me = await hadmin.Get("/hospital/me");
        Assert.Equal(7, me.Body.GetProperty("bookingRules").GetProperty("windowDays").GetInt32());
        Assert.Equal(30, me.Body.GetProperty("bookingRules").GetProperty("minNoticeMin").GetInt32()); // still the company value
        Assert.True(me.Body.GetProperty("bookingRules").GetProperty("overridden").GetBoolean());
        Assert.Equal(7, (await owner.Get($"/admin/hospitals/{hid}")).Body.GetProperty("hospital").GetProperty("bookingWindowDays").GetInt32());

        Assert.Equal(HttpStatusCode.OK, (await owner.Put($"/admin/hospitals/{hid}/booking-rules", new { bookingWindowDays = (int?)null, minNoticeMin = (int?)null })).Status);
        Assert.False((await hadmin.Get("/hospital/me")).Body.GetProperty("bookingRules").GetProperty("overridden").GetBoolean());
        Assert.Equal(HttpStatusCode.NotFound, (await owner.Put("/admin/hospitals/hsp_01ARZ3NDEKTSV4RRFFQ69G5FAV/booking-rules", new { bookingWindowDays = 7 })).Status);
    }

    [Fact(DisplayName = "The database stops a hospital session from changing company-controlled fields or the system settings")]
    public async Task DatabaseGuards()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var (hid, _, _, _) = await api.HospitalAsync(owner);
        await using var app = await fx.AppAsync();
        foreach (var sql in new[]
                 {
                     "UPDATE hospitals SET booking_window_days = 90 WHERE id = @hid",
                     "UPDATE hospitals SET status = 'suspended' WHERE id = @hid", // a real change: the hospital is active
                     "UPDATE hospitals SET name_en = 'renamed' WHERE id = @hid",
                 })
        {
            await using var tx = await app.BeginTransactionAsync();
            await app.ExecuteAsync("SELECT set_config('app.scope', 'hospital', true), set_config('app.hospital_id', @hid, true)", new { hid }, tx);
            var ex = await Assert.ThrowsAsync<PostgresException>(() => app.ExecuteAsync(sql, new { hid }, tx));
            Assert.Equal(PostgresErrorCodes.InsufficientPrivilege, ex.SqlState);
            await tx.RollbackAsync();
        }
        // Hospital-owned settings still work in that scope.
        await using (var tx = await app.BeginTransactionAsync())
        {
            await app.ExecuteAsync("SELECT set_config('app.scope', 'hospital', true), set_config('app.hospital_id', @hid, true)", new { hid }, tx);
            Assert.Equal(1, await app.ExecuteAsync("UPDATE hospitals SET no_show_grace_min = 20 WHERE id = @hid", new { hid }, tx));
            Assert.Equal(0, await app.ExecuteAsync("UPDATE platform_settings SET booking_window_days = 99", transaction: tx));
            await tx.RollbackAsync();
        }
    }
}
