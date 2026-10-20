using System.Globalization;
using System.Security.Cryptography;
using Microsoft.Data.Sqlite;

namespace MedLink.Sync;

public sealed record LocalBooking(string Id, string Ref, string DepartmentId, DateTimeOffset SlotStart, string LocalDate, string LocalTime,
    string? PatientName, string? Phone, string Status, DateTimeOffset? ArrivedAt, bool NeedsReview, bool PendingSync);

public sealed record OutboxEvent(Guid ClientEventId, string? BookingId, string? Ref, string Type, string Source, DateTimeOffset At,
    string? Reason, int Attempts, DateTimeOffset NextAttemptAt);

/// <summary>
/// The Windows app's local copy: bookings from yesterday to +30 days, departments, the sync cursor and an outbox of
/// attendance events not yet accepted by the server. The file is encrypted with SQLCipher; its random 256-bit key is
/// stored next to it, protected by <see cref="IKeyProtector"/> (DPAPI on Windows). The local copy is a cache for the
/// screen and for offline check-in only; it is never used to decide permissions.
/// </summary>
public sealed class LocalStore : IDisposable
{
    private readonly SqliteConnection _c;

    static LocalStore() => SQLitePCL.Batteries_V2.Init();

    private LocalStore(SqliteConnection c) => _c = c;

    public static LocalStore Open(string path, IKeyProtector protector)
    {
        var keyPath = path + ".key";
        byte[] key;
        if (File.Exists(keyPath)) key = protector.Unprotect(File.ReadAllBytes(keyPath));
        else
        {
            if (File.Exists(path)) throw new InvalidOperationException("Local database exists without its key.");
            key = RandomNumberGenerator.GetBytes(32);
            File.WriteAllBytes(keyPath, protector.Protect(key));
        }
        return OpenWithKey(path, key);
    }

    /// <summary>Opens with a raw key. Throws <see cref="SqliteException"/> if the key is wrong.</summary>
    public static LocalStore OpenWithKey(string path, byte[] key)
    {
        var c = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = path, Pooling = false }.ToString());
        c.Open();
        try
        {
            // A raw hex key skips SQLCipher's password-derivation step: the key is already random.
            Exec(c, $"PRAGMA key = \"x'{Convert.ToHexString(key)}'\";");
            Exec(c, "SELECT count(*) FROM sqlite_master;"); // fails here if the key is wrong
            Exec(c, """
                PRAGMA journal_mode = WAL;
                CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS departments (id TEXT PRIMARY KEY, name_ar TEXT NOT NULL, name_en TEXT, name_tr TEXT, active INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS bookings (
                  id TEXT PRIMARY KEY, ref TEXT NOT NULL UNIQUE, department_id TEXT NOT NULL, slot_start TEXT NOT NULL,
                  local_date TEXT NOT NULL, local_time TEXT NOT NULL, patient_name TEXT, phone TEXT,
                  status TEXT NOT NULL, arrived_at TEXT, needs_review INTEGER NOT NULL, seq INTEGER NOT NULL);
                CREATE INDEX IF NOT EXISTS bookings_day ON bookings (local_date, local_time);
                CREATE TABLE IF NOT EXISTS outbox (
                  client_event_id TEXT PRIMARY KEY, booking_id TEXT, ref TEXT, type TEXT NOT NULL, source TEXT NOT NULL,
                  at TEXT NOT NULL, reason TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL,
                  state TEXT NOT NULL DEFAULT 'pending', last_code TEXT);
                """);
        }
        catch { c.Dispose(); throw; }
        return new LocalStore(c);
    }

    private static void Exec(SqliteConnection c, string sql, params (string, object?)[] args)
    {
        using var cmd = c.CreateCommand();
        cmd.CommandText = sql;
        foreach (var (n, v) in args) cmd.Parameters.AddWithValue(n, v ?? DBNull.Value);
        cmd.ExecuteNonQuery();
    }

    private void Exec(string sql, params (string, object?)[] args) => Exec(_c, sql, args);

    private static string Iso(DateTimeOffset d) => d.UtcDateTime.ToString("O", CultureInfo.InvariantCulture);
    private static DateTimeOffset ParseIso(string s) => DateTimeOffset.Parse(s, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal);

    // ------------------------------------------------------------------ meta
    public string? Get(string key)
    {
        using var cmd = _c.CreateCommand();
        cmd.CommandText = "SELECT v FROM meta WHERE k = $k";
        cmd.Parameters.AddWithValue("$k", key);
        return cmd.ExecuteScalar() as string;
    }

    public void Set(string key, string value) => Exec("INSERT INTO meta (k, v) VALUES ($k, $v) ON CONFLICT (k) DO UPDATE SET v = excluded.v", ("$k", key), ("$v", value));

    public long Cursor { get => long.Parse(Get("cursor") ?? "0", CultureInfo.InvariantCulture); set => Set("cursor", value.ToString(CultureInfo.InvariantCulture)); }

    // ------------------------------------------------------------------ bookings
    public void UpsertDepartment(string id, string nameAr, string? nameEn, string? nameTr, bool active) =>
        Exec("""
            INSERT INTO departments (id, name_ar, name_en, name_tr, active) VALUES ($id, $ar, $en, $tr, $a)
            ON CONFLICT (id) DO UPDATE SET name_ar = excluded.name_ar, name_en = excluded.name_en, name_tr = excluded.name_tr, active = excluded.active
            """, ("$id", id), ("$ar", nameAr), ("$en", nameEn), ("$tr", nameTr), ("$a", active ? 1 : 0));

    /// <summary>Stores the server's state of a booking. Only applied if newer than what is stored.</summary>
    public void UpsertBooking(LocalBooking b, long seq) =>
        Exec("""
            INSERT INTO bookings (id, ref, department_id, slot_start, local_date, local_time, patient_name, phone, status, arrived_at, needs_review, seq)
            VALUES ($id, $ref, $dep, $slot, $date, $time, $name, $phone, $status, $arrived, $review, $seq)
            ON CONFLICT (id) DO UPDATE SET ref = excluded.ref, department_id = excluded.department_id, slot_start = excluded.slot_start,
              local_date = excluded.local_date, local_time = excluded.local_time, patient_name = excluded.patient_name, phone = excluded.phone,
              status = excluded.status, arrived_at = excluded.arrived_at, needs_review = excluded.needs_review, seq = excluded.seq
            WHERE excluded.seq > bookings.seq
            """, ("$id", b.Id), ("$ref", b.Ref), ("$dep", b.DepartmentId), ("$slot", Iso(b.SlotStart)), ("$date", b.LocalDate), ("$time", b.LocalTime),
            ("$name", b.PatientName), ("$phone", b.Phone), ("$status", b.Status), ("$arrived", b.ArrivedAt is { } a ? Iso(a) : null),
            ("$review", b.NeedsReview ? 1 : 0), ("$seq", seq));

    /// <summary>Removes bookings outside the cache window (and with no pending event), so old personal data does not pile up.</summary>
    public int Prune(DateTimeOffset from, DateTimeOffset to)
    {
        using var cmd = _c.CreateCommand();
        cmd.CommandText = """
            DELETE FROM bookings WHERE (slot_start < $from OR slot_start >= $to)
              AND id NOT IN (SELECT booking_id FROM outbox WHERE state = 'pending' AND booking_id IS NOT NULL)
            """;
        cmd.Parameters.AddWithValue("$from", Iso(from));
        cmd.Parameters.AddWithValue("$to", Iso(to));
        return cmd.ExecuteNonQuery();
    }

    private const string BookingSelect = """
        SELECT b.id, b.ref, b.department_id, b.slot_start, b.local_date, b.local_time, b.patient_name, b.phone, b.status, b.arrived_at, b.needs_review,
               EXISTS (SELECT 1 FROM outbox o WHERE o.state = 'pending' AND (o.booking_id = b.id OR o.ref = b.ref)) AS pending
        FROM bookings b
        """;

    private static LocalBooking Read(SqliteDataReader r)
    {
        var pending = r.GetInt64(11) == 1;
        var status = r.GetString(8);
        // A check-in waiting in the outbox is shown as arrived, marked "pending sync".
        return new LocalBooking(r.GetString(0), r.GetString(1), r.GetString(2), ParseIso(r.GetString(3)), r.GetString(4), r.GetString(5),
            r.IsDBNull(6) ? null : r.GetString(6), r.IsDBNull(7) ? null : r.GetString(7), pending && status == "waiting" ? "arrived" : status,
            r.IsDBNull(9) ? null : ParseIso(r.GetString(9)), r.GetInt64(10) == 1, pending);
    }

    public IReadOnlyList<LocalBooking> Day(string localDate)
    {
        using var cmd = _c.CreateCommand();
        cmd.CommandText = BookingSelect + " WHERE b.local_date = $d ORDER BY b.local_time, b.ref";
        cmd.Parameters.AddWithValue("$d", localDate);
        using var r = cmd.ExecuteReader();
        var list = new List<LocalBooking>();
        while (r.Read()) list.Add(Read(r));
        return list;
    }

    public LocalBooking? ByRef(string reference)
    {
        using var cmd = _c.CreateCommand();
        cmd.CommandText = BookingSelect + " WHERE b.ref = $r";
        cmd.Parameters.AddWithValue("$r", reference);
        using var r = cmd.ExecuteReader();
        return r.Read() ? Read(r) : null;
    }

    public int BookingCount()
    {
        using var cmd = _c.CreateCommand();
        cmd.CommandText = "SELECT count(*) FROM bookings";
        return Convert.ToInt32(cmd.ExecuteScalar(), CultureInfo.InvariantCulture);
    }

    // ------------------------------------------------------------------ outbox
    public void Enqueue(Guid clientEventId, string? bookingId, string? reference, string type, string source, DateTimeOffset at, string? reason) =>
        Exec("INSERT INTO outbox (client_event_id, booking_id, ref, type, source, at, reason, next_attempt_at) VALUES ($id, $b, $r, $t, $s, $at, $reason, $at)",
            ("$id", clientEventId.ToString()), ("$b", bookingId), ("$r", reference), ("$t", type), ("$s", source), ("$at", Iso(at)), ("$reason", reason));

    public IReadOnlyList<OutboxEvent> DueEvents(DateTimeOffset now, int limit)
    {
        using var cmd = _c.CreateCommand();
        cmd.CommandText = """
            SELECT client_event_id, booking_id, ref, type, source, at, reason, attempts, next_attempt_at FROM outbox
            WHERE state = 'pending' AND next_attempt_at <= $now ORDER BY at LIMIT $limit
            """;
        cmd.Parameters.AddWithValue("$now", Iso(now));
        cmd.Parameters.AddWithValue("$limit", limit);
        using var r = cmd.ExecuteReader();
        var list = new List<OutboxEvent>();
        while (r.Read())
            list.Add(new OutboxEvent(Guid.Parse(r.GetString(0)), r.IsDBNull(1) ? null : r.GetString(1), r.IsDBNull(2) ? null : r.GetString(2),
                r.GetString(3), r.GetString(4), ParseIso(r.GetString(5)), r.IsDBNull(6) ? null : r.GetString(6), r.GetInt32(7), ParseIso(r.GetString(8))));
        return list;
    }

    public int PendingCount()
    {
        using var cmd = _c.CreateCommand();
        cmd.CommandText = "SELECT count(*) FROM outbox WHERE state = 'pending'";
        return Convert.ToInt32(cmd.ExecuteScalar(), CultureInfo.InvariantCulture);
    }

    /// <summary>The server answered (applied, duplicate or rejected): the event leaves the queue for good.</summary>
    public void Resolve(Guid clientEventId, string state, string? code) =>
        Exec("UPDATE outbox SET state = $s, last_code = $c WHERE client_event_id = $id", ("$s", state), ("$c", code), ("$id", clientEventId.ToString()));

    public IReadOnlyList<(Guid Id, string? Ref, string Code)> Rejected()
    {
        using var cmd = _c.CreateCommand();
        cmd.CommandText = "SELECT client_event_id, ref, last_code FROM outbox WHERE state = 'rejected' ORDER BY at";
        using var r = cmd.ExecuteReader();
        var list = new List<(Guid, string?, string)>();
        while (r.Read()) list.Add((Guid.Parse(r.GetString(0)), r.IsDBNull(1) ? null : r.GetString(1), r.IsDBNull(2) ? "" : r.GetString(2)));
        return list;
    }

    /// <summary>Network failure: try again later, with exponential backoff (2 s, 4 s, 8 s … capped at 5 minutes).</summary>
    public void Backoff(IEnumerable<Guid> ids, DateTimeOffset now)
    {
        foreach (var id in ids)
        {
            using var cmd = _c.CreateCommand();
            cmd.CommandText = "SELECT attempts FROM outbox WHERE client_event_id = $id";
            cmd.Parameters.AddWithValue("$id", id.ToString());
            var attempts = Convert.ToInt32(cmd.ExecuteScalar(), CultureInfo.InvariantCulture) + 1;
            var delay = TimeSpan.FromSeconds(Math.Min(300, Math.Pow(2, attempts)));
            Exec("UPDATE outbox SET attempts = $a, next_attempt_at = $n WHERE client_event_id = $id",
                ("$a", attempts), ("$n", Iso(now + delay)), ("$id", id.ToString()));
        }
    }

    public void Dispose() => _c.Dispose();
}
