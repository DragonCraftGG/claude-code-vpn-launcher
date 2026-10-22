# Shared helpers for install.ps1 and uninstall.ps1 (claude-launcher).
# Kept ASCII-only: Windows PowerShell 5.1 reads BOM-less scripts as ANSI.

$script:LauncherMarker = 'claude-launcher'

function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Note([string]$Message) { Write-Host "    $Message" -ForegroundColor DarkGray }
function Write-Warn([string]$Message) { Write-Host "    ! $Message" -ForegroundColor Yellow }
function Write-Ok([string]$Message) { Write-Host "    $Message" -ForegroundColor Green }

function Get-NormalizedPath([string]$Value) {
  if (-not $Value) { return '' }
  $expanded = [Environment]::ExpandEnvironmentVariables($Value.Trim().Trim('"'))
  try { $expanded = [IO.Path]::GetFullPath($expanded) } catch {}
  return $expanded.TrimEnd('\', '/')
}

function Get-PathEntries([string]$Value) {
  return @($Value -split ';' | Where-Object { $_ -and $_.Trim() })
}

# --- User PATH (read raw from the registry so %VARIABLES% survive) ---------

function Get-UserPathRaw {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
  if (-not $key) { return '' }
  try {
    return [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  } finally {
    $key.Close()
  }
}

function Set-UserPathRaw([string]$Value) {
  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
  try {
    $key.SetValue('Path', $Value, [Microsoft.Win32.RegistryValueKind]::ExpandString)
  } finally {
    $key.Close()
  }
  # Setting any user variable broadcasts WM_SETTINGCHANGE, so new terminals see the change.
  [Environment]::SetEnvironmentVariable('CLAUDE_LAUNCHER_REFRESH', '1', 'User')
  [Environment]::SetEnvironmentVariable('CLAUDE_LAUNCHER_REFRESH', $null, 'User')
}

function Get-UserPathSafe {
  $raw = Get-UserPathRaw
  if (-not $raw -and [Environment]::GetEnvironmentVariable('Path', 'User')) {
    throw 'Could not read your user PATH from the registry; refusing to change it.'
  }
  return $raw
}

function Add-UserPathFront([string]$Dir) {
  $target = Get-NormalizedPath $Dir
  $raw = Get-UserPathSafe
  $entries = @(Get-PathEntries $raw)
  if ($entries.Count -gt 0 -and (Get-NormalizedPath $entries[0]) -ieq $target) { return $false }
  $rest = @($entries | Where-Object { (Get-NormalizedPath $_) -ine $target })
  Set-UserPathRaw ((@($Dir) + $rest) -join ';')
  return $true
}

function Remove-UserPathEntry([string]$Dir) {
  $target = Get-NormalizedPath $Dir
  $raw = Get-UserPathSafe
  $entries = @(Get-PathEntries $raw)
  $rest = @($entries | Where-Object { (Get-NormalizedPath $_) -ine $target })
  if ($rest.Count -eq $entries.Count) { return $false }
  Set-UserPathRaw ($rest -join ';')
  return $true
}

function Set-SessionPath([string]$Dir, [bool]$Front) {
  $target = Get-NormalizedPath $Dir
  $rest = @(Get-PathEntries $env:Path | Where-Object { (Get-NormalizedPath $_) -ine $target })
  if ($Front) { $rest = @($Dir) + $rest }
  $env:Path = $rest -join ';'
}

# --- Execution policy ----------------------------------------------------

# The policy that applies in a new terminal (ignores this process's -Scope Process Bypass).
function Get-PersistentExecutionPolicy {
  foreach ($scope in @('MachinePolicy', 'UserPolicy', 'CurrentUser', 'LocalMachine')) {
    $policy = 'Undefined'
    try { $policy = [string](Get-ExecutionPolicy -Scope $scope) } catch {}
    if ($policy -and $policy -ne 'Undefined') { return [pscustomobject]@{ Policy = $policy; Scope = $scope } }
  }
  return [pscustomobject]@{ Policy = 'Restricted'; Scope = 'Default' }
}

# --- Old (v1) launcher wrappers inside the npm folder ----------------------

function Test-LegacyWrapper([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  # Wrappers are tiny scripts; never read a 200 MB claude.exe.
  if ((Get-Item -LiteralPath $Path).Length -gt 65536) { return $false }
  $text = ''
  try { $text = [IO.File]::ReadAllText($Path) } catch { return $false }
  if ($text.Contains($script:LauncherMarker)) { return $true }
  # v1 claude.cmd only forwarded to claude.ps1; npm's own shim points into node_modules.
  return ($text.Contains('%~dp0claude.ps1') -and -not $text.Contains('node_modules'))
}

function Write-TextFile([string]$Path, [string[]]$Lines) {
  [IO.File]::WriteAllText($Path, (($Lines -join "`r`n") + "`r`n"), (New-Object System.Text.UTF8Encoding($false)))
}

# Writes npm-style claude.ps1 / claude.cmd that start the installed package.
function Write-NpmShims([string]$NpmDir) {
  $pkg = [IO.Path]::Combine($NpmDir, 'node_modules', '@anthropic-ai', 'claude-code')
  $ps1 = Join-Path $NpmDir 'claude.ps1'
  $cmd = Join-Path $NpmDir 'claude.cmd'

  if (Test-Path -LiteralPath ([IO.Path]::Combine($pkg, 'bin', 'claude.exe'))) {
    Write-TextFile $ps1 @(
      '#!/usr/bin/env pwsh'
      '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent'
      'if ($MyInvocation.ExpectingInput) {'
      '  $input | & "$basedir/node_modules/@anthropic-ai/claude-code/bin/claude.exe" $args'
      '} else {'
      '  & "$basedir/node_modules/@anthropic-ai/claude-code/bin/claude.exe" $args'
      '}'
      'exit $LASTEXITCODE'
    )
    Write-TextFile $cmd @(
      '@ECHO off'
      'SETLOCAL'
      '"%~dp0\node_modules\@anthropic-ai\claude-code\bin\claude.exe" %*'
    )
    return $true
  }

  if (Test-Path -LiteralPath (Join-Path $pkg 'cli.js')) {
    Write-TextFile $ps1 @(
      '#!/usr/bin/env pwsh'
      '$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent'
      '$node = if (Test-Path "$basedir/node.exe") { "$basedir/node.exe" } else { "node" }'
      'if ($MyInvocation.ExpectingInput) {'
      '  $input | & $node "$basedir/node_modules/@anthropic-ai/claude-code/cli.js" $args'
      '} else {'
      '  & $node "$basedir/node_modules/@anthropic-ai/claude-code/cli.js" $args'
      '}'
      'exit $LASTEXITCODE'
    )
    Write-TextFile $cmd @(
      '@ECHO off'
      'SETLOCAL'
      'IF EXIST "%~dp0\node.exe" (SET "_prog=%~dp0\node.exe") ELSE (SET "_prog=node")'
      '"%_prog%" "%~dp0\node_modules\@anthropic-ai\claude-code\cli.js" %*'
    )
    return $true
  }
  return $false
}

# v1 of the launcher overwrote npm's claude.ps1 / claude.cmd (and npm kept
# undoing it on every update). Put npm's own shims back.
# Returns 'none', 'restored' or 'removed'.
function Repair-LegacyNpmShims([string]$NpmDir) {
  if (-not $NpmDir) { return 'none' }
  $ps1 = Join-Path $NpmDir 'claude.ps1'
  $cmd = Join-Path $NpmDir 'claude.cmd'
  if (-not ((Test-LegacyWrapper $ps1) -or (Test-LegacyWrapper $cmd))) { return 'none' }
  if (Write-NpmShims $NpmDir) { return 'restored' }
  foreach ($path in @($ps1, $cmd)) {
    if (Test-LegacyWrapper $path) { Remove-Item -LiteralPath $path -Force }
  }
  return 'removed'
}

# --- sing-box --------------------------------------------------------------

# Stops only the sing-box started from the launcher's own binary, never other
# apps' copies (v2rayN, Hiddify, NekoBox, ...).
function Stop-LauncherSingBox([string]$Exe) {
  $target = Get-NormalizedPath $Exe
  Get-Process -Name 'sing-box' -ErrorAction SilentlyContinue | Where-Object {
    $path = ''
    try { $path = $_.Path } catch {}
    $path -and ((Get-NormalizedPath $path) -ieq $target)
  } | Stop-Process -Force -ErrorAction SilentlyContinue
}
