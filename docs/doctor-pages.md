# Doctor pages (medlink.website/dr/…)

**Owner's decisions (2026-11-08):**
- a separate company product: the doctor is not tied to a hospital;
- the company writes every page; doctors have no account;
- the stars are set by hand by the company;
- the page has a call button, social links and ShamCash. There is no booking button.

The design is the owner's `medlink-DOCTOR_PROFILE.svg`.

## Using it
1. In `https://admin.medlink.website`, open **Doctors**, then **+ New doctor**. Only the Owner can do this; Support and Viewer can only look.
2. Fill in the page:
   - name, page link (e.g. `ahmad-khatib`), specialty and "about" text;
   - phone for the **Call now** button;
   - stars (or none) and the verified badge;
   - links (Instagram, WhatsApp, Facebook, LinkedIn, Telegram, TikTok, X, YouTube, website, Google Maps);
   - the ShamCash account number.
3. Choose a photo. It is resized in the browser before upload (900 px, JPEG, at most 400 KB).
4. Turn on **Published** and save. The page is then at `https://medlink.website/dr/ahmad-khatib`. The **Copy** button copies the link.

An unpublished page answers "page not found" to everyone outside the company.

## How it is built
- **Database:** migration `0009_doctor_profiles.sql`. The table `doctor_profiles` keeps the photo inside the database: there is no separate file store.
  - Row-level security: only the company scope writes; the public (system) scope only reads; hospital sessions see nothing.
- **API** (`supabase/functions/api/src/routes/doctors.ts`):
  - `GET /admin/doctors`: permission ViewReports.
  - `POST`, `PATCH`, `DELETE /admin/doctors/{id}` and `PUT`, `DELETE /admin/doctors/{id}/photo`: new permission `DoctorProfilesManage` (Owner).
  - Public, published pages only: `GET /public/doctors/{slug}` and `GET /public/doctors/{slug}/photo?v={revision}`.
  - Every change is written to the audit log.
- **Safety:**
  - Links must be `https://`, so `javascript:`, `data:` and `http:` are refused. A WhatsApp phone number becomes `https://wa.me/…`.
  - The photo type is read from its bytes: only JPEG or WebP is accepted, so SVG and HTML are refused. Photos are served with `nosniff` and a sandbox CSP.
  - The public answer has no ids or dates.
- **Caching:** a photo URL carries its revision, so browsers keep it for a year, and a new photo gets a new URL. Every other API answer stays `no-store`.
- **Page:** `web/booking/src/DoctorPage.tsx`, in Arabic and right to left, like the design. The booking site's CSP now allows images from `https://api.medlink.website`.

## Tests
- **API:** `tests/doctors.test.ts` (5 tests) and the endpoint sweep (7 new endpoints, each with its rule). They cover:
  - who may write;
  - refused input;
  - the database refusing a hospital or public session;
  - photo checks and caching;
  - unpublished pages hidden.
- **Browser (local, 2026-11-08):**
  - first-owner link, then sign-in with 2FA;
  - a doctor created in the console with a photo, 5 links and ShamCash;
  - the public page on a 412 px and a 360 px phone and on a desktop, with no sideways scrolling;
  - the ShamCash sheet, the call link `tel:+963944000000`, and the "page not found" page.

## Differences from the design (to confirm)
- **Font:** the site's own font, IBM Plex Sans Arabic (self-hosted), instead of the design's decorative Arabic font. The design's font file was not provided, and its licence is unknown.
- **Icons:** simple drawn icons in the design's blue. ShamCash uses a wallet icon, not its logo.
- **The two unlabeled circles in the design** are left out: other links take their place.
