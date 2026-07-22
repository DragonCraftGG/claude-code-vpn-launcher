# Claude Code VPN Launcher

Красивый Windows CLI-лаунчер для Claude Code с опциональным VPN-прокси через `sing-box`.

English version is below.

## Что Это

Лаунчер перехватывает глобальную команду `claude`, показывает небольшое меню в терминале и позволяет выбрать режим запуска:

- `Claude + VPN Proxy` - Claude Code работает через локальный VPN-прокси.
- `Claude Direct` - Claude Code запускается напрямую, без VPN.

После выбора лаунчер полностью передаёт управление обратно нативному `claude.exe`, поэтому стрелки, Enter, Ctrl+C и ввод в Claude Code работают нормально.

## Что Устанавливается

- файлы лаунчера в `%USERPROFILE%\.claude-launcher`
- резервные копии старых `%APPDATA%\npm\claude.ps1` и `claude.cmd`
- новые wrapper-файлы для команды `claude`
- портативный `sing-box.exe`
- пустой `config.json` для VPN-ссылки пользователя

VPN-конфиг, API-ключи и Claude-аккаунт в проект не входят. Каждый пользователь указывает свои данные сам.

## Требования

- Windows
- Node.js
- глобально установленный Claude Code:

```powershell
npm install -g @anthropic-ai/claude-code
```

## Установка

Скачайте или клонируйте репозиторий, затем запустите PowerShell в папке проекта:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install.ps1
```

После установки запускайте Claude Code как обычно:

```powershell
claude
```

При первом запуске лаунчер попросит вставить вашу VPN-ссылку:

- `vless://...`
- `trojan://...`
- `ss://...`
- `vmess://...`
- или путь к готовому sing-box `.json`

## Режимы

### Claude + VPN Proxy

Запускает `sing-box` как локальный mixed proxy:

```text
127.0.0.1:2081
```

Затем запускает Claude Code с переменными:

```text
HTTP_PROXY=http://127.0.0.1:2081
HTTPS_PROXY=http://127.0.0.1:2081
ALL_PROXY=socks5://127.0.0.1:2081
```

Эти proxy-переменные получает только процесс Claude Code.

### Claude Direct

Останавливает `sing-box` и запускает Claude Code без proxy-переменных.

## Настройки Claude API

PowerShell-wrapper подхватывает `env` из:

```text
%USERPROFILE%\.claude\settings.json
```

Это позволяет использовать свои API-провайдеры, если они настроены там:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://your-gateway.example",
    "ANTHROPIC_AUTH_TOKEN": "your-token",
    "ANTHROPIC_MODEL": "your-model"
  }
}
```

Если `ANTHROPIC_AUTH_TOKEN` задан, а `ANTHROPIC_API_KEY` пустой, wrapper автоматически копирует токен в `ANTHROPIC_API_KEY` для совместимости с Claude Code.

## Удаление

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\uninstall.ps1
```

Удаление восстанавливает `claude.ps1.bak` и `claude.cmd.bak`, останавливает `sing-box` и удаляет `%USERPROFILE%\.claude-launcher`.

## Заметки

- Проект использует proxy-режим, а не TUN.
- Права администратора обычно не нужны.
- Лаунчер не проверяет конкретные API-эндпоинты. Его задача - запустить Claude Code напрямую или через локальный VPN-прокси.
- Если старый процесс `sing-box` завис, перезагрузка Windows обычно очищает его. Новый лаунчер использует порт `2081`.

---

# English

Interactive Windows launcher for Claude Code with optional VPN proxy routing through `sing-box`.

## What It Does

The launcher intercepts the global `claude` command, shows a small terminal menu, and lets you choose how Claude Code should start:

- `Claude + VPN Proxy` - Claude Code runs through a local VPN proxy.
- `Claude Direct` - Claude Code runs directly, without VPN.

After the choice is made, the launcher hands control back to the native `claude.exe`, so keyboard input works normally.

## Installed Files

- launcher files in `%USERPROFILE%\.claude-launcher`
- backups of existing `%APPDATA%\npm\claude.ps1` and `claude.cmd`
- new launcher-aware wrappers for the `claude` command
- portable `sing-box.exe`
- empty `config.json` for the user's VPN link

No VPN config, API key, or Claude credentials are bundled.

## Requirements

- Windows
- Node.js
- Claude Code installed globally:

```powershell
npm install -g @anthropic-ai/claude-code
```

## Install

Download or clone this repository, then run PowerShell in the project folder:

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
- or a path to a sing-box `.json` config

## Modes

### Claude + VPN Proxy

Starts `sing-box` as a local mixed proxy:

```text
127.0.0.1:2081
```

Then launches Claude Code with:

```text
HTTP_PROXY=http://127.0.0.1:2081
HTTPS_PROXY=http://127.0.0.1:2081
ALL_PROXY=socks5://127.0.0.1:2081
```

Only the Claude Code process receives those proxy variables.

### Claude Direct

Stops `sing-box` and launches Claude Code without proxy variables.

## Claude API Settings

The PowerShell wrapper imports `env` from:

```text
%USERPROFILE%\.claude\settings.json
```

This keeps custom API providers working when users configure:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://your-gateway.example",
    "ANTHROPIC_AUTH_TOKEN": "your-token",
    "ANTHROPIC_MODEL": "your-model"
  }
}
```

If `ANTHROPIC_AUTH_TOKEN` exists and `ANTHROPIC_API_KEY` is empty, the wrapper sets `ANTHROPIC_API_KEY` to the same value for Claude Code compatibility.

## Uninstall

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\uninstall.ps1
```

Uninstall restores `claude.ps1.bak` and `claude.cmd.bak`, stops `sing-box`, and removes `%USERPROFILE%\.claude-launcher`.

## Notes

- This project uses proxy mode, not TUN mode.
- Administrator privileges are usually not required.
- The launcher does not test any specific API endpoint. Its job is only to start Claude Code directly or through the local VPN proxy.
- If an old `sing-box` process gets stuck, rebooting Windows usually clears it. The current launcher uses port `2081`.
