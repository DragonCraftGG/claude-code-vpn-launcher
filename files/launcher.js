const { execFileSync } = require('child_process');
const vpnManager = require('./vpn-manager');

const TERRACOTTA = '\x1b[38;2;217;119;87m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const GRAY = '\x1b[90m';
const WHITE = '\x1b[97m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const INNER_WIDTH = 62;

function clearScreen() {
    process.stdout.write('\x1b[2J\x1b[H');
}

function getVisualWidth(str) {
    const clean = str.replace(/\x1b\[[0-9;]*m/g, '');
    let width = 0;
    for (let i = 0; i < clean.length; i++) {
        const code = clean.charCodeAt(i);
        if (code === 0xFE0F) continue;
        if (code === 0x2764 || code === 0x274C || code === 0x26A1 || code === 0x2699 || code === 0x2714 || code === 0x2718 || (code >= 0xD800 && code <= 0xDBFF)) {
            width += 2;
            if (code >= 0xD800 && code <= 0xDBFF) i++;
        } else {
            width += 1;
        }
    }
    return width;
}

function makeLine(contentStr) {
    const padNeeded = Math.max(0, INNER_WIDTH - getVisualWidth(contentStr));
    return `${TERRACOTTA}│${RESET}${contentStr}${' '.repeat(padNeeded)}${TERRACOTTA}│${RESET}`;
}

function makeSeparator() {
    return `${TERRACOTTA}├${'─'.repeat(INNER_WIDTH)}┤${RESET}`;
}

function makeTopBorder() {
    return `${TERRACOTTA}╭${'─'.repeat(INNER_WIDTH)}╮${RESET}`;
}

function makeBottomBorder() {
    return `${TERRACOTTA}╰${'─'.repeat(INNER_WIDTH)}╯${RESET}`;
}

function cleanupStdin() {
    try {
        process.stdin.removeAllListeners('data');
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.stdin.pause();
    } catch (e) {}
}

function enableRawInput() {
    process.stdin.removeAllListeners('data');
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
}

function readClipboard() {
    try {
        return execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-Clipboard -Raw'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
    } catch (e) {
        return '';
    }
}

function redrawPrompt(prompt, answer) {
    process.stdout.write(`\r\x1b[2K${prompt}${answer}`);
}

function askVpnLink(callback) {
    const prompt = `${CYAN}Enter VPN link (${WHITE}Ctrl+V${CYAN} paste from clipboard): ${RESET}`;
    let answer = '';
    enableRawInput();
    process.stdout.write(prompt);

    const finish = () => {
        cleanupStdin();
        process.stdout.write('\n');
        callback(answer.trim());
    };

    const appendText = (text) => {
        if (!text) return;
        answer += text.replace(/\r?\n/g, '');
        redrawPrompt(prompt, answer);
    };

    process.stdin.on('data', (chunk) => {
        const bytes = [...chunk];
        const text = chunk.toString('utf8');

        if (bytes.length === 1 && bytes[0] === 3) {
            cleanupStdin();
            process.exit(1);
        }
        if (bytes.length === 1 && bytes[0] === 22) {
            appendText(readClipboard());
            return;
        }
        if (bytes.length === 1 && (bytes[0] === 8 || bytes[0] === 127)) {
            answer = answer.slice(0, -1);
            redrawPrompt(prompt, answer);
            return;
        }
        if (text.includes('\r') || text.includes('\n')) {
            appendText(text.split(/\r?\n|\r/)[0]);
            finish();
            return;
        }
        appendText(text.replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, ''));
    });
}

function promptForConfig(callback) {
    clearScreen();
    console.log(makeTopBorder());
    console.log(makeLine(`  ${BOLD}${TERRACOTTA}✽ Claude Code VPN Launcher${RESET}`));
    console.log(makeSeparator());
    console.log(makeLine(''));
    console.log(makeLine(`  ${BOLD}${WHITE}First VPN setup:${RESET}`));
    console.log(makeLine(`  ${GRAY}Paste vless://, ss://, trojan://, vmess:// or .json path${RESET}`));
    console.log(makeLine(`  ${GRAY}Regular paste, Ctrl+V and Shift+Insert are supported.${RESET}`));
    console.log(makeLine(''));
    console.log(makeSeparator());
    console.log(makeLine(`  ${GRAY}[Enter] Confirm${RESET}     ${TERRACOTTA}with love by DragonCraft ❤️${RESET}`));
    console.log(makeBottomBorder());
    console.log('');

    askVpnLink((answer) => {
        if (answer) {
            const cfg = vpnManager.loadConfig();
            cfg.vpn_link = answer;
            cfg.auto_tun = false;
            vpnManager.saveConfig(cfg);
            console.log(`\n${GREEN}✔ Settings saved!${RESET}`);
        } else {
            console.log(`\n${RED}✘ No link entered.${RESET}`);
        }
        setTimeout(callback, 800);
    });
}

function renderMenu(selectedIndex, cfg) {
    clearScreen();
    const hasConfig = cfg.vpn_link && cfg.vpn_link.length > 0;
    const configStatusStr = hasConfig ? `${GREEN}(Config loaded)${RESET}` : `${RED}(No config yet)${RESET}`;
    const options = [
        '⚡ [1] Claude + VPN Proxy    ── Only Claude through VPN',
        '🌐 [2] Claude Direct         ── No VPN',
        '⚙️ [3] Configure VPN link    ── Paste vless://, ss://, etc.',
        '❌ [4] Exit'
    ];

    console.log(makeTopBorder());
    console.log(makeLine(`  ${BOLD}${TERRACOTTA}✽ Claude Code VPN Launcher${RESET}`));
    console.log(makeSeparator());
    console.log(makeLine(''));
    console.log(makeLine(`   ${BOLD}Choose connection mode before launch:${RESET}`));
    console.log(makeLine(`   ${GRAY}Status: ${configStatusStr}${RESET}`));
    console.log(makeLine(''));
    options.forEach((opt, idx) => {
        const prefix = idx === selectedIndex ? ` ${BOLD}${TERRACOTTA}❯ ` : `   ${GRAY}`;
        console.log(makeLine(`${prefix}${opt}${RESET}`));
    });
    console.log(makeLine(''));
    console.log(makeSeparator());
    console.log(makeLine(`  ${GRAY}[↑/↓] Select   [Enter] Launch${RESET}     ${TERRACOTTA}with love by DragonCraft ❤️${RESET}`));
    console.log(makeBottomBorder());
    console.log('');
}

function startInteractiveMenu() {
    const cfg = vpnManager.loadConfig();
    if (!cfg.vpn_link) {
        promptForConfig(showMenu);
    } else {
        showMenu();
    }
}

function showMenu() {
    let selectedIndex = 0;
    const cfg = vpnManager.loadConfig();
    enableRawInput();
    renderMenu(selectedIndex, cfg);

    process.stdin.on('data', (chunk) => {
        const bytes = [...chunk];
        const text = chunk.toString('utf8');
        const command = text.replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, '').trim();

        if (bytes.length === 1 && bytes[0] === 3) {
            vpnManager.stopVpn();
            cleanupStdin();
            process.exit(1);
        }
        if (text === '\x1b[A') {
            selectedIndex = (selectedIndex - 1 + 4) % 4;
            renderMenu(selectedIndex, cfg);
            return;
        }
        if (text === '\x1b[B') {
            selectedIndex = (selectedIndex + 1) % 4;
            renderMenu(selectedIndex, cfg);
            return;
        }
        if (command === '1') return finish(0);
        if (command === '2') return finish(1);
        if (command === '3') return finish(2);
        if (command === '4') return finish(3);
        if (text.includes('\r') || text.includes('\n')) return finish(selectedIndex);
    });

    function finish(choice) {
        cleanupStdin();

        if (choice === 0) {
            if (!cfg.vpn_link) {
                console.log(`${RED}✘ VPN link is not configured. Choose [3] first.${RESET}`);
                process.exit(1);
            }
            console.log(`\n${CYAN}⚡ Checking VPN server TCP reachability...${RESET}`);
            vpnManager.checkVpnReachable(cfg.vpn_link).then((status) => {
                if (!status.reachable) {
                    console.log(`${RED}⚠ TCP check failed: ${status.error}${RESET}`);
                    console.log(`${GRAY}Continuing: only local VPN proxy startup is required.${RESET}`);
                } else {
                    console.log(`${GREEN}✔ VPN server is reachable.${RESET}`);
                }
                console.log(`${CYAN}⚡ Starting VPN proxy (sing-box)...${RESET}`);
                vpnManager.startVpn(cfg.vpn_link).then(() => {
                    console.log(`${GREEN}✔ VPN proxy is active.${RESET}`);
                    setTimeout(() => {
                        clearScreen();
                        process.exit(2);
                    }, 700);
                }).catch((err) => {
                    console.error(`${RED}✘ VPN proxy startup failed: ${err.message}${RESET}`);
                    process.exit(1);
                });
            });
        } else if (choice === 1) {
            vpnManager.stopVpn();
            console.log(`\n${GRAY}🌐 Direct connection (no VPN)...${RESET}`);
            setTimeout(() => {
                clearScreen();
                process.exit(0);
            }, 300);
        } else if (choice === 2) {
            promptForConfig(startInteractiveMenu);
        } else {
            console.log(`\n${GRAY}Exit.${RESET}`);
            vpnManager.stopVpn();
            process.exit(1);
        }
    }
}

startInteractiveMenu();
