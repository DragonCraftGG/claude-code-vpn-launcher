@ECHO off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0claude.ps1" %*
EXIT /B %ERRORLEVEL%
