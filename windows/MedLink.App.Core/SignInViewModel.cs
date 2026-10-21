namespace MedLink.App;

/// <summary>
/// Sign-in (SCREENS.md §3): connection pill, email + password (Show/Hide, Caps Lock warning), a 6-digit code step for
/// accounts with 2FA, generic errors that never say which field was wrong, the server's lockout message, sign-in
/// disabled while offline, and the forgot-password WhatsApp dialog.
/// </summary>
public sealed class SignInViewModel : Observable
{
    public const string SupportWhatsApp = "4368181700732";
    private readonly AppController _app;
    private string _email = "", _password = "", _totp = "", _error = "", _info = "";
    private bool _online = true, _busy, _needTotp, _showPassword, _forgotOpen, _connOpen;
    private string? _connResult;

    public SignInViewModel(AppController app)
    {
        _app = app;
        _email = app.Settings.LastEmail ?? "";
        SubmitCommand = new Command(() => _ = SubmitAsync(), () => CanSubmit);
        BackCommand = new Command(() => { NeedTotp = false; Totp = ""; Error = ""; });
        ForgotCommand = new Command(() => ForgotOpen = true);
        CloseForgotCommand = new Command(() => ForgotOpen = false);
        OpenWhatsAppCommand = new Command(OpenWhatsApp);
        ToggleShowCommand = new Command(() => ShowPassword = !ShowPassword);
        ConnSettingsCommand = new Command(() => { ConnResult = null; ConnOpen = true; });
        CloseConnCommand = new Command(() => ConnOpen = false);
        TestConnectionCommand = new Command(() => _ = TestAsync());
    }

    public Strings S => _app.S;
    public string Email { get => _email; set { if (Set(ref _email, value)) Changed(); } }
    public string Password { get => _password; set { if (Set(ref _password, value)) Changed(); } }
    public string Totp { get => _totp; set { if (Set(ref _totp, new string(value.Where(char.IsAsciiDigit).Take(6).ToArray()))) Changed(); } }
    public string Error { get => _error; private set => Set(ref _error, value); }
    /// <summary>A notice shown above the form (session ended, device revoked).</summary>
    public string Info { get => _info; private set => Set(ref _info, value); }
    public bool Online { get => _online; private set { if (Set(ref _online, value)) { Raise(nameof(ConnectionText)); Changed(); } } }
    public string ConnectionText => Online ? S.Online : S.Offline;
    public bool Busy { get => _busy; private set { if (Set(ref _busy, value)) { Raise(nameof(SubmitText)); Changed(); } } }
    public string SubmitText => Busy ? S.Submitting : NeedTotp ? S.Verify : S.Submit;
    public bool NeedTotp { get => _needTotp; private set { if (Set(ref _needTotp, value)) { Raise(nameof(SubmitText)); Changed(); } } }
    public bool ShowPassword { get => _showPassword; private set { if (Set(ref _showPassword, value)) Raise(nameof(ShowText)); } }
    public string ShowText => ShowPassword ? S.Hide : S.Show;
    public bool ForgotOpen { get => _forgotOpen; private set => Set(ref _forgotOpen, value); }
    public bool ConnOpen { get => _connOpen; private set => Set(ref _connOpen, value); }
    public string? ConnResult { get => _connResult; private set => Set(ref _connResult, value); }
    public string Server => _app.Settings.Server;
    public string Version => _app.Version;
    /// <summary>The prepared WhatsApp message: username and hospital only (never a password or code).</summary>
    public string WhatsAppMessage => S.WaMsg(Email.Trim(), _app.Settings.LastHospital ?? "");

    public bool CanSubmit => Online && !Busy && (NeedTotp ? Totp.Length == 6 : Email.Trim().Length > 3 && Password.Length > 0);

    public Command SubmitCommand { get; }
    public Command BackCommand { get; }
    public Command ForgotCommand { get; }
    public Command CloseForgotCommand { get; }
    public Command OpenWhatsAppCommand { get; }
    public Command ToggleShowCommand { get; }
    public Command ConnSettingsCommand { get; }
    public Command CloseConnCommand { get; }
    public Command TestConnectionCommand { get; }

    private void Changed()
    {
        Raise(nameof(CanSubmit));
        Raise(nameof(WhatsAppMessage));
        SubmitCommand.Refresh();
    }

    internal void LanguageChanged() { RaiseAll(); SubmitCommand.Refresh(); }

    internal void Reset(string? message)
    {
        Password = ""; Totp = ""; NeedTotp = false; Error = ""; Info = message ?? "";
        Email = _app.Settings.LastEmail ?? Email;
    }

    public async Task CheckConnectionAsync() => Online = await _app.Auth.PingAsync();

    private async Task TestAsync()
    {
        ConnResult = null;
        var ok = await _app.Auth.PingAsync();
        _app.Ui.Post(() => { Online = ok; ConnResult = ok ? S.ConnOk : S.ConnFail; });
    }

    public async Task SubmitAsync()
    {
        if (!CanSubmit) return;
        Busy = true; Error = ""; Info = "";
        try
        {
            var r = await _app.Auth.LoginAsync(Email, Password, NeedTotp ? Totp : null);
            switch (r.Status)
            {
                case LoginStatus.Ok:
                    var err = await _app.OpenAsync(r.Token!, r.User!, _app.Settings.LastHospital);
                    if (err is not null) { Error = err; NeedTotp = false; }
                    Password = ""; Totp = "";
                    break;
                case LoginStatus.NeedTotp: NeedTotp = true; break;
                case LoginStatus.Locked: Error = S.ErrLocked; NeedTotp = false; break;
                case LoginStatus.RateLimited: Error = S.ErrRate; break;
                case LoginStatus.MfaNotEnrolled: Error = S.ErrMfaNotEnrolled; break;
                case LoginStatus.Suspended: Error = S.ErrSuspended; break;
                case LoginStatus.Offline: Error = S.ErrNetwork; Online = false; break;
                case LoginStatus.Invalid:
                    // Never says which field was wrong. A wrong 2FA code also lands here.
                    Error = S.ErrBad; Totp = "";
                    break;
                default: Error = S.ErrGeneric; break;
            }
        }
        finally { Busy = false; }
    }

    private void OpenWhatsApp() =>
        _app.Launcher.Open("https://wa.me/" + SupportWhatsApp + "?text=" + Uri.EscapeDataString(WhatsAppMessage));
}
