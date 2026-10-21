# MEDLINK for Windows: installation guide for hospital IT

**Requirements:**
- Windows 10 version 2004 or later, or Windows 11, 64-bit;
- outgoing HTTPS (443) to `api.medlink.website` and `downloads.medlink.website`.

Nothing else is needed: .NET is included in the package.

**You receive from KHATIB TECHNICAL SOLUTIONS:**
- `medlink-signing.cer`: the publisher certificate;
- `MEDLINK-x.y.z.msix`: the app;
- `install-medlink.ps1`;
- the certificate's **thumbprint**, given to you by phone or in person, not by email or WhatsApp.

## Install (once per PC, as administrator)
```powershell
powershell -ExecutionPolicy Bypass -File install-medlink.ps1 -Cer medlink-signing.cer -Msix MEDLINK-x.y.z.msix -ExpectedThumbprint <thumbprint>
```
The script:
1. checks the certificate (publisher and thumbprint);
2. trusts it on this PC only for app packages ("Trusted People");
3. installs MEDLINK for every Windows user of the PC.

MEDLINK is signed with KHATIB's own certificate (not one bought from an authority), which is why step 2 is needed. For many PCs, the same two steps can be pushed by Group Policy or Intune.

## First start
- **Sign-in:** staff use their own MEDLINK account (email, password and, for admins, the 6-digit code).
- **The PC:** it registers itself once as a device of the hospital. The hospital admin sees it, and can revoke it, under Settings › Devices in the hospital web.
- **Local data:**
  - kept encrypted, per Windows user, under `%LOCALAPPDATA%\MEDLINK` (MSIX keeps it inside the package's own folder);
  - nothing is stored in the installation folder;
  - uninstalling removes it.

## Updates
- The app checks for a new version a minute after it starts and every 6 hours.
- It installs a version only when:
  - it is signed with KHATIB's update key;
  - it matches the published checksum.
- A banner then says the update installs the next time MEDLINK opens. "Close to update" closes the app; unsent check-ins are kept and sent afterwards.

## Uninstall
Settings › Apps › MEDLINK › Uninstall, or `Get-AppxPackage KhatibTechnicalSolutions.MEDLINK | Remove-AppxPackage`. To remove it for all users: `Remove-AppxProvisionedPackage -Online -PackageName <name>`.

## Security notes
- Do not share Windows accounts between staff when you can avoid it. MEDLINK keeps each MEDLINK user's data separate, but the PC's own security (screen lock, updates, antivirus) is the hospital's responsibility.
- A PC that is lost or replaced: ask the hospital admin to revoke it under Settings › Devices.
