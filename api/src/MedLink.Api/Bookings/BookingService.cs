using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Dapper;
using MedLink.Api.Config;
using MedLink.Api.Data;
using MedLink.Api.Endpoints;
using MedLink.Api.Forms;
using MedLink.Api.Security;
using Npgsql;

namespace MedLink.Api.Bookings;

public sealed class PublicHospital
{
    public string Id { get; set; } = "";
    public string Slug { get; set; } = "";
    public string NameAr { get; set; } = "";
    public string NameEn { get; set; } = "";
    public string? NameTr { get; set; }
    public string Status { get; set; } = "";
    public string Timezone { get; set; } = "";
    public int WindowDays { get; set; }
    public int MinNoticeMin { get; set; }
    public int PerPhoneDailyLimit { get; set; }
}

public sealed record BookingRequest(string? DepartmentId, DateTimeOffset? SlotStart, string? PatientName, string? Phone,
    string? FormVersionId, Dictionary<string, JsonElement>? Answers);

public sealed record BookingResult(int Status, string? Error = null, object? Body = null);

/// <summary>
/// Public booking. Guarantees (BACKEND-SPEC §5):
/// a seat is taken at most once (partial unique index + retry on the next seat);
/// a repeated Idempotency-Key returns the original booking;
/// availability and answers are re-checked on the server at confirm time;
/// the QR token is 128 random-looking bits with no personal data, and only its hash is stored.
/// </summary>
public sealed class BookingService(Db db, MedLinkOptions options, TimeProvider clock)
{
    private const string RefAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    public static readonly TimeSpan OldFormGrace = TimeSpan.FromHours(2);
    public static readonly TimeSpan IdempotencyReplayWindow = TimeSpan.FromHours(24);

    private readonly byte[] _qrKey = HKDF.DeriveKey(HashAlgorithmName.SHA256, options.SessionSigningKey, 32, info: Encoding.UTF8.GetBytes("medlink/qr/v1"));

    /// <summary>"MLK1." + 22 base64url characters (128 bits), derived from the booking ID with a server key.</summary>
    public string QrToken(string bookingId) => "MLK1." + Tokens.Base64Url(HMACSHA256.HashData(_qrKey, Encoding.UTF8.GetBytes(bookingId)).AsSpan(0, 16));

    public static string NewRef() => "ML-" + string.Create(6, 0, (span, _) =>
    {
        for (var i = 0; i < span.Length; i++) span[i] = RefAlphabet[RandomNumberGenerator.GetInt32(RefAlphabet.Length)];
    });

    public static string? NormalizePhone(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var s = new string(raw.Where(ch => !char.IsWhiteSpace(ch) && ch is not '-' and not '(' and not ')').ToArray());
        return System.Text.RegularExpressions.Regex.IsMatch(s, @"^\+?\d{7,15}$") ? s : "";
    }

    /// <summary>Hospital by its current slug or a slug still inside its 90-day redirect window.</summary>
    public static Task<PublicHospital?> ResolveAsync(NpgsqlConnection c, NpgsqlTransaction t, string slug) =>
        c.QuerySingleOrDefaultAsync<PublicHospital>("""
            SELECT h.id, (SELECT p.slug FROM hospital_slugs p WHERE p.hospital_id = h.id AND p.is_primary) AS slug,
                   h.name_ar, h.name_en, h.name_tr, h.status, h.timezone,
                   coalesce(h.booking_window_days, ps.booking_window_days) AS window_days,
                   coalesce(h.min_notice_min, ps.min_notice_min) AS min_notice_min,
                   ps.per_phone_daily_limit
            FROM hospital_slugs s JOIN hospitals h ON h.id = s.hospital_id CROSS JOIN platform_settings ps
            WHERE s.slug = @slug AND ps.id AND (s.is_primary OR s.redirect_until > now())
            """, new { slug }, t);

    public static async Task<(List<Block> Blocks, HashSet<DateOnly> Closed, Dictionary<DateTimeOffset, int> Booked)> LoadDepartmentAsync(
        NpgsqlConnection c, NpgsqlTransaction t, string hospitalId, string departmentId, DateTimeOffset fromUtc, DateTimeOffset toUtc)
    {
        var blocks = (await c.QueryAsync<(short Weekday, int StartMin, int EndMin, int SlotMinutes, int Capacity)>(
            "SELECT weekday, start_min, end_min, slot_minutes, capacity FROM schedules WHERE hospital_id = @h AND department_id = @d",
            new { h = hospitalId, d = departmentId }, t)).Select(b => new Block(b.Weekday, b.StartMin, b.EndMin, b.SlotMinutes, b.Capacity)).ToList();
        var closed = (await c.QueryAsync<DateTime>(
            "SELECT date FROM closures WHERE hospital_id = @h AND (department_id IS NULL OR department_id = @d)",
            new { h = hospitalId, d = departmentId }, t)).Select(DateOnly.FromDateTime).ToHashSet();
        var booked = (await c.QueryAsync<(DateTime SlotStart, int N)>("""
            SELECT slot_start, count(*)::int FROM bookings
            WHERE hospital_id = @h AND department_id = @d AND status <> 'cancelled' AND slot_start >= @from AND slot_start < @to
            GROUP BY slot_start
            """, new { h = hospitalId, d = departmentId, from = fromUtc.UtcDateTime, to = toUtc.UtcDateTime }, t))
            .ToDictionary(x => new DateTimeOffset(DateTime.SpecifyKind(x.SlotStart, DateTimeKind.Utc)), x => x.N);
        return (blocks, closed, booked);
    }

    public static TimeZoneInfo Zone(string id) => TimeZoneInfo.FindSystemTimeZoneById(id);

    public async Task<BookingResult> CreateAsync(string slug, string? idempotencyKey, BookingRequest req, CancellationToken ct = default)
    {
        if (idempotencyKey is null || idempotencyKey.Length is < 8 or > 64 || !idempotencyKey.All(ch => char.IsAsciiLetterOrDigit(ch) || ch is '-' or '_'))
            return new BookingResult(400, "IDEMPOTENCY_KEY_REQUIRED");
        var name = req.PatientName?.Trim();
        if (name is null || name.Length is < 2 or > 80) return new BookingResult(422, "NAME_INVALID");
        var phone = NormalizePhone(req.Phone);
        if (phone == "") return new BookingResult(422, "PHONE_INVALID");
        if (req.DepartmentId is null || req.SlotStart is null) return new BookingResult(422, "SLOT_REQUIRED");
        var slotStart = req.SlotStart.Value.ToUniversalTime();
        var requestHash = SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new
        {
            d = req.DepartmentId, s = slotStart.ToUnixTimeSeconds(), n = name, p = phone, f = req.FormVersionId,
            a = (req.Answers ?? []).OrderBy(x => x.Key, StringComparer.Ordinal).Select(x => new[] { x.Key, x.Value.GetRawText() }),
        })));

        return await db.RunAsync(DbScope.System, async (c, t) =>
        {
            var h = await ResolveAsync(c, t, slug);
            if (h is null) return new BookingResult(404, "NOT_FOUND");

            // 1. Same Idempotency-Key → the original booking (or a clear refusal if the request differs).
            var replay = await ReplayAsync(c, t, h, idempotencyKey, requestHash);
            if (replay is not null) return replay;

            if (h.Status != "active") return new BookingResult(409, "NOT_ACCEPTING");
            var dep = await c.QuerySingleOrDefaultAsync<(string NameAr, string? NameEn, string? NameTr)?>(
                "SELECT name_ar, name_en, name_tr FROM departments WHERE id = @d AND hospital_id = @h AND active", new { d = req.DepartmentId, h = h.Id }, t);
            if (dep is null) return new BookingResult(422, "DEPARTMENT_INVALID");

            // 2. The slot must still be offered: schedule, closures, booking window, minimum notice.
            var tz = Zone(h.Timezone);
            var now = clock.GetUtcNow();
            var localDate = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(slotStart, tz).DateTime);
            var today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(now, tz).DateTime);
            if (localDate < today || localDate > today.AddDays(h.WindowDays - 1)) return new BookingResult(409, "SLOT_UNAVAILABLE");
            var (blocks, closed, booked) = await LoadDepartmentAsync(c, t, h.Id, req.DepartmentId, slotStart, slotStart.AddSeconds(1));
            var day = Availability.ComputeDay(tz, now, localDate, h.MinNoticeMin, blocks, closed, new Dictionary<DateTimeOffset, int>());
            var slot = day.Slots.FirstOrDefault(s => s.StartUtc == slotStart);
            if (slot is null) return new BookingResult(409, "SLOT_UNAVAILABLE");
            if (booked.GetValueOrDefault(slotStart) >= slot.Capacity) return new BookingResult(409, "SLOT_FULL");

            // 3. Answers are validated against the version the patient opened (accepted for 2 h after it is replaced).
            var form = await ResolveFormAsync(c, t, h.Id, req.FormVersionId, now);
            if (form.Error is not null) return new BookingResult(409, form.Error, new { currentVersionId = form.CurrentId });
            var (answers, ansErr, qid) = form.Doc is null
                ? ((req.Answers?.Count ?? 0) == 0 ? (new Dictionary<string, JsonElement>(), null, null) : (null, "ANSWER_UNKNOWN_QUESTION", req.Answers!.Keys.First()))
                : FormSchema.ValidateAnswers(form.Doc, req.Answers);
            if (ansErr is not null) return new BookingResult(422, ansErr, new { questionId = qid });

            // 4. Optional per-phone daily limit (System settings; 0 = none).
            if (phone is not null && h.PerPhoneDailyLimit > 0)
            {
                var dayStart = TimeZoneInfo.ConvertTimeToUtc(localDate.ToDateTime(TimeOnly.MinValue), tz);
                var count = await c.ExecuteScalarAsync<int>("""
                    SELECT count(*) FROM bookings WHERE hospital_id = @h AND phone = @phone AND status <> 'cancelled'
                      AND slot_start >= @from AND slot_start < @to
                    """, new { h = h.Id, phone, from = dayStart, to = dayStart.AddDays(1) }, t);
                if (count >= h.PerPhoneDailyLimit) return new BookingResult(429, "PHONE_LIMIT");
            }

            // 5. Take the first free seat. A concurrent booking of the same seat fails the unique index; try the next.
            for (var attempt = 0; attempt < slot.Capacity + 3; attempt++)
            {
                var seat = await c.ExecuteScalarAsync<int?>("""
                    SELECT s FROM generate_series(1, @cap) s
                    WHERE s NOT IN (SELECT seat_no FROM bookings WHERE hospital_id = @h AND department_id = @d AND slot_start = @slot AND status <> 'cancelled')
                    ORDER BY s LIMIT 1
                    """, new { cap = slot.Capacity, h = h.Id, d = req.DepartmentId, slot = slotStart.UtcDateTime }, t);
                if (seat is null) return new BookingResult(409, "SLOT_FULL");
                var id = "bkg_" + Ulid.NewUlid();
                var reference = NewRef();
                await c.ExecuteAsync("SAVEPOINT seat", transaction: t);
                try
                {
                    await c.ExecuteAsync("""
                        INSERT INTO bookings (id, hospital_id, ref, department_id, slot_start, seat_no, patient_name, phone, form_version_id,
                                              qr_token_hash, idempotency_key, request_hash)
                        VALUES (@id, @h, @reference, @d, @slot, @seat, @name, @phone, @form, @qr, @key, @rh)
                        """, new { id, h = h.Id, reference, d = req.DepartmentId, slot = slotStart.UtcDateTime, seat, name, phone,
                            form = form.Id, qr = Tokens.Hash(QrToken(id)), key = idempotencyKey, rh = requestHash }, t);
                }
                catch (PostgresException e) when (e.IsUniqueViolation())
                {
                    await c.ExecuteAsync("ROLLBACK TO SAVEPOINT seat", transaction: t);
                    if (e.ConstraintName == "bookings_hospital_id_idempotency_key_key")
                        return await ReplayAsync(c, t, h, idempotencyKey, requestHash) ?? new BookingResult(409, "IDEMPOTENCY_CONFLICT");
                    continue; // seat or reference taken meanwhile
                }
                foreach (var (q, v) in answers!)
                    await c.ExecuteAsync("INSERT INTO booking_answers (booking_id, hospital_id, question_id, value_json) VALUES (@id, @h, @q, @v::jsonb)",
                        new { id, h = h.Id, q, v = v.GetRawText() }, t);
                return new BookingResult(201, Body: Confirmation(h, id, reference, slotStart, tz, dep.Value));
            }
            return new BookingResult(409, "SLOT_FULL");
        }, ct);
    }

    private async Task<BookingResult?> ReplayAsync(NpgsqlConnection c, NpgsqlTransaction t, PublicHospital h, string key, byte[] requestHash)
    {
        var prev = await c.QuerySingleOrDefaultAsync<(string Id, string Ref, DateTime SlotStart, byte[] RequestHash, DateTime CreatedAt, string NameAr, string? NameEn, string? NameTr)?>("""
            SELECT b.id, b.ref, b.slot_start, b.request_hash, b.created_at, d.name_ar, d.name_en, d.name_tr
            FROM bookings b JOIN departments d ON d.id = b.department_id
            WHERE b.hospital_id = @h AND b.idempotency_key = @key
            """, new { h = h.Id, key }, t);
        if (prev is not { } p) return null;
        if (!CryptographicOperations.FixedTimeEquals(p.RequestHash, requestHash)) return new BookingResult(409, "IDEMPOTENCY_MISMATCH");
        if (clock.GetUtcNow() - new DateTimeOffset(DateTime.SpecifyKind(p.CreatedAt, DateTimeKind.Utc)) > IdempotencyReplayWindow)
            return new BookingResult(409, "IDEMPOTENCY_EXPIRED");
        var slot = new DateTimeOffset(DateTime.SpecifyKind(p.SlotStart, DateTimeKind.Utc));
        return new BookingResult(200, Body: Confirmation(h, p.Id, p.Ref, slot, Zone(h.Timezone), (p.NameAr, p.NameEn, p.NameTr)));
    }

    private object Confirmation(PublicHospital h, string id, string reference, DateTimeOffset slotStart, TimeZoneInfo tz, (string NameAr, string? NameEn, string? NameTr) dep)
    {
        var local = TimeZoneInfo.ConvertTime(slotStart, tz);
        return new
        {
            @ref = reference,
            qr = QrToken(id),
            slotStart,
            localDate = local.ToString("yyyy-MM-dd"),
            localTime = local.ToString("HH:mm"),
            department = new { ar = dep.NameAr, en = dep.NameEn, tr = dep.NameTr },
            hospital = new { ar = h.NameAr, en = h.NameEn, tr = h.NameTr },
        };
    }

    public sealed record FormChoice(string? Id, FormSchemaDoc? Doc, string? Error, string? CurrentId);

    /// <summary>The form version a booking is validated against.</summary>
    public static async Task<FormChoice> ResolveFormAsync(NpgsqlConnection c, NpgsqlTransaction t, string hospitalId, string? requested, DateTimeOffset now)
    {
        var active = await c.QuerySingleOrDefaultAsync<(string Id, int Version, string Schema)?>("""
            SELECT v.id, v.version, v.schema_json::text FROM hospital_active_form a JOIN form_versions v ON v.id = a.form_version_id
            WHERE a.hospital_id = @hospitalId
            """, new { hospitalId }, t);
        if (requested is null)
            return active is null ? new FormChoice(null, null, null, null) : new FormChoice(null, null, "FORM_UPDATED", active.Value.Id);
        if (active?.Id == requested) return new FormChoice(requested, FormEndpoints.Parse(active.Value.Schema), null, null);
        // An older version stays valid for 2 hours after the next version was published.
        var old = await c.QuerySingleOrDefaultAsync<(int Version, string Schema, DateTime? SupersededAt)?>("""
            SELECT v.version, v.schema_json::text,
                   (SELECT min(n.published_at) FROM form_versions n WHERE n.hospital_id = v.hospital_id AND n.version > v.version) AS superseded_at
            FROM form_versions v WHERE v.id = @requested AND v.hospital_id = @hospitalId
            """, new { requested, hospitalId }, t);
        if (old is { SupersededAt: { } at } o && now - new DateTimeOffset(DateTime.SpecifyKind(at, DateTimeKind.Utc)) <= OldFormGrace)
            return new FormChoice(requested, FormEndpoints.Parse(o.Schema), null, null);
        return new FormChoice(null, null, "FORM_UPDATED", active?.Id);
    }
}
