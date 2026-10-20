using System.Net;
using Dapper;
using MedLink.Api.Auth;
using MedLink.Api.Tests.Infrastructure;

namespace MedLink.Api.Tests;

[Collection("medlink")]
public sealed class FormBuilderTests(MedLinkFixture fx) : IDisposable
{
    private readonly TestApi api = new(fx);
    public void Dispose() => api.Dispose();

    public static object Visit(string ar = "نوع الزيارة") => new
    {
        id = "visit", type = "single", req = true, label = new { ar, en = "Visit type", tr = "Ziyaret türü" },
        opts = new[] { new { id = "new", label = new { ar = "استشارة جديدة", en = "New", tr = "Yeni" } }, new { id = "fu", label = new { ar = "متابعة", en = "Follow-up", tr = "Kontrol" } } },
    };
    public static object Note() => new { id = "note", type = "short", req = false, label = new { ar = "ملاحظة لموظف الاستقبال", en = "Note", tr = "Not" }, opts = Array.Empty<object>() };
    public static object First() => new { id = "first", type = "yesno", req = true, label = new { ar = "هل هذه زيارتك الأولى؟", en = "First visit?", tr = "İlk ziyaret?" }, opts = Array.Empty<object>() };

    private static async Task<int> PublishAsync(ApiClient admin, params object[] questions)
    {
        Assert.Equal(HttpStatusCode.OK, (await admin.Put("/hospital/form/draft", new { questions })).Status);
        var r = await admin.Post("/hospital/form/publish", new { });
        Assert.Equal(HttpStatusCode.OK, r.Status);
        return r.Body.GetProperty("version").GetInt32();
    }

    [Fact(DisplayName = "Acceptance 12/14: a published question appears on the booking link; a saved draft does not")]
    public async Task PublishedAppearsDraftDoesNot()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var (_, slug, _, admin) = await api.HospitalAsync(owner);
        var anon = api.Anonymous();

        Assert.Equal(System.Text.Json.JsonValueKind.Null, (await anon.Get($"/public/hospitals/{slug}/form")).Body.GetProperty("form").ValueKind);
        Assert.Equal(1, await PublishAsync(admin, Visit()));
        var pub = (await anon.Get($"/public/hospitals/{slug}/form")).Body.GetProperty("form");
        Assert.Equal(1, pub.GetProperty("version").GetInt32());
        Assert.Equal("نوع الزيارة", pub.GetProperty("questions")[0].GetProperty("label").GetProperty("ar").GetString());

        // A draft with a new question is not visible to patients.
        Assert.Equal(HttpStatusCode.OK, (await admin.Put("/hospital/form/draft", new { questions = new[] { Visit(), Note() } })).Status);
        pub = (await anon.Get($"/public/hospitals/{slug}/form")).Body.GetProperty("form");
        Assert.Equal(1, pub.GetProperty("questions").GetArrayLength());
        var state = await admin.Get("/hospital/form");
        Assert.Equal(2, state.Body.GetProperty("draft").GetProperty("questions").GetArrayLength());
        Assert.Equal(1, state.Body.GetProperty("live").GetProperty("version").GetInt32());

        // Publishing makes it appear, as version 2 with "+1 added".
        Assert.Equal(HttpStatusCode.OK, (await admin.Post("/hospital/form/publish", new { })).Status);
        pub = (await anon.Get($"/public/hospitals/{slug}/form")).Body.GetProperty("form");
        Assert.Equal(2, pub.GetProperty("version").GetInt32());
        Assert.Equal(2, pub.GetProperty("questions").GetArrayLength());
        var versions = (await admin.Get("/hospital/form/versions")).Body.GetProperty("versions");
        Assert.Equal(new[] { 1, 0, 0, 0 }, versions[0].GetProperty("summary").EnumerateArray().Select(x => x.GetInt32()));
        Assert.True(versions[0].GetProperty("live").GetBoolean());
        Assert.Equal(System.Text.Json.JsonValueKind.Null, (await admin.Get("/hospital/form")).Body.GetProperty("draft").ValueKind);
    }

    [Fact(DisplayName = "Acceptance 15: publishing is blocked until every question has Arabic text and choice questions have 2 options")]
    public async Task PublishBlockers()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var (_, _, _, admin) = await api.HospitalAsync(owner);
        var bad = new object[]
        {
            new { id = "a", type = "short", req = false, label = new { ar = "", en = "No Arabic", tr = "" }, opts = Array.Empty<object>() },
            new { id = "b", type = "single", req = true, label = new { ar = "اختر", en = "", tr = "" }, opts = new[] { new { id = "x", label = new { ar = "واحد", en = "", tr = "" } } } },
        };
        Assert.Equal(HttpStatusCode.OK, (await admin.Put("/hospital/form/draft", new { questions = bad })).Status);
        var r = await admin.Post("/hospital/form/publish", new { });
        Assert.Equal((HttpStatusCode)422, r.Status);
        Assert.Equal("FORM_BLOCKED", r.Body.GetProperty("error").GetString());
        var codes = r.Body.GetProperty("detail").EnumerateArray().Select(x => x.GetProperty("code").GetString()).ToList();
        Assert.Equal(new[] { "LABEL_AR_REQUIRED", "OPTIONS_REQUIRED" }, codes);
        Assert.Equal(System.Text.Json.JsonValueKind.Null, (await admin.Get("/hospital/form")).Body.GetProperty("live").ValueKind);

        // Structure checks on save: unknown types, duplicate ids, options on a text question.
        foreach (var q in new object[]
                 {
                     new { id = "a", type = "upload", req = false, label = new { ar = "x" }, opts = Array.Empty<object>() },
                     new { id = "BAD ID", type = "short", req = false, label = new { ar = "x" }, opts = Array.Empty<object>() },
                     new { id = "a", type = "short", req = false, label = new { ar = "x" }, opts = new[] { new { id = "o", label = new { ar = "y" } } } },
                 })
            Assert.Equal((HttpStatusCode)422, (await admin.Put("/hospital/form/draft", new { questions = new[] { q } })).Status);
        Assert.Equal((HttpStatusCode)422, (await admin.Put("/hospital/form/draft", new { questions = new[] { Note(), Note() } })).Status);

        // Nothing to publish when the draft equals the live version.
        await PublishAsync(admin, Visit());
        await admin.Put("/hospital/form/draft", new { questions = new[] { Visit() } });
        Assert.Equal(HttpStatusCode.Conflict, (await admin.Post("/hospital/form/publish", new { })).Status);
    }

    [Fact(DisplayName = "Acceptance 16: a publish that fails inside the database keeps the live version and the draft")]
    public async Task FailedPublishKeepsLive()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var (hid, slug, _, admin) = await api.HospitalAsync(owner);
        await PublishAsync(admin, Visit());
        await admin.Put("/hospital/form/draft", new { questions = new[] { Visit(), Note() } });

        // Make the next insert into form_versions fail for this hospital only (simulates a database error mid-publish).
        await using (var db = await fx.OwnerAsync())
            await db.ExecuteAsync($"""
                CREATE FUNCTION test_fail_publish() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN IF NEW.hospital_id = '{hid}' THEN RAISE EXCEPTION 'simulated failure'; END IF; RETURN NEW; END $$;
                CREATE TRIGGER test_fail_publish BEFORE INSERT ON form_versions FOR EACH ROW EXECUTE FUNCTION test_fail_publish();
                """);
        try
        {
            var r = await admin.Post("/hospital/form/publish", new { });
            Assert.Equal(HttpStatusCode.InternalServerError, r.Status);
        }
        finally
        {
            await using var db = await fx.OwnerAsync();
            await db.ExecuteAsync("DROP TRIGGER test_fail_publish ON form_versions; DROP FUNCTION test_fail_publish();");
        }
        var pub = (await api.Anonymous().Get($"/public/hospitals/{slug}/form")).Body.GetProperty("form");
        Assert.Equal(1, pub.GetProperty("version").GetInt32());
        Assert.Equal(1, pub.GetProperty("questions").GetArrayLength());
        Assert.Equal(2, (await admin.Get("/hospital/form")).Body.GetProperty("draft").GetProperty("questions").GetArrayLength());
        await using var db2 = await fx.OwnerAsync();
        Assert.Equal(1, await db2.ExecuteScalarAsync<int>("SELECT count(*) FROM form_versions WHERE hospital_id = @hid", new { hid }));
        // And the retry works.
        Assert.Equal(HttpStatusCode.OK, (await admin.Post("/hospital/form/publish", new { })).Status);
    }

    [Fact(DisplayName = "Acceptance 17: restoring an old version publishes it as a new version; old versions stay")]
    public async Task RestoreAsNewVersion()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var (_, slug, _, admin) = await api.HospitalAsync(owner);
        await PublishAsync(admin, Visit());
        await PublishAsync(admin, Visit(), Note(), First());
        await admin.Put("/hospital/form/draft", new { questions = new[] { Note() } }); // unpublished draft, to be replaced

        Assert.Equal(HttpStatusCode.Conflict, (await admin.Post("/hospital/form/versions/2/restore", new { })).Status); // already live
        var r = await admin.Post("/hospital/form/versions/1/restore", new { });
        Assert.Equal(HttpStatusCode.OK, r.Status);
        Assert.Equal(3, r.Body.GetProperty("version").GetInt32());

        var versions = (await admin.Get("/hospital/form/versions")).Body.GetProperty("versions").EnumerateArray().ToList();
        Assert.Equal(new[] { 3, 2, 1 }, versions.Select(v => v.GetProperty("version").GetInt32()));
        Assert.Equal(1, versions[0].GetProperty("restoredFrom").GetInt32());
        Assert.Equal(new[] { 0, 0, 2, 0 }, versions[0].GetProperty("summary").EnumerateArray().Select(x => x.GetInt32()));
        Assert.Equal(1, (await api.Anonymous().Get($"/public/hospitals/{slug}/form")).Body.GetProperty("form").GetProperty("questions").GetArrayLength());
        Assert.Equal(System.Text.Json.JsonValueKind.Null, (await admin.Get("/hospital/form")).Body.GetProperty("draft").ValueKind);
        Assert.Equal(3, (await admin.Get("/hospital/form/versions/2")).Body.GetProperty("questions").GetArrayLength());
    }

    [Fact(DisplayName = "Only the hospital admin edits the form; published versions cannot be modified in the database")]
    public async Task FormPermissions()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var (_, _, _, admin) = await api.HospitalAsync(owner);
        var (reception, _) = await api.StaffAsync(admin, Roles.Reception);
        Assert.Equal(HttpStatusCode.Forbidden, (await reception.Get("/hospital/form")).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await reception.Put("/hospital/form/draft", new { questions = new[] { Note() } })).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await reception.Post("/hospital/form/publish", new { })).Status);
        Assert.Equal(HttpStatusCode.Forbidden, (await owner.Get("/hospital/form")).Status);

        await PublishAsync(admin, Visit());
        await using var app = await fx.AppAsync();
        await using var tx = await app.BeginTransactionAsync();
        await app.ExecuteAsync("SELECT set_config('app.scope', 'system', true)", transaction: tx);
        var ex = await Assert.ThrowsAsync<Npgsql.PostgresException>(() => app.ExecuteAsync("UPDATE form_versions SET schema_json = '{}'", transaction: tx));
        Assert.Equal(Npgsql.PostgresErrorCodes.InsufficientPrivilege, ex.SqlState);
    }
}
