# Tenantry-Installer: kopiert die Erweiterung in einen festen Ordner
# (%LOCALAPPDATA%\Tenantry), legt im Startmenü „Tenantry aktualisieren“ an und
# öffnet chrome://extensions zum einmaligen Laden. Ist Tenantry dort schon
# installiert, werden nur die Dateien ersetzt – Container bleiben erhalten.
$ErrorActionPreference = 'Stop'

$src = Split-Path -Parent $MyInvocation.MyCommand.Path
$dest = Join-Path $env:LOCALAPPDATA 'Tenantry'
if (-not (Test-Path (Join-Path $src 'manifest.json'))) { throw "manifest.json fehlt in $src – bitte die ZIP vollständig entpacken." }
$version = (Get-Content (Join-Path $src 'manifest.json') -Raw | ConvertFrom-Json).version
$update = Test-Path (Join-Path $dest 'manifest.json')

if ((Resolve-Path $src).Path.TrimEnd('\') -ne $dest.TrimEnd('\')) {
  New-Item -ItemType Directory -Path $dest -Force | Out-Null
  Copy-Item -Path (Join-Path $src '*') -Destination $dest -Recurse -Force
}

# Startmenü-Verknüpfung zum Aktualisieren
$programs = [Environment]::GetFolderPath('Programs')
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut((Join-Path $programs 'Tenantry aktualisieren.lnk'))
$lnk.TargetPath = Join-Path $dest 'Tenantry-Update.cmd'
$lnk.WorkingDirectory = $dest
$lnk.IconLocation = "$env:SystemRoot\System32\shell32.dll,238"
$lnk.Description = 'Tenantry auf die neueste Version aktualisieren'
$lnk.Save()

Write-Host ''
Write-Host "Tenantry v$version liegt in: $dest" -ForegroundColor Green
Write-Host 'Startmenü: "Tenantry aktualisieren" für künftige Updates.'
Write-Host ''
if ($update) {
  Write-Host 'Tenantry war hier schon installiert. Die Erweiterung lädt sich innerhalb einer Minute selbst neu.'
} else {
  Set-Clipboard -Value $dest
  Write-Host 'Einmalig in Chrome laden:' -ForegroundColor Yellow
  Write-Host '  1. In chrome://extensions oben rechts den Entwicklermodus einschalten.'
  Write-Host '  2. "Entpackte Erweiterung laden" klicken.'
  Write-Host "  3. Den Ordner $dest wählen (Pfad ist in der Zwischenablage)."
  Write-Host ''
  Write-Host 'Wichtig: Für Updates die Erweiterung NICHT entfernen – "Tenantry aktualisieren" genügt.'
  Start-Process 'chrome.exe' 'chrome://extensions' -ErrorAction SilentlyContinue
}
