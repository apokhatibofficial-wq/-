# MEDLINK — Requirements Summary (condensed from the owner's Arabic master brief)

## Working rules with the owner
- Ask before making key decisions. Group related questions, explain the options and recommend one.
- Work in phases. After each phase, report the files created or changed and the tests that **actually** passed or failed.
- Never invent keys, secrets or credentials, and never ask the owner to paste real secrets into chat.
- Never claim something works without running it.

## Identity
- Product: **MEDLINK — Smart Hospital Appointment System**. Parent company: **KHATIB TECHNICAL SOLUTIONS — الخطيب للحلول التقنية**.
- Use the original logos in `designs/assets` and `brand-source`. **Do not regenerate or alter them.**
- Blue and white identity, consistent across the Windows app, company console, hospital web, booking site and phone page.
- Arabic RTL by default, plus English and Turkish.

## Out of scope / forbidden
- Do not collect diagnoses, medical files or sensitive health data without the owner's explicit approval and a privacy review.
- No patient name or personal data inside the QR code.
- No default accounts or fixed passwords, anywhere. See BACKEND-SPEC §0.
- No secrets in front-end code or in the repo.
- Never change a password based on a WhatsApp message alone.
- No real patient data in development or tests.

## Phases
1. Requirements ✔
2. Identity & UI ✔ (designs in this package)
3. Architecture & DB ✔ (approved, fully free plan)
4. **Auth, permissions, company console ← next**
5. Hospital management & unique links
6. Dynamic booking, form builder, versions
7. Sync & local SQLite
8. Windows app & splash animation
9. Phone page & QR scanner
10. Automatic no-show & password recovery
11. Tests, security, backups
12. Installer, documentation, deployment

Do not start a phase that depends on a decision the owner has not approved.

## Required deliverables (by the end)
- Source code: front-ends, API and background services.
- DB schema and migrations.
- Windows app and the phone QR page.
- Tests, with actual results recorded.
- Secure config: `.env.example` and `.gitignore`.
- README, plus:
  - run and development instructions;
  - deployment instructions;
  - how to generate secrets locally;
  - Windows build and installation;
  - backup and restore procedure;
  - free-tier limits and costs.
