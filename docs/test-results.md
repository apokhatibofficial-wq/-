# MEDLINK — Test results

Real runs only. Re-run the commands to reproduce. Newest phase first.

---

# Phase 10 — automatic no-show, cleanup, retention, password recovery (2026-10-21)

## 1. API tests (xUnit + Testcontainers, PostgreSQL 16)
`cd api && dotnet test tests/MedLink.Api.Tests`

**Result: 96 passed, 0 failed** (7 min 2 s). That is the 90 earlier tests plus 6 new ones. After the last change (the database driver's log level), the log and secrets tests and the job tests were run again: 10/10.

| Test | Result |
|---|---|
| `Acceptance 10: no-show is recorded after the grace period (per hospital), once, by the server` (two job runs at the same moment mark it once; in grace, arrived, corrected, cancelled and 6.5-day-old bookings untouched; the event's time = slot + grace; a 60-minute hospital grace is respected; a late QR scan still checks the patient in) | ✅ |
| `Retention: after the hospital's period, names, phones, answers and reasons are removed; status and times stay` (no name left anywhere, audit log included; a newer booking untouched; the anonymised ticket is refused by the scanner) | ✅ |
| `Retention: a redacted reason cannot be rewritten, and reasons cannot be edited outside redaction` | ✅ |
| `Cleanup: old used or expired links and ended sessions are deleted; current ones stay` (the signed-in session still works) | ✅ |
| `Retention runs nightly after 03:00 Syria time, once per day` | ✅ |
| `The background service runs the no-show job by itself when enabled` | ✅ |

Test-side mistakes fixed while writing the tests:
- two test bookings were moved to the same minute, which the one-patient-per-seat rule refused;
- the cleanup test ended the session it was signed in with;
- a test session was missing a required column.

**Mutation check (9 seeded bugs, all caught in the end):**
- corrected bookings no longer skipped;
- fixed 30-minute grace instead of the hospital's;
- no 6-day look-back;
- reasons not cleared;
- phone kept;
- no lock between servers;
- append-only rule removed;
- retention at any hour;
- cleanup deleting all sessions.

Two were not caught at first, and both were weak tests, not bugs:
- **The fixed grace:** I had changed it in one place only. The event time still used the hospital's grace, so the server's "not in the future" check refused the mark. With the grace replaced everywhere, the test fails as it should.
- **The look-back:** the old test booking was 8 days old, so the separate 7-day limit on events already refused it. It is now 6.5 days old, inside that limit, and the test fails without the look-back.

## 2. Web and Windows
| Check | Result |
|---|---|
| `tsc` × 4 | ✅ 0 errors |
| Unit tests | ✅ shared 3/3 · hospital 10/10 · booking 5/5 |
| `vite build` × 3 | ✅ |
| Windows app build + Windows CI run (`windows-latest`) | ✅ 0 warnings; CI run 19 green: the real window opens the forgot dialog (screenshot) and fails on any binding error |
| gitleaks 8.28.0 | ✅ no leaks |

## 3. End to end on the real stack (Docker images, Chromium)
Migration `0006_background_jobs` applied. Right after start, the service recorded a run of all three jobs in `job_runs` with no help.

**7 of 7 steps passed:**
```
PASS owner signs in; creates a hospital; admin activates and signs in
PASS admin adds two departments with timetables
PASS bookings (fictional patients): A 50 min ago, B 10 min ago (grace 30 min), C 40 min ago but checked in
PASS within a minute the server marks A as no-show by itself (source auto); B and C are untouched
PASS the hospital web shows A as no-show after a reload
PASS the patient turns up late: a correction to arrived wins, and the job does not mark it again
PASS forgot password on the hospital web: WhatsApp to support, and the staff line (ask the hospital admin)
```
- The event's time was exactly the slot plus 30 minutes, with no account. After the correction, a further minute passed and there was still exactly one automatic event.
- **API container log:** 0 matches for patient names, phone numbers, booking numbers, QR codes, `#t=`, test emails or the correction text. The job wrote one line, `job no_show: 1`.
- **Found by this run:** the database driver logged every SQL statement at the information level. With the minute job that is about 20,000 lines a day; they held no values. They are now logged at warning level only.
- Test-side slips, fixed: the menu item is «الحجوزات», not «المواعيد»; «حضر» also matched «لم يحضر».

## Not tested yet
- A night of real retention on production data: the logic is covered by the tests above with dates moved into the past.

---

# Phase 9 — phone page and QR scanner (2026-10-21)

## 1. API tests (xUnit + Testcontainers, PostgreSQL 16)
`cd api && dotnet build -c Release && dotnet test --no-build -c Release`

**Result: 90 passed, 0 failed** (6 min 6 s). That is the 84 earlier tests plus 6 new ones. Build: 0 warnings.

| Test | Result |
|---|---|
| `Scan: a valid code checks in at once (source qr); scanning again says already, at the same time, and records nothing new` | ✅ |
| `Scan: cancelled and other-day bookings show details but are not checked in; another hospital's code shows nothing; bad codes are unknown` (5 malformed or unknown codes; 0 events stored) | ✅ |
| `Scan: an arrival by QR overrides the automatic no-show; a manual correction is not overridden` | ✅ |
| `Scan by booking number: found → confirm → checked in; another hospital's number is not found; doctors and anonymous callers are refused` | ✅ |
| `Scan: QR-scanner sessions end 12 hours after sign-in; reception keeps the 7-day limit` | ✅ |
| `Scan: lookups are rate limited per IP (429)` | ✅ |

**Mutation check (4 bugs, all caught):** another hospital's code reported as unknown; check-in allowed on another day; a re-scan recorded again; the 12-hour scanner limit removed.

A slip on my side, now fixed: the first mutation script used `git checkout` on a new file that git didn't track yet. It also reverted an uncommitted change in another file. Both files were restored by hand and the tests passed again. The "other day" mutation was then rerun on its own, and it failed as it should.

## 2. Web
| Check | Result |
|---|---|
| `npm audit` (with jsqr 1.4.0) | ✅ 0 vulnerabilities |
| `tsc` × 4 | ✅ 0 errors |
| Unit tests | ✅ shared 3/3 · hospital 10/10 (5 new: result cards, details hidden for another hospital or an unknown code, formats) · booking 5/5 |
| `vite build` | ✅ hospital 307 kB + jsQR 131 kB (separate file, loaded only when the browser has no QR reader) |
| gitleaks 8.28.0 | ✅ no leaks |

## 3. Browser end-to-end on the real stack (phone size 390×844, Chromium)
The camera part uses Chromium's fake camera, fed with a video of a **real** booking QR (a fictional patient), so the real path runs: camera → decoder (jsQR, since desktop Chromium has no built-in QR reader) → server → check-in.

**15 of 15 steps passed** (4 setup + 11 scanner).
```
PASS owner signs in; creates a hospital; admin activates and signs in
PASS admin adds two departments with timetables
PASS test bookings for today (fictional patients): A for manual check-in, B for the camera, C cancelled
PASS admin invites a QR-scanner account; it activates its link
PASS sign-in screen; a wrong password gives the generic error
PASS scanner signs in: hospital name, connection, camera intro
PASS by booking number: found → identity check → checked in (source reception)
PASS by booking number: cancelled shows details in red; an unknown number is not found
PASS camera: the QR on the (fake) camera is read and checked in at once (source qr)
PASS scan next: the same ticket again says already checked in, and is not recorded twice
PASS recent list: the last actions with names, numbers and times (memory only)
PASS offline: the result says the server is needed; the header shows offline
PASS English, and no horizontal scrolling at 390px
PASS sign out returns to the sign-in screen; the session is ended on the server
PASS camera permission denied: message and a link to search by booking number
```
- **API container log** (350 lines): 0 matches for patient names, QR codes (`MLK1.`), phone numbers, booking numbers, `#t=` or test emails.
- **Nothing about patients is kept on the phone:** localStorage and sessionStorage were checked after the scans.

**Found by the browser run (fixed):**
1. "Scan next" didn't restart the camera: it was started before the viewfinder was back on screen. The user would have had to tap "Turn on camera" again.
2. The recent list showed the phone's time zone (04:16) while the card showed hospital time (07:16). Both use hospital time now, and the run checks it.
3. In Arabic, the time and booking number in the result card were aligned to the opposite side from the other values.

**Regression runs after Phase 9:** Phase 4 16/16 · Phase 5 16/16 · System settings 7/7 · Phase 6 10/10 · Phase 7 10/10. The first try of Phases 5 and 6 failed only because I hadn't started the booking site (port 5175). With it running, both passed.

Not tested: a real phone camera (iPhone Safari, Android Chrome), and Android's built-in reader (BarcodeDetector), which Chromium on Linux doesn't have. A short manual check is in the report.

---

# Phase 8 — the Windows app and the splash animation (2026-10-21)

## 1. API, sync and app-logic tests (xUnit + Testcontainers, PostgreSQL 16)
`cd api && dotnet build -c Release && dotnet test --no-build -c Release`

**Result: 84 passed, 0 failed** (4 min 51 s). That is the 76 earlier tests plus 8 new ones that drive the Windows app's logic (`MedLink.App.Core`) against the real API. Build: 0 warnings.

| Area | Test | Result |
|---|---|---|
| Splash | timings follow SCREENS.md (80/1250/1650/2700/3150 ms, bar 28/62/100 %), plus the reduced-motion variant | ✅ |
| Strings | every string in AR/EN/TR, as bindable properties (no public fields) | ✅ |
| Sign-in | the same generic error for an unknown email and a wrong password; the 6-digit code step; a QR-scanner account refused and its Windows session ended; sign-in disabled offline; lockout after 5 wrong passwords | ✅ |
| Saved session | DPAPI-protected file (no token or email in clear); reopens without a password; offline start opens the local copy with the banner; revoked session → sign-in with a notice | ✅ |
| Dashboard | chips and counts; search by name or number in the day's list; check-in from the table; offline check-in pending, then "1 update synced"; correction (reason < 5 refused); history (booked, reception, correction); live QR check-in notice; language switch (the filter keeps its items) | ✅ |
| Doctor / shared PC | own department only, no phone, read-only; reception's local copy deleted at sign-out; the same device reused | ✅ |
| Sign-out / revoke | unsent check-in → warning, copy kept, sent at the next sign-in; device revoked → signed out with a notice, device forgotten | ✅ |
| Forgot password | WhatsApp link to 4368181700732 with username and hospital only, never the password | ✅ |

Also changed and covered: the pull includes each booking's history; a correction reason needs at least 5 characters (API, web, app).

## 2. The real app on Windows (CI job `windows-app`, windows-latest)
`MEDLINK.exe --smoke <dir>` runs the WPF window against a local fake server with fictional data. **Final run: 30 of 30 checks passed.** Screenshots: [`screenshots/phase-8/`](screenshots/phase-8/) (`smoke.txt` is the run's own report).
```
PASS DPAPI protects and restores the local key
PASS splash (KHATIB): logos fully inside the window
PASS splash (KHATIB): logo drawn in the middle (white rows 346–478, window centre 412)
PASS splash (MEDLINK): logos fully inside the window
PASS splash (MEDLINK): logo drawn in the middle (white rows 296–527, window centre 412)
PASS splash plays (3.15 s) and opens sign-in
PASS sign-in shows 'connected to server'
PASS sign-in shows its labels
PASS sign-in: logos not mirrored
PASS sign-in: logos fully inside the window
PASS sign-in: primary buttons have white text
PASS wrong password shows the generic error
PASS 2FA account asks for the 6-digit code
PASS offline: pill amber, sign-in disabled
PASS reception signs in
PASS today's bookings pulled (6)
PASS this PC registered once as a device
PASS local database file is encrypted (SQLCipher)
PASS saved session is protected (no token or email in clear)
PASS dashboard shows its labels
PASS dashboard: logos not mirrored
PASS dashboard: primary buttons have white text
PASS offline check-in kept locally as pending
PASS pending check-in sent when the connection returned
PASS find by full booking number opens it
PASS dashboard (English) shows its labels
PASS sign-out deletes this user's local copy (nothing pending)
PASS doctor: read-only, no phone
PASS second user reuses the PC's device
PASS no WPF binding errors (0)
```

**How it got there.** The first Windows run passed its 17 checks, but its screenshots showed real bugs. Each was fixed and now has a check:

| Bug (seen in a screenshot) | Fix | Check added |
|---|---|---|
| MEDLINK and KHATIB logos mirrored in Arabic | logos always laid out left to right | logos not mirrored |
| Most labels empty (WPF binds to properties; the strings were fields) | strings are properties | no binding errors; screens show their labels; a unit test forbids fields |
| Title-bar buttons shown as boxes (icon font missing) | drawn as shapes | (screenshot) |
| Dark text on primary buttons | button text isolated from the app-wide text style | primary-button text is white |
| Phone and date reversed in Arabic; history time wrapped | left-to-right values, wider column | (screenshot) |
| Department filter blank after a language change | items kept and renamed in place | unit test |
| KHATIB logo shifted off the top of the splash (and ~110 px high on sign-in) | logos drawn as WPF drawings from the original files (the viewer control mishandled the file's negative viewBox origin) | logo drawn in the middle (pixel check); logos inside the window |

Two attempts at the KHATIB fix (an explicit size, then height-only) were proved insufficient by the pixel check before the third one passed.

## 3. Other checks
| Check | Result |
|---|---|
| `dotnet list package --vulnerable` (API, tests, MedLink.Sync, MedLink.App.Core, MedLink.Windows incl. SharpVectors 1.8.6) | ✅ none |
| Web: `npm audit`, `tsc` × 4, unit tests 13/13 | ✅ |
| gitleaks 8.28.0 (local and in CI) | ✅ no leaks |
| CI on GitHub (api, web, windows-app, secrets) | ✅ green on the final commit |
| Logo files copied into the app | ✅ byte-identical to `docs/design/designs/assets` (SHA-256 compared) |

Not run in this phase: the Phase 4–7 browser runs (the web changed only in the minimum correction-reason length, 3 → 5, and the Phase 7 run's reasons are longer than 5). The app has not run on a real hospital PC yet (see the manual checklist in the report).

---

# Phase 7 — sync and the local database for the Windows app (2026-10-21)

## 1. API and sync-library tests (xUnit + Testcontainers, PostgreSQL 16)
`cd api && dotnet build -c Release && dotnet test --no-build -c Release`

**Result: 76 passed, 0 failed** (4 min 18 s). That is 59 earlier tests plus 17 new ones. Build: 0 warnings (warnings are errors).

| Area | Test | Result |
|---|---|---|
| Conflict policy (unit, 6) | no events = waiting; earliest arrival wins; offline arrival beats auto no-show; correction beats everything; conflicting corrections → latest received + needs review; agreeing corrections are no conflict | ✅ |
| Pull/push | `Sync: pull after a cursor, push check-in by booking number; a retried push is applied once` | ✅ |
| Offline | `Sync: an offline check-in received after the automatic no-show wins; the earliest arrival time is kept` | ✅ |
| Corrections | `Sync: corrections win; conflicting corrections flag the booking for review; reasons are required` (also: 2 `attendance_correct` audit rows) | ✅ |
| Rejections | `Sync: cancelled bookings, other-day check-ins and implausible times are rejected` (CANCELLED, OTHER_DAY, NOT_FOUND, BAD_TIME ×2, FORBIDDEN, SOURCE_INVALID; 0 events stored) | ✅ |
| Doctor | `Sync: a doctor pulls only their own department's bookings, without phone numbers, and cannot check in` (also: department change takes effect on the next pull) | ✅ |
| Devices | `Sync: Windows bearer token; revoked devices are refused; 25 active devices per hospital; scanner cannot pull` (also: another hospital's device is refused; console last sync) | ✅ |
| RLS | `Sync: RLS keeps devices and attendance events inside their hospital` (and DELETE on events is refused: 42501) | ✅ |
| Local DB encryption | `Windows sync: the local database is encrypted; the wrong key cannot open it; no plaintext in the file` | ✅ |
| Offline client | `Windows sync: offline check-in is kept as pending, backs off, then syncs once the network returns` | ✅ |
| Lost response / rejection | `Windows sync: a lost response is retried and applied once; a check-in the server rejects is reported, not kept` | ✅ |
| Cache window | `Windows sync: the local copy keeps only yesterday to +30 days` | ✅ |

**Mutation check (9 bugs introduced on purpose, all caught, all code restored):** doctor department filter removed; doctors receive phones; revoked-device check removed; latest arrival instead of earliest; no review flag; other-day check-in allowed; push permission not checked; SQLCipher key removed (plaintext found in the file); outbox backoff removed.

Not tested here: DPAPI itself (Windows only; a stand-in protector is used in tests), and the library on a real Windows PC.

## 2. Web (npm workspace)
| Check | Result |
|---|---|
| `npm audit` | ✅ 0 vulnerabilities |
| `tsc` × 4 | ✅ 0 errors |
| Unit tests | ✅ shared 3/3 · hospital 5/5 · booking 5/5 |
| `vite build` × 3 | ✅ admin 255 kB · hospital 282 kB · booking 207 kB |
| `dotnet list package --vulnerable` (API, tests, MedLink.Sync) | ✅ none |
| gitleaks 8.28.0 | ✅ no leaks |

## 3. Browser end-to-end on the real stack (Docker: PostgreSQL, API image, Mailpit; Vite web apps)
**10 of 10 steps passed** (run twice on a fresh database; the second run was after a container restart).
```
PASS owner signs in; creates a hospital; admin activates and signs in
PASS admin adds two departments with timetables
PASS two test bookings for today, one per department (test data only)
PASS admin invites a doctor limited to one department, and a receptionist
PASS doctor signs in: no bookings page, and the server refuses the bookings list
PASS reception checks a patient in from the Bookings page
PASS a correction needs a reason; reception corrects to no-show, admin corrects back: flagged for review
PASS Windows client (bearer): registers a device, pulls today, pushes an offline check-in by booking number
PASS admin sees the device with its last sync, then revokes it; the device is refused
PASS company console: last sync shown, doctor column in the roles matrix, new audit labels
```
- **API container log** (540 lines): 0 matches for the test patient names, the phone number, `MLK1.`, `#t=`, test emails, `Bearer` or the correction reasons.

**Regression runs after Phase 7:** Phase 4 16/16 · Phase 5 16/16 · System settings 7/7 · Phase 6 10/10. The Phase 6 run first failed 9/10: the booking drawer now has two text boxes (correction and cancel reason), so its selector was changed to the cancel box's label. Not a product bug.

Found by the browser run (fixed): the console's "last sync" counted only active devices, so revoking the only PC made the hospital show "never connected". It now uses every device, and a test checks it.

---

# Phase 6 — online booking, form builder and versions (2026-10-20)

## 1. API tests (xUnit + Testcontainers, PostgreSQL 16)
`cd api && dotnet build -c Release && dotnet test --no-build -c Release`

**Result: 59 passed, 0 failed** (3 min 59 s). That is 44 earlier tests plus 15 new ones.

| Acceptance test (BACKEND-SPEC §7) | Test | Result |
|---|---|---|
| 5. Book an available slot | `Acceptance 5/8: book an available slot; the QR is an opaque 128-bit token, stored only as a hash` | ✅ |
| 6. The same slot cannot be booked twice at once | `Acceptance 6: … 10 parallel requests, capacity 1 and 2` (exactly 1 and exactly 2 succeed; seats 1..n) | ✅ |
| 7. Re-submitting does not duplicate | `Acceptance 7: re-sending the same request returns the original booking` (5 parallel replays → same ref and QR, 1 row) | ✅ |
| 8. Generate the QR code | covered by 5/8: `MLK1.` + 22 base64url chars; only its SHA-256 in the DB. (Verification by the scanner is phase 9) | ✅ |
| 12. A newly published question appears on the booking link | `Acceptance 12/14` | ✅ |
| 13. Required and optional fields behave correctly | `Acceptance 13: … checked on the server against the published version` | ✅ |
| 14. Previewing/saving the draft doesn't affect the live form | `Acceptance 12/14` | ✅ |
| 15. Publishing requires confirmation | `Acceptance 15: publishing is blocked until …` (server blockers) + browser step (confirmation dialog) | ✅ |
| 16. A failed publish keeps the live version | `Acceptance 16: a publish that fails inside the database keeps the live version and the draft` (a real DB trigger forces the failure) | ✅ |
| 17. Restoring publishes a new version | `Acceptance 17: restoring an old version publishes it as a new version; old versions stay` | ✅ |
| 18. Forms open during a publish | `Acceptance 18: a form opened before a publish is accepted for 2 hours, then the patient must reload` | ✅ |

Other new tests:
- Availability rules: 14 days, 30-minute notice, closures, the Damascus time zone, and per-hospital overrides.
- Reception cancels with a reason and the seat is freed; scanners and other hospitals cannot.
- Suspended hospitals take no bookings; the per-phone limit works only when switched on.
- RLS on bookings, answers and forms.
- Published versions can't be updated in the database.
- **A signed-in browser can still open one-time links and sign in again** (a bug the browser run found; see below).

**Mutation check:** three bugs were introduced on purpose: seats beyond the capacity, no full-slot check, and a 1000-hour grace for old forms. 3 tests failed as expected. A fourth mutation removed the cookie fix, and its test failed too. All code was restored.

## 2. Web (npm workspace)
| Check | Result |
|---|---|
| `npm audit` | ✅ 0 vulnerabilities |
| `tsc` × 4 | ✅ 0 errors |
| Unit tests | ✅ shared 3/3 · hospital 5/5 (form diff and publish blockers) · booking 5/5 (phone rule, Pages 301 function) |
| `vite build` × 3 | ✅ admin 252 kB · hospital 271 kB · booking 207 kB |

## 3. Browser end-to-end on the real stack (Phase 6 run)
**10 of 10 steps passed.**
```
PASS owner and hospital admin set up (hospital in Asia/Damascus)
PASS form builder: add a required choice question and an optional note, publish v1 with confirmation
PASS preview shows the draft and validates required questions without sending anything
PASS patient books: details → department → questions → date/time → review → confirmation ticket with QR
PASS the booked time is no longer offered to the next patient
PASS two patients pick the same last seat: the second gets the conflict banner and is sent back to pick a time
PASS a form published while a patient is booking: the patient finishes on the version they opened
PASS a publish that fails in the database shows the red banner and keeps v2 live
PASS versions tab: restore v1 publishes it as v3
PASS reception finds the booking by number, sees the answers, and cancels it with a reason
```
Also checked in that run:
- The **saved ticket PNG** (1080×1500) was decoded with a QR reader (`jsQR`). It contains a token of the form `MLK1.` + 22 characters, and its SHA-256 matches the stored `qr_token_hash` of booking `ML-YSL55X`.
- **API container log** (549 lines): 0 matches for patient names, the phone number, `MLK1.`, `#t=` or test emails.
- No horizontal scrolling at 390 px on the ticket page.

**Regression runs after Phase 6:**
- Phase 4: 16/16.
- Phase 5: 16/16. Its booking-site steps were updated on purpose, because departments are now step 2 of the booking flow.
- System settings: 7/7.

Bugs the browser run found (fixed):
1. **Session cookie blocking anonymous pages.** A browser already signed in to the console sent its session cookie to `/auth/link/inspect`. Without a CSRF header, the server refused the request, so the activation link looked "invalid". The same would have blocked signing in again. Anonymous routes (`/auth/login`, `/auth/link/*`, `/public/*`) now ignore the session cookie. A test covers it and fails without the fix.
2. The test script itself had a few wrong assumptions (a guessed error text, an option label equal to the "Continue" button). These were corrected in the test, not the product.

Screenshots: `docs/screenshots/phase-6/`.

## Not tested yet
- Printing: the print button opens a new window with the ticket image; the browser's print dialog was not driven by the test.
- The scanner verifying the QR (phase 9), no-show marking (phase 10), and the Windows app (phases 7–8).
- The same infrastructure limits as earlier phases still apply.

---

# Phase 5 addendum — System settings in the company console (2026-10-20)

The owner asked for these values to be editable in the company console, not fixed in code: default time zone (Syria), booking window (14 days), minimum notice (30 min), patient cancellation (off), and the per-phone limit (none).

| Check | Result |
|---|---|
| API tests (`dotnet test -c Release`) | ✅ **44 passed, 0 failed** (2 min 2 s). 5 new in `PlatformSettingsTests`, plus the Syria-default check in the time-zone test |
| Web: `tsc` × 4, unit tests, `vite build` × 3 | ✅ no errors · 9/9 · 3 built |
| Browser, focused run (System settings) | ✅ **7 of 7** |
| Browser, Phase 5 run repeated | ✅ 16 of 16 |
| Browser, Phase 4 run repeated | ✅ 16 of 16 |

Browser steps:
```
PASS owner signs in
PASS System settings tab shows the owner values (Syria, 14 days, 30 min, no cancel, no limit)
PASS create dialog defaults to the system time zone (Asia/Damascus)
PASS owner changes the booking window to 21 days; saved and audited
PASS hospital drawer: override minimum notice to 60 minutes for this hospital only
PASS hospital admin sees the effective rules read-only: 21 days (company) and 60 minutes (override)
PASS audit log labels the new actions
```
The hospital step also calls `PATCH /admin/settings` directly → **403**.

Failures along the way (both in the tests, not the product):
- The database-guard test tried to "change" an active hospital's status to `active`, which isn't a change, so the guard correctly didn't fire. It now uses `suspended`.
- The browser test clicked the middle of a hospital row, where the Copy button sits. It now clicks the hospital name.

Screenshots: `docs/screenshots/phase-5/system-*.png`.

---

# Phase 5 — hospital management and unique links (2026-10-20)

## 1. API tests — xUnit + Testcontainers (PostgreSQL 16)
`cd api && dotnet build -c Release && dotnet test --no-build -c Release`

**Result: 39 passed, 0 failed** (1 min 49 s). These are the 26 Phase 4 tests plus 13 new ones:

| New test | Result |
|---|---|
| Hospital admin invites reception and scanner staff; they activate without 2FA by default and get only their permissions | ✅ |
| Changing a staff role or disabling the account revokes sessions; admins cannot change themselves or other admins | ✅ |
| Send-link gives a pending user a new activation link and an active user a reset link | ✅ |
| When the hospital requires staff 2FA, new staff must enrol and staff without 2FA are told to get a reset link | ✅ |
| Hospital settings: validated ranges and real IANA time zones, recorded in the audit log | ✅ |
| Departments and weekly schedules: validation, overlap rejected by the database, deactivate instead of delete | ✅ |
| Closures: one per day per department (or whole hospital), and only for the session's hospital | ✅ |
| RLS also isolates departments, schedules and closures, and the DB rejects cross-hospital links | ✅ |
| Team: only an Owner invites company staff, by an emailed 24-hour activation link | ✅ |
| Team: role changes revoke sessions; nobody can change themselves; two Owners demoting each other at once leave one Owner | ✅ |
| reset-company-user: server-side recovery revokes sessions and issues a 1-hour reset link | ✅ |
| A session ends 7 days after sign-in even if it is used all the time | ✅ |
| Hospital time zone is chosen at creation and can be edited; unknown zones are refused | ✅ |

The slug test now also covers `/public/slugs/{slug}`, the non-redirecting endpoint the booking app uses.

**Mutation check:** two bugs were introduced on purpose: hospital admins allowed to create other admins, and role changes no longer revoking sessions. 3 tests failed as expected (`Failed: 3, Passed: 10`), and the code was restored.

**Failures along the way:**
- The 7-day session test was too strict: the database's transaction time is a few milliseconds earlier than the API's clock. One minute of tolerance was added; the 7-day limit itself is unchanged.

## 2. Web — npm workspace (`web/`: shared, admin, hospital, booking)
`cd web && npm ci && npm audit && npm run typecheck && npm test && npm run build`

| Check | Result |
|---|---|
| `npm audit` | ✅ 0 vulnerabilities |
| `tsc` (4 workspaces, strict) | ✅ no errors |
| Unit tests | ✅ shared 3/3, hospital 2/2, booking 4/4 (includes the Cloudflare Pages 301 function) |
| `vite build` × 3 | ✅ admin 242 kB, hospital 231 kB, booking 153 kB (JS, before gzip) |

## 3. Browser end-to-end on the real stack
API image + PostgreSQL + Mailpit (docker compose dev) and three Vite servers: console :5173, hospital web :5174, booking site :5175. Headless Chromium.

**Phase 5 run: 16 of 16 steps passed.**
```
PASS owner sets up the account and signs in
PASS create hospital with a chosen time zone (Europe/Istanbul)
PASS Team tab: owner invites a Support colleague by email
PASS hospital admin activation link opens the hospital web (port 5174) and enrols 2FA
PASS hospital sign-in: forgot password opens the prepared WhatsApp message to support
PASS hospital admin signs in with 2FA
PASS add two departments and a Sunday + Monday timetable
PASS an overlapping block is rejected with a clear message
PASS hide a department and add a closure day
PASS settings: booking link shown, grace changed to 45 minutes
PASS admin invites a reception user; the admin row itself is locked
PASS reception activates without 2FA, sees a limited, read-only dashboard
PASS booking site shows the hospital and only its visible departments
PASS renamed link: old URL lands on the new one; after 90 days it shows "link changed"
PASS audit log shows the hospital-side actions
PASS hospital web at phone width: top bar, no horizontal scroll
```
**Phase 4 run repeated after the refactor: 16 of 16 passed.** One expectation was updated on purpose: the hospital admin's activation link now points to the hospital web (:5174), not the console.

The reception step also calls the API directly: `PATCH /hospital/settings` → **403**, so the server refuses, not only the interface. A `grep` of the API container log for test emails and `#t=` found **0 matches**.

Bugs this run found (fixed):
1. **Booking site, renamed links:** the app relied on the browser following the API's 301, which pointed to a path on the API. Behind the dev proxy it landed on the wrong server, and it would have broken behind any other proxy. Fixed with a non-redirecting endpoint, `/public/slugs/{slug}`. The real 301 remains at `/public/book/{slug}`, used by the Cloudflare Pages Function.
2. **Closure form:** a flex rule meant for row layouts made the fields about 220 px tall. Fixed.

Screenshots: `docs/screenshots/phase-5/`.

## 4. Secrets
Run on the Phase 5 tree: `gitleaks dir . --redact` and `gitleaks git . --redact` → no leaks (§ Phase 4 shows the control check).

## Not tested yet
- The same limits as Phase 4 still apply: the full `api/Dockerfile` build, CI on GitHub, Caddy/Cloudflare, real email, and backups.
- The Cloudflare Pages Function was unit-tested with Node's `Request`/`Response`, not deployed to Cloudflare.

---

# Phase 4 — auth, permissions, company console

Recorded on **2026-10-20** from real runs in the development container. Nothing here is estimated: every line below was printed by the tool named in its section. Re-run the commands to reproduce.

Environment: .NET SDK 8.0.426, Node 22.22.0, Docker 29.9.1, PostgreSQL 16 (`postgres:16-alpine`, pulled from the `mirror.gcr.io` mirror because Docker Hub rate-limited the container), Chromium 1194 (Playwright).

---

## 1. API tests — xUnit + Testcontainers (real PostgreSQL 16)

```bash
cd api
dotnet build -c Release
dotnet test --no-build -c Release
```

**Result: 26 passed, 0 failed** (total 53.3 s).

Each run starts a disposable PostgreSQL container, applies the real migrations, and creates throwaway users with passwords generated at runtime (`RandomNumberGenerator`). Nothing is committed or reused.

| Phase 4 requirement (BACKEND-SPEC §6.5) | Test(s) | Result |
|---|---|---|
| Create a hospital and sign in | `Acceptance 1: create a hospital account, the admin activates it and signs in` | ✅ Passed |
| Unauthorised access is denied (server-side) | `Acceptance 2/25: anonymous callers are refused…`, `Acceptance 25: each company role can do only what the matrix allows`, `Hospital users cannot reach the company console…`, `Cookie requests that change state need the CSRF token` | ✅ Passed |
| Hospital A cannot read hospital B, even with tampered IDs | `Acceptance 3: … through the API, even with tampered IDs`, `Acceptance 3: row-level security stops hospital A's context…`, `With no request context set, the application role sees nothing at all`, `The application role cannot bypass RLS, edit or delete the audit log, or delete slugs` | ✅ Passed |
| Slugs are unique, reserved and redirected | `Acceptance 4: each hospital gets a unique booking link; reserved and malformed slugs are refused`, `Slug change: old link 301-redirects for 90 days, then 410; reserved forever; one change per 30 days`, `Two concurrent creates with the same slug: exactly one wins` | ✅ Passed |
| Password storage is verified (Argon2id, no plaintext anywhere) | `Password storage: Argon2id with the required parameters, salted, never plaintext` | ✅ Passed |
| No secrets in the repo or logs | `Acceptance 21: no password, token, TOTP secret, link or email address appears in the logs` (+ gitleaks, §3) | ✅ Passed |

Other passing tests: lockout after 5 failures (15 min, even for the right password), wrong TOTP counts as a failure, a used TOTP code can't be replayed, logout revokes the session on the server, the Windows client gets a bearer token instead of a cookie, one-time links work once and expire, weak passwords and wrong codes are rejected, `bootstrap-admin` runs only once, suspending revokes sessions and blocks sign-in, admin recovery needs all 3 identity checks, per-IP rate limiting (429), startup refuses missing or weak secrets, security headers.

<details><summary>Full list of the 26 passing tests</summary>

```
5 failed sign-ins lock the account for 15 minutes, even for the right password
A one-time link works once and stops working after it expires
A wrong TOTP code counts as a failed attempt and a used code cannot be replayed
Acceptance 1: create a hospital account, the admin activates it and signs in
Acceptance 2/25: anonymous callers are refused by the server on every protected route
Acceptance 21: no password, token, TOTP secret, link or email address appears in the logs
Acceptance 25: each company role can do only what the matrix allows
Acceptance 3: hospital A cannot read hospital B through the API, even with tampered IDs
Acceptance 3: row-level security stops hospital A's context from seeing or changing B's rows
Acceptance 4: each hospital gets a unique booking link; reserved and malformed slugs are refused
Cookie requests that change state need the CSRF token
Hospital users cannot reach the company console, and company users cannot use hospital routes
Logout revokes the session on the server
Password storage: Argon2id with the required parameters, salted, never plaintext
Recovering admin access needs all 3 identity checks, revokes sessions and emails a 1-hour reset link
Security headers are set and errors reveal no internals
Sign-in is rate limited per client IP
Slug change: old link 301-redirects for 90 days, then 410; reserved forever; one change per 30 days
Startup refuses missing or weak secrets
Suspending a hospital revokes its sessions and blocks sign-in; reactivating restores it
The application role cannot bypass RLS, edit or delete the audit log, or delete slugs
Two concurrent creates with the same slug: exactly one wins
Weak passwords and wrong TOTP codes are rejected when completing a link
Windows clients get a bearer token instead of a cookie
With no request context set, the application role sees nothing at all
bootstrap-admin creates one owner with a setup link and refuses to run twice
```
</details>

### Failures found along the way (now fixed)
These were real failures, kept here because the owner asked for actual results:
- **Logs test proved nothing at first.** `appsettings.json` filters hid almost all log lines from the test capture, so "no secrets found" was checked against an almost empty log. Fixed: the capture now records everything down to `Trace` and the test requires more than 100 lines, including ASP.NET routing, Npgsql and `/auth/login` entries, before it searches them. Npgsql was also not connected to the app's logging at all; it now is.
- **Mutation check.** To confirm the tests really detect faults, two bugs were introduced on purpose: (a) the hospital-user lookup ignored the session's hospital; (b) suspending a hospital no longer required the Owner permission. Both tests failed as expected (`Failed: 2, Passed: 8`), and the code was restored.

## 2. Company console (web/admin)

```bash
cd web/admin
npm ci && npm audit && npm run typecheck && npm test && npx vite build
```

| Check | Result |
|---|---|
| `npm audit` | ✅ found 0 vulnerabilities |
| `tsc -b` (strict) | ✅ no errors |
| `node --test` (slug rule matches the server, `slugify`, all 3 languages have the same keys) | ✅ 3 passed, 0 failed |
| `vite build` | ✅ built (JS 227 kB, 75 kB gzip) |

`vitest` was removed because every version compatible with Vite 6 has open advisories (`npm audit`: 2 critical, 1 moderate). Node's built-in test runner is used instead.

### End-to-end in a real browser
Stack: the API image, PostgreSQL 16 and Mailpit via `infra/docker-compose.yml` + `docker-compose.dev.yml`, the Vite dev server, and headless Chromium. The owner account was created with the real `bootstrap-admin` command.

**Result: 16 of 16 steps passed.**

```
PASS setup link opens, token removed from the address bar
PASS owner sets password and enrols TOTP
PASS the used link no longer works
PASS wrong password shows a generic error
PASS owner signs in with password + TOTP
PASS create hospital: slug suggested from the English name, checked by the server
PASS a reserved slug is refused live
PASS activation email reaches Mailpit with a 24h one-time link
PASS hospitals table, drawer with fixed ID and slug policy
PASS suspend needs a reason, then shows as suspended
PASS recover access needs all three checks
PASS audit log lists the actions; roles matrix renders
PASS English switches to LTR
PASS phone width (390px): top bar layout, no horizontal page scroll
PASS the reset link replaced the activation link (old one refused)
PASS sign out ends the session
```

Also checked by hand during that run:
- `bootstrap-admin` run a second time → exit code 1, "A company user already exists".
- `grep` over the API container's whole log for the owner email, `#t=` and the setup token → **0 matches**.

Bugs this run found (fixed):
1. The data-protection key folder in the container belonged to root, so the non-root `app` user couldn't write to it. The Dockerfile now creates it with the right owner.
2. The link page lost its token in React development mode, because the first render was discarded after it had already cleared the URL. The token is now read once when the page loads.
3. The drawer's "Save" button was squashed when the drawer scrolled. Fixed in CSS.
4. Mailpit's web UI was on an internal-only Docker network (dev file only). Fixed.

Screenshots from this run: `docs/screenshots/phase-4/`.

## 3. Secrets and dependencies

| Check | Command | Result |
|---|---|---|
| Secret scan, working tree | `gitleaks dir . --redact` (v8.28.0) | ✅ no leaks found |
| Secret scan, git history | `gitleaks git . --redact` | ✅ no leaks found |
| Control: gitleaks really detects a key | fake AWS key in a scratch folder | ✅ "leaks found: 1" (folder deleted) |
| NuGet vulnerabilities (incl. transitive), API | `dotnet list package --vulnerable --include-transitive` | ✅ none |
| NuGet vulnerabilities (incl. transitive), tests | same | ✅ none |

What these checks found and what was done:
- `MailKit 4.8.0` had a moderate advisory → upgraded to 4.18.1.
- MimeKit pulled in `System.Security.Cryptography.Pkcs 10.0.0` (high, GHSA-846f-f764-76mx; moderate, GHSA-2fmv-rv2c-59x7) → pinned to 10.0.13, the first patched release.
- Testcontainers 3.10 pulled in `SSH.NET 2023.0.0` and old `System.Net.Http` / `System.Text.RegularExpressions` (high) → Testcontainers 4.15.0, xUnit 2.9.2.

The CI workflow (`.github/workflows/ci.yml`) runs all of these on every push. **It has not run on GitHub yet**; nothing here claims that it has.

## 4. Not tested yet (and why)
- **The production Docker build (`api/Dockerfile`) was not completed here.** Inside `docker build`, this sandbox can't reach nuget.org (`NU1301`, no proxy inside build containers). The image used in the end-to-end run was made from a host `dotnet publish` plus the same runtime stage. The full Dockerfile should be verified on the server or in CI.
- **Caddy / HTTPS / Cloudflare**: needs the real domain and VM.
- **Backup and restore scripts** (`infra/backup/`): written, not run. They need the R2 bucket and an age key pair (Phase 11 covers the restore test).
- **Real email delivery** through Resend: only Mailpit was used.
