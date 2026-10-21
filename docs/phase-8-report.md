# Phase 8 report: the Windows app and the splash animation

**Date:** 2026-10-21 · **Branch:** `claude/clever-noether-tt7hdg` · **Status:** done, waiting for the owner's review before Phase 9.

Real test results: [`test-results.md`](test-results.md) (Phase 8 section). Screenshots taken on Windows by CI: [`screenshots/phase-8/`](screenshots/phase-8/).

## Owner decisions applied
| Decision | Where |
|---|---|
| Test on Windows through GitHub Actions, then a short manual checklist | New CI job `windows-app` (`windows-latest`): it builds the app, runs the real window against a local fake server with fictional data, checks it, and saves a screenshot of every screen. The manual checklist is below. |
| Stay signed in within the server's limits | The token is saved, protected by DPAPI (`session.bin`), and checked again at every start. If the server is unreachable, the local copy opens with the offline banner. If the session or the PC was revoked, sign-in appears with a notice. |
| Doctors' screen = the same list, read-only, their departments only, no phones, no buttons | The server sends doctors only their departments, without phone numbers. The screen hides check-in and correction and shows a "view only" note. |

## What was built
**`windows/MedLink.App.Core`** holds the app's logic, with no WPF, so it is tested here against the real API:
- Sign-in with email and password, then the 6-digit code step for accounts with 2FA. Errors never say which field was wrong, the lockout message comes from the server, and sign-in is disabled while offline.
- The saved session, and one encrypted local database per MEDLINK user, so a doctor never sees reception's cached data on a shared PC. Each PC is registered once as a device and shared by all its users.
- Background sync: send waiting updates, then wait up to 25 s for changes, so a QR check-in from a phone appears live with a notice. A local check-in is sent at once instead of waiting.
- The dashboard:
  - ‹ Today ›, and a search by name or booking number within the day's list;
  - status chips with counts and a department filter;
  - the table;
  - the detail panel: the status source, check-in, a correction with a reason of at least 5 characters, and the history.
- Find booking by the full number, the Sync page (pending count, last sync, updates the server rejected), and Settings (language, device, server address read-only, version).
- Signing out:
  - It deletes the user's local copy when nothing is pending.
  - If check-ins are still unsent, it warns first and keeps the encrypted copy until that user signs in again.
- Strings in AR, EN and TR. The design's text is used verbatim, and new text follows its tone.

**`windows/MedLink.Windows`** is the WPF window (`MEDLINK.exe`). It only draws the core.
- **Window:** a 36 px title bar (#f3f4f8) with the icon, the title, and minimize / maximize / close (close hover #c42b1c).
- **Splash:** built from the timings in SCREENS.md (80 / 1250 / 1650 / 2700 / 3150 ms, cubic-bezier(.2,.7,.2,1), progress bar 180×3 at 56 px from the bottom). It follows Windows' "Animation effects" setting for the reduced version.
- **Sign-in:** the design's split layout, with:
  - the connection pill;
  - Show/Hide for the password, and the Caps Lock warning;
  - the forgot-password dialog with the prepared WhatsApp message (username and hospital only, to wa.me/4368181700732);
  - read-only connection settings with a test button.
- **Dashboard:** the design's layout:
  - nav 208 px (168 px below 1100 px wide), with a pending badge on Sync;
  - toolbar with the sync pill (green, amber or blue) and the offline banner;
  - table columns as specified;
  - detail panel 340 px (290 px when narrow).
- Arabic is right-to-left and English/Turkish left-to-right.
- **Logos:** the original SVG files are drawn unchanged, never mirrored, as WPF drawings (read with SharpVectors, BSD-3-Clause).
- **Fonts:** IBM Plex Sans Arabic and IBM Plex Mono, SIL Open Font License.

**Server:**
- The sync pull now includes each booking's history and booking time, so the detail panel works offline.
- A correction reason now needs at least 5 characters (the design's rule), on the web too.

## Bugs the Windows screenshots found (fixed)
The first Windows run passed all of its automatic checks, but the screenshots showed real problems. The run now checks for each of them:
1. **The MEDLINK and KHATIB logos were mirrored in Arabic** (the right-to-left layout flipped the SVGs). Every logo is now laid out left to right, and a check enforces it.
2. **Many labels were empty.** WPF can only bind to properties, and the strings were fields. They are now properties, a test forbids fields, and the Windows run fails on any WPF binding error.
3. **The title-bar buttons showed empty boxes** (the icon font is missing on the server). They are drawn as shapes now.
4. **Primary-button text was dark on blue** (an app-wide text style overrode the button's colour). Fixed and checked.
5. **The phone number and date were reversed in Arabic**, and the history time wrapped onto two lines.
6. **The department filter went blank after a language change.** Fixed, with a test.
7. **The KHATIB logo on the splash was pushed off the top**, and on sign-in it sat about 110 px too high. The SVG viewer control mishandled that file's negative viewBox origin. Logos are now read from the original files into WPF drawings, so the origin no longer matters. A pixel check confirms that each splash logo is drawn in the middle; it took three attempts, and the check caught the two that didn't work.

**Final Windows run: 30 of 30 checks passed** (see test-results).

## Decisions I made (please confirm or correct)
1. **Sign-in uses the email address** (the design says "username"). Accounts are email-based everywhere else.
2. **No "attempts left: n" in the error message.** Showing a count would reveal that an account with that email exists. The design's sentence is used without the count.
3. **The server address is set at installation** (or with `--server`). It is shown read-only on the connection-settings screen, so nobody can point the app at another server from the screen.
4. **The day's list can be searched by name** (as in the design), but only inside the list already on screen. **Find booking** stays full booking number only, as on the web.
5. **Arabic dates use the Syrian month names** (e.g. «تشرين الأول»). The web shows «أكتوبر». Tell me which one you prefer.

## Known limits
- **Not yet tested on a real hospital PC.** The CI run uses Windows Server with a fake server. The manual checklist below covers what remains.
- **Phase 12:** the installer (MSIX), the `.exe` icon and the Ed25519-verified updates.
- **Phase 9:** the QR scanner. Its check-ins already appear live in this app.
- **Phase 10:** the automatic no-show. The app already shows it ("automatically by server").

## Manual checklist (once, on a hospital PC, after the installer in Phase 12, or earlier with a build from me)
1. The splash plays. With *Settings › Accessibility › Animation effects* off, the reduced version plays.
2. Sign in with a reception account. Close the app and open it again: you are still signed in.
3. Unplug the network: the banner and amber pill appear. Check in a patient (⟳ appears). Plug the network back in: the patient is shown on the web as arrived.
4. Sign in with a doctor account: your departments only, no phone numbers, no buttons.
5. Revoke the PC from the hospital settings on the web: the app returns to sign-in with a notice.

## Questions for Phase 9 (phone page and QR scanner)
1. **Who uses the phone scanner?** The "QR scanner" role only, or also reception and the hospital admin from their phones?
2. **Address:** the design says `app.medlink.website/scan`. Is that the address you want, and will you host it on Cloudflare Pages like the booking site?
3. **Camera:** the design uses the browser's built-in QR reader, with a bundled reader as a fallback (needed on iPhone). Do you agree to bundle a small open-source reader (jsQR, Apache 2.0)?
