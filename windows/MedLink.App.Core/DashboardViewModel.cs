using System.Globalization;
using MedLink.Sync;

namespace MedLink.App;

public sealed record BookingRow(string Id, string Ref, string Time, string Patient, string Department, string Status, string StatusLabel,
    bool Pending, bool CanCheckIn, bool NeedsReview, string CheckinTime);

public sealed record FilterChip(string Key, string Label, int Count, bool Selected);

public sealed record DepartmentOption(string Id, string Name);

public sealed record Fact(string Label, string Value);

public sealed record HistoryItem(string Time, string Text, bool Pending);

public sealed record CorrectionTarget(string Status, string Label, bool Selected);

/// <summary>
/// The appointments dashboard (SCREENS.md §3): ‹ Today › with the date, search by name or booking number within the
/// day's local list, status chips with counts, a department filter, the table and the detail panel. Check-in and
/// corrections go through the outbox, so they work offline too; the server applies the approved conflict policy.
/// </summary>
public sealed class DashboardViewModel : Observable
{
    private readonly MainViewModel _m;
    private string _date = "", _search = "", _filter = "all", _department = "", _reason = "", _reasonError = "", _target = "";
    private IReadOnlyList<LocalBooking> _day = [];
    private LocalBooking? _selected;

    internal DashboardViewModel(MainViewModel m)
    {
        _m = m;
        PrevCommand = new Command(() => Date = Shift(Date, -1));
        NextCommand = new Command(() => Date = Shift(Date, 1));
        TodayCommand = new Command(() => Date = _m.Sync.Today());
        FilterCommand = new Command(p => Filter = Convert.ToString(p, CultureInfo.InvariantCulture) ?? "all");
        SelectCommand = new Command(p => Select(p as BookingRow));
        CloseDetailCommand = new Command(() => Select(null));
        CheckInCommand = new Command(p => CheckIn((p as BookingRow)?.Ref ?? _selected?.Ref));
        TargetCommand = new Command(p => Target = Convert.ToString(p, CultureInfo.InvariantCulture) ?? "");
        SaveCorrectionCommand = new Command(SaveCorrection);
    }

    private Strings S => _m.S;

    // ------------------------------------------------------------------ toolbar and filters
    public string Date { get => _date; set { if (Set(ref _date, value)) { Select(null); Reload(); } } }
    public bool IsToday => Date == _m.Sync.Today();
    public string DateLabel => DayName(Date);
    public string Search { get => _search; set { if (Set(ref _search, value)) Rebuild(); } }
    public string Filter { get => _filter; set { if (Set(ref _filter, value)) Rebuild(); } }
    public string DepartmentId { get => _department; set { if (Set(ref _department, value ?? "")) Rebuild(); } }
    public IReadOnlyList<DepartmentOption> Departments =>
        [new("", S.AllDepts), .. _m.Store.Departments().Select(d => new DepartmentOption(d.Id, Name(d)))];
    public IReadOnlyList<FilterChip> Chips { get; private set; } = [];
    public IReadOnlyList<BookingRow> Rows { get; private set; } = [];
    public bool IsEmpty => Rows.Count == 0;
    public int Grace => int.TryParse(_m.Store.Get("no_show_grace_min"), out var g) ? g : 30;
    public string GraceNote => S.Grace(Grace);
    public bool ShowReadOnlyNote => _m.IsDoctor;

    public Command PrevCommand { get; }
    public Command NextCommand { get; }
    public Command TodayCommand { get; }
    public Command FilterCommand { get; }
    public Command SelectCommand { get; }
    public Command CloseDetailCommand { get; }
    public Command CheckInCommand { get; }
    public Command TargetCommand { get; }
    public Command SaveCorrectionCommand { get; }

    internal void Reload()
    {
        if (_date.Length == 0) _date = _m.Sync.Today();
        _day = _m.Store.Day(_date);
        if (_selected is not null) _selected = _m.Store.ById(_selected.Id);
        Rebuild();
    }

    private void Rebuild()
    {
        var q = Search.Trim();
        IEnumerable<LocalBooking> scope = _day;
        if (DepartmentId.Length > 0) scope = scope.Where(b => b.DepartmentId == DepartmentId);
        if (q.Length > 0)
            scope = scope.Where(b => b.Ref.Contains(q, StringComparison.OrdinalIgnoreCase)
                || (b.PatientName?.Contains(q, StringComparison.CurrentCultureIgnoreCase) ?? false));
        var list = scope.ToList();
        Chips =
        [
            new("all", S.All, list.Count, Filter == "all"),
            new("waiting", S.Waiting, list.Count(b => b.Status == "waiting"), Filter == "waiting"),
            new("arrived", S.Arrived, list.Count(b => b.Status == "arrived"), Filter == "arrived"),
            new("no_show", S.NoShow, list.Count(b => b.Status == "no_show"), Filter == "no_show"),
        ];
        var deps = _m.Store.Departments().ToDictionary(d => d.Id, Name);
        Rows = list.Where(b => Filter == "all" || b.Status == Filter)
            .Select(b => new BookingRow(b.Id, b.Ref, b.LocalTime, b.PatientName ?? "—", deps.GetValueOrDefault(b.DepartmentId, ""),
                b.Status, S.StatusLabel(b.Status), b.PendingSync, CanCheckInNow(b), b.NeedsReview,
                b.Status == "arrived" && b.ArrivedAt is { } a ? Clock(a) : "—"))
            .ToList();
        RaiseAll();
    }

    private bool CanCheckInNow(LocalBooking b) => _m.CanCheckIn && b.Status == "waiting" && b.LocalDate == _m.Sync.Today();

    // ------------------------------------------------------------------ detail panel
    public bool HasSelection => _selected is not null;
    public string DName => _selected?.PatientName ?? "—";
    public string DRef => _selected?.Ref ?? "";
    public string DStatus => _selected?.Status ?? "";
    public string DStatusLabel => _selected is null ? "" : S.StatusLabel(_selected.Status);
    public string DSource => _selected?.StatusSource is { } src ? S.Src.GetValueOrDefault(src, "") : "";
    public bool DPending => _selected?.PendingSync ?? false;
    public string DPendingTip => S.PendingTip;
    public bool DNeedsReview => _selected?.NeedsReview ?? false;
    public string DNeedsReviewText => S.NeedsReview;
    public IReadOnlyList<Fact> DFacts => _selected is not { } b ? [] :
    [
        // Doctors' PCs never receive phone numbers, so the line is simply absent.
        .. b.Phone is { } p ? new[] { new Fact(S.Phone, p) } : [],
        new(S.Date, b.LocalDate + " " + b.LocalTime),
        new(S.Dept, _m.Store.Departments().FirstOrDefault(d => d.Id == b.DepartmentId) is { } d ? Name(d) : ""),
    ];
    public bool DCanCheckIn => _selected is { } b && CanCheckInNow(b);
    public bool DCanCorrect => _m.CanCorrect && _selected is { Status: not "cancelled" };
    public IReadOnlyList<CorrectionTarget> DTargets => _selected is not { } b ? [] :
        new[] { "arrived", "no_show", "waiting" }.Where(s => s != b.Status).Select(s => new CorrectionTarget(s, S.StatusLabel(s), s == Target)).ToList();
    public string Target { get => _target; set { if (Set(ref _target, value)) Raise(nameof(DTargets)); } }
    public string Reason { get => _reason; set { if (Set(ref _reason, value)) ReasonError = ""; } }
    public string ReasonError { get => _reasonError; private set => Set(ref _reasonError, value); }
    public IReadOnlyList<HistoryItem> DHistory => _selected is { } b ? History(b) : [];

    public void Select(BookingRow? row)
    {
        _selected = row is null ? null : _m.Store.ById(row.Id);
        Reason = ""; ReasonError = "";
        _target = _selected is null ? "" : _selected.Status == "arrived" ? "no_show" : "arrived";
        RaiseAll();
    }

    /// <summary>Shows a booking found on the Find page, on its own day.</summary>
    internal void Open(LocalBooking b)
    {
        _search = ""; _filter = "all"; _department = "";
        _date = b.LocalDate;
        Reload();
        Select(Rows.FirstOrDefault(r => r.Id == b.Id));
    }

    private void CheckIn(string? reference)
    {
        if (reference is null || !_m.CanCheckIn) return;
        var r = _m.Sync.CheckInByRef(reference);
        if (r == CheckInResult.PendingSync) _m.Notify(S.CheckedIn);
        else if (r == CheckInResult.NotToday) _m.Notify(S.NotToday);
        _m.LocalChange();
    }

    private void SaveCorrection()
    {
        if (_selected is null || !_m.CanCorrect) return;
        var r = _m.Sync.Correct(_selected.Id, Target, Reason);
        if (r == CorrectionResult.ReasonRequired) { ReasonError = S.ReasonMin; return; }
        if (r != CorrectionResult.PendingSync) return;
        Reason = "";
        _m.Notify(S.CorrSaved);
        _m.LocalChange();
    }

    private IReadOnlyList<HistoryItem> History(LocalBooking b)
    {
        var items = new List<HistoryItem>();
        if (b.BookedAt is { } at) items.Add(new(Stamp(at, b.LocalDate), S.HBooked, false));
        string Text(LocalEvent e) => e.Source switch
        {
            "correction" => S.HCorr(S.StatusLabel(e.Type), e.Reason ?? ""),
            "auto" => S.HAuto(Grace),
            "qr" => S.HQr,
            _ => S.HRec,
        };
        items.AddRange((b.Events ?? []).Select(e => new HistoryItem(Stamp(e.At, b.LocalDate), Text(e), false)));
        items.AddRange((b.Pending ?? []).Select(e => new HistoryItem(Stamp(e.At, b.LocalDate), Text(e), true)));
        return items;
    }

    // ------------------------------------------------------------------ formatting (hospital time zone)
    private TimeZoneInfo Zone => TimeZoneInfo.FindSystemTimeZoneById(_m.Store.Get("timezone") ?? "Asia/Damascus");

    public string Clock(DateTimeOffset t) => TimeZoneInfo.ConvertTime(t, Zone).ToString("HH:mm", CultureInfo.InvariantCulture);
    public string DateTime(DateTimeOffset t) => TimeZoneInfo.ConvertTime(t, Zone).ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture);

    private string Stamp(DateTimeOffset t, string bookingDate)
    {
        var local = TimeZoneInfo.ConvertTime(t, Zone);
        var day = local.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        return day == bookingDate ? local.ToString("HH:mm", CultureInfo.InvariantCulture) : local.ToString("MM-dd HH:mm", CultureInfo.InvariantCulture);
    }

    private string Name(LocalStore.LocalDepartment d) => _m.App.Lang switch
    {
        Lang.En => d.NameEn ?? d.NameAr,
        Lang.Tr => d.NameTr ?? d.NameEn ?? d.NameAr,
        _ => d.NameAr,
    };

    private static string Shift(string date, int days) =>
        DateOnly.ParseExact(date, "yyyy-MM-dd", CultureInfo.InvariantCulture).AddDays(days).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    /// <summary>"Tuesday, 20 October" in the app language, Gregorian calendar, Latin digits (as on the web).</summary>
    private string DayName(string date)
    {
        if (date.Length == 0) return "";
        var d = DateOnly.ParseExact(date, "yyyy-MM-dd", CultureInfo.InvariantCulture).ToDateTime(TimeOnly.MinValue);
        return d.ToString("dddd، d MMMM".Replace("،", _m.App.Lang == Lang.Ar ? "،" : ","), Culture(_m.App.Lang));
    }

    internal static CultureInfo Culture(Lang l)
    {
        var c = (CultureInfo)CultureInfo.GetCultureInfo(l switch { Lang.En => "en-GB", Lang.Tr => "tr-TR", _ => "ar-SY" }).Clone();
        if (c.DateTimeFormat.Calendar is not GregorianCalendar)
        {
            var greg = c.OptionalCalendars.OfType<GregorianCalendar>().FirstOrDefault();
            if (greg is not null) c.DateTimeFormat.Calendar = greg;
        }
        return c;
    }
}
