# Creates MEDLINK's self-signed package-signing certificate (owner's decision: option c). Run ONCE, on the owner's
# own Windows PC, never on the server:   powershell -ExecutionPolicy Bypass -File new-signing-cert.ps1 -OutDir D:\medlink-keys
# Writes:
#   medlink-signing.pfx  the private key, protected by the password you type. Keep it offline (with the backup and
#                        update keys). Anyone holding it can sign packages that hospital PCs will trust.
#   medlink-signing.cer  the public certificate. Hospital IT installs it on each PC (install-medlink.ps1).
param(
  [Parameter(Mandatory)] [string] $OutDir,
  [string] $Subject = 'CN=KHATIB TECHNICAL SOLUTIONS',
  [int] $Years = 5
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
if (Test-Path (Join-Path $OutDir 'medlink-signing.pfx')) { throw "medlink-signing.pfx already exists in $OutDir: refusing to overwrite it" }
$password = Read-Host -AsSecureString 'Password for medlink-signing.pfx (long and unique; store it apart from the file)'
# Code signing (EKU 1.3.6.1.5.5.7.3.3), not a CA, RSA 3072, SHA-256.
$cert = New-SelfSignedCertificate -Type Custom -Subject $Subject -FriendlyName 'MEDLINK package signing' `
  -KeyUsage DigitalSignature -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 `
  -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}') `
  -NotAfter (Get-Date).AddYears($Years) -CertStoreLocation 'Cert:\CurrentUser\My'
Export-PfxCertificate -Cert $cert -FilePath (Join-Path $OutDir 'medlink-signing.pfx') -Password $password | Out-Null
Export-Certificate -Cert $cert -FilePath (Join-Path $OutDir 'medlink-signing.cer') | Out-Null
# The private key now lives only in the .pfx file.
Remove-Item -Path "Cert:\CurrentUser\My\$($cert.Thumbprint)" -DeleteKey
Write-Host "Created: $(Join-Path $OutDir 'medlink-signing.pfx') (private) and medlink-signing.cer (public)"
Write-Host "Subject: $Subject   Valid until: $($cert.NotAfter.ToString('yyyy-MM-dd'))   Thumbprint: $($cert.Thumbprint)"
