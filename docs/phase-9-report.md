# Phase 9 report: phone page and QR scanner

**Date:** 2026-10-21 · **Branch:** `claude/clever-noether-tt7hdg` · **Status:** done, waiting for the owner's review before Phase 10.

Real test results: [`test-results.md`](test-results.md) (Phase 9 section). Screenshots (phone size, 390×844): [`screenshots/phase-9/`](screenshots/phase-9/).

## Owner decisions applied
| Decision | Where |
|---|---|
| Who scans: I read your "yes" as **QR scanner, reception and hospital admin** (everyone with the check-in permission in the approved matrix). Doctors cannot. | Server: `/scan/*` requires the check-in permission. Page: an account without it sees a message. **Please correct me if you meant the QR-scanner role only.** |
| Address `app.medlink.website/scan`, hosted on Cloudflare Pages | `/scan` is a route of the hospital web (the same site and session), so it deploys with it and needs no extra setup. |
| jsQR as the fallback reader | jsQR 1.4.0 (Apache-2.0), loaded only on browsers without a built-in QR reader (iPhone Safari, desktop Chrome). |

## What was built
**Server:**
- `POST /scan/qr` verifies the code and checks the patient in at once (source "QR scanner"). Results follow the design's table:
  - checked in;
  - already checked in at HH:MM (nothing recorded again);
  - another day, cancelled: the booking's details are shown, but no check-in;
  - another hospital, unknown code: **no details at all**.
- `GET /scan/lookup` + `POST /scan/checkin`: by the **full** booking number of this hospital only. The booking is shown first; the staff member checks the patient's identity, then confirms. Another hospital's number is simply "not found".
- The approved conflict policy still holds:
  - a scan overrides the automatic no-show;
  - a manual correction is never overridden. The card says "status corrected manually" instead.
- Sessions of QR-scanner accounts (shared phones) end **12 hours after sign-in**, as the design's note says. Reception and admins keep their usual limits.
- Rate limit on the scanner endpoints: 60 per minute per IP (`SCAN_RATE_PER_IP_PER_MIN`), so booking numbers cannot be guessed.

**Phone page (from `QR Scanner.dc.html`, text verbatim):**
- Sticky header with the hospital name, a connection dot and a language switch; staff sign-in (with the 6-digit code step for accounts with 2FA).
- **Scan QR:**
  - The camera is requested only after "Turn on camera", back camera first.
  - The viewfinder has the frame corners and the scan line, which stays still when the phone's reduce-motion setting is on.
  - Denied or missing camera: a message and a link to "Search by booking number".
- **Booking no.:** a full-number search; name search is not possible.
- **Result card:** the colours and icons from the design, vibrate 60 ms, "Scan next" (the camera restarts by itself).
- **Recent:** the last 5 actions, **in memory only**. Nothing about patients is stored on the phone.
- **Offline:** "No connection: the server must verify the booking".

## Decisions I made (please confirm or correct)
1. **Who can scan:** QR scanner, reception and hospital admin (see above).
2. **Manual check-ins from the phone are recorded as "manually at reception"**, not as "QR scanner", because no code was scanned. The Windows app's history shows the difference.
3. **"Another hospital":** as in the design, a code belonging to another hospital says so, but shows nothing about the booking.
4. **The 12-hour limit applies to QR-scanner accounts only.** Reception and admins on their own phones keep their usual sessions (12 hours idle, 7 days at most).

## Known limits
- **Not tested on real phones.** The camera path was tested with a real ticket QR through Chromium's fake camera and the jsQR reader. Android's built-in reader and real iPhone/Android cameras still need a short manual check:
  1. Open `app.medlink.website/scan` on an Android phone and an iPhone, and sign in as a QR-scanner account.
  2. Tap "Turn on camera", allow it, and scan a ticket (a saved ticket image on another screen is fine).
  3. Scan the same ticket again ("already checked in"), then search by its number.
- **The camera needs HTTPS.** Production is HTTPS (Cloudflare); localhost works for development.

## Questions for Phase 10 (automatic no-show and password recovery)
The design covers most of this phase:
- the no-show job runs every minute with each hospital's grace period;
- the expired links and keys are cleaned up;
- a nightly retention job runs after 24 months;
- password recovery goes through an identity checklist, then a one-time email link.

Three points are open:
1. **Staff who forget their password** (reception, doctor, scanner): today their hospital admin sends a reset link from Settings. Should KHATIB support also be able to do it (with the identity checklist), or only the hospital admin? I recommend **the hospital admin only**, with support handling hospital admins.
2. **Retention after 24 months:** besides the patient's name, phone and answers, should the **correction reasons** be cleared too? A reason may contain a name. I recommend clearing them and keeping only the type and time.
3. **Patients who never arrive:** after the grace period, should the no-show also appear as a notice in the Windows app (like the live QR check-in), or only as the status change? I recommend the status change only (less noise).
