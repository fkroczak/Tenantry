# Tenantry-Updater: lädt das neueste Release von GitHub und ersetzt die Dateien
# in DIESEM Ordner. Die Erweiterung wird dabei nicht entfernt – Container und
# Anmeldungen bleiben erhalten. Tenantry lädt sich danach selbst neu.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifestPath = Join-Path $dir 'manifest.json'
if (-not (Test-Path $manifestPath)) { throw "Kein Tenantry-Ordner: $manifestPath fehlt." }
$current = (Get-Content $manifestPath -Raw | ConvertFrom-Json).version

Write-Host "Tenantry-Ordner: $dir"
Write-Host "Installiert:     v$current"

$rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/fkroczak/Tenantry/releases/latest' -Headers @{ 'User-Agent' = 'Tenantry-Updater' }
$latest = $rel.tag_name.TrimStart('v')
Write-Host "Neueste Version: v$latest"

if ([version]$latest -le [version]$current) {
  Write-Host ''
  Write-Host 'Tenantry ist aktuell.' -ForegroundColor Green
  exit 0
}

$asset = $rel.assets | Where-Object { $_.name -like 'tenantry-*.zip' } | Select-Object -First 1
if (-not $asset) { throw 'Im Release wurde keine tenantry-*.zip gefunden.' }

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("tenantry-update-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  $zip = Join-Path $tmp 'tenantry.zip'
  Write-Host "Lade $($asset.name) ..."
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -Headers @{ 'User-Agent' = 'Tenantry-Updater' }
  $x = Join-Path $tmp 'x'
  Expand-Archive -Path $zip -DestinationPath $x
  $newManifest = Join-Path $x 'manifest.json'
  if (-not (Test-Path $newManifest)) { throw 'ZIP enthält keine manifest.json.' }
  $newVersion = (Get-Content $newManifest -Raw | ConvertFrom-Json).version
  Copy-Item -Path (Join-Path $x '*') -Destination $dir -Recurse -Force
  Write-Host ''
  Write-Host "Aktualisiert auf v$newVersion." -ForegroundColor Green
  Write-Host 'Tenantry lädt sich innerhalb einer Minute selbst neu (oder im Popup auf "Jetzt neu laden" klicken).'
} finally {
  Remove-Item -Path $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
