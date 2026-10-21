# For hospital IT, on each PC, as an administrator:
#   powershell -ExecutionPolicy Bypass -File install-medlink.ps1 -Cer medlink-signing.cer -Msix MEDLINK-0.9.0.msix
# 1. Trusts KHATIB TECHNICAL SOLUTIONS' package certificate on this PC (Trusted People, for all users). This is
#    needed once: MEDLINK is signed with its own certificate, not one bought from a certificate authority.
# 2. Installs MEDLINK for every user of the PC (provisioned), so each Windows user finds it in the Start menu.
# Later versions update themselves (signed with the same certificate and verified by the app).
param(
  [Parameter(Mandatory)] [string] $Cer,
  [Parameter(Mandatory)] [string] $Msix,
  [string] $ExpectedThumbprint = ''
)
$ErrorActionPreference = 'Stop'
$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 (Resolve-Path $Cer).Path
if ($cert.Subject -ne 'CN=KHATIB TECHNICAL SOLUTIONS') { throw "Unexpected certificate subject: $($cert.Subject)" }
if ($ExpectedThumbprint -and $cert.Thumbprint -ne $ExpectedThumbprint.ToUpperInvariant()) { throw "Certificate thumbprint $($cert.Thumbprint) is not the one KHATIB gave you" }
Write-Host "Certificate: $($cert.Subject), thumbprint $($cert.Thumbprint), valid until $($cert.NotAfter.ToString('yyyy-MM-dd'))"
Import-Certificate -FilePath $Cer -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople' | Out-Null
Add-AppxProvisionedPackage -Online -PackagePath (Resolve-Path $Msix).Path -SkipLicense | Out-Null
Add-AppxPackage -Path (Resolve-Path $Msix).Path
$p = Get-AppxPackage -Name 'KhatibTechnicalSolutions.MEDLINK'
Write-Host "Installed MEDLINK $($p.Version) for this PC."
