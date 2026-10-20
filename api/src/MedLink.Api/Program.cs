using System.Net;
using System.Threading.RateLimiting;
using MedLink.Api.Auth;
using MedLink.Api.Config;
using MedLink.Api.Data;
using MedLink.Api.Email;
using MedLink.Api.Endpoints;
using MedLink.Api.Security;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.HttpOverrides;
using Npgsql;

// ---------------------------------------------------------------- CLI commands
// medlink migrate                        apply SQL migrations (as the DB owner)
// medlink bootstrap-admin --email <addr> create the first company owner and print a single-use setup link
if (args.Length > 0 && args[0] is "migrate" or "bootstrap-admin")
    return await Cli.RunAsync(args);

var builder = WebApplication.CreateBuilder(args);
var options = MedLinkOptions.FromConfiguration(builder.Configuration);
builder.Services.AddMedLink(options);

var app = builder.Build();
app.UseMedLink(options);
app.Run();
return 0;

public partial class Program;

public static class Startup
{
    public static IServiceCollection AddMedLink(this IServiceCollection services, MedLinkOptions options)
    {
        services.AddSingleton(options);
        services.AddSingleton(TimeProvider.System);
        services.AddSingleton(_ => new NpgsqlDataSourceBuilder(options.AppConnectionString).Build());
        services.AddSingleton<Db>();
        services.AddSingleton<PasswordHasher>();
        services.AddSingleton<TotpService>();
        services.AddSingleton<AuthService>();
        services.AddSingleton<IEmailSender, SmtpEmailSender>();
        services.AddProblemDetails();

        var dp = services.AddDataProtection().SetApplicationName("medlink");
        if (!string.IsNullOrEmpty(options.DataProtectionKeysPath))
            dp.PersistKeysToFileSystem(new DirectoryInfo(options.DataProtectionKeysPath));

        services.Configure<ForwardedHeadersOptions>(f =>
        {
            f.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
            f.ForwardLimit = 1;
            f.KnownProxies.Clear();
            f.KnownNetworks.Clear();
            foreach (var entry in options.TrustedProxies)
            {
                if (entry.Contains('/'))
                {
                    var parts = entry.Split('/');
                    f.KnownNetworks.Add(new Microsoft.AspNetCore.HttpOverrides.IPNetwork(IPAddress.Parse(parts[0]), int.Parse(parts[1])));
                }
                else f.KnownProxies.Add(IPAddress.Parse(entry));
            }
        });

        services.AddCors(c => c.AddDefaultPolicy(p => p
            .WithOrigins(options.CorsOrigins)
            .AllowCredentials()
            .WithHeaders("Content-Type", HttpAuth.CsrfHeader, "Authorization")
            .WithMethods("GET", "POST", "PATCH")));

        services.AddRateLimiter(r =>
        {
            r.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
            r.OnRejected = (ctx, _) =>
            {
                ctx.HttpContext.Response.ContentType = "application/json";
                return new ValueTask(ctx.HttpContext.Response.WriteAsync("{\"error\":\"RATE_LIMITED\"}"));
            };
            // Applies to /auth/*: per client IP and per /24 network (BACKEND-SPEC §3).
            r.GlobalLimiter = PartitionedRateLimiter.CreateChained(
                PartitionedRateLimiter.Create<HttpContext, string>(ctx => AuthPartition(ctx, options.AuthRatePerIp, net24: false)),
                PartitionedRateLimiter.Create<HttpContext, string>(ctx => AuthPartition(ctx, options.AuthRatePerNet24, net24: true)));
        });
        return services;
    }

    private static RateLimitPartition<string> AuthPartition(HttpContext ctx, int perMinute, bool net24)
    {
        if (!ctx.Request.Path.StartsWithSegments("/auth") || HttpMethods.IsGet(ctx.Request.Method))
            return RateLimitPartition.GetNoLimiter("none");
        var ip = ctx.Connection.RemoteIpAddress;
        string key;
        if (ip is null) key = "unknown";
        else if (net24 && ip.MapToIPv4() is { } v4 && (ip.IsIPv4MappedToIPv6 || ip.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork))
        {
            var b = v4.GetAddressBytes();
            key = $"{b[0]}.{b[1]}.{b[2]}.0/24";
        }
        else key = ip.ToString();
        return RateLimitPartition.GetSlidingWindowLimiter((net24 ? "n:" : "i:") + key, _ => new SlidingWindowRateLimiterOptions
        {
            PermitLimit = perMinute,
            Window = TimeSpan.FromMinutes(1),
            SegmentsPerWindow = 6,
            QueueLimit = 0,
        });
    }

    public static WebApplication UseMedLink(this WebApplication app, MedLinkOptions options)
    {
        app.UseForwardedHeaders();
        app.UseExceptionHandler(e => e.Run(async ctx =>
        {
            ctx.Response.StatusCode = 500;
            await ctx.Response.WriteAsJsonAsync(new { error = "INTERNAL", requestId = ctx.TraceIdentifier });
        }));
        app.Use(async (ctx, next) =>
        {
            var h = ctx.Response.Headers;
            h["X-Content-Type-Options"] = "nosniff";
            h["Referrer-Policy"] = "no-referrer";
            h["Cache-Control"] = "no-store";
            h["X-Frame-Options"] = "DENY";
            await next(ctx);
        });
        app.UseCors();
        app.Use(HttpAuth.Middleware);
        app.UseRateLimiter();

        app.MapGet("/health", async (Db db) =>
        {
            await db.RunAsync(DbScope.System, (c, t) => Dapper.SqlMapper.ExecuteScalarAsync<int>(c, "SELECT 1", transaction: t));
            return Results.Json(new { status = "ok" });
        });
        app.MapAuth();
        app.MapAdmin();
        app.MapHospital();
        app.MapPublic();
        return app;
    }
}

internal static class Cli
{
    public static async Task<int> RunAsync(string[] args)
    {
        var config = new ConfigurationBuilder().AddEnvironmentVariables().Build();
        try
        {
            if (args[0] == "migrate")
            {
                var o = MedLinkOptions.FromConfiguration(config, requireApp: false, requireOwner: true);
                var applied = await Migrator.MigrateAsync(o.OwnerConnectionString, o.AppDbPassword, Console.Out);
                Console.WriteLine(applied.Count == 0 ? "database is up to date" : $"{applied.Count} migration(s) applied");
                return 0;
            }

            var i = Array.IndexOf(args, "--email");
            var email = i >= 0 && i + 1 < args.Length ? args[i + 1].Trim() : null;
            if (string.IsNullOrEmpty(email) || !email.Contains('@') || email.Length > 254)
            {
                Console.Error.WriteLine("usage: medlink bootstrap-admin --email <owner email>");
                return 2;
            }
            var opts = MedLinkOptions.FromConfiguration(config);
            await using var ds = new NpgsqlDataSourceBuilder(opts.AppConnectionString).Build();
            var auth = new AuthService(new Db(ds), new PasswordHasher(), new TotpService(opts), opts, TimeProvider.System);
            var url = await auth.BootstrapAdminAsync(email);
            // Printed to this terminal only. It is never written to a log file and expires in 30 minutes.
            Console.WriteLine("Company owner created. Open this single-use setup link within 30 minutes to set a password and 2FA:");
            Console.WriteLine(url);
            return 0;
        }
        catch (InvalidOperationException e)
        {
            Console.Error.WriteLine("error: " + e.Message);
            return 1;
        }
    }
}
