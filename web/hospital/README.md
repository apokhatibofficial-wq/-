# Hospital web (`app.medlink.website`)
- Sign-in (2FA where required) and activation/reset links.
- **Booking Form Builder:** draft, preview, publish, versions, restore.
- **Bookings:** the day's list, lookup by full booking number, cancel with a reason.
- **Departments:** weekly timetables and closed days.
- **Bookings:** also check-in and status correction with a reason.
- **Settings:** booking link, hospital rules, users (including doctors and their departments), Windows devices.
- **Phone scanner at `/scan`** (`app.medlink.website/scan`): for the QR scanner, reception and hospital admin roles. Camera only after a tap; the browser's QR reader, or jsQR (Apache-2.0) where there is none. Results follow the design's table. Recent actions stay in memory only. The camera needs HTTPS (or localhost).

The Appointments board is in the Windows app. Designs: `docs/design/designs/`.

    cd web && npm ci && npm run dev -w @medlink/hospital   # http://localhost:5174
