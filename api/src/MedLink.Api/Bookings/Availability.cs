namespace MedLink.Api.Bookings;

public sealed record Block(int Weekday, int StartMin, int EndMin, int SlotMinutes, int Capacity);

public sealed record Slot(DateTimeOffset StartUtc, string LocalTime, int Capacity, int Free);

/// <summary>Status: "open", "full" (every slot taken) or "closed" (no hours, a closure, or nothing left today).</summary>
public sealed record Day(DateOnly Date, string Status, List<Slot> Slots)
{
    public int Open => Slots.Count(s => s.Free > 0);
}

/// <summary>
/// Turns weekly timetables into bookable slots. All times are wall-clock times in the hospital's own
/// time zone; "today" is the hospital's today. The booking window counts today as day 1; slots that start
/// sooner than the minimum notice are not offered.
/// </summary>
public static class Availability
{
    public static List<Day> Compute(TimeZoneInfo tz, DateTimeOffset now, int windowDays, int minNoticeMin,
        IReadOnlyCollection<Block> blocks, IReadOnlySet<DateOnly> closedDays, IReadOnlyDictionary<DateTimeOffset, int> booked)
    {
        var today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(now, tz).DateTime);
        var days = new List<Day>(windowDays);
        for (var i = 0; i < windowDays; i++)
            days.Add(ComputeDay(tz, now, today.AddDays(i), minNoticeMin, blocks, closedDays, booked));
        return days;
    }

    public static Day ComputeDay(TimeZoneInfo tz, DateTimeOffset now, DateOnly date, int minNoticeMin,
        IReadOnlyCollection<Block> blocks, IReadOnlySet<DateOnly> closedDays, IReadOnlyDictionary<DateTimeOffset, int> booked)
    {
        if (closedDays.Contains(date)) return new Day(date, "closed", []);
        var todays = blocks.Where(b => b.Weekday == (int)date.DayOfWeek).OrderBy(b => b.StartMin).ToList();
        if (todays.Count == 0) return new Day(date, "closed", []);

        var earliest = now.AddMinutes(minNoticeMin);
        var slots = new List<Slot>();
        var anyInTime = false;
        foreach (var b in todays)
        {
            for (var m = b.StartMin; m + b.SlotMinutes <= b.EndMin; m += b.SlotMinutes)
            {
                var local = date.ToDateTime(TimeOnly.MinValue).AddMinutes(m);
                if (tz.IsInvalidTime(local)) continue; // skipped by a daylight-saving change
                var utc = new DateTimeOffset(TimeZoneInfo.ConvertTimeToUtc(DateTime.SpecifyKind(local, DateTimeKind.Unspecified), tz), TimeSpan.Zero);
                if (utc < earliest) continue;
                anyInTime = true;
                var free = b.Capacity - booked.GetValueOrDefault(utc);
                if (free > 0) slots.Add(new Slot(utc, $"{m / 60:00}:{m % 60:00}", b.Capacity, free));
            }
        }
        if (!anyInTime) return new Day(date, "closed", []);
        return new Day(date, slots.Count == 0 ? "full" : "open", slots);
    }
}
