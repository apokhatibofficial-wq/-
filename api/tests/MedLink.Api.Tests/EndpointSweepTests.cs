using System.Net;
using MedLink.Api.Auth;
using MedLink.Api.Tests.Infrastructure;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.Routing.Patterns;
using Microsoft.Extensions.DependencyInjection;

namespace MedLink.Api.Tests;

[Collection("medlink")]
public sealed class EndpointSweepTests(MedLinkFixture fx) : IDisposable
{
    private readonly TestApi api = new(fx);
    public void Dispose() => api.Dispose();

    private sealed record Ep(string Method, string Pattern, string Path, Permission? Permission, bool SignIn);

    private List<Ep> Endpoints()
    {
        _ = api.Anonymous(); // starts the server
        var source = api.Factory.Services.GetRequiredService<EndpointDataSource>();
        var list = new List<Ep>();
        foreach (var e in source.Endpoints.OfType<RouteEndpoint>())
        {
            var methods = e.Metadata.GetMetadata<HttpMethodMetadata>()?.HttpMethods ?? ["GET"];
            var pattern = "/" + string.Join("/", e.RoutePattern.PathSegments.Select(s => string.Concat(s.Parts.Select(p => p switch
            {
                RoutePatternLiteralPart l => l.Content,
                RoutePatternParameterPart q => "{" + q.Name + "}",
                _ => "",
            }))));
            var path = "/" + string.Join("/", e.RoutePattern.PathSegments.Select(s => string.Concat(s.Parts.Select(p => p switch
            {
                RoutePatternLiteralPart l => l.Content,
                RoutePatternParameterPart => "1", // also matches {version:int}
                _ => "",
            }))));
            foreach (var m in methods)
                list.Add(new Ep(m, pattern, path, e.Metadata.GetMetadata<PermissionRequired>()?.Permission, e.Metadata.GetMetadata<SignInRequired>() is not null));
        }
        return list;
    }

    /// <summary>The only endpoints anyone may call without signing in. A new public endpoint fails this test until it is reviewed and added.</summary>
    private static readonly string[] Public =
    [
        "GET /health",
        "POST /auth/login", "POST /auth/link/inspect", "POST /auth/link/complete",
        "GET /public/book/{slug}", "GET /public/slugs/{slug}",
        "GET /public/hospitals/{slug}/form", "GET /public/hospitals/{slug}/availability", "POST /public/hospitals/{slug}/bookings",
    ];

    private static string Key(Ep e) => e.Method + " " + e.Pattern;

    private static Task<(HttpStatusCode Status, System.Text.Json.JsonElement Body)> Call(ApiClient c, Ep e, object? body = null) =>
        c.SendAsync(new HttpMethod(e.Method), e.Path, e.Method is "POST" or "PUT" or "PATCH" ? body ?? new { } : null);

    [Fact(DisplayName = "Acceptance 25: every endpoint declares who may call it; only the reviewed public ones are open")]
    public void EveryEndpointDeclaresAccess()
    {
        var eps = Endpoints();
        Assert.True(eps.Count >= 61, $"only {eps.Count} endpoints found");
        foreach (var e in eps)
        {
            var isPublic = Public.Contains(Key(e));
            Assert.True(isPublic || e.Permission is not null || e.SignIn, $"{Key(e)} has no access rule");
            // The session middleware skips public paths, so a rule there would never see a user, and vice versa.
            Assert.True(isPublic == MedLink.Api.Auth.HttpAuth.IsAnonymousPath(e.Path), $"{Key(e)}: public list and middleware disagree");
        }
        Assert.Equal(Public.Order(), eps.Where(e => Public.Contains(Key(e))).Select(Key).Order());
    }

    [Fact(DisplayName = "Acceptance 2: without signing in, every non-public endpoint answers 401 and does nothing")]
    public async Task AnonymousIsRefusedEverywhere()
    {
        var anon = api.Anonymous();
        var auditBefore = await AuditCountAsync();
        var checkedCount = 0;
        foreach (var e in Endpoints().Where(e => !Public.Contains(Key(e))))
        {
            var r = await Call(anon, e);
            Assert.True(r.Status == HttpStatusCode.Unauthorized, $"{Key(e)} answered {(int)r.Status} without a session");
            checkedCount++;
        }
        Assert.Equal(52, checkedCount);
        Assert.Equal(auditBefore, await AuditCountAsync());
    }

    [Fact(DisplayName = "Acceptance 25: every role is refused (403) on every endpoint whose permission it lacks, company and hospital alike")]
    public async Task EveryRoleWithoutThePermissionIsRefused()
    {
        var (owner, _) = await api.CompanyUserAsync(Roles.Owner);
        var clients = new Dictionary<string, ApiClient> { [Roles.Owner] = owner };
        foreach (var role in new[] { Roles.Support, Roles.Viewer }) clients[role] = (await api.CompanyUserAsync(role)).Client;
        var h = await BookingSetup.CreateAsync(api, owner);
        clients[Roles.HospAdmin] = h.Admin;
        foreach (var role in new[] { Roles.Reception, Roles.Scanner }) clients[role] = (await api.StaffAsync(h.Admin, role)).Client;
        var docEmail = TestApi.NewEmail("doc");
        var inv = await h.Admin.Post("/hospital/users", new { email = docEmail, role = Roles.Doctor, departmentIds = new[] { h.DepartmentId } });
        var (pw, secret) = await api.CompleteLinkAsync(CapturingEmailSender.TokenFrom(fx.Email.LastTo(docEmail)));
        clients[Roles.Doctor] = await api.SignInAsync(new TestUser(inv.Body.GetProperty("id").GetString()!, docEmail, pw, secret));
        var auditBefore = await AuditCountAsync();

        var refused = 0;
        foreach (var e in Endpoints().Where(e => e.Permission is not null))
            foreach (var (role, client) in clients.Where(c => !PermissionMatrix.Has([c.Key], e.Permission!.Value)))
            {
                var r = await Call(client, e);
                Assert.True(r.Status == HttpStatusCode.Forbidden, $"{role} on {Key(e)} (needs {e.Permission}) answered {(int)r.Status}");
                refused++;
            }

        // Signed-in endpoints that check the permission inside: the roles that must be refused.
        var company = new[] { Roles.Owner, Roles.Support, Roles.Viewer };
        var inside = new (string Key, object? Body, string[] Refused)[]
        {
            ("GET /admin/audit", null, [Roles.Viewer, Roles.HospAdmin, Roles.Reception, Roles.Scanner, Roles.Doctor]),
            ("POST /hospital/bookings/{id}/attendance", new { type = "arrived" }, [.. company, Roles.Doctor]),
            ("POST /hospital/bookings/{id}/attendance", new { type = "arrived", reason = "تصحيح للاختبار" }, [.. company, Roles.Scanner, Roles.Doctor]),
            ("GET /sync/pull", null, [.. company, Roles.Scanner]),
            ("POST /sync/push", new { deviceId = "1", events = Array.Empty<object>() }, company),
        };
        var all = Endpoints();
        foreach (var (key, body, roles) in inside)
        {
            var e = Assert.Single(all, x => Key(x) == key);
            Assert.True(e.SignIn);
            foreach (var role in roles)
            {
                var r = await Call(clients[role], e, body);
                Assert.True(r.Status == HttpStatusCode.Forbidden, $"{role} on {key} answered {(int)r.Status}");
                refused++;
            }
        }
        Console.WriteLine($"refused {refused} calls");
        Assert.True(refused > 200, $"only {refused} refusals checked");
        Assert.Equal(auditBefore, await AuditCountAsync());
    }

    private async Task<long> AuditCountAsync()
    {
        await using var db = await fx.OwnerAsync();
        return await Dapper.SqlMapper.ExecuteScalarAsync<long>(db, "SELECT count(*) FROM audit_log");
    }
}
