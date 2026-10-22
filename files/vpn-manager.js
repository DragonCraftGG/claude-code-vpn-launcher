'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const IS_WIN = process.platform === 'win32';

// CLAUDE_LAUNCHER_HOME / CLAUDE_LAUNCHER_SINGBOX exist mostly for testing.
const LAUNCHER_DIR = process.env.CLAUDE_LAUNCHER_HOME || path.join(os.homedir(), '.claude-launcher');
const BIN_DIR = path.join(LAUNCHER_DIR, 'bin');
const SINGBOX_EXE = process.env.CLAUDE_LAUNCHER_SINGBOX || path.join(BIN_DIR, IS_WIN ? 'sing-box.exe' : 'sing-box');
const CONFIG_FILE = path.join(LAUNCHER_DIR, 'config.json');
const GENERATED_SINGBOX_CONFIG = path.join(LAUNCHER_DIR, 'singbox_run.json');
const STATE_FILE = path.join(LAUNCHER_DIR, 'singbox.state.json');
const LOG_FILE = path.join(LAUNCHER_DIR, 'sing-box.log');
const SESSIONS_DIR = path.join(LAUNCHER_DIR, 'sessions');
const PROXY_HOST = '127.0.0.1';
const DEFAULT_PROXY_PORT = 2081;
const PROXY_PORT = readProxyPort();
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const DEFAULT_CONFIG = { vpn_link: '', auto_tun: false, last_mode: '' };

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

// "proxy_port" in config.json overrides 2081 (Windows sometimes reserves it
// for Hyper-V / WSL / Docker). The shim reads the same setting.
function readProxyPort() {
    try {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, ''));
        const port = parseInt(cfg.proxy_port, 10);
        if (port > 0 && port < 65536) return port;
    } catch (e) {}
    return DEFAULT_PROXY_PORT;
}

function loadConfig() {
    try {
        const raw = fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^﻿/, '');
        return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    } catch (e) {
        return { ...DEFAULT_CONFIG };
    }
}

function saveConfig(cfg) {
    ensureDir(LAUNCHER_DIR);
    const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
    fs.renameSync(tmp, CONFIG_FILE);
}

// ---------------------------------------------------------------------------
// Link parsing
// ---------------------------------------------------------------------------

function safeDecode(value) {
    if (value == null) return '';
    try {
        return decodeURIComponent(value);
    } catch (e) {
        return value;
    }
}

function b64decode(value) {
    return Buffer.from(String(value).trim(), 'base64').toString('utf8');
}

function toPort(value, fallback) {
    const port = parseInt(value, 10);
    return port > 0 && port < 65536 ? port : fallback;
}

function isTruthy(value) {
    return value === '1' || value === 'true' || value === true || value === 1;
}

function stripBrackets(host) {
    return String(host || '').replace(/^\[(.*)\]$/, '$1');
}

function splitTag(uri) {
    const hashIdx = uri.indexOf('#');
    if (hashIdx === -1) return [uri, ''];
    return [uri.slice(0, hashIdx), safeDecode(uri.slice(hashIdx + 1)).trim()];
}

function splitList(value) {
    return String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function buildTls(params, server, { defaultSecurity = 'none', defaultFingerprint = '' } = {}) {
    const security = (params.get('security') || defaultSecurity).toLowerCase();
    if (security !== 'tls' && security !== 'reality' && security !== 'xtls') return null;

    const tls = {
        enabled: true,
        server_name: params.get('sni') || params.get('peer') || params.get('host') || server
    };
    const alpn = splitList(params.get('alpn'));
    if (alpn.length) tls.alpn = alpn;
    if (isTruthy(params.get('allowInsecure')) || isTruthy(params.get('insecure'))) tls.insecure = true;

    const fingerprint = params.get('fp') || (security === 'reality' ? 'chrome' : defaultFingerprint);
    if (fingerprint) tls.utls = { enabled: true, fingerprint };

    if (security === 'reality') {
        tls.reality = {
            enabled: true,
            public_key: params.get('pbk') || '',
            short_id: params.get('sid') || ''
        };
    }
    return { tls, security: security === 'xtls' ? 'tls' : security };
}

function applyTransport(outbound, network, { host = '', pathValue = '', serviceName = '' } = {}) {
    const type = String(network || 'tcp').toLowerCase();
    if (!type || type === 'tcp' || type === 'raw' || type === 'none') return 'tcp';

    if (type === 'ws' || type === 'websocket') {
        const transport = { type: 'ws' };
        let wsPath = pathValue || '/';
        const earlyData = /[?&]ed=(\d+)/.exec(wsPath);
        if (earlyData) {
            transport.max_early_data = Number(earlyData[1]);
            transport.early_data_header_name = 'Sec-WebSocket-Protocol';
            wsPath = wsPath.replace(/([?&])ed=\d+&?/, '$1').replace(/[?&]$/, '');
        }
        transport.path = wsPath || '/';
        if (host) transport.headers = { Host: host };
        outbound.transport = transport;
        return 'ws';
    }
    if (type === 'grpc') {
        outbound.transport = { type: 'grpc', service_name: serviceName || '' };
        return 'grpc';
    }
    if (type === 'httpupgrade') {
        outbound.transport = { type: 'httpupgrade', path: pathValue || '/' };
        if (host) outbound.transport.host = host;
        return 'httpupgrade';
    }
    if (type === 'h2' || type === 'http') {
        outbound.transport = { type: 'http', path: pathValue || '/' };
        const hosts = splitList(host);
        if (hosts.length) outbound.transport.host = hosts;
        return 'http';
    }
    throw new Error(`Transport "${type}" is not supported by sing-box.`);
}

function parseVless(uri) {
    const [clean, name] = splitTag(uri);
    const url = new URL(clean);
    const params = url.searchParams;
    const server = stripBrackets(url.hostname);
    const outbound = {
        type: 'vless',
        tag: 'proxy',
        server,
        server_port: toPort(url.port, 443),
        uuid: safeDecode(url.username)
    };

    const flow = params.get('flow');
    if (flow) outbound.flow = flow.startsWith('xtls-rprx-vision') ? 'xtls-rprx-vision' : flow;
    const packetEncoding = params.get('packetEncoding');
    if (packetEncoding) outbound.packet_encoding = packetEncoding;

    const tls = buildTls(params, server, { defaultFingerprint: 'chrome' });
    if (tls) outbound.tls = tls.tls;

    const transport = applyTransport(outbound, params.get('type'), {
        host: params.get('host') || '',
        pathValue: params.get('path') || '',
        serviceName: params.get('serviceName') || params.get('servicename') || ''
    });

    if (!outbound.uuid) throw new Error('VLESS link has no UUID.');
    return {
        outbound,
        meta: { protocol: 'vless', server, port: outbound.server_port, security: tls ? tls.security : '', transport, name }
    };
}

function parseTrojan(uri) {
    const [clean, name] = splitTag(uri);
    const url = new URL(clean);
    const params = url.searchParams;
    const server = stripBrackets(url.hostname);
    const outbound = {
        type: 'trojan',
        tag: 'proxy',
        server,
        server_port: toPort(url.port, 443),
        password: safeDecode(url.username)
    };

    const tls = buildTls(params, server, { defaultSecurity: 'tls' });
    if (tls) outbound.tls = tls.tls;

    const transport = applyTransport(outbound, params.get('type'), {
        host: params.get('host') || '',
        pathValue: params.get('path') || '',
        serviceName: params.get('serviceName') || params.get('servicename') || ''
    });

    if (!outbound.password) throw new Error('Trojan link has no password.');
    return {
        outbound,
        meta: { protocol: 'trojan', server, port: outbound.server_port, security: tls ? tls.security : '', transport, name }
    };
}

function splitHostPort(value, fallbackPort) {
    const text = String(value || '').trim();
    const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(text);
    if (v6) return [v6[1], toPort(v6[2], fallbackPort)];
    const idx = text.lastIndexOf(':');
    if (idx === -1) return [text, fallbackPort];
    return [text.slice(0, idx), toPort(text.slice(idx + 1), fallbackPort)];
}

function parseShadowsocks(uri) {
    const [clean, name] = splitTag(uri);
    let body = clean.slice('ss://'.length);
    let query = '';
    const queryIdx = body.indexOf('?');
    if (queryIdx !== -1) {
        query = body.slice(queryIdx + 1);
        body = body.slice(0, queryIdx);
    }
    body = body.replace(/\/+$/, '');

    let userInfo;
    let hostPort;
    const atIdx = body.lastIndexOf('@');
    if (atIdx === -1) {
        // Legacy format: ss://base64(method:password@host:port)
        const decoded = b64decode(body);
        const innerAt = decoded.lastIndexOf('@');
        if (innerAt === -1) throw new Error('Shadowsocks link is malformed.');
        userInfo = decoded.slice(0, innerAt);
        hostPort = decoded.slice(innerAt + 1);
    } else {
        userInfo = safeDecode(body.slice(0, atIdx));
        hostPort = body.slice(atIdx + 1);
        if (!userInfo.includes(':')) userInfo = b64decode(userInfo);
    }

    const colonIdx = userInfo.indexOf(':');
    if (colonIdx === -1) throw new Error('Shadowsocks link has no method/password.');
    const method = userInfo.slice(0, colonIdx);
    const password = userInfo.slice(colonIdx + 1);
    const [server, port] = splitHostPort(hostPort, 8388);

    const outbound = { type: 'shadowsocks', tag: 'proxy', server, server_port: port, method, password };

    const plugin = new URLSearchParams(query).get('plugin');
    if (plugin) {
        const sep = plugin.indexOf(';');
        const pluginName = sep === -1 ? plugin : plugin.slice(0, sep);
        outbound.plugin = pluginName === 'simple-obfs' ? 'obfs-local' : pluginName;
        if (sep !== -1) outbound.plugin_opts = plugin.slice(sep + 1);
    }

    if (!server) throw new Error('Shadowsocks link has no server.');
    return {
        outbound,
        meta: { protocol: 'ss', server, port, security: method, transport: outbound.plugin || 'tcp', name }
    };
}

function parseVmess(uri) {
    const body = uri.slice('vmess://'.length);
    let v = null;
    try {
        v = JSON.parse(b64decode(body.split('#')[0]));
    } catch (e) {
        v = null;
    }

    if (!v || typeof v !== 'object') {
        // Standard URI form: vmess://uuid@host:port?type=ws&security=tls#name
        const [clean, name] = splitTag(uri);
        const url = new URL(clean);
        const params = url.searchParams;
        const server = stripBrackets(url.hostname);
        const outbound = {
            type: 'vmess',
            tag: 'proxy',
            server,
            server_port: toPort(url.port, 443),
            uuid: safeDecode(url.username),
            alter_id: 0,
            security: params.get('encryption') || 'auto'
        };
        const tls = buildTls(params, server);
        if (tls) outbound.tls = tls.tls;
        const transport = applyTransport(outbound, params.get('type'), {
            host: params.get('host') || '',
            pathValue: params.get('path') || '',
            serviceName: params.get('serviceName') || ''
        });
        if (!outbound.uuid) throw new Error('VMess link has no UUID.');
        return {
            outbound,
            meta: { protocol: 'vmess', server, port: outbound.server_port, security: tls ? tls.security : '', transport, name }
        };
    }

    const server = String(v.add || '').trim();
    const outbound = {
        type: 'vmess',
        tag: 'proxy',
        server,
        server_port: toPort(v.port, 443),
        uuid: String(v.id || ''),
        alter_id: parseInt(v.aid, 10) || 0,
        security: v.scy || 'auto'
    };

    const tlsOn = v.tls === true || String(v.tls || '').toLowerCase() === 'tls';
    if (tlsOn) {
        outbound.tls = { enabled: true, server_name: v.sni || v.host || server };
        const alpn = splitList(v.alpn);
        if (alpn.length) outbound.tls.alpn = alpn;
        if (v.fp) outbound.tls.utls = { enabled: true, fingerprint: v.fp };
        if (isTruthy(v.allowInsecure) || isTruthy(v.insecure)) outbound.tls.insecure = true;
    }

    const transport = applyTransport(outbound, v.net, {
        host: v.host || '',
        pathValue: v.path || '',
        serviceName: v.path || ''
    });

    if (!server) throw new Error('VMess link has no server.');
    if (!outbound.uuid) throw new Error('VMess link has no UUID.');
    return {
        outbound,
        meta: { protocol: 'vmess', server, port: outbound.server_port, security: tlsOn ? 'tls' : '', transport, name: String(v.ps || '').trim() }
    };
}

function parseHysteria2(uri) {
    const [clean, name] = splitTag(uri.replace(/^hy2:\/\//i, 'hysteria2://'));
    const url = new URL(clean);
    const params = url.searchParams;
    const server = stripBrackets(url.hostname);
    const password = url.password ? `${safeDecode(url.username)}:${safeDecode(url.password)}` : safeDecode(url.username);
    const outbound = {
        type: 'hysteria2',
        tag: 'proxy',
        server,
        server_port: toPort(url.port, 443),
        password,
        tls: { enabled: true, server_name: params.get('sni') || server }
    };
    if (isTruthy(params.get('insecure'))) outbound.tls.insecure = true;
    const alpn = splitList(params.get('alpn'));
    if (alpn.length) outbound.tls.alpn = alpn;

    const obfs = params.get('obfs');
    if (obfs && obfs !== 'none') {
        outbound.obfs = { type: obfs, password: params.get('obfs-password') || '' };
    }
    const hopPorts = params.get('mport');
    if (hopPorts) outbound.server_ports = splitList(hopPorts).map((p) => p.replace('-', ':'));

    return {
        outbound,
        meta: { protocol: 'hysteria2', server, port: outbound.server_port, security: 'tls', transport: 'quic', name, udp: true }
    };
}

function parseTuic(uri) {
    const [clean, name] = splitTag(uri);
    const url = new URL(clean);
    const params = url.searchParams;
    const server = stripBrackets(url.hostname);
    const outbound = {
        type: 'tuic',
        tag: 'proxy',
        server,
        server_port: toPort(url.port, 443),
        uuid: safeDecode(url.username),
        password: safeDecode(url.password),
        tls: { enabled: true, server_name: params.get('sni') || server }
    };
    const cc = params.get('congestion_control') || params.get('congestion');
    if (cc) outbound.congestion_control = cc;
    const relay = params.get('udp_relay_mode');
    if (relay) outbound.udp_relay_mode = relay;
    const alpn = splitList(params.get('alpn'));
    if (alpn.length) outbound.tls.alpn = alpn;
    if (isTruthy(params.get('allow_insecure')) || isTruthy(params.get('insecure'))) outbound.tls.insecure = true;
    if (isTruthy(params.get('disable_sni'))) outbound.tls.disable_sni = true;

    if (!outbound.uuid) throw new Error('TUIC link has no UUID.');
    return {
        outbound,
        meta: { protocol: 'tuic', server, port: outbound.server_port, security: 'tls', transport: 'quic', name, udp: true }
    };
}

function parseJsonConfig(obj) {
    if (!obj || typeof obj !== 'object') throw new Error('JSON config is empty.');

    if (Array.isArray(obj.outbounds)) {
        const first = obj.outbounds.find((o) => o && o.server) || obj.outbounds[0] || {};
        if (first.protocol && !first.type) {
            throw new Error('This looks like an Xray/V2Ray config. Paste a share link (vless://...) or a sing-box config.');
        }
        return {
            kind: 'config',
            config: obj,
            meta: {
                protocol: first.type || 'sing-box',
                server: first.server || '',
                port: first.server_port || 0,
                security: first.tls && first.tls.reality && first.tls.reality.enabled ? 'reality' : (first.tls && first.tls.enabled ? 'tls' : ''),
                transport: (first.transport && first.transport.type) || 'tcp',
                name: 'sing-box config',
                udp: first.type === 'hysteria2' || first.type === 'tuic' || first.type === 'hysteria'
            }
        };
    }

    if (obj.type) {
        return {
            kind: 'outbound',
            outbound: { ...obj, tag: 'proxy' },
            meta: {
                protocol: obj.type,
                server: obj.server || '',
                port: obj.server_port || 0,
                security: obj.tls && obj.tls.enabled ? 'tls' : '',
                transport: (obj.transport && obj.transport.type) || 'tcp',
                name: obj.tag && obj.tag !== 'proxy' ? obj.tag : '',
                udp: obj.type === 'hysteria2' || obj.type === 'tuic' || obj.type === 'hysteria'
            }
        };
    }

    if (obj.protocol) {
        throw new Error('This looks like an Xray/V2Ray config. Paste a share link (vless://...) or a sing-box config.');
    }
    throw new Error('JSON is not a sing-box config or outbound.');
}

/**
 * Parses a share link, inline JSON or a path to a sing-box .json file.
 * Returns { ok: true, kind, outbound|config, meta } or { ok: false, error }.
 */
function parseLink(input) {
    let link = String(input || '').trim();
    if (!link) return { ok: false, error: 'VPN link is empty.' };
    link = link.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').trim();

    try {
        if (link.startsWith('{')) {
            return { ok: true, ...parseJsonConfig(JSON.parse(link)) };
        }
        if (/\.json$/i.test(link)) {
            if (!fs.existsSync(link)) return { ok: false, error: `File not found: ${link}` };
            const raw = fs.readFileSync(link, 'utf8').replace(/^﻿/, '');
            return { ok: true, ...parseJsonConfig(JSON.parse(raw)) };
        }

        const scheme = (/^([a-z0-9+.-]+):\/\//i.exec(link) || [])[1];
        const lower = (scheme || '').toLowerCase();
        let parsed;
        if (lower === 'vless') parsed = parseVless(link);
        else if (lower === 'trojan') parsed = parseTrojan(link);
        else if (lower === 'ss') parsed = parseShadowsocks(link);
        else if (lower === 'vmess') parsed = parseVmess(link);
        else if (lower === 'hysteria2' || lower === 'hy2') parsed = parseHysteria2(link);
        else if (lower === 'tuic') parsed = parseTuic(link);
        else if (lower === 'http' || lower === 'https') {
            return { ok: false, error: 'Subscription URLs are not supported. Open it and copy one vless:// (or other) link.' };
        } else {
            return { ok: false, error: 'Unsupported link. Use vless://, vmess://, trojan://, ss://, hysteria2://, tuic:// or a .json path.' };
        }

        if (!parsed.meta.server) return { ok: false, error: 'Link has no server address.' };
        return { ok: true, kind: 'outbound', ...parsed };
    } catch (err) {
        return { ok: false, error: err && err.message ? err.message : String(err) };
    }
}

/** Back-compat helper: returns the outbound (or full config) object, or null. */
function parseProxyUri(uriStr) {
    const parsed = parseLink(uriStr);
    if (!parsed.ok) return null;
    return parsed.kind === 'config' ? parsed.config : parsed.outbound;
}

/** Short, credential-free description of a link for the UI. */
function describeLink(link) {
    const parsed = parseLink(link);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const m = parsed.meta;
    const parts = [m.protocol];
    if (m.transport && m.transport !== 'tcp' && m.transport !== 'quic') parts.push(m.transport);
    if (m.security && m.protocol !== 'ss') parts.push(m.security);
    const host = m.server && m.server.includes(':') ? `[${m.server}]` : m.server;
    const endpoint = host ? `${host}${m.port ? `:${m.port}` : ''}` : '';
    return {
        ok: true,
        protocol: m.protocol,
        server: m.server,
        port: m.port,
        endpoint,
        name: m.name || '',
        udp: Boolean(m.udp),
        kind: parsed.kind,
        summary: parts.filter(Boolean).join(' · ')
    };
}

// ---------------------------------------------------------------------------
// sing-box config
// ---------------------------------------------------------------------------

function mixedInbound() {
    return { type: 'mixed', tag: 'mixed-in', listen: PROXY_HOST, listen_port: PROXY_PORT };
}

function buildSingboxConfig(parsed) {
    if (parsed.kind === 'config') {
        const cfg = JSON.parse(JSON.stringify(parsed.config));
        cfg.inbounds = [mixedInbound()];
        if (!cfg.log) cfg.log = { level: 'warn', timestamp: true };
        return cfg;
    }

    const outbound = { ...parsed.outbound, tag: 'proxy' };
    return {
        log: { level: 'warn', timestamp: true },
        dns: {
            servers: [{ tag: 'dns-local', type: 'local' }]
        },
        inbounds: [mixedInbound()],
        outbounds: [outbound, { type: 'direct', tag: 'direct' }],
        route: {
            rules: [
                // Local services (IDE bridges, dev servers) must never go through the VPN.
                { ip_is_private: true, outbound: 'direct' },
                { domain: ['localhost'], domain_suffix: ['.localhost'], outbound: 'direct' }
            ],
            final: 'proxy',
            default_domain_resolver: 'dns-local'
        }
    };
}

/** Back-compat: build a full config from an outbound object. */
function buildSingboxFullConfig(outboundObj) {
    return buildSingboxConfig({ kind: 'outbound', outbound: outboundObj });
}

// ---------------------------------------------------------------------------
// Network helpers
// ---------------------------------------------------------------------------

/** Resolves to 'open', 'closed' (connection refused) or 'unknown' (timeout/other). */
function probePort(host, port, timeoutMs = 250) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let done = false;
        const finish = (result) => {
            if (done) return;
            done = true;
            socket.destroy();
            resolve(result);
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => finish('open'));
        socket.once('timeout', () => finish('unknown'));
        socket.once('error', (err) => finish(err && err.code === 'ECONNREFUSED' ? 'closed' : 'unknown'));
        socket.connect(port, host);
    });
}

function isTcpPortOpen(host, port, timeoutMs = 250) {
    return probePort(host, port, timeoutMs).then((r) => r === 'open');
}

/**
 * Checks a local port by trying to bind it. (Connecting is no good here: on
 * Windows a refused localhost connection takes 1-2 seconds.)
 * Resolves to { free: true } or { free: false, code }.
 */
function checkPortFree(host, port) {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.unref();
        server.once('error', (err) => resolve({ free: false, code: err.code || 'ERROR' }));
        server.listen({ host, port, exclusive: true }, () => {
            server.close(() => resolve({ free: true }));
        });
    });
}

function portBusyMessage(code) {
    if (code === 'EACCES') {
        return `Windows blocks port ${PROXY_PORT} (reserved range, often Hyper-V/WSL/Docker). ` +
            `Set "proxy_port" in ${CONFIG_FILE} to another port, e.g. 2181.`;
    }
    return `Port ${PROXY_PORT} is already in use by another program. ` +
        `Close it or set "proxy_port" in ${CONFIG_FILE}.`;
}

/**
 * Waits until something accepts connections on host:port. Starts a new probe
 * every 60 ms and keeps older ones alive, so a slow refusal on Windows never
 * delays noticing the moment the proxy comes up.
 */
function waitForTcpPort(host, port, timeoutMs, isCancelled = () => false) {
    return new Promise((resolve) => {
        const sockets = new Set();
        let done = false;
        const finish = (ok) => {
            if (done) return;
            done = true;
            clearInterval(timer);
            clearTimeout(deadline);
            for (const s of sockets) s.destroy();
            resolve(ok);
        };
        const probe = () => {
            if (isCancelled()) return finish(false);
            const socket = new net.Socket();
            sockets.add(socket);
            socket.setTimeout(1500);
            socket.once('connect', () => finish(true));
            const drop = () => { sockets.delete(socket); socket.destroy(); };
            socket.once('timeout', drop);
            socket.once('error', drop);
            socket.connect(port, host);
        };
        const timer = setInterval(probe, 60);
        const deadline = setTimeout(() => finish(false), timeoutMs);
        probe();
    });
}

async function waitForPortFree(host, port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let last = await checkPortFree(host, port);
    while (!last.free && last.code === 'EADDRINUSE' && Date.now() < deadline) {
        await sleep(100);
        last = await checkPortFree(host, port);
    }
    return last;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** TCP connect time to the VPN server itself (not through the tunnel). */
function pingServer(link, timeoutMs = 3000) {
    const info = describeLink(link);
    if (!info.ok) return Promise.resolve({ ok: false, error: info.error });
    if (info.udp) return Promise.resolve({ ok: false, skipped: true, error: 'UDP protocol' });
    if (!info.server || !info.port) return Promise.resolve({ ok: false, skipped: true, error: 'No server in config' });

    return new Promise((resolve) => {
        const started = process.hrtime.bigint();
        const socket = new net.Socket();
        let done = false;
        const finish = (result) => {
            if (done) return;
            done = true;
            socket.destroy();
            resolve(result);
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => {
            const ms = Number((process.hrtime.bigint() - started) / 1000000n);
            finish({ ok: true, ms });
        });
        socket.once('timeout', () => finish({ ok: false, error: 'timeout' }));
        socket.once('error', (err) => finish({ ok: false, error: err.code || err.message }));
        socket.connect(info.port, info.server);
    });
}

/** Back-compat wrapper around pingServer(). */
function checkVpnReachable(linkStr) {
    return pingServer(linkStr).then((r) => (r.ok ? { reachable: true, ms: r.ms } : { reachable: false, error: r.error }));
}

// ---------------------------------------------------------------------------
// Process management (only ever touches the sing-box this launcher started)
// ---------------------------------------------------------------------------

function readState() {
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch (e) {
        return null;
    }
}

function writeState(state) {
    ensureDir(LAUNCHER_DIR);
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function clearState() {
    try { fs.unlinkSync(STATE_FILE); } catch (e) {}
}

function isPidAlive(pid) {
    if (!pid || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e.code === 'EPERM';
    }
}

function processImageName(pid) {
    if (IS_WIN) {
        try {
            const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
                windowsHide: true,
                timeout: 5000
            });
            const match = /^"([^"]+)","(\d+)"/m.exec(out);
            return match && Number(match[2]) === pid ? match[1] : '';
        } catch (e) {
            return '';
        }
    }
    try {
        return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
    } catch (e) {}
    try {
        return execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch (e) {
        return '';
    }
}

function isOurSingBox(pid) {
    if (!isPidAlive(pid)) return false;
    return path.basename(processImageName(pid)).toLowerCase().startsWith('sing-box');
}

function killPid(pid) {
    try { process.kill(pid); } catch (e) {}
}

function waitForExitSync(pid, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!isPidAlive(pid)) return true;
        sleepSync(50);
    }
    return !isPidAlive(pid);
}

/**
 * Kills sing-box processes started from our own binary that we lost track of
 * (for example ones left by an older launcher version). Never touches other
 * apps' sing-box (v2rayN, Hiddify, NekoBox, ...).
 */
function killStrayOwnSingBox() {
    if (IS_WIN) {
        const exe = SINGBOX_EXE.replace(/'/g, "''");
        try {
            execFileSync('powershell.exe', [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                `Get-Process -Name sing-box -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${exe}' } | Stop-Process -Force -ErrorAction SilentlyContinue`
            ], { stdio: 'ignore', windowsHide: true, timeout: 10000 });
        } catch (e) {}
        return;
    }
    try {
        for (const entry of fs.readdirSync('/proc')) {
            if (!/^\d+$/.test(entry)) continue;
            try {
                if (fs.readlinkSync(`/proc/${entry}/exe`) === SINGBOX_EXE) killPid(Number(entry));
            } catch (e) {}
        }
    } catch (e) {}
}

/** Stops the sing-box instance this launcher started. Returns true if one was stopped. */
function stopVpn() {
    const state = readState();
    let stopped = false;
    if (state && state.pid && isOurSingBox(state.pid)) {
        killPid(state.pid);
        waitForExitSync(state.pid, 2000);
        stopped = true;
    }
    clearState();
    return stopped;
}

/** Stops sing-box only when no Claude session is still using it. */
function stopVpnIfIdle() {
    if (activeSessions().length > 0) return false;
    return stopVpn();
}

/** Quick, non-blocking status for the UI. */
function proxyStatus() {
    const state = readState();
    const running = Boolean(state && isPidAlive(state.pid));
    return { running, pid: running ? state.pid : 0, sessions: activeSessions().length };
}

function readStartupError() {
    let log = '';
    try {
        log = fs.readFileSync(LOG_FILE, 'utf8');
    } catch (e) {
        return '';
    }
    log = log.replace(/\x1b\[[0-9;]*m/g, '');
    const line = log.split(/\r?\n/).find((l) => /\b(FATAL|ERROR)\b/.test(l)) || '';
    if (!line) return '';
    if (/address already in use|only one usage of each socket address/i.test(line)) {
        return portBusyMessage('EADDRINUSE');
    }
    if (/forbidden by its access permissions/i.test(line)) {
        return portBusyMessage('EACCES');
    }
    if (/access is denied/i.test(line)) {
        return 'Access denied while starting sing-box (antivirus or permissions).';
    }
    const message = line.replace(/^.*?\b(FATAL|ERROR)\[\d+\]\s*/, '').trim();
    return message.length > 220 ? `${message.slice(0, 217)}...` : message;
}

/**
 * Starts (or reuses) the local sing-box proxy.
 * onProgress receives { phase: 'reused' | 'spawned' | 'ready', pid }.
 * Resolves to { reused, pid, ms }.
 */
async function startVpn(linkStr, { onProgress = () => {} } = {}) {
    const parsed = parseLink(linkStr);
    if (!parsed.ok) throw new Error(parsed.error);
    if (!fs.existsSync(SINGBOX_EXE)) {
        throw new Error(`sing-box not found at ${SINGBOX_EXE}. Run install.ps1 again.`);
    }

    const json = JSON.stringify(buildSingboxConfig(parsed), null, 2);
    const hash = crypto.createHash('sha1').update(json).digest('hex');

    const state = readState();
    if (state && state.hash === hash && isOurSingBox(state.pid) && await isTcpPortOpen(PROXY_HOST, PROXY_PORT)) {
        onProgress({ phase: 'reused', pid: state.pid });
        return { reused: true, pid: state.pid, ms: 0 };
    }

    if (state) stopVpn();
    let port = await checkPortFree(PROXY_HOST, PROXY_PORT);
    if (!port.free && port.code === 'EADDRINUSE') {
        killStrayOwnSingBox();
        port = await waitForPortFree(PROXY_HOST, PROXY_PORT, 2000);
    }
    if (!port.free) throw new Error(portBusyMessage(port.code));

    ensureDir(LAUNCHER_DIR);
    fs.writeFileSync(GENERATED_SINGBOX_CONFIG, json, 'utf8');

    const started = Date.now();
    const logFd = fs.openSync(LOG_FILE, 'w');
    let child;
    try {
        child = spawn(SINGBOX_EXE, ['run', '-c', GENERATED_SINGBOX_CONFIG], {
            detached: true,
            windowsHide: true,
            stdio: ['ignore', logFd, logFd],
            env: { ...process.env, ENABLE_DEPRECATED_SPECIAL_OUTBOUNDS: 'true' }
        });
    } finally {
        fs.closeSync(logFd);
    }

    let exited = false;
    const exitPromise = new Promise((resolve) => {
        child.once('exit', (code) => { exited = true; resolve({ code }); });
        child.once('error', (err) => { exited = true; resolve({ err }); });
    });
    child.unref();

    if (child.pid) {
        writeState({ pid: child.pid, hash, port: PROXY_PORT, startedAt: started, exe: SINGBOX_EXE });
        onProgress({ phase: 'spawned', pid: child.pid });
    }

    const result = await Promise.race([
        waitForTcpPort(PROXY_HOST, PROXY_PORT, 6000, () => exited).then((ready) => ({ ready })),
        exitPromise
    ]);

    if (result.ready && !exited) {
        onProgress({ phase: 'ready', pid: child.pid });
        return { reused: false, pid: child.pid, ms: Date.now() - started };
    }

    if (!exited) killPid(child.pid);
    clearState();
    await sleep(50);
    const reason = readStartupError()
        || (result.err ? result.err.message : '')
        || (result.code != null ? `sing-box exited with code ${result.code}.` : '')
        || `Local proxy ${PROXY_HOST}:${PROXY_PORT} did not start in time.`;
    throw new Error(reason);
}

// ---------------------------------------------------------------------------
// Sessions: several Claude windows can share one proxy
// ---------------------------------------------------------------------------

function sessionFile(pid) {
    return path.join(SESSIONS_DIR, `${pid}.json`);
}

function registerSession(pid) {
    if (!pid) return;
    ensureDir(SESSIONS_DIR);
    fs.writeFileSync(sessionFile(pid), JSON.stringify({ pid, startedAt: Date.now() }), 'utf8');
}

function releaseSession(pid) {
    if (!pid) return;
    try { fs.unlinkSync(sessionFile(pid)); } catch (e) {}
}

/** Live sessions; dead or stale entries are removed on the way. */
function activeSessions() {
    let entries = [];
    try {
        entries = fs.readdirSync(SESSIONS_DIR).filter((f) => /^\d+\.json$/.test(f));
    } catch (e) {
        return [];
    }
    const now = Date.now();
    const alive = [];
    for (const file of entries) {
        const full = path.join(SESSIONS_DIR, file);
        let info = null;
        try { info = JSON.parse(fs.readFileSync(full, 'utf8')); } catch (e) {}
        const pid = info && Number(info.pid);
        if (pid && isPidAlive(pid) && now - (info.startedAt || 0) < SESSION_MAX_AGE_MS) {
            alive.push(info);
        } else {
            try { fs.unlinkSync(full); } catch (e) {}
        }
    }
    return alive;
}

module.exports = {
    loadConfig,
    saveConfig,
    parseLink,
    parseProxyUri,
    describeLink,
    buildSingboxConfig,
    buildSingboxFullConfig,
    startVpn,
    stopVpn,
    stopVpnIfIdle,
    proxyStatus,
    pingServer,
    checkVpnReachable,
    registerSession,
    releaseSession,
    activeSessions,
    isTcpPortOpen,
    checkPortFree,
    SINGBOX_EXE,
    CONFIG_FILE,
    LAUNCHER_DIR,
    LOG_FILE,
    PROXY_HOST,
    PROXY_PORT
};
