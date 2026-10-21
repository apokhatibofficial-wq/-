# Acceptance tests: where each one is covered

The 25 acceptance tests of [`design/BACKEND-SPEC.md`](design/BACKEND-SPEC.md) §7, and the real tests that cover them (Phase 11). API tests are in `api/tests/MedLink.Api.Tests`, run in CI on every push; browser runs and the Windows run are listed in [`test-results.md`](test-results.md).

| # | Acceptance test | Covered by | Status |
|---|---|---|---|
| 1 | Create a hospital account and sign in | API: "Acceptance 1: create a hospital account…"; browser runs of phases 4–10 | ✅ |
| 2 | Unauthorised users cannot reach the dashboards | API: "Acceptance 2: without signing in, every non-public endpoint answers 401" (all 52); "Acceptance 2/25"; the web pages show sign-in | ✅ |
| 3 | A hospital cannot read another hospital's data | API: "Acceptance 3" (API with tampered IDs; row-level security); RLS tests for bookings, departments, devices and events | ✅ |
| 4 | Each hospital gets a unique booking link | API: "Acceptance 4"; concurrent slug creation; slug change and 301 | ✅ |
| 5 | Book an available slot | API: "Acceptance 5/8"; browser run of phase 6 | ✅ |
| 6 | The same slot cannot be booked twice at the same time | API: "Acceptance 6" (10 parallel requests) | ✅ |
| 7 | Re-submitting does not create a duplicate | API: "Acceptance 7" (Idempotency-Key) | ✅ |
| 8 | Generate and verify the QR code | API: "Acceptance 5/8" and the scan tests; browser run of phase 9 (real camera path with a fake camera) | ✅ |
| 9 | Check-in happens only once | API: "Scan: … scanning again says already …"; sync "a retried push is applied once"; Windows sync tests | ✅ |
| 10 | No-show is recorded after the grace period | API: "Acceptance 10"; browser run of phase 10 (real stack, within a minute) | ✅ |
| 11 | An authorised user can correct attendance | API: sync corrections; attendance policy tests; endpoint sweep (who may not); browser runs of phases 7 and 10 | ✅ |
| 12 | A newly published question appears on the booking link | API: "Acceptance 12/14"; browser run of phase 6 | ✅ |
| 13 | Required and optional fields behave correctly | API: "Acceptance 13" | ✅ |
| 14 | Previewing the draft does not affect the live form | API: "Acceptance 12/14" | ✅ |
| 15 | Publishing requires confirmation | API: "Acceptance 15" (blockers); browser run of phase 6 (confirmation dialog) | ✅ |
| 16 | A failed publish keeps the live version | API: "Acceptance 16" | ✅ |
| 17 | Restoring an old version publishes it as a new version | API: "Acceptance 17" | ✅ |
| 18 | Forms already open during a publish are handled | API: "Acceptance 18" (2 hours) | ✅ |
| 19 | Sync works after an internet outage | API: Windows sync "offline check-in … syncs once the network returns"; sync "offline check-in received after the automatic no-show wins"; Windows CI run (offline check-in) | ✅ |
| 20 | Attendance conflicts are resolved | Attendance policy tests (6); sync conflict tests | ✅ |
| 21 | No secret leaks in the repo or logs | API: "Acceptance 21"; gitleaks in CI; log checks in every browser run | ✅ |
| 22 | Passwords are protected | API: "Password storage: Argon2id …"; lockout; weak passwords refused | ✅ |
| 23 | Backup and restore work | CI job `backups` (`infra/backup/ci-test.sh`): backup, monthly test, restore with the private key, disaster recovery | ✅ (with an S3 mock; the real R2 bucket is tested at deployment, Phase 12) |
| 24 | Mobile, desktop and RTL layouts work | Browser runs with screenshots (phones 390×844 for the booking site and scanner, desktop for the others; Arabic RTL and English/Turkish LTR); Windows CI screenshots | ✅ by screenshots; not yet on real phones (manual checklist in the Phase 9 report) |
| 25 | Permissions are enforced on the server, not only in the UI | API: the endpoint sweep (fixed table of every endpoint's rule; 267 refusals as all 7 roles); role-matrix tests | ✅ |
