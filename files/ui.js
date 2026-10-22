'use strict';

// Terminal drawing helpers in the style of Claude Code: its colors, the
// "· ✢ * ✶ ✻ ✽" spinner, the shimmering status text and the Clawd mascot.

const IS_MAC = process.platform === 'darwin';

const COLORS = {
    claude: [215, 119, 87],
    shimmer: [245, 149, 117],
    dim: [153, 153, 153],
    faint: [102, 102, 102],
    border: [136, 136, 136],
    success: [78, 186, 101],
    error: [255, 107, 128],
    warning: [255, 193, 7],
    heart: [235, 87, 87]
};

const RESET = '\x1b[0m';
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_AT = /\x1b\[[0-9;?]*[ -/]*[@-~]/y;

function fg(rgb) {
    return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}

function paint(rgb, text) {
    return `${fg(rgb)}${text}\x1b[39m`;
}

function bold(text) {
    return `\x1b[1m${text}\x1b[22m`;
}

function inverse(text) {
    return `\x1b[7m${text}\x1b[27m`;
}

function mix(a, b, k) {
    return [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * k));
}

const claude = (t) => paint(COLORS.claude, t);
const dim = (t) => paint(COLORS.dim, t);
const faint = (t) => paint(COLORS.faint, t);
const success = (t) => paint(COLORS.success, t);
const error = (t) => paint(COLORS.error, t);
const warning = (t) => paint(COLORS.warning, t);

// ---------------------------------------------------------------------------
// Text width (so borders line up even with emoji or CJK in VPN names)
// ---------------------------------------------------------------------------

function charWidth(cp) {
    if (cp === 0) return 0;
    if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
    if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || cp === 0x2060 ||
        (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x20d0 && cp <= 0x20ff) || (cp >= 0xe0100 && cp <= 0xe01ef)) {
        return 0;
    }
    if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
        (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) ||
        (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) ||
        (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f680 && cp <= 0x1f6ff) || (cp >= 0x1f900 && cp <= 0x1faff) ||
        (cp >= 0x1f004 && cp <= 0x1f1e5) || (cp >= 0x1f200 && cp <= 0x1f251) || (cp >= 0x20000 && cp <= 0x3fffd)) {
        return 2;
    }
    // BMP symbols that terminals draw as two-column emoji.
    if (cp === 0x231a || cp === 0x231b || (cp >= 0x23e9 && cp <= 0x23ec) || cp === 0x23f0 || cp === 0x23f3 ||
        cp === 0x25fd || cp === 0x25fe || cp === 0x2614 || cp === 0x2615 || (cp >= 0x2648 && cp <= 0x2653) ||
        cp === 0x267f || cp === 0x2693 || cp === 0x26a1 || cp === 0x26aa || cp === 0x26ab || cp === 0x26bd ||
        cp === 0x26be || cp === 0x26c4 || cp === 0x26c5 || cp === 0x26ce || cp === 0x26d4 || cp === 0x26ea ||
        cp === 0x26f2 || cp === 0x26f3 || cp === 0x26f5 || cp === 0x26fa || cp === 0x26fd || cp === 0x2705 ||
        cp === 0x270a || cp === 0x270b || cp === 0x2728 || cp === 0x274c || cp === 0x274e ||
        (cp >= 0x2753 && cp <= 0x2755) || cp === 0x2757 || (cp >= 0x2795 && cp <= 0x2797) || cp === 0x27b0 ||
        cp === 0x27bf || cp === 0x2b1b || cp === 0x2b1c || cp === 0x2b50 || cp === 0x2b55) {
        return 2;
    }
    return 1;
}

function stripAnsi(text) {
    return String(text).replace(ANSI_RE, '');
}

function strWidth(text) {
    let width = 0;
    for (const ch of stripAnsi(text)) width += charWidth(ch.codePointAt(0));
    return width;
}

/** Cuts plain text to `max` columns, ending with "…" when cut. */
function truncate(text, max) {
    text = String(text);
    if (max <= 0) return '';
    if (strWidth(text) <= max) return text;
    let out = '';
    let width = 0;
    for (const ch of text) {
        const w = charWidth(ch.codePointAt(0));
        if (width + w > max - 1) break;
        out += ch;
        width += w;
    }
    return `${out}…`;
}

/** Keeps the end of plain text: "…tail". */
function truncateStart(text, max) {
    text = String(text);
    if (max <= 0) return '';
    if (strWidth(text) <= max) return text;
    const chars = Array.from(text);
    let out = '';
    let width = 0;
    for (let i = chars.length - 1; i >= 0; i--) {
        const w = charWidth(chars[i].codePointAt(0));
        if (width + w > max - 1) break;
        out = chars[i] + out;
        width += w;
    }
    return `…${out}`;
}

function padEnd(text, width) {
    return text + ' '.repeat(Math.max(0, width - strWidth(text)));
}

/** ANSI-aware cut to `max` visible columns. */
function clip(line, max) {
    if (strWidth(line) <= max) return line;
    let out = '';
    let width = 0;
    let i = 0;
    while (i < line.length) {
        if (line[i] === '\x1b') {
            ANSI_AT.lastIndex = i;
            const m = ANSI_AT.exec(line);
            if (m) {
                out += m[0];
                i += m[0].length;
                continue;
            }
        }
        const cp = line.codePointAt(i);
        const ch = String.fromCodePoint(cp);
        const w = charWidth(cp);
        if (width + w > max) break;
        out += ch;
        width += w;
        i += ch.length;
    }
    return out + RESET;
}

function wrap(text, width) {
    const words = String(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let current = '';
    for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;
        if (strWidth(candidate) <= width || !current) {
            current = candidate;
        } else {
            lines.push(current);
            current = word;
        }
    }
    if (current) lines.push(current);
    return lines.map((l) => truncate(l, width));
}

// ---------------------------------------------------------------------------
// Animations
// ---------------------------------------------------------------------------

// Claude Code's spinner: forward, then backwards ("·✢*✶✻✽✽✻✶*✢·").
const SPINNER_GLYPHS = IS_MAC ? ['·', '✢', '✳', '✶', '✻', '✽'] : ['·', '✢', '*', '✶', '✻', '✽'];
const SPINNER_FRAMES = [...SPINNER_GLYPHS, ...SPINNER_GLYPHS.slice().reverse()];

function spinner(t, interval = 120) {
    return SPINNER_FRAMES[Math.floor(t / interval) % SPINNER_FRAMES.length];
}

/**
 * Colors text with a moving highlight, like Claude Code's "Thinking…" line.
 * everyMs > 0 sweeps once per period; otherwise it loops continuously.
 */
function shimmer(text, t, { base = COLORS.claude, hi = COLORS.shimmer, sweepMs = 1400, everyMs = 0, radius = 3 } = {}) {
    const chars = Array.from(text);
    const span = chars.length + radius * 2;
    let phase;
    if (everyMs > 0) {
        const local = t % everyMs;
        phase = local < sweepMs ? local / sweepMs : -1;
    } else {
        phase = (t % sweepMs) / sweepMs;
    }
    const pos = phase < 0 ? -1e9 : phase * span - radius;
    let out = '';
    let last = '';
    for (let i = 0; i < chars.length; i++) {
        const k = Math.max(0, 1 - Math.abs(i - pos) / radius);
        const code = fg(mix(base, hi, k));
        if (code !== last) {
            out += code;
            last = code;
        }
        out += chars[i];
    }
    return `${out}\x1b[39m`;
}

/** Soft "heartbeat": two quick pulses, then rest. */
function heartbeat(t) {
    const local = t % 1600;
    const pulse = (center) => Math.max(0, 1 - Math.abs(local - center) / 110);
    const k = Math.max(pulse(120), pulse(380));
    return fg(mix(COLORS.claude, COLORS.heart, k));
}

/** Blinking dot for "in progress" steps (Claude Code's tool-call dot). */
function blinkOn(t, period = 1000) {
    return t % period < period * 0.6;
}

// Clawd, the Claude Code mascot. All rows are 9 columns wide.
const CLAWD = {
    idle: [' ▐▛███▜▌ ', '▝▜█████▛▘', '  ▘▘ ▝▝  '],
    blink: [' ▐█████▌ ', '▝▜█████▛▘', '  ▘▘ ▝▝  '],
    wave: [' ▐▛███▜▌ ', '▝▜█████▛▖', '  ▘▘ ▝▝  '],
    walkA: [' ▐▛███▜▌ ', '▝▜█████▛▘', '  ▘▘ ▝▝  '],
    walkB: [' ▐▛███▜▌ ', '▝▜█████▛▘', '  ▝▘ ▝▘  ']
};

/**
 * Picks Clawd's pose. mood: 'idle' | 'walk'.
 * Waves hello for the first second, then blinks every few seconds.
 */
function clawd(t, mood, blinking) {
    if (mood === 'walk') return Math.floor(t / 180) % 2 ? CLAWD.walkB : CLAWD.walkA;
    if (t < 1100) return Math.floor(t / 180) % 2 ? CLAWD.wave : CLAWD.idle;
    return blinking ? CLAWD.blink : CLAWD.idle;
}

// ---------------------------------------------------------------------------
// Screen: alternate buffer + line diffing, so animation never flickers
// ---------------------------------------------------------------------------

class Screen {
    constructor(out) {
        this.out = out;
        this.prev = [];
        this.active = false;
    }

    enter() {
        this.active = true;
        this.prev = [];
        this.out.write('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H');
    }

    leave() {
        if (!this.active) return;
        this.active = false;
        this.out.write(`${RESET}\x1b[2J\x1b[H\x1b[?25h\x1b[?1049l`);
    }

    invalidate() {
        this.prev = [];
        if (this.active) this.out.write('\x1b[2J');
    }

    render(lines) {
        if (!this.active) return;
        const cols = this.out.columns || 80;
        const rows = this.out.rows || 40;
        const visible = lines.slice(0, Math.max(1, rows - 1)).map((l) => clip(l, Math.max(1, cols - 1)));
        let buf = '';
        const total = Math.max(visible.length, this.prev.length);
        for (let i = 0; i < total; i++) {
            const line = visible[i] === undefined ? '' : visible[i];
            if (line !== this.prev[i]) buf += `\x1b[${i + 1};1H${line}${RESET}\x1b[K`;
        }
        this.prev = visible;
        if (buf) this.out.write(buf);
    }
}

module.exports = {
    COLORS,
    RESET,
    fg,
    paint,
    bold,
    inverse,
    claude,
    dim,
    faint,
    success,
    error,
    warning,
    stripAnsi,
    strWidth,
    truncate,
    truncateStart,
    padEnd,
    clip,
    wrap,
    spinner,
    shimmer,
    heartbeat,
    blinkOn,
    clawd,
    Screen,
    SPINNER_FRAMES
};
