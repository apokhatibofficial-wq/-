namespace MedLink.Api.Hospitals;

/// <summary>IANA time zones. "Today" and the no-show grace period are computed in the hospital's zone.</summary>
public static class Timezones
{
    public static bool IsValid(string? id) =>
        !string.IsNullOrWhiteSpace(id) && id.Length <= 64 && (id == "UTC" || id.Contains('/'))
        && TimeZoneInfo.TryFindSystemTimeZoneById(id, out _);
}
