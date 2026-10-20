using System.Text.Json;
using Dapper;
using MedLink.Api.Audit;
using MedLink.Api.Auth;
using MedLink.Api.Data;
using MedLink.Api.Forms;
using Npgsql;

namespace MedLink.Api.Endpoints;

/// <summary>
/// Booking-form builder (hospital admin): draft, preview data, publish, versions, restore.
/// Publishing runs in one transaction under an advisory lock; on any failure the live version is untouched.
/// </summary>
public static class FormEndpoints
{
    public sealed record DraftRequest(FormQuestion[]? Questions, int? BaseVersion);

    private sealed class VersionRow
    {
        public string Id { get; set; } = "";
        public int Version { get; set; }
        public string SchemaJson { get; set; } = "";
        public DateTime PublishedAt { get; set; }
        public string? PublishedBy { get; set; }
        public int? RestoredFromVersion { get; set; }
        public string ChangeSummaryJson { get; set; } = "[0,0,0,0]";
    }

    private const string VersionSelect = """
        SELECT v.id, v.version, v.schema_json::text AS schema_json, v.published_at, u.email::text AS published_by,
               v.restored_from_version, v.change_summary_json::text AS change_summary_json
        FROM form_versions v LEFT JOIN users u ON u.id = v.published_by
        """;

    public static FormSchemaDoc Parse(string json) => JsonSerializer.Deserialize<FormSchemaDoc>(json, FormSchema.Json)!;

    private static IResult Error(string code, int status, object? detail = null) =>
        Results.Json(new Dictionary<string, object?> { ["error"] = code, ["detail"] = detail }, statusCode: status);

    private static Task<VersionRow?> LiveAsync(NpgsqlConnection c, NpgsqlTransaction t, string hospitalId) =>
        c.QuerySingleOrDefaultAsync<VersionRow>(VersionSelect + " JOIN hospital_active_form a ON a.form_version_id = v.id WHERE a.hospital_id = @hospitalId",
            new { hospitalId }, t);

    private static object VersionDto(VersionRow v, int? liveVersion) => new
    {
        version = v.Version,
        publishedAt = DateTime.SpecifyKind(v.PublishedAt, DateTimeKind.Utc),
        publishedBy = v.PublishedBy,
        restoredFrom = v.RestoredFromVersion,
        summary = JsonSerializer.Deserialize<int[]>(v.ChangeSummaryJson),
        questionCount = Parse(v.SchemaJson).Questions.Length,
        live = v.Version == liveVersion,
    };

    /// <summary>Inserts a new version and makes it live. Caller holds the transaction.</summary>
    public static async Task<int> PublishAsync(NpgsqlConnection c, NpgsqlTransaction t, string hospitalId, FormSchemaDoc doc, string actorId, int? restoredFrom)
    {
        // Serialise publishes per hospital (two admins pressing Publish at once).
        await c.ExecuteAsync("SELECT pg_advisory_xact_lock(7240100, hashtext(@hospitalId))", new { hospitalId }, t);
        var live = await LiveAsync(c, t, hospitalId);
        var next = await c.ExecuteScalarAsync<int>("SELECT coalesce(max(version), 0) + 1 FROM form_versions WHERE hospital_id = @hospitalId", new { hospitalId }, t);
        var id = "frm_" + Ulid.NewUlid();
        var summary = FormSchema.Diff(doc, live is null ? null : Parse(live.SchemaJson));
        await c.ExecuteAsync("""
            INSERT INTO form_versions (id, hospital_id, version, schema_json, published_by, restored_from_version, change_summary_json)
            VALUES (@id, @hospitalId, @next, @schema::jsonb, @actorId, @restoredFrom, @summary::jsonb)
            """, new { id, hospitalId, next, schema = JsonSerializer.Serialize(doc, FormSchema.Json), actorId, restoredFrom, summary = JsonSerializer.Serialize(summary) }, t);
        await c.ExecuteAsync("""
            INSERT INTO hospital_active_form (hospital_id, form_version_id) VALUES (@hospitalId, @id)
            ON CONFLICT (hospital_id) DO UPDATE SET form_version_id = excluded.form_version_id
            """, new { hospitalId, id }, t);
        await c.ExecuteAsync("DELETE FROM form_drafts WHERE hospital_id = @hospitalId", new { hospitalId }, t);
        await AuditLog.WriteAsync(c, t, actorId, hospitalId, "form_publish", "v" + next, new { summary, restoredFrom });
        return next;
    }

    public static void MapForms(this WebApplication app)
    {
        var g = app.MapGroup("/hospital/form");

        g.MapGet("", async (HttpContext ctx, Db db) =>
        {
            var p = ctx.RequirePrincipal();
            return Results.Json(await db.RunAsync(p.DbScope, async (c, t) =>
            {
                var live = await LiveAsync(c, t, p.HospitalId!);
                var draft = await c.QuerySingleOrDefaultAsync<(string SchemaJson, int BaseVersion, DateTime UpdatedAt)?>(
                    "SELECT schema_json::text, base_version, updated_at FROM form_drafts WHERE hospital_id = @h", new { h = p.HospitalId }, t);
                return new
                {
                    live = live is null ? null : new
                    {
                        version = live.Version, publishedAt = DateTime.SpecifyKind(live.PublishedAt, DateTimeKind.Utc),
                        publishedBy = live.PublishedBy, questions = Parse(live.SchemaJson).Questions,
                    },
                    draft = draft is null ? null : new
                    {
                        questions = Parse(draft.Value.SchemaJson).Questions, baseVersion = draft.Value.BaseVersion,
                        updatedAt = DateTime.SpecifyKind(draft.Value.UpdatedAt, DateTimeKind.Utc),
                    },
                };
            }));
        }).Require(Permission.FormEditPublish);

        // Saving a draft never touches the live form.
        g.MapPut("/draft", async (DraftRequest req, HttpContext ctx, Db db) =>
        {
            var p = ctx.RequirePrincipal();
            var doc = new FormSchemaDoc(req.Questions ?? []);
            if (FormSchema.ValidateStructure(doc) is { } err) return Error(err, 422);
            await db.RunAsync(p.DbScope, (c, t) => c.ExecuteAsync("""
                INSERT INTO form_drafts (hospital_id, schema_json, base_version, updated_by, updated_at)
                VALUES (@h, @schema::jsonb, @base, @by, now())
                ON CONFLICT (hospital_id) DO UPDATE SET schema_json = excluded.schema_json, base_version = excluded.base_version,
                    updated_by = excluded.updated_by, updated_at = now()
                """, new { h = p.HospitalId, schema = JsonSerializer.Serialize(doc, FormSchema.Json), @base = req.BaseVersion ?? 0, by = p.UserId }, t));
            return Results.Json(new { status = "ok" });
        }).Require(Permission.FormEditPublish).RequireJson();

        g.MapDelete("/draft", async (HttpContext ctx, Db db) =>
        {
            var p = ctx.RequirePrincipal();
            await db.RunAsync(p.DbScope, (c, t) => c.ExecuteAsync("DELETE FROM form_drafts WHERE hospital_id = @h", new { h = p.HospitalId }, t));
            return Results.Json(new { status = "ok" });
        }).Require(Permission.FormEditPublish);

        // Publishes the saved draft. Success is reported only after the commit.
        g.MapPost("/publish", async (HttpContext ctx, Db db) =>
        {
            var p = ctx.RequirePrincipal();
            return await db.RunAsync(p.DbScope, async (c, t) =>
            {
                var json = await c.ExecuteScalarAsync<string?>("SELECT schema_json::text FROM form_drafts WHERE hospital_id = @h FOR UPDATE", new { h = p.HospitalId }, t);
                if (json is null) return Error("NO_DRAFT", 409);
                var doc = Parse(json);
                if (FormSchema.ValidateStructure(doc) is { } err) return Error(err, 422);
                var blockers = FormSchema.Blockers(doc);
                if (blockers.Count > 0) return Error("FORM_BLOCKED", 422, blockers);
                var cleaned = FormSchema.CleanForPublish(doc);
                var live = await LiveAsync(c, t, p.HospitalId!);
                if (live is not null && FormSchema.Diff(cleaned, Parse(live.SchemaJson)).Sum() == 0) return Error("NO_CHANGES", 409);
                var version = await PublishAsync(c, t, p.HospitalId!, cleaned, p.UserId, null);
                return Results.Json(new { version });
            });
        }).Require(Permission.FormEditPublish);

        g.MapGet("/versions", async (HttpContext ctx, Db db) =>
        {
            var p = ctx.RequirePrincipal();
            return Results.Json(await db.RunAsync(p.DbScope, async (c, t) =>
            {
                var live = await LiveAsync(c, t, p.HospitalId!);
                var rows = await c.QueryAsync<VersionRow>(VersionSelect + " WHERE v.hospital_id = @h ORDER BY v.version DESC", new { h = p.HospitalId }, t);
                return new { versions = rows.Select(v => VersionDto(v, live?.Version)) };
            }));
        }).Require(Permission.FormEditPublish);

        g.MapGet("/versions/{version:int}", async (int version, HttpContext ctx, Db db) =>
        {
            var p = ctx.RequirePrincipal();
            var v = await db.RunAsync(p.DbScope, (c, t) => c.QuerySingleOrDefaultAsync<VersionRow>(
                VersionSelect + " WHERE v.hospital_id = @h AND v.version = @version", new { h = p.HospitalId, version }, t));
            return v is null ? Error("NOT_FOUND", 404) : Results.Json(new { version = v.Version, questions = Parse(v.SchemaJson).Questions });
        }).Require(Permission.FormEditPublish);

        // Restoring publishes the old content as a NEW version; nothing is deleted. Any unpublished draft is replaced.
        g.MapPost("/versions/{version:int}/restore", async (int version, HttpContext ctx, Db db) =>
        {
            var p = ctx.RequirePrincipal();
            return await db.RunAsync(p.DbScope, async (c, t) =>
            {
                var v = await c.QuerySingleOrDefaultAsync<VersionRow>(VersionSelect + " WHERE v.hospital_id = @h AND v.version = @version", new { h = p.HospitalId, version }, t);
                if (v is null) return Error("NOT_FOUND", 404);
                var live = await LiveAsync(c, t, p.HospitalId!);
                if (live?.Version == version) return Error("ALREADY_LIVE", 409);
                var next = await PublishAsync(c, t, p.HospitalId!, Parse(v.SchemaJson), p.UserId, version);
                return Results.Json(new { version = next, restoredFrom = version });
            });
        }).Require(Permission.FormEditPublish);
    }
}
