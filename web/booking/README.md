# Patient booking site (`medlink.website/book/{slug}`)
Phases 5–6. Design: `docs/design/designs/Patient Booking.dc.html`, spec: `docs/design/SCREENS.md` §1.
The API already resolves booking links: `GET /public/book/{slug}` → 200 (active), 301 (renamed within 90 days), 410 (link changed), 404.
