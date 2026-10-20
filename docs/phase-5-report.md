# Phase 5 report: hospital management and unique links

**Date:** 2026-10-20 · **Branch:** `claude/clever-noether-tt7hdg` · **Status:** done, waiting for the owner's review before Phase 6.

Real test results: [`test-results.md`](test-results.md) (Phase 5 section). Screenshots: [`screenshots/phase-5/`](screenshots/phase-5/).

## Phase 4 open questions — what I did (the owner said "start Phase 5", so I used my recommendations)
| Question | What was built |
|---|---|
| Hospital time zone | A time-zone list in the create dialog and the edit drawer (company), and in hospital settings. The server accepts only real IANA zones. The dialog defaults to **Africa/Tripoli**; the API's fallback stays `DEFAULT_HOSPITAL_TIMEZONE` |
| Company staff accounts | A **Team** tab (Owner only): invite Owner/Support/Viewer by a 24-hour activation link, change roles, disable/enable, resend links. Nobody can change their own account, and at least one active Owner always remains, even if two Owners demote each other at the same moment |
| Company user loses access | Another Owner sends a reset link from the Team tab. If there is only one Owner: `medlink reset-company-user --email …` on the server (revokes sessions, prints a 1-hour link) |
| Maximum session age | Hard limit of 7 days, on top of the 8 h / 12 h idle timeouts |
| Password length | Unchanged: at least 10 characters |

## What was built
**Database (migration `0002_hospital_management.sql`):**
- `departments`: names in 3 languages, shown/hidden, order. Never deleted.
- `schedules`: weekly blocks per department: day, from, to, slot length, patients per slot. A PostgreSQL **exclusion constraint** makes overlapping blocks impossible, even from two requests at the same time.
- `closures`: closed days for the whole hospital or one department, at most one per day.
- RLS on all three tables. Triggers stop a schedule or closure from pointing at another hospital's department.
- `sessions.absolute_expires_at` for the 7-day limit.

**Hospital web (`web/hospital`, `app.medlink.website`).** The sidebar follows the form-builder design.
- Sign-in with 2FA when required. "Forgot password?" opens the design's prepared WhatsApp message to +43 681 81700732; the message contains the email only, never a secret.
- Activation / reset page (moved here from the console for hospital users).
- **Departments:** add, rename, show/hide, reorder; a weekly timetable per department showing the number of appointments per day; closed days.
- **Settings** (hospital admin only):
  - the patient booking link, with copy/open;
  - no-show grace (0–240 min), data retention (1–120 months), time zone, and the switch "require 2FA for reception and scanner staff";
  - users: invite reception/scanner staff, change role, disable, resend invite or send a reset link. The hospital admin's own row is locked (the company manages admins).
- Reception and scanner staff see a reduced, read-only menu. Appointments, Bookings and the Form Builder are marked "soon" (phases 6–9).

**Booking site (`web/booking`, `medlink.website/book/{slug}`):**
- Header, footer and department text from the Patient Booking design: the hospital name, the logo slot and the visible departments. A clear note says that choosing a time opens in Phase 6.
- Renamed link within 90 days: the page loads and the address bar switches to the new link. After 90 days: "This link has changed". Unknown link: "Link not found". Suspended or unactivated hospital: "not taking bookings".
- `functions/book/[slug].js`: a Cloudflare Pages Function that returns a **real HTTP 301** for renamed links (needs `API_ORIGIN` in the Pages settings).

**Code structure:**
- `web/` is now an npm workspace.
- `web/shared` holds sign-in, the link page, the shell, the users panel, the API client, the time zones and the styles, used by all three sites.

## Decisions I made (please confirm or correct)
1. **Weekday numbering:** 0 = Sunday … 6 = Saturday. Times are stored as minutes in the hospital's own time zone. A block may end at 24:00.
2. **Staff roles a hospital admin can give:** reception and scanner only. Hospital admins are created and recovered by the company.
3. **Departments are hidden, never deleted**, because future bookings will reference them.
4. **Default time zone in the create dialog: Africa/Tripoli** (the design's example email is `.ly`). Tell me if most hospitals are elsewhere.
5. **Production URL:** `HOSPITAL_WEB_URL` should now be `https://app.medlink.website`. The Phase 4 workaround (pointing it at the console) is no longer needed.

## Known limits
- Time fields show AM/PM or 24-hour depending on the device's language. Browsers decide this for `<input type="time">`; the stored value is always 24-hour.
- The design has no detailed mock-ups for the Departments and Settings screens. They follow the console's style; tell me if you want changes.
- No hospital logo upload yet; the booking header shows the design's logo slot. Recommendation: Phase 6 or 12.

## Questions for Phase 6 (booking form and dynamic booking)
1. **Booking window:** how far ahead can patients book (the design shows 14 days)? And the minimum notice (e.g. no booking less than 1 hour before)?
2. **Cancellation by the patient:** the design re-shows nothing after confirmation and has no cancel flow. Should patients be able to cancel (for example by booking number plus phone)? I recommend no for now: reception cancels.
3. **Limits per patient:** without accounts, should there be a limit (e.g. per phone number per day) to stop abuse, or only the per-IP rate limit?
