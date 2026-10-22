@ECHO off
REM Claude Code VPN Launcher shim (claude-launcher) for cmd.exe.
REM Works with any PowerShell execution policy. Logic lives in ..\claude.ps1.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\claude.ps1" %*
EXIT /B %ERRORLEVEL%
