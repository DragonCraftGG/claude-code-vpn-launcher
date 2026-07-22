$ErrorActionPreference = "Stop"

$homeDir = [Environment]::GetFolderPath("UserProfile")
$launcherDir = Join-Path $homeDir ".claude-launcher"
$npmDir = Join-Path $env:APPDATA "npm"
$ps1Path = Join-Path $npmDir "claude.ps1"
$cmdPath = Join-Path $npmDir "claude.cmd"

function Restore-Backup($path) {
  $backup = "$path.bak"
  if (Test-Path $backup) {
    Copy-Item -LiteralPath $backup -Destination $path -Force
    Write-Host "Restored: $path" -ForegroundColor Green
  } else {
    Write-Host "No backup found for: $path" -ForegroundColor Yellow
  }
}

Write-Host "Stopping sing-box..." -ForegroundColor Cyan
try { taskkill /F /IM sing-box.exe 2>$null | Out-Null } catch {}
try { Stop-Process -Name sing-box -Force -ErrorAction SilentlyContinue } catch {}

Write-Host "Restoring claude wrappers..." -ForegroundColor Cyan
Restore-Backup $ps1Path
Restore-Backup $cmdPath

if (Test-Path $launcherDir) {
  Write-Host "Removing $launcherDir" -ForegroundColor Cyan
  Remove-Item -LiteralPath $launcherDir -Recurse -Force
}

Write-Host "Uninstalled Claude Code VPN Launcher." -ForegroundColor Green
