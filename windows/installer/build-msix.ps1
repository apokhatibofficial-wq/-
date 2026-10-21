# Builds and signs the MEDLINK MSIX. Run on a Windows PC with the .NET 8 SDK and the Windows SDK (makeappx, signtool):
#   powershell -ExecutionPolicy Bypass -File build-msix.ps1 -Version 0.9.0 -Pfx D:\medlink-keys\medlink-signing.pfx `
#     -UpdatePublicKey <UPDATE_SIGNING_PUBLIC_KEY> -OutDir D:\medlink-release
# The pfx password is read from MEDLINK_PFX_PASSWORD if set (CI), otherwise asked for. Output: MEDLINK-<version>.msix.
param(
  [Parameter(Mandatory)] [string] $Version,
  [Parameter(Mandatory)] [string] $Pfx,
  [Parameter(Mandatory)] [string] $UpdatePublicKey,
  [Parameter(Mandatory)] [string] $OutDir,
  [string] $UpdateFeed = 'https://downloads.medlink.website/windows/',
  [string] $Publisher = 'CN=KHATIB TECHNICAL SOLUTIONS'
)
$ErrorActionPreference = 'Stop'
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Version must be x.y.z' }
if ([Convert]::FromBase64String($UpdatePublicKey).Length -ne 32) { throw 'UpdatePublicKey is not an Ed25519 public key (base64 of 32 bytes)' }
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$stage = Join-Path ([IO.Path]::GetTempPath()) ("medlink-msix-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $OutDir, $stage | Out-Null

# 1. The app, self-contained (hospital PCs need no .NET installed).
dotnet publish (Join-Path $here '..\MedLink.Windows\MedLink.Windows.csproj') -c Release -r win-x64 --self-contained true `
  -p:Version=$Version -p:UpdatePublicKey=$UpdatePublicKey -p:UpdateFeed=$UpdateFeed -o $stage --nologo
if ($LASTEXITCODE -ne 0) { throw 'dotnet publish failed' }

# 2. Manifest and tile images (rendered from the original logo by make-icons.mjs).
Copy-Item -Recurse (Join-Path $here 'Assets') (Join-Path $stage 'Assets') -Force
(Get-Content (Join-Path $here 'AppxManifest.xml') -Raw).Replace('__VERSION__', "$Version.0").Replace('__PUBLISHER__', $Publisher) |
  Set-Content -Encoding UTF8 (Join-Path $stage 'AppxManifest.xml')

# 3. Pack and sign with the Windows SDK tools.
$kit = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin' -Directory | Where-Object Name -match '^10\.' | Sort-Object Name -Descending |
  Where-Object { Test-Path (Join-Path $_.FullName 'x64\makeappx.exe') } | Select-Object -First 1
if (-not $kit) { throw 'Windows SDK not found (makeappx.exe)' }
$makeappx = Join-Path $kit.FullName 'x64\makeappx.exe'; $signtool = Join-Path $kit.FullName 'x64\signtool.exe'
$msix = Join-Path $OutDir "MEDLINK-$Version.msix"
& $makeappx pack /o /d $stage /p $msix /nv | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'makeappx failed' }
$plain = $env:MEDLINK_PFX_PASSWORD
if (-not $plain) { $plain = [Net.NetworkCredential]::new('', (Read-Host -AsSecureString 'Password of the signing .pfx')).Password }
& $signtool sign /q /fd SHA256 /f $Pfx /p $plain $msix
if ($LASTEXITCODE -ne 0) { throw 'signtool failed (wrong password, or the certificate subject does not match the publisher)' }
Remove-Item -Recurse -Force $stage
$hash = (Get-FileHash -Algorithm SHA256 $msix).Hash.ToLowerInvariant()
Write-Host "Built $msix ($([math]::Round((Get-Item $msix).Length / 1MB, 1)) MB), SHA-256 $hash"
