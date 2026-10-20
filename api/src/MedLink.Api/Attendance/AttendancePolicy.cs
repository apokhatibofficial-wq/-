namespace MedLink.Api.Attendance;

public sealed record AttendanceEvent(string Type, string Source, DateTimeOffset At, DateTimeOffset ReceivedAt);

public sealed record AttendanceState(string Status, DateTimeOffset? ArrivedAt, bool NeedsReview);

/// <summary>
/// The approved conflict policy (README decisions). Status is always derived from all events:
/// <list type="bullet">
/// <item>A manual correction beats every QR, reception and automatic event. If corrections disagree,
/// the latest received wins and the booking is flagged for review.</item>
/// <item>Otherwise the earliest "arrived" wins, and "arrived" beats an automatic "no-show".</item>
/// <item>No event is ever deleted.</item>
/// </list>
/// </summary>
public static class AttendancePolicy
{
    public static AttendanceState Derive(IReadOnlyCollection<AttendanceEvent> events)
    {
        var corrections = events.Where(e => e.Source == "correction").OrderBy(e => e.ReceivedAt).ToList();
        if (corrections.Count > 0)
        {
            var winner = corrections[^1];
            var conflict = corrections.Select(c => c.Type).Distinct().Count() > 1;
            return new AttendanceState(winner.Type, winner.Type == "arrived" ? winner.At : null, conflict);
        }
        var arrivals = events.Where(e => e.Type == "arrived").ToList();
        if (arrivals.Count > 0) return new AttendanceState("arrived", arrivals.Min(e => e.At), false);
        if (events.Any(e => e.Type == "no_show" && e.Source == "auto")) return new AttendanceState("no_show", null, false);
        return new AttendanceState("waiting", null, false);
    }
}
