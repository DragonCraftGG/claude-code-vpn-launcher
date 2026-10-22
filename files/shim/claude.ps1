#!/usr/bin/env pwsh
# Claude Code VPN Launcher shim (claude-launcher): forwards to ..\claude.ps1.
$main = Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Definition)) 'claude.ps1'
if ($MyInvocation.ExpectingInput) { $input | & $main @args } else { & $main @args }
exit $LASTEXITCODE
