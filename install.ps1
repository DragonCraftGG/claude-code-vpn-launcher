param(
  [string]$SingBoxVersion = "1.12.12"
)

$ErrorActionPreference = "Stop"

$repoDir = Split-Path $MyInvocation.MyCommand.Path -Parent
$filesDir = Join-Path $repoDir "files"
$homeDir = [Environment]::GetFolderPath("UserProfile")
$launcherDir = Join-Path $homeDir ".claude-launcher"
$binDir = Join-Path $launcherDir "bin"
$npmDir = Join-Path $env:APPDATA "npm"

function Write-Step($message) {
  Write-Host "==> $message" -ForegroundColor Cyan
}

function Require-Command($name, $hint) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "$name not found. $hint"
  }
}

function Backup-File($path) {
  if (Test-Path $path) {
    $backup = "$path.bak"
    if (-not (Test-Path $backup)) {
      Copy-Item -LiteralPath $path -Destination $backup -Force
      Write-Host "Backup: $backup" -ForegroundColor DarkGray
    } else {
      $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
      $backup = "$path.bak.$stamp"
      Copy-Item -LiteralPath $path -Destination $backup -Force
      Write-Host "Backup: $backup" -ForegroundColor DarkGray
    }
  }
}

Write-Step "Checking prerequisites"
Require-Command node "Install Node.js first: https://nodejs.org/"
Require-Command claude "Install Claude Code first: npm install -g @anthropic-ai/claude-code"

Write-Step "Creating launcher directory"
New-Item -ItemType Directory -Force -Path $launcherDir | Out-Null
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

Write-Step "Copying launcher files"
Copy-Item -LiteralPath (Join-Path $filesDir "launcher.js") -Destination (Join-Path $launcherDir "launcher.js") -Force
Copy-Item -LiteralPath (Join-Path $filesDir "vpn-manager.js") -Destination (Join-Path $launcherDir "vpn-manager.js") -Force
Copy-Item -LiteralPath (Join-Path $filesDir "cleanup.js") -Destination (Join-Path $launcherDir "cleanup.js") -Force

$configPath = Join-Path $launcherDir "config.json"
if (-not (Test-Path $configPath)) {
  @{ vpn_link = ""; auto_tun = $false } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $configPath -Encoding UTF8
  Write-Host "Created empty config: $configPath" -ForegroundColor DarkGray
} else {
  Write-Host "Keeping existing config: $configPath" -ForegroundColor DarkGray
}

Write-Step "Installing sing-box $SingBoxVersion"
$singBoxExe = Join-Path $binDir "sing-box.exe"
if (-not (Test-Path $singBoxExe)) {
  $zipUrl = "https://github.com/SagerNet/sing-box/releases/download/v$SingBoxVersion/sing-box-$SingBoxVersion-windows-amd64.zip"
  $tmpZip = Join-Path $env:TEMP "sing-box-$SingBoxVersion-windows-amd64.zip"
  $tmpDir = Join-Path $env:TEMP "sing-box-$SingBoxVersion-windows-amd64"
  Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
  Invoke-WebRequest -Uri $zipUrl -OutFile $tmpZip
  Expand-Archive -LiteralPath $tmpZip -DestinationPath $tmpDir -Force
  $downloadedExe = Get-ChildItem -Path $tmpDir -Recurse -Filter "sing-box.exe" | Select-Object -First 1
  if (-not $downloadedExe) {
    throw "Downloaded sing-box archive did not contain sing-box.exe"
  }
  Copy-Item -LiteralPath $downloadedExe.FullName -Destination $singBoxExe -Force
  Remove-Item -LiteralPath $tmpZip -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
} else {
  Write-Host "sing-box.exe already exists: $singBoxExe" -ForegroundColor DarkGray
}

Write-Step "Installing claude wrappers"
New-Item -ItemType Directory -Force -Path $npmDir | Out-Null
$ps1Path = Join-Path $npmDir "claude.ps1"
$cmdPath = Join-Path $npmDir "claude.cmd"
Backup-File $ps1Path
Backup-File $cmdPath
Copy-Item -LiteralPath (Join-Path $filesDir "claude.ps1") -Destination $ps1Path -Force
Copy-Item -LiteralPath (Join-Path $filesDir "claude.cmd") -Destination $cmdPath -Force

Write-Step "Validating Node files"
node --check (Join-Path $launcherDir "launcher.js") | Out-Null
node --check (Join-Path $launcherDir "vpn-manager.js") | Out-Null
node --check (Join-Path $launcherDir "cleanup.js") | Out-Null

Write-Host ""
Write-Host "Installed Claude Code VPN Launcher." -ForegroundColor Green
Write-Host "Run: claude"
Write-Host "On first launch, paste your own VPN link. No VPN config is bundled."
