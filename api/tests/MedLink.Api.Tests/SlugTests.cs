using System.Net;
using Dapper;
using MedLink.Api.Auth;
using MedLink.Api.Tests.Infrastructure;

namespace MedLink.Api.Tests;

[Collection("medlink")]
public sealed class SlugTests(MedLinkFixture fx) : IDisposable
{
    private readonly TestApi api = new(fx);
    public void Dispose() => api.Dispose();

    private static string NewSlug(string p) => p + "-" + Guid.NewGuid().ToString("N")[..8];

    [Fact(DisplayName = "Acceptance 4: each hospital gets a unique booking link; reserved and malformed slugs are refused")]
    public async Task UniqueReservedValid()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var (_, slug, _, _) = await api.HospitalAsync(owner);

        object Body(string s) => new { nameAr = "م", nameEn = "Slug Hospital", adminEmail = TestApi.NewEmail("s"), slug = s };
        var dup = await owner.Post("/admin/hospitals", Body(slug));
        Assert.Equal(HttpStatusCode.Conflict, dup.Status);
        Assert.Equal("SLUG_TAKEN", dup.Body.GetProperty("error").GetString());

        foreach (var reserved in new[] { "admin", "api", "book", "www", "medlink" })
            Assert.Equal(HttpStatusCode.Conflict, (await owner.Post("/admin/hospitals", Body(reserved))).Status);

        foreach (var bad in new[] { "ab", "-abc", "abc-", "Abc", "ab_c", "عربي", new string('a', 41) })
            Assert.Equal((HttpStatusCode)422, (await owner.Post("/admin/hospitals", Body(bad))).Status);

        Assert.Equal("taken", (await owner.Get($"/admin/slugs/check?slug={slug}")).Body.GetProperty("state").GetString());
        Assert.Equal("taken", (await owner.Get("/admin/slugs/check?slug=admin")).Body.GetProperty("state").GetString());
        Assert.Equal("bad", (await owner.Get("/admin/slugs/check?slug=A")).Body.GetProperty("state").GetString());
        Assert.Equal("ok", (await owner.Get($"/admin/slugs/check?slug={NewSlug("free")}")).Body.GetProperty("state").GetString());

        var pub = await api.Anonymous().Get($"/public/book/{slug}");
        Assert.Equal(HttpStatusCode.OK, pub.Status);
        Assert.Equal("active", pub.Body.GetProperty("state").GetString());
        Assert.Equal(HttpStatusCode.NotFound, (await api.Anonymous().Get($"/public/book/{NewSlug("nobody")}")).Status);
    }

    [Fact(DisplayName = "Two concurrent creates with the same slug: exactly one wins")]
    public async Task ConcurrentCreate()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var slug = NewSlug("race");
        var results = await Task.WhenAll(Enumerable.Range(0, 5).Select(i =>
            owner.Post("/admin/hospitals", new { nameAr = "م", nameEn = "Race " + i, adminEmail = TestApi.NewEmail("r"), slug })));
        Assert.Equal(1, results.Count(r => r.Status == HttpStatusCode.Created));
        Assert.All(results.Where(r => r.Status != HttpStatusCode.Created), r => Assert.Equal(HttpStatusCode.Conflict, r.Status));
    }

    [Fact(DisplayName = "Slug change: old link 301-redirects for 90 days, then 410; reserved forever; one change per 30 days")]
    public async Task ChangePolicy()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var (hid, oldSlug, _, _) = await api.HospitalAsync(owner);
        var newSlug = NewSlug("renamed");

        var edit = await owner.Patch($"/admin/hospitals/{hid}", new { nameAr = "مستشفى الاختبار", nameEn = "Test Hospital", slug = newSlug });
        Assert.Equal(HttpStatusCode.OK, edit.Status);

        var anon = api.Anonymous();
        var moved = await anon.Get($"/public/book/{oldSlug}");
        Assert.Equal(HttpStatusCode.MovedPermanently, moved.Status);
        Assert.Equal(newSlug, moved.Body.GetProperty("slug").GetString());
        Assert.Equal(HttpStatusCode.OK, (await anon.Get($"/public/book/{newSlug}")).Status);
        // The app endpoint never redirects: it answers with the current page and current slug.
        var viaApp = await anon.Get($"/public/slugs/{oldSlug}");
        Assert.Equal(HttpStatusCode.OK, viaApp.Status);
        Assert.Equal("active", viaApp.Body.GetProperty("state").GetString());
        Assert.Equal(newSlug, viaApp.Body.GetProperty("slug").GetString());

        var detail = await owner.Get($"/admin/hospitals/{hid}");
        Assert.Equal(oldSlug, detail.Body.GetProperty("oldSlugs")[0].GetProperty("slug").GetString());
        var until = detail.Body.GetProperty("oldSlugs")[0].GetProperty("redirectUntil").GetDateTime();
        Assert.InRange((until - DateTime.UtcNow).TotalDays, 89.9, 90.1);

        // A second change inside 30 days is refused.
        var tooSoon = await owner.Patch($"/admin/hospitals/{hid}", new { nameAr = "م", nameEn = "Test Hospital", slug = NewSlug("again") });
        Assert.Equal(HttpStatusCode.Conflict, tooSoon.Status);
        Assert.Equal("SLUG_CHANGE_TOO_SOON", tooSoon.Body.GetProperty("error").GetString());

        // No other hospital may claim the retired slug.
        var steal = await owner.Post("/admin/hospitals", new { nameAr = "م", nameEn = "Thief", adminEmail = TestApi.NewEmail("t"), slug = oldSlug });
        Assert.Equal(HttpStatusCode.Conflict, steal.Status);

        // After 90 days the old link shows "link changed" (aged directly in the database).
        await using (var db = await fx.OwnerAsync())
            await db.ExecuteAsync("UPDATE hospital_slugs SET retired_at = now() - interval '91 days', redirect_until = now() - interval '1 day' WHERE slug = @oldSlug", new { oldSlug });
        var gone = await anon.Get($"/public/book/{oldSlug}");
        Assert.Equal(HttpStatusCode.Gone, gone.Status);
        Assert.Equal("LINK_CHANGED", gone.Body.GetProperty("error").GetString());
        Assert.Equal("changed", (await anon.Get($"/public/slugs/{oldSlug}")).Body.GetProperty("state").GetString());
        Assert.Equal(HttpStatusCode.NotFound, (await anon.Get($"/public/slugs/{NewSlug("nobody")}")).Status);

        // 30+ days later the hospital may change again, including back to its own old slug.
        var back = await owner.Patch($"/admin/hospitals/{hid}", new { nameAr = "م", nameEn = "Test Hospital", slug = oldSlug });
        Assert.Equal(HttpStatusCode.OK, back.Status);
        Assert.Equal(HttpStatusCode.OK, (await anon.Get($"/public/book/{oldSlug}")).Status);
        Assert.Equal(HttpStatusCode.MovedPermanently, (await anon.Get($"/public/book/{newSlug}")).Status);

        // The hospital ID never changed and every slug row is still there.
        await using var db2 = await fx.OwnerAsync();
        Assert.Equal(2, await db2.ExecuteScalarAsync<int>("SELECT count(*) FROM hospital_slugs WHERE hospital_id = @hid", new { hid }));
    }
}
