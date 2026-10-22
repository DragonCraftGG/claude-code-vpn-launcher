# Claude Code VPN Launcher

Красивый Windows CLI-лаунчер для Claude Code с опциональным VPN-прокси через `sing-box`.

English version is below.

## Что Это

Лаунчер перехватывает команду `claude`, показывает анимированное меню в стиле Claude Code и позволяет выбрать режим запуска:

- `Claude + VPN Proxy` - Claude Code работает через локальный VPN-прокси.
- `Claude Direct` - Claude Code запускается напрямую, без VPN.

После выбора лаунчер полностью передаёт управление настоящему Claude Code, поэтому стрелки, Enter, Ctrl+C и ввод работают как обычно.

## Что Нового в 2.0

- **Обновления Claude Code больше не сбрасывают лаунчер.** Раньше он подменял `claude.ps1` / `claude.cmd` в папке npm, а npm перезаписывал их при каждом обновлении. Теперь команда `claude` живёт в `%USERPROFILE%\.claude-launcher\shim`, эта папка стоит первой в PATH пользователя, а настоящий Claude Code ищется заново при каждом запуске. Работает и с npm-установкой, и с нативной (`~\.local\bin\claude.exe`).
- **Анимации как в Claude Code:** спиннер `· ✢ * ✶ ✻ ✽` с переливающимся текстом и забавными глаголами (`Tunneling…`, `Handshaking…`, `Clauding…`), маскот Clawd (машет при запуске, моргает, семенит лапками во время подключения), шаги запуска в виде `●` / `⎿`, как вызовы инструментов, мерцающий заголовок и «бьющееся» сердечко.
- **Живой статус:** версия Claude Code, протокол и имя сервера, пинг до VPN-сервера, запущен ли прокси и сколько сессий его используют.
- **Ввод ссылки** с проверкой на лету и скрытием UUID/пароля на экране (удобно для стримов).
- **Несколько окон Claude** используют один прокси. sing-box останавливается, когда закрывается последнее окно, а не первое.
- **Без меню там, где оно мешает:** `claude --version`, `claude -p "..."`, `claude update`, `claude mcp ...` и запуск с перенаправленным вводом/выводом идут сразу, в последнем выбранном режиме.
- Лаунчер останавливает только **свой** sing-box и не трогает v2rayN, Hiddify, NekoBox и другие программы.
- Исправлены ссылки VLESS с `type=ws` / `grpc` (раньше sing-box падал с `unknown network`), добавлены `httpupgrade`, `h2`, Hysteria2 и TUIC.
- Запросы к `localhost` и локальной сети идут мимо VPN (интеграция с IDE, локальные dev-серверы).

## Что Устанавливается

- файлы лаунчера в `%USERPROFILE%\.claude-launcher`
- команда `claude` в `%USERPROFILE%\.claude-launcher\shim` (первой в PATH пользователя)
- портативный `sing-box.exe`
- пустой `config.json` для VPN-ссылки пользователя

Файлы npm (`%APPDATA%\npm`) больше не изменяются. Если там остались обёртки от старой версии лаунчера, установщик вернёт нормальные шимы npm.

VPN-конфиг, API-ключи и Claude-аккаунт в проект не входят. Каждый пользователь указывает свои данные сам.

## Требования

- Windows 10/11
- Node.js
- Claude Code (npm или нативная установка):

```powershell
npm install -g @anthropic-ai/claude-code
```

## Установка

Скачайте или клонируйте репозиторий, затем запустите PowerShell в папке проекта:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install.ps1
```

Откройте **новый** терминал (уже открытые окна и VS Code видят старый PATH до перезапуска) и запускайте Claude Code как обычно:

```powershell
claude
```

При первом запуске лаунчер попросит вставить вашу VPN-ссылку:

- `vless://...` (tcp / ws / grpc / httpupgrade / h2, tls / reality)
- `vmess://...`
- `trojan://...`
- `ss://...` (SIP002, старый base64-формат, 2022, плагины obfs / v2ray)
- `hysteria2://...` / `hy2://...`
- `tuic://...`
- или путь к готовому sing-box `.json`

Подписки (`https://...`) не поддерживаются - скопируйте из них одну ссылку.

## Управление

| Клавиша | Действие |
| --- | --- |
| `↑` / `↓`, `j` / `k` | выбор пункта |
| `Enter` | запустить |
| `1`-`4` | сразу выбрать пункт |
| `Esc` | назад / отмена / выход |
| `Ctrl+V` | вставить из буфера обмена |
| `Ctrl+U` | очистить поле ввода |

## Режимы

### Claude + VPN Proxy

Запускает `sing-box` как локальный mixed proxy (или переиспользует уже запущенный):

```text
127.0.0.1:2081
```

Затем запускает Claude Code с переменными:

```text
HTTP_PROXY=http://127.0.0.1:2081
HTTPS_PROXY=http://127.0.0.1:2081
ALL_PROXY=socks5://127.0.0.1:2081
NO_PROXY=localhost,127.0.0.1,::1
```

Эти переменные получает только процесс Claude Code; после выхода переменные вашей сессии PowerShell восстанавливаются.

### Claude Direct

Запускает Claude Code без proxy-переменных. Если прокси больше никто не использует, sing-box останавливается.

## Настройки

`%USERPROFILE%\.claude-launcher\config.json`:

| Поле | Значение |
| --- | --- |
| `vpn_link` | ваша VPN-ссылка или путь к `.json` |
| `proxy_port` | порт локального прокси (по умолчанию `2081`) |
| `last_mode` | последний выбранный режим (`vpn` / `direct`), его использует запуск без меню |

Переменные окружения:

| Переменная | Значение |
| --- | --- |
| `CLAUDE_LAUNCHER_MODE=vpn` / `direct` | пропустить меню и сразу запустить в этом режиме |
| `CLAUDE_LAUNCHER_MODE=last` | пропустить меню, использовать последний режим |
| `CLAUDE_LAUNCHER_MODE=menu` | показать меню даже для `-p` / подкоманд |
| `CLAUDE_LAUNCHER_CLAUDE_PATH` | путь к настоящему `claude.exe`, если он лежит в нестандартном месте |

## Настройки Claude API

Лаунчер подхватывает `env` из:

```text
%USERPROFILE%\.claude\settings.json
```

Это позволяет использовать свои API-провайдеры:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://your-gateway.example",
    "ANTHROPIC_AUTH_TOKEN": "your-token",
    "ANTHROPIC_MODEL": "your-model"
  }
}
```

Если `ANTHROPIC_AUTH_TOKEN` задан, а `ANTHROPIC_API_KEY` пустой, лаунчер копирует токен в `ANTHROPIC_API_KEY` для совместимости с Claude Code.

## Удаление

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\uninstall.ps1
```

Можно запустить и без папки проекта: `~\.claude-launcher\uninstall.ps1`. Флаг `-KeepConfig` сохраняет `config.json`.

Удаление останавливает sing-box лаунчера, убирает его из PATH и удаляет `%USERPROFILE%\.claude-launcher`. После этого `claude` снова запускает Claude Code напрямую.

## Если Что-То Не Так

- **`claude` запускается без меню** - откройте новый терминал. Если не помогло, запустите `.\install.ps1` ещё раз: он снова поставит лаунчер первым в PATH. Если Claude Code лежит в *системном* PATH, установщик предупредит об этом.
- **«Port 2081 is already in use» или «Windows blocks port 2081»** - порт занят другой программой или зарезервирован Windows (Hyper-V / WSL / Docker). Укажите другой порт в `config.json`, например `"proxy_port": 2181`.
- **Не стартует sing-box** - смотрите `%USERPROFILE%\.claude-launcher\sing-box.log`.
- В PowerShell запрещены скрипты - ничего страшного: тогда установщик ставит только `claude.cmd`, он работает при любой политике.

## Заметки

- Проект использует proxy-режим, а не TUN. Права администратора не нужны.
- Лаунчер не проверяет конкретные API-эндпоинты. Пинг в меню - это TCP-подключение к самому VPN-серверу.

---

# English

Interactive Windows launcher for Claude Code with optional VPN proxy routing through `sing-box`.

## What It Does

The launcher intercepts the `claude` command, shows an animated menu in the style of Claude Code, and lets you choose how Claude Code should start:

- `Claude + VPN Proxy` - Claude Code runs through a local VPN proxy.
- `Claude Direct` - Claude Code runs directly, without VPN.

After the choice is made, the launcher hands the console over to the real Claude Code, so keyboard input works normally.

## What's New in 2.0

- **Claude Code updates no longer reset the launcher.** v1 replaced `claude.ps1` / `claude.cmd` in the npm folder, and npm rewrote them on every update. Now the `claude` command lives in `%USERPROFILE%\.claude-launcher\shim`, that folder is first in the user PATH, and the real Claude Code is looked up again on every run. Works with both npm and native (`~\.local\bin\claude.exe`) installs.
- **Claude Code style animations:** the `· ✢ * ✶ ✻ ✽` spinner with shimmering text and whimsical verbs (`Tunneling…`, `Handshaking…`, `Clauding…`), the Clawd mascot (waves hello, blinks, scuttles while connecting), launch steps drawn as `●` / `⎿` tool calls, a shimmering title and a beating heart.
- **Live status:** Claude Code version, protocol and server name, ping to the VPN server, whether the proxy is running and how many sessions use it.
- **Link input** with live validation; UUIDs and passwords are masked on screen (handy when streaming).
- **Several Claude windows share one proxy.** sing-box stops when the last window closes, not the first.
- **No menu where it gets in the way:** `claude --version`, `claude -p "..."`, `claude update`, `claude mcp ...` and redirected input/output start right away, in the last chosen mode.
- The launcher only stops **its own** sing-box and leaves v2rayN, Hiddify, NekoBox and other apps alone.
- Fixed VLESS links with `type=ws` / `grpc` (sing-box used to fail with `unknown network`); added `httpupgrade`, `h2`, Hysteria2 and TUIC.
- Traffic to `localhost` and private networks bypasses the VPN (IDE integration, local dev servers).

## Installed Files

- launcher files in `%USERPROFILE%\.claude-launcher`
- the `claude` command in `%USERPROFILE%\.claude-launcher\shim` (first in the user PATH)
- portable `sing-box.exe`
- empty `config.json` for the user's VPN link

The npm folder (`%APPDATA%\npm`) is no longer modified. If wrappers from the old launcher are still there, the installer puts npm's own shims back.

No VPN config, API key, or Claude credentials are bundled.

## Requirements

- Windows 10/11
- Node.js
- Claude Code (npm or native install):

```powershell
npm install -g @anthropic-ai/claude-code
```

## Install

Download or clone this repository, then run PowerShell in the project folder:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install.ps1
```

Open a **new** terminal (already open windows and VS Code keep the old PATH until restarted) and start Claude Code as usual:

```powershell
claude
```

On first launch, paste your own VPN link:

- `vless://...` (tcp / ws / grpc / httpupgrade / h2, tls / reality)
- `vmess://...`
- `trojan://...`
- `ss://...` (SIP002, legacy base64, 2022 ciphers, obfs / v2ray plugins)
- `hysteria2://...` / `hy2://...`
- `tuic://...`
- or a path to a sing-box `.json` config

Subscription URLs (`https://...`) are not supported - copy a single link from them.

## Keys

| Key | Action |
| --- | --- |
| `↑` / `↓`, `j` / `k` | select |
| `Enter` | launch |
| `1`-`4` | pick an option instantly |
| `Esc` | back / cancel / exit |
| `Ctrl+V` | paste from the clipboard |
| `Ctrl+U` | clear the input |

## Modes

### Claude + VPN Proxy

Starts `sing-box` as a local mixed proxy (or reuses one that is already running):

```text
127.0.0.1:2081
```

Then launches Claude Code with:

```text
HTTP_PROXY=http://127.0.0.1:2081
HTTPS_PROXY=http://127.0.0.1:2081
ALL_PROXY=socks5://127.0.0.1:2081
NO_PROXY=localhost,127.0.0.1,::1
```

Only the Claude Code process receives those variables; your PowerShell session's variables are restored when it exits.

### Claude Direct

Launches Claude Code without proxy variables. If no other session uses the proxy, sing-box is stopped.

## Settings

`%USERPROFILE%\.claude-launcher\config.json`:

| Field | Meaning |
| --- | --- |
| `vpn_link` | your VPN link or a path to a `.json` config |
| `proxy_port` | local proxy port (default `2081`) |
| `last_mode` | last chosen mode (`vpn` / `direct`), used when the menu is skipped |

Environment variables:

| Variable | Meaning |
| --- | --- |
| `CLAUDE_LAUNCHER_MODE=vpn` / `direct` | skip the menu and start in that mode |
| `CLAUDE_LAUNCHER_MODE=last` | skip the menu and use the last mode |
| `CLAUDE_LAUNCHER_MODE=menu` | show the menu even for `-p` / subcommands |
| `CLAUDE_LAUNCHER_CLAUDE_PATH` | path to the real `claude.exe` if it lives somewhere unusual |

## Claude API Settings

The launcher imports `env` from:

```text
%USERPROFILE%\.claude\settings.json
```

This keeps custom API providers working:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://your-gateway.example",
    "ANTHROPIC_AUTH_TOKEN": "your-token",
    "ANTHROPIC_MODEL": "your-model"
  }
}
```

If `ANTHROPIC_AUTH_TOKEN` exists and `ANTHROPIC_API_KEY` is empty, the launcher sets `ANTHROPIC_API_KEY` to the same value for Claude Code compatibility.

## Uninstall

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\uninstall.ps1
```

It also works without the project folder: `~\.claude-launcher\uninstall.ps1`. Pass `-KeepConfig` to keep `config.json`.

Uninstall stops the launcher's sing-box, removes it from PATH and deletes `%USERPROFILE%\.claude-launcher`. After that, `claude` starts Claude Code directly again.

## Troubleshooting

- **`claude` starts without the menu** - open a new terminal. If that doesn't help, run `.\install.ps1` again; it puts the launcher first in PATH again. If Claude Code is in the *system* PATH, the installer warns about it.
- **"Port 2081 is already in use" or "Windows blocks port 2081"** - another program uses the port, or Windows reserved it (Hyper-V / WSL / Docker). Set another port in `config.json`, for example `"proxy_port": 2181`.
- **sing-box doesn't start** - see `%USERPROFILE%\.claude-launcher\sing-box.log`.
- PowerShell scripts are disabled - that's fine: the installer then installs only `claude.cmd`, which works under any execution policy.

## Notes

- This project uses proxy mode, not TUN mode. Administrator rights are not needed.
- The launcher does not test any specific API endpoint. The ping in the menu is a TCP connection to the VPN server itself.
