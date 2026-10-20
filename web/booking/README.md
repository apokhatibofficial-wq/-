# Patient booking site (`medlink.website/book/{slug}`)
The five booking steps from `docs/design/designs/Patient Booking.dc.html`: details, department, questions (the published form), date and time, and review. Then the confirmation ticket with its QR code, Save image (PNG) and Print.

- `GET /public/slugs/{slug}`: hospital page (never redirects).
- `GET /public/hospitals/{slug}/form` and `/availability?departmentId=`: published form and bookable slots.
- `POST /public/hospitals/{slug}/bookings` with an `Idempotency-Key` header: a retry never creates a duplicate.
- `functions/book/[slug].js`: Cloudflare Pages Function giving renamed links a real HTTP 301 (set `API_ORIGIN`).

    cd web && npm ci && npm run dev -w @medlink/booking    # http://localhost:5175/book/<slug>
