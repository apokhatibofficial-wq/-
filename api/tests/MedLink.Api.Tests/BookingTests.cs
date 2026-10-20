using System.Net;
using System.Text.Json;
using Dapper;
using MedLink.Api.Auth;
using MedLink.Api.Security;
using MedLink.Api.Tests.Infrastructure;

namespace MedLink.Api.Tests;

[Collection("medlink")]
public sealed class BookingTests(MedLinkFixture fx) : IDisposable
{
    private readonly TestApi api = new(fx);
    public void Dispose() => api.Dispose();

    [Fact(DisplayName = "Acceptance 5/8: book an available slot; the QR is an opaque 128-bit token, stored only as a hash")]
    public async Task BookSlot()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var h = await BookingSetup.CreateAsync(api, owner);
        var slot = await BookingSetup.SlotAsync(api.Anonymous(), h);
        var r = await BookingSetup.BookAsync(api, h, slot, phone: "+963 944 123-456");
        Assert.Equal(HttpStatusCode.Created, r.Status);
        var reference = r.Body.GetProperty("ref").GetString()!;
        var qr = r.Body.GetProperty("qr").GetString()!;
        Assert.Matches("^ML-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$", reference);
        Assert.Matches("^MLK1\\.[A-Za-z0-9_-]{22}$", qr);
        Assert.Equal("الباطنية", r.Body.GetProperty("department").GetProperty("ar").GetString());
        fx.Secrets.Add(qr);

        await using var db = await fx.OwnerAsync();
        var row = await db.QuerySingleAsync<(byte[] Hash, string Phone, string Status, int Seat)>(
            "SELECT qr_token_hash, phone, status, seat_no FROM bookings WHERE ref = @reference", new { reference });
        Assert.Equal(Tokens.Hash(qr), row.Hash);
        Assert.Equal("+963944123456", row.Phone);
        Assert.Equal(("waiting", 1), (row.Status, row.Seat));
        var dump = string.Join("\n", await db.QueryAsync<string>("SELECT row_to_json(b)::text FROM bookings b"));
        Assert.DoesNotContain(qr, dump);
        Assert.DoesNotContain(qr[5..], dump);

        // The staff list shows it (by full booking number), and the slot is no longer offered.
        var found = await h.Admin.Get($"/hospital/bookings?ref={reference}");
        Assert.Equal("مريض اختبار", found.Body.GetProperty("bookings")[0].GetProperty("patientName").GetString());
        var av = await BookingSetup.AvailabilityAsync(api.Anonymous(), h);
        Assert.DoesNotContain(av.GetProperty("days")[1].GetProperty("slots").EnumerateArray(), s => s.GetProperty("start").GetString() == slot);
    }

    [Fact(DisplayName = "Acceptance 6: the same seat cannot be booked twice at the same time (10 parallel requests, capacity 1 and 2)")]
    public async Task NoDoubleBooking()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        foreach (var capacity in new[] { 1, 2 })
        {
            var h = await BookingSetup.CreateAsync(api, owner, capacity);
            var slot = await BookingSetup.SlotAsync(api.Anonymous(), h);
            var results = await Task.WhenAll(Enumerable.Range(0, 10).Select(i => BookingSetup.BookAsync(api, h, slot, name: "مريض " + i)));
            Assert.Equal(capacity, results.Count(r => r.Status == HttpStatusCode.Created));
            Assert.All(results.Where(r => r.Status != HttpStatusCode.Created), r =>
            {
                Assert.Equal(HttpStatusCode.Conflict, r.Status);
                Assert.Equal("SLOT_FULL", r.Body.GetProperty("error").GetString());
            });
            await using var db = await fx.OwnerAsync();
            var seats = (await db.QueryAsync<int>("SELECT seat_no FROM bookings WHERE hospital_id = @h ORDER BY seat_no", new { h = h.HospitalId })).ToList();
            Assert.Equal(Enumerable.Range(1, capacity), seats);
        }
    }

    [Fact(DisplayName = "Acceptance 7: re-sending the same request returns the original booking, never a duplicate")]
    public async Task Idempotency()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var h = await BookingSetup.CreateAsync(api, owner, capacity: 5);
        var slot = await BookingSetup.SlotAsync(api.Anonymous(), h);
        var key = Guid.NewGuid().ToString("N");
        var first = await BookingSetup.BookAsync(api, h, slot, key);
        var again = await Task.WhenAll(Enumerable.Range(0, 5).Select(_ => BookingSetup.BookAsync(api, h, slot, key)));
        Assert.Equal(HttpStatusCode.Created, first.Status);
        Assert.All(again, r =>
        {
            Assert.Equal(HttpStatusCode.OK, r.Status);
            Assert.Equal(first.Body.GetProperty("ref").GetString(), r.Body.GetProperty("ref").GetString());
            Assert.Equal(first.Body.GetProperty("qr").GetString(), r.Body.GetProperty("qr").GetString());
        });
        fx.Secrets.Add(first.Body.GetProperty("qr").GetString()!);
        await using var db = await fx.OwnerAsync();
        Assert.Equal(1, await db.ExecuteScalarAsync<int>("SELECT count(*) FROM bookings WHERE hospital_id = @h", new { h = h.HospitalId }));

        // Same key with a different request is refused; a missing key is refused.
        var other = await BookingSetup.BookAsync(api, h, slot, key, name: "شخص آخر");
        Assert.Equal("IDEMPOTENCY_MISMATCH", other.Body.GetProperty("error").GetString());
        var noKey = await api.Anonymous().Post($"/public/hospitals/{h.Slug}/bookings", new { departmentId = h.DepartmentId, slotStart = slot, patientName = "x y" }, csrf: false);
        Assert.Equal(HttpStatusCode.BadRequest, noKey.Status);
    }

    [Fact(DisplayName = "Acceptance 13: required and optional answers are checked on the server against the published version")]
    public async Task AnswersValidated()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var h = await BookingSetup.CreateAsync(api, owner, capacity: 20);
        await h.Admin.Put("/hospital/form/draft", new { questions = new[] { FormBuilderTests.Visit(), FormBuilderTests.Note(), FormBuilderTests.First() } });
        await h.Admin.Post("/hospital/form/publish", new { });
        var form = (await api.Anonymous().Get($"/public/hospitals/{h.Slug}/form")).Body.GetProperty("form");
        var fv = form.GetProperty("versionId").GetString()!;
        var slot = await BookingSetup.SlotAsync(api.Anonymous(), h);

        async Task<(HttpStatusCode, string?)> Try(object answers)
        {
            var r = await BookingSetup.BookAsync(api, h, slot, answers: answers, formVersionId: fv);
            return (r.Status, r.Status == HttpStatusCode.Created ? null : r.Body.GetProperty("error").GetString());
        }

        Assert.Equal(((HttpStatusCode)422, "ANSWER_REQUIRED"), await Try(new { visit = "new" }));              // "first" missing
        Assert.Equal(((HttpStatusCode)422, "ANSWER_INVALID"), await Try(new { visit = "other", first = "yes" })); // not an option
        Assert.Equal(((HttpStatusCode)422, "ANSWER_INVALID"), await Try(new { visit = "new", first = "maybe" }));
        Assert.Equal(((HttpStatusCode)422, "ANSWER_UNKNOWN_QUESTION"), await Try(new { visit = "new", first = "no", diagnosis = "x" }));
        Assert.Equal(((HttpStatusCode)422, "ANSWER_INVALID"), await Try(new { visit = "new", first = "no", note = new string('a', 121) }));
        Assert.Equal((HttpStatusCode.Created, (string?)null), await Try(new { visit = "fu", first = "no" }));            // optional omitted
        Assert.Equal((HttpStatusCode.Created, (string?)null), await Try(new { visit = "new", first = "yes", note = "  كرسي متحرك  " }));

        await using var db = await fx.OwnerAsync();
        var stored = await db.QueryAsync<string>("SELECT value_json::text FROM booking_answers WHERE hospital_id = @h AND question_id = 'note'", new { h = h.HospitalId });
        Assert.Equal("\"كرسي متحرك\"", Assert.Single(stored));
        // Without the form version, a hospital that has a form refuses the booking (the client must reload the form).
        var noForm = await BookingSetup.BookAsync(api, h, slot, answers: new { visit = "new", first = "yes" });
        Assert.Equal("FORM_UPDATED", noForm.Body.GetProperty("error").GetString());
    }

    [Fact(DisplayName = "Acceptance 18: a form opened before a publish is accepted for 2 hours, then the patient must reload")]
    public async Task OpenFormsDuringPublish()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var h = await BookingSetup.CreateAsync(api, owner, capacity: 20);
        await h.Admin.Put("/hospital/form/draft", new { questions = new[] { FormBuilderTests.Visit() } });
        await h.Admin.Post("/hospital/form/publish", new { });
        var v1 = (await api.Anonymous().Get($"/public/hospitals/{h.Slug}/form")).Body.GetProperty("form").GetProperty("versionId").GetString()!;

        // The admin publishes v2 (adds a required question) while the patient still has v1 open.
        await h.Admin.Put("/hospital/form/draft", new { questions = new[] { FormBuilderTests.Visit(), FormBuilderTests.First() } });
        await h.Admin.Post("/hospital/form/publish", new { });
        var slot = await BookingSetup.SlotAsync(api.Anonymous(), h);
        var ok = await BookingSetup.BookAsync(api, h, slot, answers: new { visit = "new" }, formVersionId: v1);
        Assert.Equal(HttpStatusCode.Created, ok.Status);

        // More than 2 hours after v2 was published, v1 is refused with the current version to reload.
        await using (var db = await fx.OwnerAsync())
            await db.ExecuteAsync("UPDATE form_versions SET published_at = now() - interval '121 minutes' WHERE hospital_id = @h AND version = 2", new { h = h.HospitalId });
        var late = await BookingSetup.BookAsync(api, h, slot, answers: new { visit = "new" }, formVersionId: v1);
        Assert.Equal(HttpStatusCode.Conflict, late.Status);
        Assert.Equal("FORM_UPDATED", late.Body.GetProperty("error").GetString());
        var v2 = (await api.Anonymous().Get($"/public/hospitals/{h.Slug}/form")).Body.GetProperty("form").GetProperty("versionId").GetString();
        Assert.Equal(v2, late.Body.GetProperty("detail").GetProperty("currentVersionId").GetString());
    }

    [Fact(DisplayName = "Availability follows the rules: 14-day window, 30-minute notice, closures, hospital time zone")]
    public async Task AvailabilityRules()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var h = await BookingSetup.CreateAsync(api, owner);
        var anon = api.Anonymous();
        var av = await BookingSetup.AvailabilityAsync(anon, h);
        Assert.Equal("Asia/Damascus", av.GetProperty("timezone").GetString());
        var days = av.GetProperty("days").EnumerateArray().ToList();
        Assert.Equal(14, days.Count);
        var now = DateTimeOffset.UtcNow;
        var all = days.SelectMany(d => d.GetProperty("slots").EnumerateArray()).Select(s => DateTimeOffset.Parse(s.GetProperty("start").GetString()!)).ToList();
        Assert.All(all, s => Assert.True(s >= now.AddMinutes(29.5), $"slot {s} is inside the 30-minute notice"));
        Assert.Equal(48, days[1].GetProperty("slots").GetArrayLength());

        // Day 15 is outside the window; an off-grid time and a slot inside the notice are refused.
        var lastDayFirst = DateTimeOffset.Parse(days[13].GetProperty("slots")[0].GetProperty("start").GetString()!);
        Assert.Equal("SLOT_UNAVAILABLE", (await BookingSetup.BookAsync(api, h, lastDayFirst.AddDays(1).ToString("o"))).Body.GetProperty("error").GetString());
        Assert.Equal("SLOT_UNAVAILABLE", (await BookingSetup.BookAsync(api, h, lastDayFirst.AddMinutes(7).ToString("o"))).Body.GetProperty("error").GetString());
        var soon = all.Min().AddMinutes(-30);
        if (soon > now) Assert.Equal("SLOT_UNAVAILABLE", (await BookingSetup.BookAsync(api, h, soon.ToString("o"))).Body.GetProperty("error").GetString());

        // Closing tomorrow removes its slots and refuses bookings on it.
        var tomorrow = days[1].GetProperty("date").GetString();
        Assert.Equal(HttpStatusCode.Created, (await h.Admin.Post("/hospital/closures", new { date = tomorrow })).Status);
        var closed = (await BookingSetup.AvailabilityAsync(anon, h)).GetProperty("days")[1];
        Assert.Equal("closed", closed.GetProperty("status").GetString());
        Assert.Equal("SLOT_UNAVAILABLE", (await BookingSetup.BookAsync(api, h, days[1].GetProperty("slots")[0].GetProperty("start").GetString()!)).Body.GetProperty("error").GetString());

        // A per-hospital override from the console changes the rules immediately.
        await owner.Put($"/admin/hospitals/{h.HospitalId}/booking-rules", new { bookingWindowDays = 3, minNoticeMin = 1440 });
        var av2 = await BookingSetup.AvailabilityAsync(anon, h);
        Assert.Equal(3, av2.GetProperty("days").GetArrayLength());
        Assert.All(av2.GetProperty("days").EnumerateArray().SelectMany(d => d.GetProperty("slots").EnumerateArray()),
            s => Assert.True(DateTimeOffset.Parse(s.GetProperty("start").GetString()!) >= now.AddMinutes(1439)));
    }

    [Fact(DisplayName = "Reception cancels with a reason and the seat becomes free; scanners and other hospitals cannot")]
    public async Task CancelByReception()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var h = await BookingSetup.CreateAsync(api, owner);
        var other = await BookingSetup.CreateAsync(api, owner);
        var (reception, _) = await api.StaffAsync(h.Admin, Roles.Reception);
        var (scanner, _) = await api.StaffAsync(h.Admin, Roles.Scanner);
        var slot = await BookingSetup.SlotAsync(api.Anonymous(), h);
        var b = await BookingSetup.BookAsync(api, h, slot);
        var reference = b.Body.GetProperty("ref").GetString();
        var id = (await reception.Get($"/hospital/bookings?ref={reference}")).Body.GetProperty("bookings")[0].GetProperty("id").GetString();

        Assert.Equal(HttpStatusCode.Forbidden, (await scanner.Post($"/hospital/bookings/{id}/cancel", new { reason = "test" })).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await scanner.Get($"/hospital/bookings?ref={reference}")).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await other.Admin.Post($"/hospital/bookings/{id}/cancel", new { reason = "test" })).Status);
        Assert.Empty((await other.Admin.Get($"/hospital/bookings?ref={reference}")).Body.GetProperty("bookings").EnumerateArray());
        Assert.Equal((HttpStatusCode)422, (await reception.Post($"/hospital/bookings/{id}/cancel", new { reason = "" })).Status);

        // Capacity 1 and already booked: full until reception cancels.
        Assert.Equal(HttpStatusCode.Conflict, (await BookingSetup.BookAsync(api, h, slot)).Status);
        Assert.Equal(HttpStatusCode.OK, (await reception.Post($"/hospital/bookings/{id}/cancel", new { reason = "طلب المريض بالهاتف" })).Status);
        Assert.Equal(HttpStatusCode.Conflict, (await reception.Post($"/hospital/bookings/{id}/cancel", new { reason = "again" })).Status);
        Assert.Equal(HttpStatusCode.Created, (await BookingSetup.BookAsync(api, h, slot)).Status);
        var day = await reception.Get($"/hospital/bookings?date={DateTimeOffset.Parse(slot).ToOffset(TimeSpan.FromHours(3)):yyyy-MM-dd}");
        Assert.Equal(new[] { "cancelled", "waiting" }, day.Body.GetProperty("bookings").EnumerateArray().Select(x => x.GetProperty("status").GetString()).OrderBy(x => x));
    }

    [Fact(DisplayName = "Suspended hospitals take no bookings; the per-phone limit applies only when set in System settings")]
    public async Task SuspendedAndPhoneLimit()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var h = await BookingSetup.CreateAsync(api, owner, capacity: 10);
        var slot = await BookingSetup.SlotAsync(api.Anonymous(), h);
        Assert.Equal(HttpStatusCode.Created, (await BookingSetup.BookAsync(api, h, slot, phone: "0944000111")).Status);
        Assert.Equal(HttpStatusCode.Created, (await BookingSetup.BookAsync(api, h, slot, phone: "0944000111")).Status); // no limit by default
        Assert.Equal((HttpStatusCode)422, (await BookingSetup.BookAsync(api, h, slot, phone: "12ab")).Status);
        try
        {
            await owner.Patch("/admin/settings", new { perPhoneDailyLimit = 2 });
            var third = await BookingSetup.BookAsync(api, h, slot, phone: "0944 000 111");
            Assert.Equal((HttpStatusCode)429, third.Status);
            Assert.Equal("PHONE_LIMIT", third.Body.GetProperty("error").GetString());
        }
        finally { await owner.Patch("/admin/settings", new { perPhoneDailyLimit = 0 }); }

        await owner.Post($"/admin/hospitals/{h.HospitalId}/suspend", new { reason = "test suspension" });
        Assert.Equal("NOT_ACCEPTING", (await BookingSetup.BookAsync(api, h, slot)).Body.GetProperty("error").GetString());
        Assert.Empty((await BookingSetup.AvailabilityAsync(api.Anonymous(), h)).GetProperty("days").EnumerateArray());
    }

    [Fact(DisplayName = "RLS isolates bookings and answers between hospitals")]
    public async Task RlsBookings()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var a = await BookingSetup.CreateAsync(api, owner);
        var b = await BookingSetup.CreateAsync(api, owner);
        await BookingSetup.BookAsync(api, b, await BookingSetup.SlotAsync(api.Anonymous(), b));
        await using var app = await fx.AppAsync();
        await using var tx = await app.BeginTransactionAsync();
        await app.ExecuteAsync("SELECT set_config('app.scope', 'hospital', true), set_config('app.hospital_id', @h, true)", new { h = a.HospitalId }, tx);
        foreach (var table in new[] { "bookings", "booking_answers", "form_versions", "form_drafts", "hospital_active_form" })
            Assert.Equal(0, await app.ExecuteScalarAsync<int>($"SELECT count(*) FROM {table} WHERE hospital_id = @h", new { h = b.HospitalId }, tx));
        Assert.Equal(0, await app.ExecuteAsync("UPDATE bookings SET status = 'cancelled', cancelled_at = now() WHERE hospital_id = @h", new { h = b.HospitalId }, tx));
    }
}
