#!/usr/bin/env pwsh
$basedir = Split-Path $MyInvocation.MyCommand.Definition -Parent
$homeDir = [Environment]::GetFolderPath("UserProfile")
$settingsPath = Join-Path $homeDir ".claude\settings.json"
$launcherDir = Join-Path $homeDir ".claude-launcher"

function Import-ClaudeSettingsEnv {
  if (Test-Path $settingsPath) {
    try {
      $settings = Get-Content -Raw $settingsPath | ConvertFrom-Json
      if ($settings.env) {
        $settings.env.PSObject.Properties | ForEach-Object {
          Set-Item -Path "Env:$($_.Name)" -Value ([string]$_.Value)
        }
        if ($env:ANTHROPIC_AUTH_TOKEN -and -not $env:ANTHROPIC_API_KEY) {
          $env:ANTHROPIC_API_KEY = $env:ANTHROPIC_AUTH_TOKEN
        }
      }
    } catch {}
  }
}

node (Join-Path $launcherDir "launcher.js")
$code = $LASTEXITCODE

if ($code -eq 0 -or $code -eq 2) {
  Import-ClaudeSettingsEnv

  if ($code -eq 2) {
    $env:HTTP_PROXY = "http://127.0.0.1:2080"
    $env:HTTPS_PROXY = "http://127.0.0.1:2080"
    $env:ALL_PROXY = "socks5://127.0.0.1:2080"
    $env:http_proxy = "http://127.0.0.1:2080"
    $env:https_proxy = "http://127.0.0.1:2080"
    $env:all_proxy = "socks5://127.0.0.1:2080"
  } else {
    $env:HTTP_PROXY = $null
    $env:HTTPS_PROXY = $null
    $env:ALL_PROXY = $null
    $env:http_proxy = $null
    $env:https_proxy = $null
    $env:all_proxy = $null
  }

  try {
    if ($MyInvocation.ExpectingInput) {
      $input | & "$basedir/node_modules/@anthropic-ai/claude-code/bin/claude.exe" $args
    } else {
      & "$basedir/node_modules/@anthropic-ai/claude-code/bin/claude.exe" $args
    }
    $exitCode = $LASTEXITCODE
  } finally {
    $env:HTTP_PROXY = $null
    $env:HTTPS_PROXY = $null
    $env:ALL_PROXY = $null
    $env:http_proxy = $null
    $env:https_proxy = $null
    $env:all_proxy = $null
    node (Join-Path $launcherDir "cleanup.js")
    Clear-Host
  }
  exit $exitCode
}

exit $code
