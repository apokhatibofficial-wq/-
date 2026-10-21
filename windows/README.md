# MEDLINK Windows app

| Project | What it is | Runs on | Tested by |
|---|---|---|---|
| `MedLink.Sync` | Local database (SQLite + SQLCipher, key protected by DPAPI), outbox, pull/push | any .NET 8 | `api/tests/.../SyncClientTests.cs` against the real API |
| `MedLink.App.Core` | The app's logic: sign-in, saved session, per-user local copy, background sync, view models, strings | any .NET 8 | `api/tests/.../WindowsAppTests.cs` against the real API |
| `MedLink.Windows` | The WPF window (`MEDLINK.exe`): it only draws `MedLink.App.Core` | Windows 10/11 | CI job `windows-app` (`MEDLINK.exe --smoke`) |

## Running
```
dotnet run --project windows/MedLink.Windows -- --server https://api.medlink.website
```
- **Server address:** set at installation, or with `--server` (saved in `%LOCALAPPDATA%\MEDLINK\settings.json`). The app shows it read-only, so nobody can point it at another server from the screen.
- **Files:** everything lives in `%LOCALAPPDATA%\MEDLINK`.
  - `settings.json`: language, device id and name, last email and hospital name. Nothing secret.
  - `session.bin`: the session token, protected by DPAPI.
  - `local-<hash>.db` + `.key`: one SQLCipher database per MEDLINK user.

## Behaviour (owner's decisions)
- **Staying signed in:** the app stays signed in within the server's limits (12 hours idle, 7 days at most). The token is checked again at every start.
  - If the server is unreachable at start, the local copy opens, with the offline banner.
  - A revoked session or device goes back to sign-in, with a notice.
- **Doctors:** see their departments' appointments only, read-only, with no phone numbers. The server enforces this; the screen only follows it.
- **Offline check-in:** by booking number, kept as "pending sync" (⟳). It is sent automatically, and the server can still reject it (Sync page).
- **Signing out:**
  - With nothing pending, sign-out deletes that user's local copy.
  - With check-ins still unsent, the app warns first. The encrypted copy stays and is sent at that user's next sign-in.
- **Shared PCs:** all users of one PC share one registered device, but each user has their own local copy.

## Design
- Splash, sign-in and dashboard follow `docs/design/designs/Windows App.dc.html` and `SCREENS.md §3`. The design's text is used verbatim; extra strings follow its tone.
- **Logos:** the original SVG files, rendered unchanged with SharpVectors (BSD-3-Clause).
- **Fonts:** IBM Plex Sans Arabic (Latin included) and IBM Plex Mono, SIL Open Font License (`MedLink.Windows/Fonts/OFL.txt`).
- **Reduced motion:** follows Windows *Settings › Accessibility › Animation effects*.

## Not yet (later phases)
- **Phase 12:** the installer (MSIX), the `.exe` icon and the Ed25519-verified updates.
- **Phase 9:** the QR scanner on the phone. Its check-ins already show up live here.
