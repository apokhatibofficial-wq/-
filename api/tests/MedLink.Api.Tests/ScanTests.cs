using System.Net;
using System.Text.Json;
using Dapper;
using MedLink.Api.Auth;
using MedLink.Api.Tests.Infrastructure;

namespace MedLink.Api.Tests;

[Collection("medlink")]
public sealed class ScanTests(MedLinkFixture fx) : IDisposable
{
    private readonly TestApi api = new(fx);
    public void Dispose() => api.Dispose();

    /// <summary>Books a slot and moves it to today (hospital time) at 00:00 + minutes. Returns id, ref and QR code.</summary>
    private async Task<(string Id, string Ref, string Qr)> BookAsync(BookingHospital h, int minutes, int dayShift = 0)
    {
        var slot = await BookingSetup.SlotAsync(api.Anonymous(), h);
        var r = await BookingSetup.BookAsync(api, h, slot, name: "مريض تجريبي للماسح");
        Assert.Equal(HttpStatusCode.Created, r.Status);
        var reference = r.Body.GetProperty("ref").GetString()!;
        var qr = r.Body.GetProperty("qr").GetString()!;
        fx.Secrets.Add(qr);
        await using var db = await fx.OwnerAsync();
        await db.ExecuteAsync("""
            UPDATE bookings b SET slot_start = (date_trunc('day', now() AT TIME ZONE h.timezone) + make_interval(days => @dayShift, mins => @minutes)) AT TIME ZONE h.timezone
            FROM hospitals h WHERE h.id = b.hospital_id AND b.ref = @reference
            """, new { reference, minutes, dayShift });
        return ((await db.ExecuteScalarAsync<string>("SELECT id FROM bookings WHERE ref = @reference", new { reference }))!, reference, qr);
    }

    private static string Kind(JsonElement b) => b.GetProperty("kind").GetString()!;

    [Fact(DisplayName = "Scan: a valid code checks in at once (source qr); scanning again says already, at the same time, and records nothing new")]
    public async Task ScanChecksIn()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var h = await BookingSetup.CreateAsync(api, owner);
        var (scanner, _) = await api.StaffAsync(h.Admin, Roles.Scanner);
        var (bid, reference, qr) = await BookAsync(h, 600);

        var r = await scanner.Post("/scan/qr", new { code = qr, clientEventId = Guid.NewGuid() });
        Assert.Equal(HttpStatusCode.OK, r.Status);
        Assert.Equal("ok", Kind(r.Body));
        var b = r.Body.GetProperty("booking");
        Assert.Equal((reference, "مريض تجريبي للماسح", "10:00"), (b.GetProperty("ref").GetString(), b.GetProperty("patientName").GetString(), b.GetProperty("time").GetString()));
        var at = b.GetProperty("arrivedAt").GetString();
        Assert.NotNull(at);
        Assert.False(r.Body.GetRawText().Contains("phone", StringComparison.OrdinalIgnoreCase));

        var again = await scanner.Post("/scan/qr", new { code = qr, clientEventId = Guid.NewGuid() });
        Assert.Equal("already", Kind(again.Body));
        Assert.Equal(at, again.Body.GetProperty("booking").GetProperty("arrivedAt").GetString());
        await using var db = await fx.OwnerAsync();
        var ev = await db.QuerySingleAsync<(string Source, int N)>("SELECT min(source) AS source, count(*)::int AS n FROM attendance_events WHERE booking_id = @bid", new { bid });
        Assert.Equal(("qr", 1), (ev.Source, ev.N));
        Assert.Equal("arrived", await db.ExecuteScalarAsync<string>("SELECT status FROM bookings WHERE id = @bid", new { bid }));
    }

    [Fact(DisplayName = "Scan: cancelled and other-day bookings show details but are not checked in; another hospital's code shows nothing; bad codes are unknown")]
    public async Task ScanResults()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var h = await BookingSetup.CreateAsync(api, owner);
        var other = await BookingSetup.CreateAsync(api, owner);
        var (reception, _) = await api.StaffAsync(h.Admin, Roles.Reception);
        var (cancelled, _, cancelledQr) = await BookAsync(h, 300);
        Assert.Equal(HttpStatusCode.OK, (await reception.Post($"/hospital/bookings/{cancelled}/cancel", new { reason = "طلب المريض" })).Status);
        var (_, _, tomorrowQr) = await BookAsync(h, 300, dayShift: 1);
        var (_, _, otherQr) = await BookAsync(other, 300);

        var c = await reception.Post("/scan/qr", new { code = cancelledQr });
        Assert.Equal("cancelled", Kind(c.Body));
        Assert.Equal("مريض تجريبي للماسح", c.Body.GetProperty("booking").GetProperty("patientName").GetString());
        var d = await reception.Post("/scan/qr", new { code = tomorrowQr });
        Assert.Equal("otherday", Kind(d.Body));
        Assert.NotNull(d.Body.GetProperty("booking").GetProperty("date").GetString());

        var o = await reception.Post("/scan/qr", new { code = otherQr });
        Assert.Equal("other", Kind(o.Body));
        Assert.False(o.Body.TryGetProperty("booking", out _));
        Assert.DoesNotContain("مريض", o.Body.GetRawText());

        foreach (var bad in new[] { "MLK1." + new string('A', 22), "hello", "", "https://example.com", otherQr + "x" })
        {
            var r = await reception.Post("/scan/qr", new { code = bad });
            Assert.Equal(HttpStatusCode.OK, r.Status);
            Assert.Equal("bad", Kind(r.Body));
            Assert.False(r.Body.TryGetProperty("booking", out _));
        }
        await using var db = await fx.OwnerAsync();
        Assert.Equal(0, await db.ExecuteScalarAsync<int>("SELECT count(*) FROM attendance_events WHERE hospital_id IN (@a, @b)", new { a = h.HospitalId, b = other.HospitalId }));
    }

    [Fact(DisplayName = "Scan: an arrival by QR overrides the automatic no-show; a manual correction is not overridden")]
    public async Task ScanAndPolicy()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var h = await BookingSetup.CreateAsync(api, owner);
        var (scanner, _) = await api.StaffAsync(h.Admin, Roles.Scanner);
        var (auto, _, autoQr) = await BookAsync(h, 1);
        var (corrected, _, correctedQr) = await BookAsync(h, 2);
        await using (var db = await fx.OwnerAsync())
            await db.ExecuteAsync("""
                INSERT INTO attendance_events (id, hospital_id, booking_id, type, source, at) VALUES (@id, @h, @b, 'no_show', 'auto', now());
                UPDATE bookings SET status = 'no_show' WHERE id = @b;
                """, new { id = "att_" + Ulid.NewUlid(), h = h.HospitalId, b = auto });
        Assert.Equal("ok", Kind((await scanner.Post("/scan/qr", new { code = autoQr })).Body));

        Assert.Equal(HttpStatusCode.OK, (await h.Admin.Post($"/hospital/bookings/{corrected}/attendance", new { type = "no_show", reason = "لم يحضر بعد التحقق" })).Status);
        var r = await scanner.Post("/scan/qr", new { code = correctedQr });
        Assert.Equal("corrected", Kind(r.Body));
        await using var db2 = await fx.OwnerAsync();
        Assert.Equal("no_show", await db2.ExecuteScalarAsync<string>("SELECT status FROM bookings WHERE id = @corrected", new { corrected }));
    }

    [Fact(DisplayName = "Scan by booking number: found → confirm → checked in; another hospital's number is not found; doctors and anonymous callers are refused")]
    public async Task ManualLookup()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var h = await BookingSetup.CreateAsync(api, owner);
        var other = await BookingSetup.CreateAsync(api, owner);
        var (scanner, _) = await api.StaffAsync(h.Admin, Roles.Scanner);
        var (bid, reference, _) = await BookAsync(h, 700);
        var (_, otherRef, _) = await BookAsync(other, 700);

        var found = await scanner.Get($"/scan/lookup?ref={reference.ToLowerInvariant()}");
        Assert.Equal("found", Kind(found.Body));
        Assert.Equal(bid, found.Body.GetProperty("bookingId").GetString());
        await using (var db = await fx.OwnerAsync())
            Assert.Equal(0, await db.ExecuteScalarAsync<int>("SELECT count(*) FROM attendance_events WHERE booking_id = @bid", new { bid }));

        var ok = await scanner.Post("/scan/checkin", new { bookingId = bid, clientEventId = Guid.NewGuid() });
        Assert.Equal("ok", Kind(ok.Body));
        Assert.Equal("already", Kind((await scanner.Get($"/scan/lookup?ref={reference}")).Body));
        await using (var db = await fx.OwnerAsync())
            Assert.Equal("reception", await db.ExecuteScalarAsync<string>("SELECT source FROM attendance_events WHERE booking_id = @bid", new { bid }));

        Assert.Equal("notfound", Kind((await scanner.Get($"/scan/lookup?ref={otherRef}")).Body));
        Assert.Equal("notfound", Kind((await scanner.Get("/scan/lookup?ref=ML-ZZZZZZ")).Body));
        Assert.Equal("notfound", Kind((await scanner.Get("/scan/lookup?ref=مريض")).Body));
        var (otherBid, _, _) = await BookAsync(other, 710);
        Assert.Equal("notfound", Kind((await scanner.Post("/scan/checkin", new { bookingId = otherBid })).Body));

        var docEmail = TestApi.NewEmail("doc");
        var inv = await h.Admin.Post("/hospital/users", new { email = docEmail, role = Roles.Doctor, departmentIds = new[] { h.DepartmentId } });
        var (pw, secret) = await api.CompleteLinkAsync(CapturingEmailSender.TokenFrom(fx.Email.LastTo(docEmail)));
        var doctor = await api.SignInAsync(new TestUser(inv.Body.GetProperty("id").GetString()!, docEmail, pw, secret));
        Assert.Equal(HttpStatusCode.Forbidden, (await doctor.Get($"/scan/lookup?ref={reference}")).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await doctor.Post("/scan/qr", new { code = "MLK1." + new string('A', 22) })).Status);
        Assert.Equal(HttpStatusCode.Unauthorized, (await api.Anonymous().Get($"/scan/lookup?ref={reference}")).Status);
    }

    [Fact(DisplayName = "Scan: QR-scanner sessions end 12 hours after sign-in; reception keeps the 7-day limit")]
    public async Task ScannerSessionLimit()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var h = await BookingSetup.CreateAsync(api, owner);
        var (_, scanner) = await api.StaffAsync(h.Admin, Roles.Scanner);
        var (_, rec) = await api.StaffAsync(h.Admin, Roles.Reception);
        await using var db = await fx.OwnerAsync();
        double Hours(string userId) => db.ExecuteScalar<double>(
            "SELECT extract(epoch FROM max(absolute_expires_at - created_at)) / 3600 FROM sessions WHERE user_id = @userId", new { userId });
        Assert.InRange(Hours(scanner.Id), 11.99, 12.01);
        Assert.InRange(Hours(rec.Id), 7 * 24 - 0.01, 7 * 24 + 0.01);
    }

    [Fact(DisplayName = "Scan: lookups are rate limited per IP (429)")]
    public async Task RateLimit()
    {
        using var limited = new TestApi(fx, scanRate: 5);
        var (owner, _) = await limited.CompanyUserAsync(Roles.Owner);
        var h = await BookingSetup.CreateAsync(limited, owner);
        var (scanner, _) = await limited.StaffAsync(h.Admin, Roles.Scanner);
        var codes = new List<HttpStatusCode>();
        for (var i = 0; i < 8; i++) codes.Add((await scanner.Get("/scan/lookup?ref=ML-ZZZZZZ")).Status);
        Assert.Equal(5, codes.Count(c => c == HttpStatusCode.OK));
        Assert.Equal(3, codes.Count(c => c == HttpStatusCode.TooManyRequests));
    }
}
