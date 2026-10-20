# Phase 6 report: online booking, form builder and versions

**Date:** 2026-10-20 · **Branch:** `claude/clever-noether-tt7hdg` · **Status:** done, waiting for the owner's review before Phase 7.

Real test results: [`test-results.md`](test-results.md) (Phase 6 section). Screenshots: [`screenshots/phase-6/`](screenshots/phase-6/).

## Owner decisions applied
| Decision | Where |
|---|---|
| Booking window 14 days, minimum notice 30 minutes | System settings (company console), optional per-hospital override; enforced by the server for both availability and confirmation |
| Patients cannot cancel online | No public cancel endpoint; reception (and the hospital admin) cancel with a reason |
| No per-phone daily limit | System setting = 0; the limit works if the owner ever sets it. Per-IP (10/min) and per-hospital (120/min) rate limits on booking creation |
| Default time zone Syria | New hospitals: `Asia/Damascus`; "today" and slots use the hospital's own zone |

## What was built
**Database (`0004_forms_and_bookings.sql`):**
- `form_versions`: insert and select only, so a published version can never be edited.
- `form_drafts`, `hospital_active_form`.
- `bookings`: a partial unique index allows one patient per seat, and cancelling frees the seat. Bookings also hold the idempotency key, the request fingerprint and the QR hash.
- `booking_answers`.
- All tables have RLS, plus triggers that stop cross-hospital references.

**Form builder (hospital web), from `Form Builder.dc.html`:**
- Question cards with drag and ↑/↓, the six answer types, text in 3 languages, options and the Required switch.
- "New", "Edited" and "Missing translation" tags.
- The status strip (live version, draft changes, discard) and an autosaved draft.
- Phone/desktop preview that validates but never sends anything.
- Publish dialog with the added/edited/removed counts and the new version number, plus the design's blockers.
- Red failure banner (live version kept), Versions tab, and restore as a new version.

**Booking site, from `Patient Booking.dc.html`:**
- The five steps: details, department, questions, date and time, review. Only open days and times are shown.
- On confirmation, the ticket with QR, the booking number, the "save now" warning, **Save image** (1080×1500 PNG) and **Print**.
- If a time was just taken, the amber banner returns the patient to pick another time.
- If the form changed, the new questions load and matching answers are kept.
- A network error can be retried safely: the same Idempotency-Key means no duplicate booking.

**Server guarantees:**
- **Re-checked at confirm time:** the time slot is checked again on confirm (timetable, closures, window, notice, time zone), and so are the answers, against the version the patient opened. That version is accepted for 2 hours after a newer one is published.
- **Seats:** the first free seat is taken, with a retry if another request takes it at the same moment.
- **Idempotency:** a repeated key returns the original booking, and a different request with the same key is refused.
- **QR code:** `MLK1.` plus 128 bits with no personal data; only its SHA-256 is stored.

**Bookings page (hospital web, admin and reception):**
- The day's list in hospital time; search by the **full** booking number only (no name search).
- The details drawer with form answers; cancel with a required reason.

## Decisions I made (please confirm or correct)
1. **QR tokens are derived from the booking ID with a server key** (HMAC). Only the hash is stored, but the server can re-create the token. This is used for one thing: answering a repeated request (same Idempotency-Key, within 24 hours) with the same ticket. It is not a "show my booking again" feature, which stays off as you decided.
2. A hospital with **no published form** can still take bookings (the questions step is skipped).
3. Cancelling is allowed only while the booking is "waiting"; arrived and no-show bookings are handled by attendance correction (phase 10).
4. Booking numbers use the design's alphabet (`ML-` + 6 characters, no 0/O/1/I). That gives about 887 million combinations, with a retry on the rare collision.

## Known limits
- The design has no mock-up for the Bookings page; it follows the console style.
- Print opens the ticket image in a new tab and calls the print dialog (as in the prototype). Pop-up blockers can stop it; **Save image** always works.
- Retention (deleting names/phones/answers after 24 months) runs in phase 10 with the other background jobs. The schema is ready for it (`anonymized_at`).

## Questions for Phase 7 (sync and the local SQLite database for the Windows app)
1. **Windows app scope:** does the Windows app run only at reception, or also on doctors' PCs? Phase 7 assumes reception and hospital admin, with check-in and the day list available offline.
2. **Offline check-in:** may reception check in a patient **offline** from the local copy, and sync later? The approved conflict policy supports it; QR verification itself needs the server. I recommend allowing offline check-in by booking number only, marked "pending sync".
3. **How many PCs per hospital** (roughly)? This affects device registration and the sync cursors.
