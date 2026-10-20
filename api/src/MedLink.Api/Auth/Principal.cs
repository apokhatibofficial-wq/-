using MedLink.Api.Data;

namespace MedLink.Api.Auth;

/// <summary>The authenticated caller, built only from the server-side session row.</summary>
public sealed record Principal(
    string SessionId,
    string UserId,
    string Email,
    string Scope,
    string? HospitalId,
    string[] Roles,
    string Client,
    bool ViaCookie)
{
    public bool IsCompany => Scope == "company";
    public bool IsHospital => Scope == "hospital";

    /// <summary>RLS context for this caller. The hospital ID always comes from the session.</summary>
    public DbScope DbScope => IsCompany ? DbScope.Company : DbScope.Hospital(HospitalId!);

    public bool Has(Permission p) => PermissionMatrix.Has(Roles, p);
}

public static class PrincipalHttpExtensions
{
    private const string Key = "medlink.principal";
    public static Principal? GetPrincipal(this HttpContext ctx) => ctx.Items[Key] as Principal;
    public static void SetPrincipal(this HttpContext ctx, Principal p) => ctx.Items[Key] = p;
    public static Principal RequirePrincipal(this HttpContext ctx) =>
        ctx.GetPrincipal() ?? throw new InvalidOperationException("endpoint is missing an authorization filter");
}
