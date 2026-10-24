# The hospital web as the main tool (after Phase 12)

**Date:** 2026-10-24 · **Branch:** `claude/clever-noether-tt7hdg` · **Owner's decision:** option (a): the web is the main tool, the Windows app is optional, and its installer is deferred.

Real results: [`test-results.md`](test-results.md) (section "Web as the main tool"). Screenshots: [`screenshots/web-main/`](screenshots/web-main/).

## What changed
**The "Bookings" page of `app.medlink.website` is now the live day board, and the first page staff see:**
- **Live:**
  - today's list refreshes itself every 15 seconds while the page is open;
  - a check-in from the phone scanner, the Windows app or another member of staff appears without reloading, with a notice: "سُجّل حضور: <name>";
  - an open booking's details follow too.
- **Status chips with counts** (All / Waiting / Arrived / No-show / Cancelled) that filter the list, plus a **department filter**.
- **History in the details**, as on the Windows panel: booked via the link, then each check-in or correction with its source (QR scanner, reception, server, correction). The reason and the account are shown to reception and admins.
- **Notes:** the no-show grace period and the refresh rhythm are shown under the chips.
- **Removed:** the empty "المواعيد (قريبًا)" placeholder.

**Doctors can now use the web (before, only the Windows app):**
- They see the same board, **read-only**, with a "view only" note.
- They see their own departments only.
- They do not see phone numbers, cancellation or correction reasons, staff accounts, or the form answers.
- Another department's booking does not exist for them, by link or by booking number.
- The server enforces all of this. The endpoint sweep and a new test check it.

**Windows app:**
- unchanged and still tested in CI on every push;
- the deployment guide marks it optional: build the installer only when a hospital asks for it.

## Files changed
- `api/src/MedLink.Api/Endpoints/BookingEndpoints.cs`: doctors' reading rules; history in the details.
- `api/tests/MedLink.Api.Tests/SyncTests.cs` (new test), `EndpointSweepTests.cs` (updated table).
- `web/hospital/src/Bookings.tsx`, `bookingsText.ts`, `App.tsx`, `text.ts`.
- `docs/deployment.md`, `README.md`.

## Decision I made (please confirm or correct)
- **Doctors do not see the booking form answers,** as in the Windows app. If the form asks something the doctor needs to see before the visit, tell me and I will show them the answers too.

## Known limits
- **The web needs the internet.** During an outage, reception cannot check patients in from the web (the Windows app can).
- **"Live" means up to 15 seconds.** That is enough for a reception desk, and it keeps the load on the free server low.
