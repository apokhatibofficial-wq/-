using System.Net;
using Dapper;
using MedLink.Api.Auth;
using MedLink.Api.Tests.Infrastructure;
using Npgsql;

namespace MedLink.Api.Tests;

[Collection("medlink")]
public sealed class HospitalManagementTests(MedLinkFixture fx) : IDisposable
{
    private readonly TestApi api = new(fx);
    public void Dispose() => api.Dispose();

    [Fact(DisplayName = "Hospital admin invites reception and scanner staff; they activate without 2FA by default and get only their permissions")]
    public async Task StaffInviteAndPermissions()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var (_, _, _, admin) = await api.HospitalAsync(owner);

        var (reception, recUser) = await api.StaffAsync(admin, Roles.Reception);
        var (scanner, _) = await api.StaffAsync(admin, Roles.Scanner);
        Assert.Null(recUser.TotpSecret); // optional for staff unless the hospital requires it

        // Only reception and scanner roles can be given by a hospital admin.
        foreach (var role in new[] { Roles.HospAdmin, Roles.Owner, "superuser" })
            Assert.Equal((HttpStatusCode)422, (await admin.Post("/hospital/users", new { email = TestApi.NewEmail("x"), role })).Status);

        // Staff can read their hospital and departments, but cannot change settings or manage users.
        foreach (var c in new[] { reception, scanner })
        {
            Assert.Equal(HttpStatusCode.OK, (await c.Get("/hospital/me")).Status);
            Assert.Equal(HttpStatusCode.OK, (await c.Get("/hospital/departments")).Status);
            Assert.Equal(HttpStatusCode.Forbidden, (await c.Patch("/hospital/settings", new { noShowGraceMin = 10 })).Status);
            Assert.Equal(HttpStatusCode.Forbidden, (await c.Post("/hospital/departments", new { nameAr = "قسم" })).Status);
            Assert.Equal(HttpStatusCode.Forbidden, (await c.Get("/hospital/users")).Status);
            Assert.Equal(HttpStatusCode.Forbidden, (await c.Post("/hospital/users", new { email = TestApi.NewEmail("y"), role = Roles.Scanner })).Status);
        }

        var list = await admin.Get("/hospital/users");
        Assert.Equal(3, list.Body.GetProperty("users").GetArrayLength());
    }

    [Fact(DisplayName = "Changing a staff role or disabling the account revokes sessions; admins cannot change themselves or other admins")]
    public async Task StaffChanges()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var (_, _, adminUser, admin) = await api.HospitalAsync(owner);
        var (reception, recUser) = await api.StaffAsync(admin, Roles.Reception);

        Assert.Equal(HttpStatusCode.OK, (await admin.Patch($"/hospital/users/{recUser.Id}", new { role = Roles.Scanner })).Status);
        Assert.Equal(HttpStatusCode.Unauthorized, (await reception.Get("/hospital/me")).Status);
        var again = await api.SignInAsync(recUser);
        var me = await again.Get("/auth/me");
        Assert.Equal(Roles.Scanner, me.Body.GetProperty("user").GetProperty("roles")[0].GetString());

        Assert.Equal(HttpStatusCode.OK, (await admin.Patch($"/hospital/users/{recUser.Id}", new { disabled = true })).Status);
        Assert.Equal(HttpStatusCode.Unauthorized, (await again.Get("/hospital/me")).Status);
        Assert.Equal(HttpStatusCode.Unauthorized, (await api.Anonymous().LoginAsync(recUser.Email, recUser.Password, null)).Status);
        Assert.Equal(HttpStatusCode.OK, (await admin.Patch($"/hospital/users/{recUser.Id}", new { disabled = false })).Status);
        await api.SignInAsync(recUser);

        Assert.Equal(HttpStatusCode.Conflict, (await admin.Patch($"/hospital/users/{adminUser.Id}", new { disabled = true })).Status);
        var (_, _, otherAdminUser, _) = await api.HospitalAsync(owner);
        Assert.Equal(HttpStatusCode.NotFound, (await admin.Patch($"/hospital/users/{otherAdminUser.Id}", new { disabled = true })).Status);
        Assert.Equal(HttpStatusCode.NotFound, (await admin.Post($"/hospital/users/{otherAdminUser.Id}/send-link", new { })).Status);
    }

    [Fact(DisplayName = "Send-link gives a pending user a new activation link and an active user a reset link")]
    public async Task StaffLinks()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var (_, _, _, admin) = await api.HospitalAsync(owner);
        var email = TestApi.NewEmail("pending");
        var inv = await admin.Post("/hospital/users", new { email, role = Roles.Scanner });
        var id = inv.Body.GetProperty("id").GetString();
        var first = CapturingEmailSender.TokenFrom(fx.Email.LastTo(email));
        fx.Secrets.Add(first);
        Assert.Equal(HttpStatusCode.OK, (await admin.Post($"/hospital/users/{id}/send-link", new { })).Status);
        var mail = fx.Email.LastTo(email);
        Assert.Equal("activation", mail.Kind);
        // The first link was cancelled by the new one.
        Assert.Equal(HttpStatusCode.Gone, (await api.Anonymous().Post("/auth/link/inspect", new { token = first }, csrf: false)).Status);
        await api.CompleteLinkAsync(CapturingEmailSender.TokenFrom(mail));
        Assert.Equal(HttpStatusCode.OK, (await admin.Post($"/hospital/users/{id}/send-link", new { })).Status);
        Assert.Equal("reset", fx.Email.LastTo(email).Kind);
    }

    [Fact(DisplayName = "When the hospital requires staff 2FA, new staff must enrol and staff without 2FA are told to get a reset link")]
    public async Task StaffTotpPolicy()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var (_, _, _, admin) = await api.HospitalAsync(owner);
        var (_, before) = await api.StaffAsync(admin, Roles.Reception);

        Assert.Equal(HttpStatusCode.OK, (await admin.Patch("/hospital/settings", new { staffTotpRequired = true })).Status);
        var login = await api.Anonymous().LoginAsync(before.Email, before.Password, null);
        Assert.Equal(HttpStatusCode.Forbidden, login.Status);
        Assert.Equal("MFA_NOT_ENROLLED", login.Body.GetProperty("error").GetString());

        var (_, after) = await api.StaffAsync(admin, Roles.Scanner);
        Assert.NotNull(after.TotpSecret);
    }

    [Fact(DisplayName = "Hospital settings: validated ranges and real IANA time zones, recorded in the audit log")]
    public async Task Settings()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var (hid, _, _, admin) = await api.HospitalAsync(owner);
        Assert.Equal((HttpStatusCode)422, (await admin.Patch("/hospital/settings", new { noShowGraceMin = 999 })).Status);
        Assert.Equal((HttpStatusCode)422, (await admin.Patch("/hospital/settings", new { retentionMonths = 0 })).Status);
        Assert.Equal((HttpStatusCode)422, (await admin.Patch("/hospital/settings", new { timezone = "Mars/Olympus" })).Status);
        Assert.Equal(HttpStatusCode.OK, (await admin.Patch("/hospital/settings", new { noShowGraceMin = 45, retentionMonths = 36, timezone = "Africa/Tripoli" })).Status);
        var me = await admin.Get("/hospital/me");
        Assert.Equal(45, me.Body.GetProperty("noShowGraceMin").GetInt32());
        Assert.Equal(36, me.Body.GetProperty("retentionMonths").GetInt32());
        Assert.Equal("Africa/Tripoli", me.Body.GetProperty("timezone").GetString());
        await using var db = await fx.OwnerAsync();
        Assert.Equal(1, await db.ExecuteScalarAsync<int>("SELECT count(*) FROM audit_log WHERE hospital_id = @hid AND action = 'hospital_settings'", new { hid }));
    }

    [Fact(DisplayName = "Departments and weekly schedules: validation, overlap rejected by the database, deactivate instead of delete")]
    public async Task DepartmentsAndSchedules()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var (_, slug, _, admin) = await api.HospitalAsync(owner);

        Assert.Equal((HttpStatusCode)422, (await admin.Post("/hospital/departments", new { nameAr = "  " })).Status);
        var dep = await admin.Post("/hospital/departments", new { nameAr = "الباطنية", nameEn = "Internal medicine", nameTr = "Dahiliye" });
        Assert.Equal(HttpStatusCode.Created, dep.Status);
        var depId = dep.Body.GetProperty("id").GetString();
        Assert.Equal(HttpStatusCode.Conflict, (await admin.Post("/hospital/departments", new { nameAr = "الباطنية " })).Status);
        var dep2 = (await admin.Post("/hospital/departments", new { nameAr = "الأطفال", nameEn = "Paediatrics" })).Body.GetProperty("id").GetString();

        var ok = await admin.Put($"/hospital/departments/{depId}/schedules", new
        {
            blocks = new object[]
            {
                new { weekday = 0, start = "08:00", end = "12:00", slotMinutes = 15, capacity = 2 },
                new { weekday = 0, start = "13:00", end = "16:00", slotMinutes = 20, capacity = 1 },
                new { weekday = 2, start = "09:00", end = "24:00", slotMinutes = 30, capacity = 3 },
            },
        });
        Assert.Equal(HttpStatusCode.OK, ok.Status);

        var overlap = await admin.Put($"/hospital/departments/{depId}/schedules", new
        {
            blocks = new object[]
            {
                new { weekday = 1, start = "08:00", end = "12:00", slotMinutes = 15, capacity = 2 },
                new { weekday = 1, start = "11:30", end = "14:00", slotMinutes = 15, capacity = 2 },
            },
        });
        Assert.Equal(HttpStatusCode.Conflict, overlap.Status);
        Assert.Equal("SCHEDULE_OVERLAP", overlap.Body.GetProperty("error").GetString());

        foreach (var bad in new object[]
                 {
                     new { weekday = 7, start = "08:00", end = "12:00", slotMinutes = 15, capacity = 1 },
                     new { weekday = 1, start = "12:00", end = "08:00", slotMinutes = 15, capacity = 1 },
                     new { weekday = 1, start = "8:00", end = "12:00", slotMinutes = 15, capacity = 1 },
                     new { weekday = 1, start = "08:00", end = "08:10", slotMinutes = 15, capacity = 1 },
                     new { weekday = 1, start = "08:00", end = "12:00", slotMinutes = 15, capacity = 0 },
                 })
            Assert.Equal((HttpStatusCode)422, (await admin.Put($"/hospital/departments/{depId}/schedules", new { blocks = new[] { bad } })).Status);

        // The failed requests changed nothing: the first timetable is still there.
        var list = await admin.Get("/hospital/departments");
        var d = list.Body.GetProperty("departments").EnumerateArray().Single(x => x.GetProperty("id").GetString() == depId);
        Assert.Equal(3, d.GetProperty("schedules").GetArrayLength());
        Assert.Equal("24:00", d.GetProperty("schedules")[2].GetProperty("end").GetString());

        // Public link shows only active departments.
        Assert.Equal(HttpStatusCode.OK, (await admin.Patch($"/hospital/departments/{dep2}", new { active = false })).Status);
        var pub = await api.Anonymous().Get($"/public/book/{slug}");
        var names = pub.Body.GetProperty("departments").EnumerateArray().Select(x => x.GetProperty("name").GetProperty("ar").GetString()).ToList();
        Assert.Equal(new[] { "الباطنية" }, names);
    }

    [Fact(DisplayName = "Closures: one per day per department (or whole hospital), and only for the session's hospital")]
    public async Task Closures()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var (_, _, _, a) = await api.HospitalAsync(owner);
        var (_, _, _, b) = await api.HospitalAsync(owner);
        var bDep = (await b.Post("/hospital/departments", new { nameAr = "قسم ب" })).Body.GetProperty("id").GetString();
        var date = DateTime.UtcNow.AddDays(10).ToString("yyyy-MM-dd");

        var c1 = await a.Post("/hospital/closures", new { date, reason = "عطلة رسمية" });
        Assert.Equal(HttpStatusCode.Created, c1.Status);
        Assert.Equal(HttpStatusCode.Conflict, (await a.Post("/hospital/closures", new { date })).Status);
        Assert.Equal((HttpStatusCode)422, (await a.Post("/hospital/closures", new { date = "2026-13-40" })).Status);
        // Hospital A cannot attach a closure to hospital B's department, nor delete B's closures.
        Assert.Equal(HttpStatusCode.NotFound, (await a.Post("/hospital/closures", new { date, departmentId = bDep })).Status);
        var bClosure = (await b.Post("/hospital/closures", new { date })).Body.GetProperty("id").GetString();
        Assert.Equal(HttpStatusCode.NotFound, (await a.Delete($"/hospital/closures/{bClosure}")).Status);
        Assert.Single((await a.Get("/hospital/closures")).Body.GetProperty("closures").EnumerateArray());
        Assert.Equal(HttpStatusCode.OK, (await a.Delete($"/hospital/closures/{c1.Body.GetProperty("id").GetString()}")).Status);
    }

    [Fact(DisplayName = "RLS also isolates departments, schedules and closures, and the DB rejects cross-hospital links")]
    public async Task RlsNewTables()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var (aId, _, _, a) = await api.HospitalAsync(owner);
        var (bId, _, _, b) = await api.HospitalAsync(owner);
        var bDep = (await b.Post("/hospital/departments", new { nameAr = "قسم ب" })).Body.GetProperty("id").GetString();
        await b.Put($"/hospital/departments/{bDep}/schedules", new { blocks = new[] { new { weekday = 1, start = "08:00", end = "10:00", slotMinutes = 30, capacity = 1 } } });
        await b.Post("/hospital/closures", new { date = DateTime.UtcNow.AddDays(3).ToString("yyyy-MM-dd") });
        _ = a;

        await using var app = await fx.AppAsync();
        await using var tx = await app.BeginTransactionAsync();
        await app.ExecuteAsync("SELECT set_config('app.scope', 'hospital', true), set_config('app.hospital_id', @aId, true)", new { aId }, tx);
        foreach (var table in new[] { "departments", "schedules", "closures" })
            Assert.Equal(0, await app.ExecuteScalarAsync<int>($"SELECT count(*) FROM {table} WHERE hospital_id = @bId", new { bId }, tx));
        await app.ExecuteAsync("SAVEPOINT s", transaction: tx);
        var ex = await Assert.ThrowsAsync<PostgresException>(() => app.ExecuteAsync(
            "INSERT INTO departments (id, hospital_id, name_ar) VALUES ('dep_01ARZ3NDEKTSV4RRFFQ69G5FAV', @bId, 'x')", new { bId }, tx));
        Assert.Equal(PostgresErrorCodes.InsufficientPrivilege, ex.SqlState);
        await app.ExecuteAsync("ROLLBACK TO SAVEPOINT s", transaction: tx);
        // A schedule in A pointing at B's department is refused by the trigger.
        var ex2 = await Assert.ThrowsAsync<PostgresException>(() => app.ExecuteAsync("""
            INSERT INTO schedules (id, hospital_id, department_id, weekday, start_min, end_min, slot_minutes, capacity)
            VALUES ('sch_01ARZ3NDEKTSV4RRFFQ69G5FAV', @aId, @bDep, 1, 600, 700, 30, 1)
            """, new { aId, bDep }, tx));
        Assert.Equal(PostgresErrorCodes.ForeignKeyViolation, ex2.SqlState);
        await tx.RollbackAsync();
    }
}
