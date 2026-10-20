# MEDLINK API (ASP.NET Core 8)

```
medlink migrate                          # apply SQL migrations as the DB owner
medlink bootstrap-admin --email <addr>   # first company owner + single-use setup link (once only)
medlink                                  # run the API on :8080
```

- `src/MedLink.Api/Data/Migrations/*.sql`: versioned migrations, applied in order and checksum-locked (never edit an applied file).
- `Auth/`: Argon2id, TOTP, sessions, one-time links, the permission matrix.
- `Endpoints/`: `/auth/*`, `/admin/*` (company scope), `/hospital/*` (hospital scope, from the session only), `/public/book/{slug}`.
- `tests/`: xUnit + Testcontainers (PostgreSQL 16). Needs Docker. Set `MEDLINK_TEST_PG_IMAGE` to use another image or mirror.
