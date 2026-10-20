using System.Net;
using System.Text.Json;

namespace MedLink.Api.Tests.Infrastructure;

/// <summary>A hospital with one department open every day 00:00–24:00 in 30-minute slots.</summary>
public sealed record BookingHospital(string HospitalId, string Slug, string DepartmentId, ApiClient Admin, TestUser AdminUser);

public static class BookingSetup
{
    public static async Task<BookingHospital> CreateAsync(TestApi api, ApiClient owner, int capacity = 1, int slotMinutes = 30)
    {
        var (hid, slug, adminUser, admin) = await api.HospitalAsync(owner);
        var dep = await admin.Post("/hospital/departments", new { nameAr = "الباطنية", nameEn = "Internal medicine" });
        Assert.Equal(HttpStatusCode.Created, dep.Status);
        var depId = dep.Body.GetProperty("id").GetString()!;
        var blocks = Enumerable.Range(0, 7).Select(w => new { weekday = w, start = "00:00", end = "24:00", slotMinutes, capacity }).ToArray();
        Assert.Equal(HttpStatusCode.OK, (await admin.Put($"/hospital/departments/{depId}/schedules", new { blocks })).Status);
        return new BookingHospital(hid, slug, depId, admin, adminUser);
    }

    public static async Task<JsonElement> AvailabilityAsync(ApiClient anon, BookingHospital h)
    {
        var r = await anon.Get($"/public/hospitals/{h.Slug}/availability?departmentId={h.DepartmentId}");
        Assert.Equal(HttpStatusCode.OK, r.Status);
        return r.Body;
    }

    /// <summary>The n-th bookable slot start (ISO) from the public availability.</summary>
    public static async Task<string> SlotAsync(ApiClient anon, BookingHospital h, int dayIndex = 1, int slotIndex = 0)
    {
        var av = await AvailabilityAsync(anon, h);
        return av.GetProperty("days")[dayIndex].GetProperty("slots")[slotIndex].GetProperty("start").GetString()!;
    }

    public static Task<(HttpStatusCode Status, JsonElement Body)> BookAsync(TestApi api, BookingHospital h, string slot, string? key = null,
        object? answers = null, string? formVersionId = null, string name = "مريض اختبار", string? phone = null)
    {
        var c = api.Anonymous();
        return c.SendWithHeaderAsync(HttpMethod.Post, $"/public/hospitals/{h.Slug}/bookings",
            new { departmentId = h.DepartmentId, slotStart = slot, patientName = name, phone, formVersionId, answers },
            "Idempotency-Key", key ?? Guid.NewGuid().ToString("N"));
    }
}
