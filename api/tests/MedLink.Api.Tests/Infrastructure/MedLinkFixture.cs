using System.Collections.Concurrent;
using System.Security.Cryptography;
using MedLink.Api.Data;
using MedLink.Api.Email;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using Npgsql;
using Testcontainers.PostgreSql;

namespace MedLink.Api.Tests.Infrastructure;

/// <summary>
/// One disposable PostgreSQL 16 container per test run. Every credential is generated at runtime with
/// RandomNumberGenerator and lives only in this process; nothing is committed, printed or reused.
/// </summary>
public sealed class MedLinkFixture : IAsyncLifetime
{
    public static readonly string Image = Environment.GetEnvironmentVariable("MEDLINK_TEST_PG_IMAGE") ?? "postgres:16-alpine";

    private readonly string _ownerPassword = Secret();
    private readonly string _appPassword = Secret();
    private PostgreSqlContainer _pg = null!;

    public CapturingEmailSender Email { get; } = new();
    public LogCapture Logs { get; } = new();
    public string OwnerConnectionString { get; private set; } = "";
    public string AppConnectionString { get; private set; } = "";

    /// <summary>Every password and token the tests create, so the log test can look for them.</summary>
    public ConcurrentBag<string> Secrets { get; } = new();

    public static string Secret() => Convert.ToBase64String(RandomNumberGenerator.GetBytes(36));

    public async Task InitializeAsync()
    {
        _pg = new PostgreSqlBuilder(Image)
            .WithDatabase("medlink")
            .WithUsername("medlink_owner")
            .WithPassword(_ownerPassword)
            .Build();
        await _pg.StartAsync();
        OwnerConnectionString = _pg.GetConnectionString();
        await Migrator.MigrateAsync(OwnerConnectionString, _appPassword);
        AppConnectionString = new NpgsqlConnectionStringBuilder(OwnerConnectionString) { Username = "medlink_app", Password = _appPassword }.ConnectionString;
        Secrets.Add(_ownerPassword);
        Secrets.Add(_appPassword);
    }

    public Task DisposeAsync() => _pg.DisposeAsync().AsTask();

    public Dictionary<string, string?> Settings(int authRate = 10_000, int scanRate = 10_000)
    {
        var b = new NpgsqlConnectionStringBuilder(OwnerConnectionString);
        var signing = Secret() + Secret();
        var totp = Secret() + Secret();
        Secrets.Add(signing);
        Secrets.Add(totp);
        return new()
        {
            ["DB_HOST"] = b.Host,
            ["DB_PORT"] = b.Port.ToString(),
            ["DB_NAME"] = b.Database,
            ["DB_APP_PASSWORD"] = _appPassword,
            ["SESSION_SIGNING_KEY"] = signing,
            ["TOTP_ENC_KEY"] = totp,
            ["SMTP_HOST"] = "localhost",
            ["EMAIL_FROM"] = "MEDLINK <no-reply@medlink.website>",
            ["ADMIN_WEB_URL"] = "https://admin.medlink.website",
            ["HOSPITAL_WEB_URL"] = "https://app.medlink.website",
            ["AUTH_RATE_PER_IP_PER_MIN"] = authRate.ToString(),
            ["AUTH_RATE_PER_NET24_PER_MIN"] = authRate.ToString(),
            ["BOOKING_RATE_PER_IP_PER_MIN"] = authRate.ToString(),
            ["BOOKING_RATE_PER_HOSPITAL_PER_MIN"] = authRate.ToString(),
            ["SCAN_RATE_PER_IP_PER_MIN"] = scanRate.ToString(),
        };
    }

    private static readonly object EnvLock = new();

    /// <summary>
    /// Program reads configuration from environment variables at startup, so the factory is started
    /// while those variables are set and they are cleared again straight after.
    /// </summary>
    public WebApplicationFactory<Program> CreateFactory(int authRate = 10_000, int scanRate = 10_000)
    {
        lock (EnvLock)
        {
            var settings = Settings(authRate, scanRate);
            foreach (var (k, v) in settings) Environment.SetEnvironmentVariable(k, v);
            try
            {
                var f = new WebApplicationFactory<Program>().WithWebHostBuilder(w =>
                {
                    w.UseEnvironment("Production");
                    // Provider-specific rule: the capture sees everything down to Trace, whatever appsettings.json filters.
                    w.ConfigureLogging(l => l.AddProvider(Logs).AddFilter<LogCapture>(null, LogLevel.Trace));
                    w.ConfigureServices(s =>
                    {
                        s.RemoveAll<IEmailSender>();
                        s.AddSingleton<IEmailSender>(Email);
                    });
                });
                f.Server.PreserveExecutionContext = true;
                _ = f.Server; // start now, while the environment is set
                return f;
            }
            finally
            {
                foreach (var k in settings.Keys) Environment.SetEnvironmentVariable(k, null);
            }
        }
    }

    public async Task<NpgsqlConnection> OwnerAsync()
    {
        var c = new NpgsqlConnection(OwnerConnectionString);
        await c.OpenAsync();
        return c;
    }

    public async Task<NpgsqlConnection> AppAsync()
    {
        var c = new NpgsqlConnection(AppConnectionString);
        await c.OpenAsync();
        return c;
    }
}

[CollectionDefinition("medlink")]
public sealed class MedLinkCollection : ICollectionFixture<MedLinkFixture>;

public sealed class CapturingEmailSender : IEmailSender
{
    public ConcurrentQueue<EmailMessage> Sent { get; } = new();

    public Task SendAsync(EmailMessage message, CancellationToken ct = default)
    {
        Sent.Enqueue(message);
        return Task.CompletedTask;
    }

    public EmailMessage LastTo(string to) => Sent.Last(m => string.Equals(m.To, to, StringComparison.OrdinalIgnoreCase));

    public static string TokenFrom(EmailMessage m)
    {
        var url = m.TextBody.Split('\n').Select(l => l.Trim()).Single(l => l.StartsWith("https://"));
        return url[(url.IndexOf("#t=", StringComparison.Ordinal) + 3)..];
    }
}

public sealed class LogCapture : ILoggerProvider
{
    public ConcurrentQueue<string> Lines { get; } = new();
    public ILogger CreateLogger(string categoryName) => new L(this, categoryName);
    public void Dispose() { }

    private sealed class L(LogCapture owner, string category) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            var values = state is IEnumerable<KeyValuePair<string, object?>> kv ? string.Join(" ", kv.Select(x => $"{x.Key}={x.Value}")) : "";
            owner.Lines.Enqueue($"{logLevel} {category} {formatter(state, exception)} {values} {exception}");
        }
    }
}
