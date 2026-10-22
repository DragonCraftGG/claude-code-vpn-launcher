param(
  [switch]$KeepConfig
)

$ErrorActionPreference = "Stop"

$homeDir = [Environment]::GetFolderPath("UserProfile")
$launcherDir = Join-Path $homeDir ".claude-launcher"
$shimDir = Join-Path $launcherDir "shim"
$singBoxExe = Join-Path (Join-Path $launcherDir "bin") "sing-box.exe"
$npmDir = if ($env:APPDATA) { Join-Path $env:APPDATA "npm" } else { "" }

# Works both from the repository and from %USERPROFILE%\.claude-launcher\uninstall.ps1.
$helpers = @((Join-Path $PSScriptRoot "files\setup-helpers.ps1"), (Join-Path $PSScriptRoot "setup-helpers.ps1")) |
  Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $helpers) { throw "setup-helpers.ps1 was not found next to uninstall.ps1" }
. $helpers

Write-Step "Stopping the launcher's sing-box"
Stop-LauncherSingBox $singBoxExe

Write-Step "Removing the launcher from PATH"
if (Remove-UserPathEntry $shimDir) {
  Write-Note "Removed from the user PATH: $shimDir"
} else {
  Write-Note "Not in the user PATH"
}
Set-SessionPath $shimDir $false

$legacy = Repair-LegacyNpmShims $npmDir
if ($legacy -eq "restored") {
  Write-Note "Restored npm's own claude.ps1 / claude.cmd"
} elseif ($legacy -eq "removed") {
  Write-Note "Removed old launcher wrappers from $npmDir"
}

if (Test-Path -LiteralPath $launcherDir) {
  if ((Get-NormalizedPath (Get-Location).Path) -like "$(Get-NormalizedPath $launcherDir)*") { Set-Location $homeDir }
  if ($KeepConfig) {
    Write-Step "Removing $launcherDir (keeping config.json)"
    Get-ChildItem -LiteralPath $launcherDir -Force | Where-Object { $_.Name -ne "config.json" } |
      Remove-Item -Recurse -Force
  } else {
    Write-Step "Removing $launcherDir"
    Remove-Item -LiteralPath $launcherDir -Recurse -Force
  }
}

Write-Host ""
Write-Host "Uninstalled Claude Code VPN Launcher." -ForegroundColor Green
Write-Host "  'claude' now starts Claude Code directly (open a new terminal)." -ForegroundColor DarkGray
