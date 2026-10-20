# MEDLINK Windows — sync library (`MedLink.Sync`)

The part of the Windows app that keeps a local copy and syncs it (Phase 7). The app's screens come in a later phase.

- **Local database:** SQLite with **SQLCipher** (whole-file AES-256). A random 256-bit key is created on first run and
  stored next to the database (`<db>.key`), protected by **DPAPI** for the signed-in Windows user (`DpapiKeyProtector`).
  Copying the files to another PC or user does not open them.
- **What is stored:** bookings from yesterday to +30 days (hospital time), departments, the sync cursor and an outbox.
  Older and later bookings are deleted after each pull. Doctors' PCs never receive phone numbers.
- **Sync:** `SyncClient.SyncAsync()` pushes the outbox, then pulls every change after the cursor
  (`/sync/pull`, `/sync/push`). Each event has a `clientEventId`, so a retry after a lost response is applied once.
  Network errors keep events queued with backoff (2 s, 4 s, 8 s … max 5 min).
- **Offline check-in:** by booking number only (`CheckInByRef`). It shows as arrived, "pending sync", until the server
  answers. The server re-checks everything (permission, day, cancellation) and can reject it (`Rejected()`).
- **Permissions:** never taken from the local copy. The bearer token's server-side session decides.

Tests run against the real API and PostgreSQL: `api/tests/MedLink.Api.Tests/SyncClientTests.cs`.
DPAPI itself exists only on Windows, so the tests use a stand-in protector; the encryption test checks that the file
has no plaintext and that a wrong key cannot open it.
