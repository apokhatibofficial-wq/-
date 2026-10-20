# Hospital web (`app.medlink.website`)
- Sign-in (2FA where required) and activation/reset links.
- **Booking Form Builder:** draft, preview, publish, versions, restore.
- **Bookings:** the day's list, lookup by full booking number, cancel with a reason.
- **Departments:** weekly timetables and closed days.
- **Settings:** booking link, hospital rules, users.

Coming next: the Appointments board and phone QR scanner (phases 7–9). Designs: `docs/design/designs/`.

    cd web && npm ci && npm run dev -w @medlink/hospital   # http://localhost:5174
