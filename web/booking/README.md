# Patient booking site (`medlink.website/book/{slug}`)
Phase 5: the hospital page with its visible departments; renamed links follow the 90-day redirect policy; "link changed" and "not found" pages.
Phase 6 adds the booking steps from `docs/design/designs/Patient Booking.dc.html`.

- The app calls `GET /public/slugs/{slug}`, which never redirects.
- `functions/book/[slug].js` is a Cloudflare Pages Function. It turns the API's `GET /public/book/{slug}` 301 into a real HTTP 301 for browsers and crawlers. Set `API_ORIGIN` in the Pages project.

    cd web && npm ci && npm run dev -w @medlink/booking    # http://localhost:5175/book/<slug>
