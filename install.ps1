param(
  [string]$SingBoxVersion = "1.12.12"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repoDir = Split-Path $MyInvocation.MyCommand.Path -Parent
$filesDir = Join-Path $repoDir "files"
$homeDir = [Environment]::GetFolderPath("UserProfile")
$launcherDir = Join-Path $homeDir ".claude-launcher"
$binDir = Join-Path $launcherDir "bin"
$shimDir = Join-Path $launcherDir "shim"
$npmDir = if ($env:APPDATA) { Join-Path $env:APPDATA "npm" } else { "" }

. (Join-Path $filesDir "setup-helpers.ps1")

function Copy-Normalized([string]$Source, [string]$Destination, [string]$Eol) {
  $text = [IO.File]::ReadAllText($Source) -replace "`r`n", "`n"
  if ($Eol -eq "crlf") { $text = $text -replace "`n", "`r`n" }
  [IO.File]::WriteAllText($Destination, $text, (New-Object System.Text.UTF8Encoding($false)))
}

Write-Host ""
Write-Host "  * Claude Code VPN Launcher" -ForegroundColor DarkYellow
Write-Host ""

Write-Step "Checking prerequisites"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  throw "Node.js not found. Install it first: https://nodejs.org/"
}
Write-Note "Node.js $(& node --version)"

$claudeFound = $false
if ($npmDir -and (Test-Path -LiteralPath ([IO.Path]::Combine($npmDir, "node_modules", "@anthropic-ai", "claude-code")))) {
  $claudeFound = $true
  Write-Note "Claude Code (npm): $npmDir"
} elseif (Test-Path -LiteralPath ([IO.Path]::Combine($homeDir, ".local", "bin", "claude.exe"))) {
  $claudeFound = $true
  Write-Note "Claude Code (native): $([IO.Path]::Combine($homeDir, '.local', 'bin', 'claude.exe'))"
} else {
  foreach ($cmd in @(Get-Command claude -All -ErrorAction SilentlyContinue)) {
    if ($cmd.Source -and -not (Test-LegacyWrapper $cmd.Source) -and (Get-NormalizedPath (Split-Path -Parent $cmd.Source)) -ine (Get-NormalizedPath $shimDir)) {
      $claudeFound = $true
      Write-Note "Claude Code: $($cmd.Source)"
      break
    }
  }
}
if (-not $claudeFound) {
  Write-Warn "Claude Code was not found. Install it before running claude:"
  Write-Warn "  npm install -g @anthropic-ai/claude-code"
}

Write-Step "Copying launcher files to $launcherDir"
New-Item -ItemType Directory -Force -Path $launcherDir, $binDir, $shimDir | Out-Null
foreach ($name in @("launcher.js", "vpn-manager.js", "ui.js", "cleanup.js", "claude.ps1", "setup-helpers.ps1")) {
  Copy-Item -LiteralPath (Join-Path $filesDir $name) -Destination (Join-Path $launcherDir $name) -Force
}
Copy-Item -LiteralPath (Join-Path $repoDir "uninstall.ps1") -Destination (Join-Path $launcherDir "uninstall.ps1") -Force

$configPath = Join-Path $launcherDir "config.json"
if (-not (Test-Path -LiteralPath $configPath)) {
  [IO.File]::WriteAllText($configPath, "{`n  ""vpn_link"": """",`n  ""auto_tun"": false`n}`n", (New-Object System.Text.UTF8Encoding($false)))
  Write-Note "Created empty config: $configPath"
} else {
  Write-Note "Keeping existing config: $configPath"
}

Write-Step "Installing sing-box $SingBoxVersion"
$singBoxExe = Join-Path $binDir "sing-box.exe"
$installedVersion = ""
if (Test-Path -LiteralPath $singBoxExe) {
  try {
    $installedVersion = ((& $singBoxExe version) | Select-Object -First 1) -replace "^sing-box version\s*", ""
  } catch {}
}
if ($installedVersion -eq $SingBoxVersion) {
  Write-Note "sing-box $installedVersion is already installed"
} else {
  $zipUrl = "https://github.com/SagerNet/sing-box/releases/download/v$SingBoxVersion/sing-box-$SingBoxVersion-windows-amd64.zip"
  $tmpZip = Join-Path $env:TEMP "sing-box-$SingBoxVersion-windows-amd64.zip"
  $tmpDir = Join-Path $env:TEMP "sing-box-$SingBoxVersion-windows-amd64"
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    Invoke-WebRequest -Uri $zipUrl -OutFile $tmpZip -UseBasicParsing
    Expand-Archive -LiteralPath $tmpZip -DestinationPath $tmpDir -Force
    $downloadedExe = Get-ChildItem -Path $tmpDir -Recurse -Filter "sing-box.exe" | Select-Object -First 1
    if (-not $downloadedExe) { throw "The sing-box archive did not contain sing-box.exe" }
    Stop-LauncherSingBox $singBoxExe
    Copy-Item -LiteralPath $downloadedExe.FullName -Destination $singBoxExe -Force
    Write-Note "sing-box $SingBoxVersion -> $singBoxExe"
  } catch {
    if ($installedVersion) {
      Write-Warn "Could not download sing-box $SingBoxVersion ($($_.Exception.Message)). Keeping $installedVersion."
    } else {
      throw
    }
  } finally {
    Remove-Item -LiteralPath $tmpZip -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Write-Step "Installing the claude command"
$policy = Get-PersistentExecutionPolicy
$scriptsAllowed = @("RemoteSigned", "Unrestricted", "Bypass") -contains $policy.Policy
Copy-Normalized (Join-Path $filesDir "shim\claude.cmd") (Join-Path $shimDir "claude.cmd") "crlf"
Copy-Normalized (Join-Path $filesDir "shim\claude") (Join-Path $shimDir "claude") "lf"
$shimPs1 = Join-Path $shimDir "claude.ps1"
if ($scriptsAllowed) {
  Copy-Item -LiteralPath (Join-Path $filesDir "shim\claude.ps1") -Destination $shimPs1 -Force
} else {
  Remove-Item -LiteralPath $shimPs1 -Force -ErrorAction SilentlyContinue
  Write-Note "PowerShell scripts are disabled (execution policy: $($policy.Policy)), so PowerShell will use claude.cmd."
  if ($policy.Scope -like "*Policy") {
    Write-Warn "The policy is set by Group Policy; if claude.cmd is blocked too, ask your administrator."
  }
}
# Files from a downloaded ZIP carry "Mark of the Web", which RemoteSigned blocks.
Get-ChildItem -LiteralPath $launcherDir -Recurse -File | Unblock-File -ErrorAction SilentlyContinue

Write-Step "Putting the launcher first in your PATH (survives Claude Code updates)"
if (Add-UserPathFront $shimDir) {
  Write-Note "Added to the user PATH: $shimDir"
} else {
  Write-Note "Already first in the user PATH: $shimDir"
}
Set-SessionPath $shimDir $true

foreach ($entry in Get-PathEntries ([Environment]::GetEnvironmentVariable("Path", "Machine"))) {
  $dir = Get-NormalizedPath $entry
  foreach ($name in @("claude.exe", "claude.cmd", "claude.ps1")) {
    if ($dir -and (Test-Path -LiteralPath (Join-Path $dir $name))) {
      Write-Warn "Claude Code is also in the system PATH ($dir). System PATH entries win over"
      Write-Warn "the user PATH, so 'claude' may skip the launcher. Remove it from the system PATH."
      break
    }
  }
}

$legacy = Repair-LegacyNpmShims $npmDir
if ($legacy -eq "restored") {
  Write-Note "Restored npm's own claude.ps1 / claude.cmd (the old launcher had replaced them)"
} elseif ($legacy -eq "removed") {
  Write-Note "Removed the old launcher wrappers from $npmDir"
}

Write-Step "Checking the installation"
foreach ($name in @("launcher.js", "vpn-manager.js", "ui.js", "cleanup.js")) {
  & node --check (Join-Path $launcherDir $name)
  if ($LASTEXITCODE -ne 0) { throw "Syntax check failed for $name" }
}
$resolved = Get-Command claude -ErrorAction SilentlyContinue | Select-Object -First 1
if ($resolved -and $resolved.Source -and (Get-NormalizedPath (Split-Path -Parent $resolved.Source)) -ieq (Get-NormalizedPath $shimDir)) {
  Write-Ok "claude -> $($resolved.Source)"
} else {
  Write-Warn "In this window 'claude' resolves to: $(if ($resolved) { $resolved.Source } else { 'nothing' })"
  Write-Warn "Open a new terminal; if it still skips the launcher, check your PATH order."
}

Write-Host ""
Write-Host "Installed Claude Code VPN Launcher." -ForegroundColor Green
Write-Host "  Open a NEW terminal and run: claude"
Write-Host "  Already open terminals (and VS Code) keep the old PATH until you restart them." -ForegroundColor DarkGray
Write-Host "  Claude Code updates (npm or native) no longer remove the launcher." -ForegroundColor DarkGray
Write-Host "  On first launch, paste your own VPN link. No VPN config is bundled." -ForegroundColor DarkGray
