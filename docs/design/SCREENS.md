# MEDLINK: Screen Specifications

Every screen supports **AR (default, RTL) / EN / TR**, switched with a segmented pill (`عربي | EN | TR`). The exact copy for each language is in the `T` objects of each prototype's logic class; use those strings verbatim.

---

## 1. Patient Booking (`/book/{slug}`)
**Purpose:** a patient books an appointment without installing anything.
**Layout:**
- White header bar with: a 44px hospital logo slot (each hospital uploads its own), the hospital name, "Book an appointment", and the language pill.
- Main area: `max-width:1040px`. A 5‑step progress bar (4px bars plus labels), then a flex‑wrap row: the step card (`flex:1 1 520px`, white, radius 16, padding `clamp(16px,5vw,28px)`) and a summary aside (`flex:1 1 260px`). On mobile the aside drops below the card.
- Footer: "Powered by" plus the MEDLINK logo (44px tall), and the KHATIB logo.

**Steps:**
1. **Details:** full name (required, min 2 chars, max 80); phone (optional; `^\+?\d{7,15}$` after removing spaces, dashes and brackets); hint saying it is used only to contact the patient about this appointment.
2. **Department:** grid `repeat(auto-fill,minmax(min(100%,200px),1fr))` of 64px‑tall cards. Selected card: border `#2b41c5`, bg `#eef1fc`, ✓ mark. Only departments the hospital has enabled are shown.
3. **Questions:** rendered from the **published form version**. Supported types: single choice, multiple choice (☐/☑ chips), yes/no, short text (max 120 chars, with a counter), long text, date. Required questions are tagged "Required" in red; optional ones "Optional" in muted. Show the form version number (e.g. "Form version 3").
4. **Date & time:** a horizontal strip of 14 day cards (78×92). Each card shows the weekday, day number, and "n open" / "Closed" / "Full"; closed and full days are disabled at 50% opacity. Below it, a grid of time chips (min 80px wide, 44px tall). **Only available slots are shown.**
5. **Review:** rows of label/value pairs with "Edit" links that jump back to the step, plus a privacy note ("do not enter medical information"). The button reads "Confirm booking" and changes to "Confirming…" while disabled.
6. **Confirmation:**
   - A ✓ badge, then a ticket card (max 420px) with:
     - header (bg `#1a2d99`): hospital name, "Appointment confirmation";
     - body: patient name, date, time, department;
     - a dashed divider, then a 200px QR code, "Booking number" and the reference (24px/700, letter-spacing .08em).
   - A warning box: *save or print now; it can't be shown again.*
   - Buttons: **Save image** (a 1080×1500 PNG drawn on canvas) and **Print**. A link: "Book another appointment".
   - Note: the QR code contains no personal data.

**Errors:** if the slot is taken at confirm time, return to step 4 with an amber banner ("that time was just booked…") and remove that slot from the list. Field errors appear inline in `#b42318` at 13px.

**QR content:** an opaque token only, `MLK1.` followed by 22 random base64url characters (≥128 bits). The booking reference format is `ML-` followed by 6 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`.

---

## 2. Booking Form Builder (hospital web, `app.`)
**Layout:**
- Dark sidebar (`#0f1a4a`, 236px) with the white MEDLINK logo; the active nav item has bg `#2b41c5`. Below 860px the sidebar becomes a top bar.
- Title row: the title, the language pill, and two buttons: **Preview form** (secondary) and **Publish form** (primary; disabled when the draft has no changes).
- Status strip:
  - a green dot with "Live version vN", the date and the publisher;
  - an amber dot with "Draft: n unpublished changes" and a "Discard draft" link;
  - the booking URL.
- Tabs: **Editor** and **Versions (n)**.

**Editor:**
- Each question is a card with: a drag handle ⋮⋮ (HTML5 drag-and-drop), its number, label, type tag, Required/Optional tag, and a "New", "Edited" or "Missing translation" badge.
- Card buttons: ↑ ↓ Edit/Done ×.
- The expanded card shows:
  - answer-type chips (6 types);
  - question text in **3 inputs (AR, EN, TR)**;
  - for choice types, option rows with 3 inputs each, plus "Add option";
  - a Required toggle switch (40×24).
- Right panel: "Add a question" (6 type buttons), and a yellow note: "Don't collect medical data".

**Preview:**
- Full-screen overlay with a Phone (390px frame, 8px `#0f1a4a` border, radius 28) / Desktop (960px) toggle.
- It renders the booking "Questions" step with the draft (or a selected version) and validates required questions.
- **It never creates a booking or sends any data.**

**Publish confirmation dialog:**
- Shows counts of Added (green), Edited (blue) and Removed (red) questions, and the new version number.
- Blocking errors: every question needs Arabic text, and every choice question needs at least 2 options.
- Buttons: **Back to editing** and **Confirm publish** (reads "Publishing…" while busy).
- On failure, show a red banner: *nothing changed; vN is still live and the draft is saved.*
- On success, show a toast: "Version vN is live…".

**Versions tab:**
- Versions are listed newest first. Each row shows: a vN badge (green if live), the change summary or "Restored from vX", the date, publisher, question count and "← v(N‑1)".
- Actions: **Preview** and **Restore** (not available on the live version).
- Restoring opens a dialog: *"v1 will be published as new v5; all earlier versions stay."* If the draft has unpublished changes, the dialog warns that they will be replaced.

---

## 3. Windows App (WPF)
**Window:** a 36px title bar (`#f3f4f8`) with the MEDLINK icon (18px), the title, and min / max / close buttons (close hover `#c42b1c`).

**Splash** (respect *Settings › Accessibility › Animation effects*, which maps to `prefers-reduced-motion`):
| t (ms) | Event |
|---|---|
| 80 | KHATIB white logo fades in and rises (opacity 0→1 over 520ms, translateY 10→0 and scale .96→1 over 700ms, `cubic-bezier(.2,.7,.2,1)`). Progress bar 28% |
| 1250 | KHATIB fades out, moving up 14px and scaling to 1.02. Bar 62% |
| 1650 | MEDLINK white logo fades in and rises from 14px. Bar 100% |
| 2700 | Splash fades out (420ms) to sign‑in |
| 3150 | Splash removed |

The background is `#1a2d99`. The bar is 180×3, white on 18% white, 56px from the bottom. With reduced motion: MEDLINK appears at 50ms, the fade starts at 700ms, and the splash is removed at 1150ms; there is no movement.

**Sign‑in:**
- Split layout:
  - left pane (`#1a2d99`): white MEDLINK logo (300px), a description line, and at the bottom the KHATIB logo and the version;
  - right pane: the form.
- Above the form, a connection pill (green "Connected to server" / amber "No internet connection").
- Username and password fields; the password has a Show/Hide toggle and a Caps Lock warning.
- **The error message never reveals which field was wrong.** After 5 failed attempts, show a lockout message (15 minutes, enforced by the server).
- Sign‑in is disabled while offline.
- "Forgot password?" opens a dialog with the prepared WhatsApp message (username and hospital only), a warning not to send any secrets, and an **Open WhatsApp** button linking to `wa.me/4368181700732`.

**Appointments dashboard:**
- Left nav (208px; 168px below 1100px wide): Appointments, Find booking, Sync (shows a pending-count badge), Settings. User and role at the bottom, plus Sign out.
- Toolbar: ‹ Today › with the date label; search by name or booking number; and a sync pill:
  - green "Online · synced";
  - amber "Offline · n pending";
  - blue "Syncing…".
- When offline, an amber banner explains that check‑ins are stored locally and sent when the connection returns.
- Filter chips: All, Awaiting, Arrived, No‑show, each with a count. Department select. Note: "Server marks no‑show automatically after 30 min".
- Table columns: `52px | minmax(120px,1.6fr) | minmax(90px,1fr) | 78px | 112px | 52px` = Time, Patient, Department, Booking no., Status chip (+ ⟳ if pending sync), Check‑in.
- Detail panel (340px; 290px when narrow):
  - name, reference, status chip and source ("via QR scanner", "manually at reception", "automatically by server", "by manual correction");
  - facts;
  - **Check in manually** (only for awaiting bookings, today);
  - **Correct status:** a target chip plus a reason of at least 5 characters. Corrections are audit-logged;
  - history timeline.
- Live push: a QR check‑in from a phone appears without a refresh (SignalR, or long‑poll over the sync endpoint).

---

## 4. Phone QR Scanner (`app.medlink.website/scan`)
**Layout:**
- Single column, `max-width:440px`.
- Sticky header: MEDLINK icon, hospital name, connection dot and status line, language pill.
- Two modes: **Scan QR** and **Booking no.**

**Scan mode:**
- Square viewfinder (`#0b1230`, radius 18) with a 14% inset frame, white 4px corners and an animated scan line.
- Before the camera starts: an explanation and a **Turn on camera** button. Call `getUserMedia({video:{facingMode:'environment'}})` only after the tap.
- Decode with `BarcodeDetector` where available; otherwise bundle a decoder (e.g. zxing‑wasm or jsQR).
- If permission is denied or no camera exists, show a message with a "Search by booking number" link.

**Result card** (role="status"; vibrate 60ms):
| State | Colour | Icon | Shows details? |
|---|---|---|---|
| Checked in | green | ✓ | yes, plus check‑in time |
| Already checked in at HH:MM | amber | ! | yes |
| Appointment on another day | amber | ! | yes |
| Cancelled | red | ✕ | yes |
| Belongs to another hospital | red | ✕ | **no** |
| Unknown or expired code | red | ✕ | no |
| No booking with that number | red | ? | no |
| Offline (server verification required) | amber | ! | no |

**Manual lookup:**
- Only the **full** booking number is accepted; name search is not allowed.
- If found, show the booking first. The staff member confirms the patient's identity, then taps **Check in**.

**Recent:** the last 5 actions.
**Session:** expires after 12 hours. Tokens must never appear in the URL.

---

## 5. Company Console (`admin.medlink.website`)
**Layout:** dark sidebar (240px; 184px below 1100px wide) with the MEDLINK and KHATIB white logos and a user card ("Owner · 2FA"). Tabs: Hospitals, Reports, Audit log, Roles & permissions.

**Hospitals tab:**
- Search box; status chips (All, Active, Suspended, Awaiting activation).
- Table: `minmax(160px,1.5fr) | minmax(150px,1.2fr) | 96px | 120px | 76px`:
  - name plus internal ID (monospace);
  - `/slug` plus a Copy button (shows "Copied" for 1.5s);
  - status chip;
  - sync state (green "n min ago", amber "n h behind", red when more than 24h behind, grey "Never connected");
  - user count.

**Create hospital dialog:**
- Fields: name AR (required), EN (required), TR, admin email.
- The slug is auto‑generated from the English name and can be edited. Validation: `^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$`; it must not be reserved, used, or a retired slug.
- The internal ID is generated (`hsp_` + ULID).
- **No password is created.** A one‑time activation email is sent (valid 24h); the admin sets their own password and enables 2FA.

**Edit drawer** (460px, slides from the inline end):
- internal ID with "🔒 Fixed";
- display name in 3 languages;
- slug editor with the policy text and a list of old slugs;
- Save button;
- facts: bookings (30 days), users, created date, last sync;
- **Recover admin access…**: a 3‑item identity checklist must be fully ticked before the server will issue a 1‑hour reset link by email. All sessions are revoked;
- **Suspend / Reactivate…**: requires a reason. Suspending revokes all sessions and stops new bookings; the data is kept.

**Reports:** KPIs (total bookings, average attendance, active hospitals) and a per-hospital table with an attendance bar. Never shows patient data.
**Audit log:** read‑only list of time, action tag, target and actor.
**Roles:** two permission matrices (company and hospital), shown in the prototype.
