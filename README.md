# Claude Code VPN Launcher

Interactive Windows launcher for Claude Code with two modes:

- Claude through a local VPN proxy powered by sing-box
- Claude direct, without VPN

The launcher intercepts the global `claude` command, shows a small terminal menu, then hands control back to the native `claude.exe` so keyboard input works normally.

## What It Does

- Installs files into `%USERPROFILE%\.claude-launcher`
- Backs up existing `%APPDATA%\npm\claude.ps1` and `claude.cmd`
- Replaces those wrappers with launcher-aware wrappers
- Downloads portable `sing-box.exe`
- Creates an empty `config.json`
- Prompts each user for their own VPN link on first run

No VPN config, API key, or Claude credentials are bundled.

## Requirements

- Windows
- Node.js
- Claude Code installed globally:

```powershell
npm install -g @anthropic-ai/claude-code
```

## Install

Download or clone this repository, then run:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install.ps1
```

Then start Claude Code as usual:

```powershell
claude
```

On first launch, paste your own VPN link:

- `vless://...`
- `trojan://...`
- `ss://...`
- `vmess://...`
- or a path to a sing-box JSON config

## Modes

`Claude + VPN Proxy`

Starts sing-box as a local mixed proxy on:

```text
127.0.0.1:2080
```

Then launches Claude Code with:

```text
HTTP_PROXY=http://127.0.0.1:2080
HTTPS_PROXY=http://127.0.0.1:2080
ALL_PROXY=socks5://127.0.0.1:2080
```

Only the Claude process receives those proxy variables.

`Claude Direct`

Stops sing-box and launches Claude without proxy variables.

## Claude API Settings

The PowerShell wrapper imports `env` from:

```text
%USERPROFILE%\.claude\settings.json
```

This keeps custom providers such as FreeModel working when users configure:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://your-gateway.example",
    "ANTHROPIC_AUTH_TOKEN": "your-token",
    "ANTHROPIC_MODEL": "your-model"
  }
}
```

If `ANTHROPIC_AUTH_TOKEN` exists and `ANTHROPIC_API_KEY` is empty, the wrapper sets `ANTHROPIC_API_KEY` to the same value for compatibility with Claude Code.

## Uninstall

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\uninstall.ps1
```

This restores `claude.ps1.bak` and `claude.cmd.bak`, stops sing-box, and removes `%USERPROFILE%\.claude-launcher`.

## Notes

- This project uses proxy mode, not TUN mode.
- Administrator privileges are usually not required.
- If your VPN server is unreachable, the launcher may still start sing-box if the local proxy can start. It does not test any specific API endpoint.
