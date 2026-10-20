using MedLink.Api.Attendance;

namespace MedLink.Api.Tests;

public sealed class AttendancePolicyTests
{
    private static readonly DateTimeOffset T0 = new(2026, 10, 20, 9, 0, 0, TimeSpan.Zero);
    private static AttendanceEvent E(string type, string source, int atMin, int receivedMin) => new(type, source, T0.AddMinutes(atMin), T0.AddMinutes(receivedMin));

    [Fact(DisplayName = "Policy: no events = waiting")]
    public void Empty() => Assert.Equal(new AttendanceState("waiting", null, false), AttendancePolicy.Derive([]));

    [Fact(DisplayName = "Policy: the earliest arrival wins, whatever order the events were received in")]
    public void EarliestArrived() =>
        Assert.Equal(new AttendanceState("arrived", T0.AddMinutes(3), false),
            AttendancePolicy.Derive([E("arrived", "qr", 10, 11), E("arrived", "reception", 3, 40), E("arrived", "reception", 7, 12)]));

    [Fact(DisplayName = "Policy: an offline arrival received after the automatic no-show still wins")]
    public void ArrivedBeatsAutoNoShow() =>
        Assert.Equal(new AttendanceState("arrived", T0.AddMinutes(5), false),
            AttendancePolicy.Derive([E("no_show", "auto", 30, 30), E("arrived", "reception", 5, 90)]));

    [Fact(DisplayName = "Policy: an automatic no-show alone = no-show")]
    public void AutoNoShow() => Assert.Equal("no_show", AttendancePolicy.Derive([E("no_show", "auto", 30, 30)]).Status);

    [Fact(DisplayName = "Policy: a correction beats QR, reception and automatic events")]
    public void CorrectionWins()
    {
        Assert.Equal(new AttendanceState("no_show", null, false),
            AttendancePolicy.Derive([E("arrived", "qr", 1, 1), E("no_show", "correction", 60, 60), E("arrived", "reception", 2, 70)]));
        Assert.Equal(new AttendanceState("waiting", null, false),
            AttendancePolicy.Derive([E("no_show", "auto", 30, 30), E("waiting", "correction", 50, 50)]));
    }

    [Fact(DisplayName = "Policy: conflicting corrections — the latest received wins and the booking needs review")]
    public void ConflictingCorrections()
    {
        Assert.Equal(new AttendanceState("arrived", T0.AddMinutes(100), true),
            AttendancePolicy.Derive([E("arrived", "correction", 100, 120), E("no_show", "correction", 110, 115)]));
        // Agreeing corrections are not a conflict.
        Assert.False(AttendancePolicy.Derive([E("no_show", "correction", 1, 1), E("no_show", "correction", 2, 2)]).NeedsReview);
    }
}
