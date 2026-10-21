using System.Text.Json;

namespace MedLink.App;

/// <summary>
/// Non-secret settings of this PC (%LOCALAPPDATA%\MEDLINK\settings.json): language, device name and id, the server
/// address and the last hospital name (only used in the forgot-password WhatsApp message). The server address is set
/// at installation (or with --server) and is shown read-only in the app, so nobody can point it at another server.
/// </summary>
public sealed class AppSettings
{
    public const string DefaultServer = "https://api.medlink.website";

    public Lang Language { get; set; } = Lang.Ar;
    public string Server { get; set; } = DefaultServer;
    public string? DeviceId { get; set; }
    public string? DeviceName { get; set; }
    public string? LastEmail { get; set; }
    public string? LastHospital { get; set; }

    private static readonly JsonSerializerOptions Json = new() { WriteIndented = true };

    public static AppSettings Load(string path)
    {
        try { return File.Exists(path) ? JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(path)) ?? new() : new(); }
        catch (Exception e) when (e is JsonException or IOException) { return new(); }
    }

    public void Save(string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, JsonSerializer.Serialize(this, Json));
    }
}
