#!/usr/bin/env pwsh
# Claude Code VPN Launcher (claude-launcher): what runs when you type `claude`.
#
# Installed to %USERPROFILE%\.claude-launcher. The tiny shims in .\shim are first
# in the user PATH and forward here. npm and the native installer only rewrite
# their own folders, so Claude Code updates no longer remove the launcher, and
# the real Claude Code is looked up again on every run.

$homeDir = [Environment]::GetFolderPath('UserProfile')
$launcherDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$shimDir = Join-Path $launcherDir 'shim'
$onWindows = ($PSVersionTable.PSVersion.Major -lt 6) -or $IsWindows
$marker = 'claude-launcher'

# A .ps1 runs inside the caller's PowerShell session, so every environment
# change is recorded and undone afterwards (in reverse order).
$script:envUndo = New-Object System.Collections.ArrayList

function Set-ScopedEnv([string]$Name, $Value) {
  [void]$script:envUndo.Add(@($Name, [Environment]::GetEnvironmentVariable($Name, 'Process')))
  [Environment]::SetEnvironmentVariable($Name, $Value, 'Process')
}

function Restore-ScopedEnv {
  for ($i = $script:envUndo.Count - 1; $i -ge 0; $i--) {
    $entry = $script:envUndo[$i]
    [Environment]::SetEnvironmentVariable($entry[0], $entry[1], 'Process')
  }
  $script:envUndo.Clear()
}

function Test-LauncherScript([string]$Path) {
  try {
    return [bool](Select-String -LiteralPath $Path -SimpleMatch -Pattern $marker -Quiet)
  } catch {
    return $false
  }
}

function Get-FullDir([string]$Dir) {
  $value = [Environment]::ExpandEnvironmentVariables($Dir.Trim().Trim('"'))
  if (-not $value) { return $null }
  try {
    return [IO.Path]::GetFullPath($value).TrimEnd('\', '/')
  } catch {
    return $null
  }
}

# Finds the real Claude Code in PATH order (skipping this shim), plus the
# default npm and native install folders.
function Find-RealClaude {
  $override = $env:CLAUDE_LAUNCHER_CLAUDE_PATH
  if ($override -and (Test-Path -LiteralPath $override -PathType Leaf)) { return $override }

  $dirs = New-Object System.Collections.Generic.List[string]
  foreach ($p in ($env:PATH -split [IO.Path]::PathSeparator)) { if ($p) { $dirs.Add($p) } }
  if ($env:APPDATA) { $dirs.Add((Join-Path $env:APPDATA 'npm')) }
  $dirs.Add([IO.Path]::Combine($homeDir, '.local', 'bin'))

  $self = Get-FullDir $shimDir
  $seen = @{}
  foreach ($raw in $dirs) {
    $dir = Get-FullDir $raw
    if (-not $dir -or $seen.ContainsKey($dir)) { continue }
    $seen[$dir] = $true
    if ($self -and ($dir -ieq $self)) { continue }

    $pkg = [IO.Path]::Combine($dir, 'node_modules', '@anthropic-ai', 'claude-code')
    foreach ($candidate in @([IO.Path]::Combine($pkg, 'bin', 'claude.exe'), (Join-Path $dir 'claude.exe'), (Join-Path $pkg 'cli.js'))) {
      if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    # Unknown future layout: fall back to npm's own shim, as long as it is not ours.
    foreach ($candidate in @((Join-Path $dir 'claude.ps1'), (Join-Path $dir 'claude.cmd'))) {
      if ((Test-Path -LiteralPath $candidate -PathType Leaf) -and -not (Test-LauncherScript $candidate)) { return $candidate }
    }
  }
  return $null
}

function Get-ProxyPort {
  $port = 2081
  $configPath = Join-Path $launcherDir 'config.json'
  if (Test-Path -LiteralPath $configPath) {
    try {
      $cfg = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
      $value = 0
      if ($cfg.proxy_port -and [int]::TryParse([string]$cfg.proxy_port, [ref]$value) -and $value -gt 0 -and $value -lt 65536) {
        $port = $value
      }
    } catch {}
  }
  return $port
}

# Claude Code reads "env" from settings.json itself, but some checks run before
# that, so custom API providers get these variables up front.
function Import-ClaudeSettingsEnv {
  $configDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $homeDir '.claude' }
  $settingsPath = Join-Path $configDir 'settings.json'
  if (-not (Test-Path -LiteralPath $settingsPath)) { return }
  try {
    $settings = Get-Content -Raw -Encoding UTF8 -LiteralPath $settingsPath | ConvertFrom-Json
    if ($settings.env) {
      foreach ($prop in $settings.env.PSObject.Properties) {
        Set-ScopedEnv $prop.Name ([string]$prop.Value)
      }
      if ($env:ANTHROPIC_AUTH_TOKEN -and -not $env:ANTHROPIC_API_KEY) {
        Set-ScopedEnv 'ANTHROPIC_API_KEY' $env:ANTHROPIC_AUTH_TOKEN
      }
    }
  } catch {}
}

function Set-ProxyEnv([string]$Name, $Value) {
  Set-ScopedEnv $Name $Value
  if (-not $onWindows) { Set-ScopedEnv $Name.ToLowerInvariant() $Value }
}

$target = Find-RealClaude
if (-not $target) {
  Write-Host 'claude-launcher: Claude Code was not found.' -ForegroundColor Red
  Write-Host '  Install it:  npm install -g @anthropic-ai/claude-code' -ForegroundColor DarkGray
  Write-Host '  Or set CLAUDE_LAUNCHER_CLAUDE_PATH to claude.exe.' -ForegroundColor DarkGray
  exit 1
}

# 1. Let the launcher pick the mode (0 = direct, 2 = VPN proxy, other = abort).
Set-ScopedEnv 'CLAUDE_LAUNCHER_TARGET' $target
Set-ScopedEnv 'CLAUDE_LAUNCHER_PARENT_PID' ([string]$PID)
Set-ScopedEnv 'CLAUDE_LAUNCHER_ARGS' (ConvertTo-Json -Compress -InputObject ([string[]]$args))
if ($MyInvocation.ExpectingInput) { Set-ScopedEnv 'CLAUDE_LAUNCHER_PIPED' '1' }

$launcherJs = Join-Path $launcherDir 'launcher.js'
$mode = 0
if ((Test-Path -LiteralPath $launcherJs) -and (Get-Command node -CommandType Application -ErrorAction SilentlyContinue)) {
  & node $launcherJs
  $mode = $LASTEXITCODE
} else {
  Write-Host 'claude-launcher: Node.js or launcher.js not found, starting Claude Code directly.' -ForegroundColor Yellow
}
Restore-ScopedEnv

if ($mode -ne 0 -and $mode -ne 2) { exit $mode }

# 2. Start the real Claude Code with the right environment.
Import-ClaudeSettingsEnv
if ($mode -eq 2) {
  $port = Get-ProxyPort
  $noProxy = 'localhost,127.0.0.1,::1'
  if ($env:NO_PROXY) { $noProxy = "$($env:NO_PROXY),$noProxy" }
  Set-ProxyEnv 'HTTP_PROXY' "http://127.0.0.1:$port"
  Set-ProxyEnv 'HTTPS_PROXY' "http://127.0.0.1:$port"
  Set-ProxyEnv 'ALL_PROXY' "socks5://127.0.0.1:$port"
  Set-ProxyEnv 'NO_PROXY' $noProxy
} else {
  foreach ($name in @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY')) { Set-ProxyEnv $name $null }
}

$exitCode = 0
try {
  if ($target.EndsWith('.js', [StringComparison]::OrdinalIgnoreCase)) {
    if ($MyInvocation.ExpectingInput) { $input | & node $target @args } else { & node $target @args }
  } else {
    if ($MyInvocation.ExpectingInput) { $input | & $target @args } else { & $target @args }
  }
  $exitCode = $LASTEXITCODE
} finally {
  Restore-ScopedEnv
  if ($mode -eq 2) {
    $cleanupJs = Join-Path $launcherDir 'cleanup.js'
    if (Test-Path -LiteralPath $cleanupJs) { & node $cleanupJs $PID 2>$null | Out-Null }
  }
}
exit $exitCode
