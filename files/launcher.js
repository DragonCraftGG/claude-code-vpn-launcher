'use strict';

// Claude Code VPN Launcher: picks how Claude Code connects, then exits with a
// code the shim understands (0 = direct, 2 = through the VPN proxy, 1 = abort).
// The shim then starts the real Claude Code with the console fully handed over.

const fs = require('fs');
const path = require('path');
const tty = require('tty');
const { execFile } = require('child_process');
const vpn = require('./vpn-manager');
const ui = require('./ui');

const VERSION = '2.0.0';
const EXIT = { DIRECT: 0, ABORT: 1, VPN: 2 };
const PROXY = `${vpn.PROXY_HOST}:${vpn.PROXY_PORT}`;

// Arguments that mean "not an interactive chat": never show the menu for them.
const INFO_FLAGS = new Set(['-v', '--version', '-h', '--help']);
const PRINT_FLAGS = new Set(['-p', '--print']);
const SUBCOMMANDS = new Set([
    'update', 'upgrade', 'mcp', 'config', 'doctor', 'install', 'migrate-installer',
    'setup-token', 'plugin', 'plugins'
]);

const VERBS = [
    'Tunneling', 'Handshaking', 'Encrypting', 'Routing', 'Burrowing', 'Teleporting',
    'Negotiating', 'Obfuscating', 'Scuttling', 'Clauding', 'Percolating', 'Reticulating',
    'Combobulating', 'Moseying', 'Schlepping', 'Noodling'
];

const TIPS = [
    'Claude Code updates no longer reset the launcher',
    'claude -p, claude update and --version skip this menu',
    'Set CLAUDE_LAUNCHER_MODE=vpn or direct to skip the menu',
    'Several Claude windows can share one VPN proxy',
    'Press 1-4 to pick an option instantly',
    'Your VPN link stays in ~/.claude-launcher/config.json'
];

const MENU = [
    { key: 'vpn', label: 'Claude + VPN Proxy' },
    { key: 'direct', label: 'Claude Direct' },
    { key: 'config', label: 'Configure VPN' },
    { key: 'exit', label: 'Exit' }
];

function pick(list) {
    return list[Math.floor(Math.random() * list.length)];
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function parentPid() {
    return Number(process.env.CLAUDE_LAUNCHER_PARENT_PID) || process.ppid || 0;
}

function readArgs() {
    const raw = process.env.CLAUDE_LAUNCHER_ARGS;
    if (raw) {
        try {
            const value = JSON.parse(raw);
            if (Array.isArray(value)) return value.map(String);
            if (typeof value === 'string') return [value];
        } catch (e) {}
    }
    return process.argv.slice(2);
}

function classifyArgs(args) {
    if (args.some((a) => INFO_FLAGS.has(a))) return 'info';
    if (args.some((a) => PRINT_FLAGS.has(a))) return 'headless';
    if (args.length && SUBCOMMANDS.has(args[0])) return 'headless';
    return 'interactive';
}

function saveQuietly(cfg) {
    try { vpn.saveConfig(cfg); } catch (e) {}
}

function exitWith(code) {
    process.exitCode = code;
    process.stdout.write('', () => process.exit(code));
}

function versionFromPackage(target) {
    let dir = path.dirname(target);
    for (let i = 0; i < 4; i++) {
        try {
            const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
            if (pkg && pkg.name === '@anthropic-ai/claude-code' && pkg.version) return pkg.version;
        } catch (e) {}
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return '';
}

function readClipboard(callback) {
    if (process.platform !== 'win32') return callback('');
    execFile('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        '[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-Clipboard -Raw'
    ], { encoding: 'utf8', windowsHide: true, timeout: 5000 }, (err, stdout) => {
        callback(err ? '' : String(stdout || '').trim());
    });
}

/** Hides credentials when the link is shown on screen (handy when streaming). */
function maskLink(value) {
    const match = /^([a-z0-9+.-]+:\/\/)([^@]*)@(.*)$/i.exec(value);
    if (match) return `${match[1]}${'•'.repeat(Math.min(8, Math.max(3, match[2].length)))}@${match[3]}`;
    const opaque = /^(vmess:\/\/|ss:\/\/)(.+)$/i.exec(value);
    if (opaque) return `${opaque[1]}${opaque[2].slice(0, 4)}${'•'.repeat(Math.min(12, Math.max(0, opaque[2].length - 4)))}`;
    return value;
}

const KEY_NAMES = {
    '\x1b[A': 'up', '\x1bOA': 'up', '\x1b[B': 'down', '\x1bOB': 'down',
    '\x1b[C': 'right', '\x1bOC': 'right', '\x1b[D': 'left', '\x1bOD': 'left',
    '\x1b[H': 'home', '\x1b[1~': 'home', '\x1b[F': 'end', '\x1b[4~': 'end',
    '\r': 'enter', '\n': 'enter', '\r\n': 'enter', '\x1b': 'esc', '\x1b\x1b': 'esc',
    '\x03': 'ctrl-c', '\x16': 'ctrl-v', '\x15': 'ctrl-u', '\x17': 'ctrl-w',
    '\x7f': 'backspace', '\b': 'backspace', '\t': 'tab'
};
const KEY_TOKEN = /\x1b\[[0-9;?]*[A-Za-z~]|\x1bO[A-Za-z]|\x1b\x1b|\r\n|[\s\S]/g;

/** Splits one stdin chunk into keys. A multi-character chunk without escape codes is a paste. */
function parseKeys(buf) {
    const s = buf.toString('utf8');
    if (s.length > 1 && !s.includes('\x1b') && /[^\r\n]/.test(s.replace(/[\x00-\x1f\x7f]/g, ''))) {
        return [{ name: 'text', text: s }];
    }
    const keys = [];
    for (const token of s.match(KEY_TOKEN) || []) {
        if (KEY_NAMES[token]) keys.push({ name: KEY_NAMES[token] });
        else if (token.startsWith('\x1b')) keys.push({ name: 'unknown' });
        else keys.push({ name: 'text', text: token });
    }
    return keys;
}

// ---------------------------------------------------------------------------
// Non-interactive launch: no UI, just make sure the right mode is ready
// ---------------------------------------------------------------------------

async function quickLaunch(mode, cfg) {
    if (mode !== 'vpn') return exitWith(EXIT.DIRECT);

    if (!cfg.vpn_link) {
        process.stderr.write(`${ui.warning('!')} claude-launcher: no VPN link configured, starting Claude Code directly.\n`);
        return exitWith(EXIT.DIRECT);
    }

    const pid = parentPid();
    vpn.registerSession(pid);
    try {
        const res = await vpn.startVpn(cfg.vpn_link);
        if (tty.isatty(2)) {
            process.stderr.write(`${ui.claude('✻')} ${ui.dim(`claude-launcher · VPN proxy ${PROXY}${res.reused ? ' (shared)' : ''}`)}\n`);
        }
        return exitWith(EXIT.VPN);
    } catch (err) {
        vpn.releaseSession(pid);
        process.stderr.write(`${ui.error('✘')} claude-launcher: VPN proxy failed: ${err.message}\n`);
        return exitWith(EXIT.ABORT);
    }
}

// ---------------------------------------------------------------------------
// Interactive launcher
// ---------------------------------------------------------------------------

class App {
    constructor(cfg) {
        this.cfg = cfg;
        this.screen = new ui.Screen(process.stdout);
        this.t0 = Date.now();
        this.view = cfg.vpn_link ? 'menu' : 'setup';
        this.selected = cfg.last_mode === 'direct' ? 1 : 0;
        this.input = '';
        this.preview = { value: null, info: null };
        this.toast = null;
        this.tip = pick(TIPS);
        this.claudeInfo = { state: 'loading', version: '' };
        this.link = vpn.describeLink(cfg.vpn_link);
        this.ping = { state: 'idle' };
        this.pingId = 0;
        this.proxy = { running: false, pid: 0, sessions: 0 };
        this.run = null;
        this.pending = Promise.resolve();
        this.nextBlink = this.t0 + 2600;
        this.blinkUntil = 0;
        this.closing = false;
    }

    start() {
        this.screen.enter();
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on('data', (buf) => this.onData(buf));
        process.stdout.on('resize', () => {
            this.screen.invalidate();
            this.draw();
        });
        this.timer = setInterval(() => this.draw(), 50);
        this.statusTimer = setInterval(() => {
            if (this.view === 'menu') this.proxy = vpn.proxyStatus();
        }, 2000);
        this.loadClaudeVersion();
        this.refreshStatus();
        this.draw();
    }

    stopInput() {
        clearInterval(this.timer);
        clearInterval(this.statusTimer);
        try {
            process.stdin.removeAllListeners('data');
            if (process.stdin.isTTY) process.stdin.setRawMode(false);
            process.stdin.pause();
        } catch (e) {}
    }

    finish(code, summary) {
        if (this.closing) return;
        this.closing = true;
        this.stopInput();
        this.screen.leave();
        if (summary) process.stdout.write(`${summary}\n`);
        exitWith(code);
    }

    quit() {
        if (this.closing) return;
        if (this.run && this.run.mode === 'vpn' && this.run.status !== 'error') this.cancelRun();
        this.closing = true;
        this.stopInput();
        this.screen.leave();
        // Wait for an in-flight start so it can't leave an orphan proxy behind.
        this.pending.catch(() => {}).then(() => {
            try { vpn.stopVpnIfIdle(); } catch (e) {}
            exitWith(EXIT.ABORT);
        });
    }

    // ---- data ------------------------------------------------------------

    loadClaudeVersion() {
        const target = process.env.CLAUDE_LAUNCHER_TARGET || '';
        if (!target) {
            this.claudeInfo = { state: 'unknown', version: '' };
            return;
        }
        if (!fs.existsSync(target)) {
            this.claudeInfo = { state: 'missing', version: '' };
            return;
        }
        const fromPackage = versionFromPackage(target);
        if (fromPackage) {
            this.claudeInfo = { state: 'ok', version: fromPackage };
            return;
        }
        if (!/\.exe$/i.test(target) && process.platform === 'win32') {
            this.claudeInfo = { state: 'unknown', version: '' };
            return;
        }
        execFile(target, ['--version'], { timeout: 4000, windowsHide: true }, (err, stdout) => {
            const match = /(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)/.exec(String(stdout || ''));
            this.claudeInfo = match ? { state: 'ok', version: match[1] } : { state: 'unknown', version: '' };
        });
    }

    refreshStatus() {
        this.link = vpn.describeLink(this.cfg.vpn_link);
        this.proxy = vpn.proxyStatus();
        const id = ++this.pingId;
        if (!this.cfg.vpn_link || !this.link.ok) {
            this.ping = { state: 'idle' };
            return;
        }
        if (this.link.udp || !this.link.port) {
            this.ping = { state: 'skip' };
            return;
        }
        this.ping = { state: 'checking' };
        vpn.pingServer(this.cfg.vpn_link).then((r) => {
            if (id !== this.pingId) return;
            if (r.ok) this.ping = { state: 'ok', ms: r.ms };
            else this.ping = r.skipped ? { state: 'skip' } : { state: 'fail', error: r.error };
        });
    }

    // ---- input -----------------------------------------------------------

    onData(buf) {
        for (const key of parseKeys(buf)) {
            if (this.closing) return;
            if (key.name === 'ctrl-c') return this.quit();
            if (this.view === 'menu') this.onMenuKey(key);
            else if (this.view === 'setup') this.onSetupKey(key);
            else if (this.view === 'launch') this.onLaunchKey(key);
        }
        this.draw();
    }

    onMenuKey(key) {
        const n = MENU.length;
        const text = key.name === 'text' ? key.text.trim().toLowerCase() : '';
        if (key.name === 'up' || text === 'k') this.selected = (this.selected + n - 1) % n;
        else if (key.name === 'down' || key.name === 'tab' || text === 'j') this.selected = (this.selected + 1) % n;
        else if (key.name === 'home') this.selected = 0;
        else if (key.name === 'end') this.selected = n - 1;
        else if (key.name === 'enter') this.choose(this.selected);
        else if (key.name === 'esc' || text === 'q') this.quit();
        else if (/^[1-4]$/.test(text)) {
            this.selected = Number(text) - 1;
            this.choose(this.selected);
        }
    }

    choose(index) {
        this.toast = null;
        const item = MENU[index].key;
        if (item === 'vpn') {
            if (!this.cfg.vpn_link || !this.link.ok) {
                this.openSetup();
                this.toast = { kind: 'warning', text: this.cfg.vpn_link ? 'The saved link is invalid, paste a new one' : 'Add a VPN link first' };
            } else {
                this.launchVpn();
            }
        } else if (item === 'direct') {
            this.launchDirect();
        } else if (item === 'config') {
            this.openSetup();
        } else {
            this.quit();
        }
    }

    openSetup() {
        this.view = 'setup';
        this.input = '';
        this.toast = null;
    }

    appendInput(text) {
        this.input += String(text || '').replace(/[\r\n\t]+/g, '').replace(/[\x00-\x1f\x7f]/g, '');
        this.toast = null;
    }

    onSetupKey(key) {
        if (key.name === 'esc') {
            this.view = 'menu';
            this.toast = null;
        } else if (key.name === 'enter') {
            this.saveLink();
        } else if (key.name === 'backspace') {
            this.input = Array.from(this.input).slice(0, -1).join('');
            this.toast = null;
        } else if (key.name === 'ctrl-u') {
            this.input = '';
            this.toast = null;
        } else if (key.name === 'ctrl-w') {
            this.input = this.input.replace(/\S*\s*$/, '');
        } else if (key.name === 'ctrl-v') {
            readClipboard((text) => {
                this.appendInput(text);
                this.draw();
            });
        } else if (key.name === 'text') {
            this.appendInput(key.text);
        }
    }

    saveLink() {
        const value = this.input.trim().replace(/^"(.*)"$/, '$1');
        if (!value) {
            if (this.cfg.vpn_link) this.view = 'menu';
            else this.toast = { kind: 'error', text: 'No link entered' };
            return;
        }
        const info = vpn.describeLink(value);
        if (!info.ok) {
            this.toast = { kind: 'error', text: info.error };
            return;
        }
        this.cfg.vpn_link = value;
        this.cfg.auto_tun = false;
        try {
            vpn.saveConfig(this.cfg);
        } catch (err) {
            this.toast = { kind: 'error', text: `Could not save config: ${err.message}` };
            return;
        }
        this.view = 'menu';
        this.selected = 0;
        this.toast = { kind: 'success', text: `VPN link saved · ${info.summary}`, until: Date.now() + 5000 };
        this.refreshStatus();
    }

    onLaunchKey(key) {
        const run = this.run;
        if (!run) return;
        const text = key.name === 'text' ? key.text.trim().toLowerCase() : '';
        if (run.status === 'error') {
            if (text === 'r') this.launchVpn();
            else if (key.name === 'enter') this.backToMenu();
            else if (key.name === 'esc' || text === 'q') this.quit();
            return;
        }
        if (key.name === 'esc') {
            this.cancelRun();
            this.backToMenu();
            this.toast = { kind: 'warning', text: 'Launch cancelled', until: Date.now() + 3000 };
        }
    }

    backToMenu() {
        this.run = null;
        this.view = 'menu';
        this.refreshStatus();
    }

    cancelRun() {
        const run = this.run;
        if (!run || run.cancelled) return;
        run.cancelled = true;
        clearTimeout(run.timer);
        if (run.mode === 'vpn') {
            vpn.releaseSession(run.pid);
            // If the proxy is already up and nobody else uses it, stop it.
            if (run.status === 'launching') {
                try { vpn.stopVpnIfIdle(); } catch (e) {}
            }
        }
    }

    // ---- launching -------------------------------------------------------

    launchVpn() {
        const link = this.cfg.vpn_link;
        const info = vpn.describeLink(link);
        const run = {
            mode: 'vpn',
            pid: parentPid(),
            startedAt: Date.now(),
            verb: pick(VERBS),
            status: 'running',
            cancelled: false,
            steps: [
                { title: 'Read VPN link', state: 'done', detail: [info.summary, info.endpoint].filter(Boolean).join(' · ') },
                { title: 'Start sing-box', state: 'running', detail: '' }
            ]
        };
        const spawnStep = run.steps[1];
        let proxyStep = null;
        const addProxyStep = () => {
            if (!proxyStep) {
                proxyStep = { title: 'Open local proxy', state: 'running', detail: PROXY };
                run.steps.push(proxyStep);
            }
            return proxyStep;
        };

        this.run = run;
        this.view = 'launch';
        this.toast = null;
        vpn.registerSession(run.pid);

        const task = this.pending.catch(() => {}).then(() => vpn.startVpn(link, {
            onProgress: (event) => {
                if (event.phase === 'reused') {
                    spawnStep.state = 'done';
                    spawnStep.detail = `already running · pid ${event.pid}`;
                    const others = Math.max(0, vpn.activeSessions().length - 1);
                    const step = addProxyStep();
                    step.state = 'done';
                    step.detail = others ? `${PROXY} · shared with ${others} other session${others === 1 ? '' : 's'}` : `${PROXY} · reused`;
                } else if (event.phase === 'spawned') {
                    spawnStep.state = 'done';
                    spawnStep.detail = `pid ${event.pid}`;
                    addProxyStep();
                }
                this.proxy = vpn.proxyStatus();
            }
        }));
        this.pending = task;

        task.then((res) => {
            if (run.cancelled) {
                try { vpn.stopVpnIfIdle(); } catch (e) {}
                return;
            }
            if (!res.reused) {
                const step = addProxyStep();
                step.state = 'done';
                step.detail = `${PROXY} · ready in ${res.ms} ms`;
            }
            run.status = 'launching';
            this.cfg.last_mode = 'vpn';
            saveQuietly(this.cfg);
            const where = info.name || info.endpoint;
            const summary = `${ui.claude('✻')} ${ui.bold('Claude Code')} ${ui.dim(`via VPN · ${[info.protocol, where].filter(Boolean).join(' · ')} · ${PROXY}`)}`;
            run.timer = setTimeout(() => this.finish(EXIT.VPN, summary), 650);
        }, (err) => {
            vpn.releaseSession(run.pid);
            if (run.cancelled) return;
            const step = run.steps.find((s) => s.state === 'running') || spawnStep;
            step.state = 'error';
            step.detail = err.message;
            run.status = 'error';
            this.proxy = vpn.proxyStatus();
        });
    }

    launchDirect() {
        const run = {
            mode: 'direct',
            startedAt: Date.now(),
            verb: 'Launching',
            status: 'launching',
            cancelled: false,
            steps: [{ title: 'Direct connection', state: 'done', detail: 'no proxy for this session' }]
        };
        this.run = run;
        this.view = 'launch';
        this.toast = null;
        this.cfg.last_mode = 'direct';
        saveQuietly(this.cfg);
        const summary = `${ui.claude('✻')} ${ui.bold('Claude Code')} ${ui.dim('· direct connection')}`;
        run.timer = setTimeout(() => {
            // Housekeeping: stop a leftover proxy nobody is using.
            this.pending.catch(() => {}).then(() => {
                try { vpn.stopVpnIfIdle(); } catch (e) {}
                if (!run.cancelled) this.finish(EXIT.DIRECT, summary);
            });
        }, 450);
    }

    // ---- drawing ---------------------------------------------------------

    draw() {
        if (this.closing) return;
        const now = Date.now();
        const t = now - this.t0;
        if (now >= this.nextBlink) {
            this.blinkUntil = now + 150;
            this.nextBlink = now + 2500 + Math.random() * 3500;
        }
        if (this.toast && this.toast.until && now > this.toast.until) this.toast = null;

        const cols = process.stdout.columns || 80;
        const width = clamp(cols - 2, 48, 68);
        const lines = [''];
        lines.push(...this.header(t, width, now < this.blinkUntil));
        lines.push('');
        if (this.view === 'menu') lines.push(...this.menuView(t, width));
        else if (this.view === 'setup') lines.push(...this.setupView(t, width));
        else lines.push(...this.launchView(t, width));
        lines.push('');
        lines.push(this.signature(t, width));
        this.screen.render(lines.map((l) => ` ${l}`));
    }

    header(t, width, blinking) {
        const inner = width - 2;
        const border = (s) => ui.paint(ui.COLORS.claude, s);
        const busy = this.view === 'launch' && this.run && this.run.status !== 'error';

        const glyph = busy ? ui.spinner(t) : '✻';
        const title = ` ${ui.claude(glyph)} ${ui.bold(ui.shimmer('Claude Code VPN Launcher', t, { everyMs: 4200, sweepMs: 1300 }))} `;
        const version = ` v${VERSION} `;
        const fill = width - 7 - ui.strWidth(title) - ui.strWidth(version);
        const top = border('╭───') + title + border('─'.repeat(Math.max(1, fill))) + ui.dim(version) + border('──╮');

        const pose = ui.clawd(t, busy ? 'walk' : 'idle', blinking);
        const infoWidth = inner - 16;
        const info = this.infoLines(t, infoWidth);
        const row = (content) => border('│') + ui.padEnd(ui.clip(content, inner), inner) + border('│');

        const rows = [top, row('')];
        for (let i = 0; i < 4; i++) {
            const art = i < 3 ? ui.claude(pose[i]) : ' '.repeat(9);
            rows.push(row(`   ${art}   ${info[i] || ''}`));
        }
        rows.push(row(''));
        rows.push(border(`╰${'─'.repeat(inner)}╯`));
        return rows;
    }

    infoLines(t, width) {
        const label = (s) => ui.dim(s.padEnd(8));
        const rest = width - 8;
        const lines = [];

        let claudeLine = ui.bold('Claude Code');
        if (this.claudeInfo.state === 'loading') claudeLine += ` ${ui.dim(ui.spinner(t))}`;
        else if (this.claudeInfo.version) claudeLine += ` ${ui.dim(`v${this.claudeInfo.version}`)}`;
        else if (this.claudeInfo.state === 'missing') claudeLine += ` ${ui.error('not found')}`;
        lines.push(claudeLine);

        const endpoint = this.link.ok ? this.link.endpoint : '';
        if (!this.cfg.vpn_link) {
            lines.push(label('VPN') + ui.dim('not configured'));
        } else if (!this.link.ok) {
            lines.push(label('VPN') + ui.error(ui.truncate(this.link.error, rest)));
        } else {
            const text = this.link.name ? `${this.link.summary} · ${this.link.name}` : this.link.summary;
            lines.push(label('VPN') + ui.truncate(text, rest));
        }

        const ping = this.ping;
        let server = label('Server');
        if (!this.cfg.vpn_link || !this.link.ok) {
            server += ui.dim('—');
        } else if (ping.state === 'checking') {
            server += `${ui.claude(ui.spinner(t))} ${ui.shimmer('checking…', t, { base: ui.COLORS.dim, hi: [235, 235, 235], sweepMs: 1100 })}`;
        } else if (ping.state === 'ok') {
            server += `${ui.success('●')} ${ping.ms} ms${ui.dim(` · ${ui.truncate(endpoint, Math.max(4, rest - 12))}`)}`;
        } else if (ping.state === 'fail') {
            server += `${ui.error('●')} ${ui.error('unreachable')}${ui.dim(` · ${ui.truncate(endpoint, Math.max(4, rest - 16))}`)}`;
        } else if (ping.state === 'skip') {
            server += ui.dim(ui.truncate(`○ ${endpoint || 'custom config'}`, rest));
        } else {
            server += ui.dim('—');
        }
        lines.push(server);

        const n = this.proxy.sessions;
        if (this.proxy.running) {
            lines.push(`${label('Proxy')}${ui.success('●')} running${ui.dim(` · ${n ? `${n} session${n === 1 ? '' : 's'}` : 'idle'}`)}`);
        } else {
            lines.push(label('Proxy') + ui.dim(`○ stopped · ${PROXY}`));
        }
        return lines.map((l) => ui.clip(l, width));
    }

    menuDescription(key) {
        if (key === 'vpn') {
            if (!this.cfg.vpn_link) return { text: 'add a VPN link first', color: ui.warning };
            if (!this.link.ok) return { text: 'saved link is invalid', color: ui.error };
            return { text: `sing-box → ${PROXY}`, color: ui.dim };
        }
        if (key === 'direct') return { text: 'no proxy', color: ui.dim };
        if (key === 'config') return { text: this.cfg.vpn_link ? 'change VPN link' : 'paste your VPN link', color: ui.dim };
        return { text: '', color: ui.dim };
    }

    toastLines(width) {
        const toast = this.toast;
        const icon = toast.kind === 'success' ? ui.success('✔') : toast.kind === 'warning' ? ui.warning('!') : ui.error('✘');
        const color = toast.kind === 'success' ? ui.success : toast.kind === 'warning' ? ui.warning : ui.error;
        return ui.wrap(toast.text, width - 6).slice(0, 3).map((l, i) => `  ${i === 0 ? icon : ' '} ${color(l)}`);
    }

    menuView(t, width) {
        const out = [`  ${ui.bold('How should Claude Code connect?')}`, ''];
        MENU.forEach((item, i) => {
            const selected = i === this.selected;
            const text = `${i + 1}. ${item.label}`;
            const label = selected
                ? ui.bold(ui.shimmer(text, t, { everyMs: 2600, sweepMs: 1200, radius: 4 }))
                : text;
            const pointer = selected ? ui.claude('❯') : ' ';
            const desc = this.menuDescription(item.key);
            const room = width - 27;
            const descText = room >= 8 ? desc.color(ui.truncate(desc.text, room)) : '';
            out.push(`  ${pointer} ${ui.padEnd(label, 23)}${descText}`);
        });
        out.push('');
        if (this.toast) out.push(...this.toastLines(width));
        else out.push(`  ${ui.dim(`⎿  Tip: ${ui.truncate(this.tip, width - 12)}`)}`);
        out.push('');
        const hint = width >= 58 ? '↑/↓ select · enter launch · 1-4 quick pick · esc exit' : '↑/↓ select · enter launch · esc exit';
        out.push(`  ${ui.dim(hint)}`);
        return out;
    }

    setupView(t, width) {
        const gray = (s) => ui.paint(ui.COLORS.border, s);
        const out = [
            `  ${ui.bold(this.cfg.vpn_link ? 'Replace your VPN link' : 'Paste your VPN link')}`,
            `  ${ui.dim('vless · vmess · trojan · ss · hysteria2 · tuic · sing-box .json')}`,
            ''
        ];

        const innerWidth = width - 4;
        const fieldWidth = innerWidth - 3;
        let field;
        if (this.input) {
            field = ui.truncateStart(maskLink(this.input), fieldWidth - 1) + ui.inverse(' ');
        } else {
            field = ui.inverse('v') + ui.dim(ui.truncate('less://…  or a path to config.json', fieldWidth - 1));
        }
        out.push(`  ${gray(`╭${'─'.repeat(innerWidth)}╮`)}`);
        out.push(`  ${gray('│')} ${ui.claude('>')} ${ui.padEnd(field, fieldWidth)}${gray('│')}`);
        out.push(`  ${gray(`╰${'─'.repeat(innerWidth)}╯`)}`);

        const value = this.input.trim();
        if (this.toast) {
            out.push(...this.toastLines(width));
        } else if (!value) {
            if (this.cfg.vpn_link && this.link.ok) {
                out.push(`  ${ui.dim(ui.truncate(`Current: ${this.link.summary} · ${this.link.endpoint}`, width - 4))}`);
            } else {
                out.push(`  ${ui.dim(`${ui.spinner(t, 160)} Waiting for a link…`)}`);
            }
        } else {
            if (this.preview.value !== value) this.preview = { value, info: vpn.describeLink(value) };
            const info = this.preview.info;
            if (info.ok) {
                const extra = [info.endpoint, info.name].filter(Boolean).join(' · ');
                const summary = ui.truncate(info.summary, 30);
                const rest = Math.max(4, width - 8 - ui.strWidth(summary));
                out.push(`  ${ui.success('✔')} ${summary}${ui.dim(ui.truncate(` · ${extra}`, rest))}`);
            } else {
                out.push(...ui.wrap(info.error, width - 6).slice(0, 2).map((l, i) => `  ${i === 0 ? ui.error('✘') : ' '} ${ui.error(l)}`));
            }
        }
        out.push('');
        out.push(`  ${ui.dim(this.cfg.vpn_link ? 'enter save · ctrl+v paste · ctrl+u clear · esc back' : 'enter save · ctrl+v paste · ctrl+u clear · esc skip')}`);
        return out;
    }

    launchView(t, width) {
        const run = this.run;
        const out = [];
        for (const step of run.steps) {
            let dot;
            if (step.state === 'done') dot = ui.success('●');
            else if (step.state === 'error') dot = ui.error('●');
            else dot = ui.blinkOn(t, 900) ? ui.dim('●') : ' ';
            out.push(`  ${dot} ${ui.bold(step.title)}`);
            if (step.detail) {
                const detailLines = step.state === 'error'
                    ? ui.wrap(step.detail, width - 10).slice(0, 3)
                    : [ui.truncate(step.detail, width - 10)];
                detailLines.forEach((l, i) => {
                    out.push(`    ${ui.dim(i === 0 ? '⎿' : ' ')}  ${step.state === 'error' ? ui.error(l) : ui.dim(l)}`);
                });
            }
        }
        out.push('');
        if (run.status === 'error') {
            out.push(`  ${ui.error('✘')} ${ui.bold('Could not start the VPN proxy')}`);
            out.push(`  ${ui.dim(ui.truncateStart(`log: ${vpn.LOG_FILE}`, width - 4))}`);
            out.push('');
            out.push(`  ${ui.dim('r retry · enter back · esc exit')}`);
        } else {
            const elapsed = Math.floor((Date.now() - run.startedAt) / 1000);
            const message = run.status === 'launching' ? 'Launching Claude Code…' : `${run.verb}…`;
            out.push(`  ${ui.claude(ui.spinner(t))} ${ui.shimmer(message, t, { sweepMs: 1500 })} ${ui.dim(`(${elapsed}s · esc to cancel)`)}`);
        }
        return out;
    }

    signature(t, width) {
        const text = 'with love by DragonCraft ';
        const pad = Math.max(2, width - ui.strWidth(text) - 1);
        return `${' '.repeat(pad)}${ui.dim(text)}${ui.heartbeat(t)}♥\x1b[39m`;
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

let app = null;

function restoreTerminal() {
    if (app && app.screen.active) {
        try { fs.writeSync(1, '\x1b[0m\x1b[?25h\x1b[?1049l'); } catch (e) {}
        app.screen.active = false;
    }
    try {
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
    } catch (e) {}
}

process.on('exit', restoreTerminal);
process.on('uncaughtException', (err) => {
    restoreTerminal();
    process.stderr.write(`claude-launcher crashed: ${err && err.stack ? err.stack : err}\n`);
    process.stderr.write('Tip: set CLAUDE_LAUNCHER_MODE=direct to bypass the menu.\n');
    process.exit(EXIT.ABORT);
});

function main() {
    const args = readArgs();
    const kind = classifyArgs(args);
    const forced = String(process.env.CLAUDE_LAUNCHER_MODE || '').trim().toLowerCase();
    const cfg = vpn.loadConfig();
    const lastMode = cfg.last_mode === 'vpn' ? 'vpn' : 'direct';
    const interactiveTerminal = tty.isatty(0) && tty.isatty(1) && process.env.CLAUDE_LAUNCHER_PIPED !== '1';

    if (kind === 'info') return exitWith(EXIT.DIRECT);
    if (forced === 'vpn' || forced === 'direct') return quickLaunch(forced, cfg);
    if (forced === 'last') return quickLaunch(lastMode, cfg);
    if (!interactiveTerminal) return quickLaunch(lastMode, cfg);
    if (kind === 'headless' && forced !== 'menu') return quickLaunch(lastMode, cfg);

    app = new App(cfg);
    app.start();
}

main();
