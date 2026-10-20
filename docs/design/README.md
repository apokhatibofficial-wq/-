# Handoff: MEDLINK — Smart Hospital Appointment System

Owner: **KHATIB TECHNICAL SOLUTIONS — الخطيب للحلول التقنية**
Status: design phase (phases 1–3) approved on 2026‑10‑20. Next step is **Phase 4: auth, permissions, company console**.

## Overview
MEDLINK has five parts that work as one system:
1. **Company console**: KHATIB creates and manages hospital accounts.
2. **Hospital Windows app**: appointments dashboard, check‑in, offline sync.
3. **Patient booking site**: one unique link per hospital.
4. **Phone QR check‑in page**: staff scan the patient's QR code.
5. **Central backend**: auth, roles, bookings, form versions, attendance, sync, audit.

Phase 4 is only one step of a larger plan. The full requirements (Arabic, from the owner) are in `REQUIREMENTS-SUMMARY.md`. **Hard rules:**
- Never claim a feature works or a test passed without running it.
- Ask the owner before any decision not covered here.
- Never put secrets in code, the repo, chat, or WhatsApp.

## No demo accounts
This package contains **no accounts, credentials or seed users**. Wherever a prototype needs an identity, it shows the placeholder `user@example.com`; never create that account. Accounts are created only by the one-time admin bootstrap and the activation-link flows (see `BACKEND-SPEC.md` §0). The prototypes' sign-in accepts any password of 8+ characters to simulate success; this is only a design mock and must not be copied.

## About the design files
The files in `designs/` are **design references built in HTML**. They are working prototypes that show the intended look, copy and behaviour. They are **not production code**. Recreate them in the approved stack (below). Open any `*.dc.html` file in a browser: it needs `support.js` next to it and an internet connection for Google Fonts.

All data in the prototypes is fake. Every "server" behaviour is simulated in the browser with `setTimeout`. Each prototype has a small props/tweaks block (`data-props`) with simulation switches, for example `simulateConflict`, `simulatePublishFailure`, `simulateOffline` and `startSignedIn`.

## Fidelity
**High fidelity.** Colours, type, spacing, copy (AR/EN/TR) and interactions are final. Match them closely using the target framework's normal patterns.

## Approved decisions
| Topic | Decision |
|---|---|
| Domain | `medlink.website`. Subdomains: `book.`/root for patients, `app.` (hospital web + scanner), `admin.` (company), `api.` |
| Booking URL | `https://medlink.website/book/{slug}` |
| Languages | **Arabic default (RTL)**, English, Turkish. Switchable on every surface |
| Scale | 20–100 hospitals in year 1 |
| Hosting | **Fully free plan (owner accepted the risks):** one Oracle Cloud *Always Free* ARM VM running Docker (ASP.NET Core API + PostgreSQL + Caddy for HTTPS / Let's Encrypt). Cloudflare free for DNS, proxy and WAF. Cloudflare Pages free for static web front‑ends. Cloudflare R2 free for encrypted backups. Free transactional‑email tier (e.g. Resend) for activation and reset mail only. Check current free‑tier terms at sign‑up |
| Backend | **ASP.NET Core 8** (same language as the Windows app). PostgreSQL 16. EF Core migrations or plain SQL migrations |
| Windows app | **.NET 8 + WPF**, local **SQLite encrypted with SQLCipher**, MSIX package. **No code‑signing certificate** (no free option), so SmartScreen will warn. Hospital IT installs it and whitelists it. Updates must be verified with our own Ed25519 signature inside the app |
| Password hashing | **Argon2id** (e.g. Konscious.Security.Cryptography or libsodium). Never plaintext. No hard‑coded or default accounts. The first company admin is created by a one‑time CLI bootstrap command that prints a single‑use setup link |
| Attendance conflict policy | The earliest "arrived" time wins. "Arrived" beats an automatic "no‑show". A manual correction (with a reason) beats an automatic action. If two manual corrections conflict, the latest wins and the booking is flagged for review. **No attendance event is ever deleted**; status is derived from events |
| Slug change policy | The old slug redirects (301) for **90 days**, then shows a "this link has changed" page. The old slug stays **reserved forever**. At most one change per 30 days. Bookings are tied to the immutable internal hospital ID, not to the slug |
| Re-showing a booking confirmation | **Not offered.** The patient must save or print the confirmation image. The UI warns them clearly |
| Patient phone | Optional field |
| Data retention | Default **24 months**, then delete the patient name, phone and answers and keep aggregate stats. Each hospital may change the period |
| Hospital roles | Hospital admin, Reception, QR scanner. Company roles: Owner, Support, Viewer. See the matrix in the Company Console › Roles tab |
| Support WhatsApp | **+43 681 81700732** (Austria): `https://wa.me/4368181700732?text=…`. The prepared message never contains secrets. A WhatsApp message alone must never change a password; a company user completes an identity checklist, then issues a one‑time reset link by email |
| No-show grace | Configurable per hospital (default 30 min). Applied by a server background job, never by the Windows app |

## Files
- `designs/Patient Booking.dc.html`: patient booking flow and confirmation ticket with QR.
- `designs/Form Builder.dc.html`: hospital booking-form builder: draft, preview, publish confirmation, versions and restore.
- `designs/Windows App.dc.html`: splash animation, sign‑in, forgot password, appointments dashboard, offline sync and conflict.
- `designs/QR Scanner.dc.html`: phone staff sign‑in, camera scan, result states, manual lookup.
- `designs/Company Console.dc.html`: hospitals, create hospital, edit drawer, suspend, recover access, reports, audit, roles.
- `designs/Architecture.dc.html`: Phase 3 architecture document (Arabic). **Note:** sections 2–4 were first written for a Cloudflare Workers + Neon stack and later changed to the free plan in section 5. **Section 5 and the decisions table above are authoritative.** The data model and the mechanisms in sections 3–4 still apply unchanged.
- `designs/assets/`: logos extracted from the owner's originals (do **not** redraw or alter them):
  - `medlink-logo.svg` / `medlink-logo-white.svg`: full logo with tagline.
  - `medlink-icon.svg`: the three-dot link mark only (window title bar, favicon, app icon).
  - `khatib-logo.svg` / `khatib-logo-white.svg`: company logo.
- `brand-source/`: the owner's original files (`MEDLINK-LOGO.jpg` is the reference for MEDLINK colours).
- `SCREENS.md`: per-screen specifications.
- `BACKEND-SPEC.md`: data model, critical mechanisms, security, acceptance tests, Phase 4 scope.
- `REQUIREMENTS-SUMMARY.md`: condensed original requirements.

## Design tokens
**Colour**
| Token | Hex | Use |
|---|---|---|
| ink | `#0f1a4a` | headings, dark sidebars, toasts |
| brand-deep | `#1a2d99` | secondary buttons text, splash bg, ticket header |
| brand | `#2b41c5` | primary buttons, active states, focus |
| brand-bright | `#3149d6` | logo gradient end |
| logo letters | `#002f8a → #00053f` | MEDLINK wordmark gradient (per letter, left→right) |
| text | `#1c2340` | body |
| muted | `#5b6380` | secondary text (≥4.5:1 on white) |
| disabled | `#9aa6d8` | disabled primary button bg |
| border | `#dde2f0` / input `#c9cfe3` / divider `#eef0f6` / table head `#e3e6ef` |
| surface | `#ffffff`, page bg `#f4f6fb`, soft fill `#eef1fc`, table head `#f7f8fc` |
| success | text `#13795b` / dark `#0d5a43`, bg `#e7f6ee`, border `#9fd8bf` |
| warning | dot `#e8a317`, text `#7a4300` / `#6b4a00`, bg `#fff4e5` / `#fff8e6`, border `#f0d48a` |
| danger | text `#b42318` / dark `#8a1c12`, bg `#fdecea`, border `#f1b4ae` |
| accent gold | `#ffdf00 → #e8a317` | KHATIB logo dot only |

**Type**: `IBM Plex Sans` (Latin) + `IBM Plex Sans Arabic` (Arabic), as one stack. Use `IBM Plex Mono` / Consolas for IDs and booking numbers.
Sizes: 11, 12, 13, 14, 15 (body), 16 (inputs on mobile, never below 16), 17, 18, 20, 22, 24, 26 (page titles; fluid `clamp(20px,4vw,26px)`). Weights: 400, 500, 600 (labels/buttons), 700 (logo-adjacent, ticket ref).

**Radius**: 6 (Windows controls), 8 (inputs/small buttons), 10 (buttons/alerts), 12 (cards), 14–18 (patient cards, scanner results), 999 (pills/chips).
**Spacing**: 4‑pt based; common gaps are 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 28.
**Shadows**: cards `0 8px 28px rgba(26,45,153,.10)`; modals `0 20px 50px rgba(15,26,74,.25)`; Windows frame `0 24px 60px rgba(15,26,74,.28)`.
**Touch targets**: ≥44px on all mobile surfaces.
**RTL**: wrap every Latin product name, number run or ID inside Arabic text in `<bdi dir="ltr">`. Use logical properties (`inline-start`/`inline-end`).
