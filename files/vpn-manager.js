const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, execSync, execFileSync } = require('child_process');
const URL = require('url').URL;

const LAUNCHER_DIR = path.join(os.homedir(), '.claude-launcher');
const BIN_DIR = path.join(LAUNCHER_DIR, 'bin');
const SINGBOX_EXE = path.join(BIN_DIR, 'sing-box.exe');
const CONFIG_FILE = path.join(LAUNCHER_DIR, 'config.json');
const GENERATED_SINGBOX_CONFIG = path.join(LAUNCHER_DIR, 'singbox_run.json');
const PROXY_PORT = 2081;

function loadConfig() {
    if (!fs.existsSync(CONFIG_FILE)) {
        return { vpn_link: '', auto_tun: false };
    }
    try {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (e) {
        return { vpn_link: '', auto_tun: false };
    }
}

function saveConfig(cfg) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

function parseProxyUri(uriStr) {
    if (!uriStr || typeof uriStr !== 'string') return null;
    uriStr = uriStr.trim();

    if (uriStr.endsWith('.json') && fs.existsSync(uriStr)) {
        try {
            return JSON.parse(fs.readFileSync(uriStr, 'utf8'));
        } catch (e) {
            return null;
        }
    }

    if (uriStr.startsWith('{') && uriStr.endsWith('}')) {
        try {
            return JSON.parse(uriStr);
        } catch (e) {
            return null;
        }
    }

    try {
        if (uriStr.startsWith('vless://')) return parseVless(uriStr);
        if (uriStr.startsWith('trojan://')) return parseTrojan(uriStr);
        if (uriStr.startsWith('ss://')) return parseShadowsocks(uriStr);
        if (uriStr.startsWith('vmess://')) return parseVmess(uriStr);
    } catch (err) {
        console.error('Error parsing URI:', err.message);
    }
    return null;
}

function parseVless(uriStr) {
    const hashIdx = uriStr.indexOf('#');
    let tag = 'proxy';
    let cleanUri = uriStr;
    if (hashIdx !== -1) {
        tag = decodeURIComponent(uriStr.substring(hashIdx + 1)) || tag;
        cleanUri = uriStr.substring(0, hashIdx);
    }

    const parsed = new URL(cleanUri);
    const params = parsed.searchParams;
    const server = parsed.hostname;
    const security = params.get('security') || 'none';
    const type = params.get('type') || 'tcp';
    const fp = params.get('fp') || 'chrome';
    const sni = params.get('sni') || params.get('peer') || server;
    const flow = params.get('flow') || '';

    const outbound = {
        type: 'vless',
        tag,
        server,
        server_port: parseInt(parsed.port, 10) || 443,
        uuid: parsed.username,
        network: type === 'grpc' ? 'grpc' : (type === 'ws' ? 'ws' : 'tcp')
    };

    if (flow) outbound.flow = flow;

    if (security === 'reality' || security === 'tls') {
        outbound.tls = {
            enabled: true,
            server_name: sni,
            utls: { enabled: true, fingerprint: fp }
        };
        if (security === 'reality') {
            outbound.tls.reality = {
                enabled: true,
                public_key: params.get('pbk') || '',
                short_id: params.get('sid') || ''
            };
        }
    }

    if (type === 'ws') {
        outbound.transport = { type: 'ws', path: params.get('path') || '/' };
    } else if (type === 'grpc') {
        outbound.transport = {
            type: 'grpc',
            service_name: params.get('serviceName') || params.get('servicename') || ''
        };
    }

    return outbound;
}

function parseTrojan(uriStr) {
    const hashIdx = uriStr.indexOf('#');
    let tag = 'proxy';
    let cleanUri = uriStr;
    if (hashIdx !== -1) {
        tag = decodeURIComponent(uriStr.substring(hashIdx + 1)) || tag;
        cleanUri = uriStr.substring(0, hashIdx);
    }

    const parsed = new URL(cleanUri);
    const params = parsed.searchParams;
    const server = parsed.hostname;
    const fp = params.get('fp') || '';
    const tls = {
        enabled: true,
        server_name: params.get('sni') || server
    };

    if (fp) {
        tls.utls = { enabled: true, fingerprint: fp };
    }

    return {
        type: 'trojan',
        tag,
        server,
        server_port: parseInt(parsed.port, 10) || 443,
        password: parsed.username,
        tls
    };
}

function parseShadowsocks(uriStr) {
    const hashIdx = uriStr.indexOf('#');
    let tag = 'proxy';
    let cleanUri = uriStr;
    if (hashIdx !== -1) {
        tag = decodeURIComponent(uriStr.substring(hashIdx + 1)) || tag;
        cleanUri = uriStr.substring(0, hashIdx);
    }

    const mainPart = cleanUri.replace('ss://', '');
    const atIdx = mainPart.lastIndexOf('@');
    if (atIdx === -1) return null;

    const userInfo = mainPart.substring(0, atIdx);
    const serverPort = mainPart.substring(atIdx + 1);
    let method = 'aes-256-gcm';
    let password = '';

    if (userInfo.includes(':')) {
        const parts = userInfo.split(':');
        method = parts[0];
        password = parts.slice(1).join(':');
    } else {
        const decoded = Buffer.from(userInfo, 'base64').toString('utf8');
        const parts = decoded.split(':');
        method = parts[0];
        password = parts.slice(1).join(':');
    }

    const [server, portStr] = serverPort.split(':');
    return {
        type: 'shadowsocks',
        tag,
        server,
        server_port: parseInt(portStr, 10) || 8388,
        method,
        password
    };
}

function parseVmess(uriStr) {
    const b64 = uriStr.replace('vmess://', '');
    const v = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    return {
        type: 'vmess',
        tag: 'proxy',
        server: v.add,
        server_port: parseInt(v.port, 10),
        uuid: v.id,
        alter_id: parseInt(v.aid, 10) || 0,
        security: v.scy || 'auto',
        tls: v.tls ? { enabled: true, server_name: v.sni || v.host || v.add } : undefined
    };
}

function isTcpPortOpen(host, port, timeoutMs = 250) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let completed = false;
        const finish = (open) => {
            if (completed) return;
            completed = true;
            socket.destroy();
            resolve(open);
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));
        socket.connect(port, host);
    });
}

async function waitForTcpPort(host, port, timeoutMs = 2500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await isTcpPortOpen(host, port)) return true;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
}

function buildSingboxFullConfig(outboundObj) {
    outboundObj.tag = 'proxy';
    return {
        log: { level: 'warn', timestamp: true },
        dns: {
            servers: [
                { tag: 'dns-remote', type: 'udp', server: '8.8.8.8' },
                { tag: 'dns-direct', type: 'udp', server: '1.1.1.1' }
            ]
        },
        inbounds: [
            {
                type: 'mixed',
                tag: 'mixed-in',
                listen: '127.0.0.1',
                listen_port: PROXY_PORT,
                sniff: true
            }
        ],
        route: {
            default_domain_resolver: 'dns-direct',
            final: 'proxy'
        },
        outbounds: [
            outboundObj,
            { type: 'direct', tag: 'direct' }
        ]
    };
}

function checkVpnReachable(linkStr) {
    const parsed = parseProxyUri(linkStr);
    if (!parsed || !parsed.server || !parsed.server_port) {
        return Promise.resolve({ reachable: false, error: 'Invalid VPN link/config format' });
    }

    return new Promise((resolve) => {
        const socket = new net.Socket();
        let completed = false;
        socket.setTimeout(2500);

        socket.once('connect', () => {
            completed = true;
            socket.destroy();
            resolve({ reachable: true });
        });

        const fail = (err) => {
            if (!completed) {
                completed = true;
                socket.destroy();
                resolve({ reachable: false, error: err ? err.message : 'Server timeout' });
            }
        };

        socket.once('timeout', () => fail(new Error('Server timeout')));
        socket.once('error', fail);
        socket.connect(parsed.server_port, parsed.server);
    });
}

function startVpn(linkStr) {
    if (!linkStr) return Promise.reject(new Error('VPN link is empty.'));

    const parsedOutbound = parseProxyUri(linkStr);
    if (!parsedOutbound) {
        return Promise.reject(new Error('Failed to parse VPN link. Check your config.'));
    }

    const fullConfig = buildSingboxFullConfig(parsedOutbound);
    fs.writeFileSync(GENERATED_SINGBOX_CONFIG, JSON.stringify(fullConfig, null, 2), 'utf8');

    if (!fs.existsSync(SINGBOX_EXE)) {
        return Promise.reject(new Error(`sing-box.exe not found at: ${SINGBOX_EXE}`));
    }

    stopVpn();

    const child = spawn(SINGBOX_EXE, ['run', '-c', GENERATED_SINGBOX_CONFIG], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
            ENABLE_DEPRECATED_SPECIAL_OUTBOUNDS: 'true'
        }
    });

    child.unref();

    return new Promise((resolve, reject) => {
        let logBuffer = '';
        const onData = (data) => { logBuffer += data.toString(); };
        const closeStartupPipes = () => {
            try { child.stdout.destroy(); } catch (e) {}
            try { child.stderr.destroy(); } catch (e) {}
        };

        child.stdout.on('data', onData);
        child.stderr.on('data', onData);

        setTimeout(() => {
            child.stdout.off('data', onData);
            child.stderr.off('data', onData);

            if (logBuffer.includes('Access is denied') || logBuffer.includes('access is denied')) {
                closeStartupPipes();
                stopVpn();
                reject(new Error('Access denied while starting sing-box. Try running the terminal as Administrator.'));
            } else if (logBuffer.includes('FATAL') || logBuffer.includes('ERROR')) {
                closeStartupPipes();
                stopVpn();
                const firstFatal = logBuffer.split('\n').find(l => l.includes('FATAL') || l.includes('ERROR')) || logBuffer;
                reject(new Error(firstFatal.trim()));
            } else {
                waitForTcpPort('127.0.0.1', PROXY_PORT, 2500).then((proxyReady) => {
                    closeStartupPipes();
                    if (proxyReady) {
                        resolve(true);
                    } else {
                        stopVpn();
                        reject(new Error(`sing-box started, but local proxy 127.0.0.1:${PROXY_PORT} did not become ready.`));
                    }
                });
            }
        }, 500);
    });
}

function stopVpn() {
    try {
        const pid = execFileSync('powershell.exe', [
            '-NoProfile',
            '-Command',
            "(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 2080,2081 -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -gt 0 } | Select-Object -ExpandProperty OwningProcess -Unique) -join ','"
        ], { encoding: 'utf8' }).trim();
        if (pid) {
            execSync(`powershell -NoProfile -Command "Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue"`, { stdio: 'ignore' });
        }
    } catch (e) {}
    try {
        execSync('taskkill /F /IM sing-box.exe 2>nul', { stdio: 'ignore' });
    } catch (e) {}
    try {
        execSync('powershell -Command "Stop-Process -Name sing-box -Force -ErrorAction SilentlyContinue"', { stdio: 'ignore' });
    } catch (e) {}
}

module.exports = {
    loadConfig,
    saveConfig,
    parseProxyUri,
    startVpn,
    stopVpn,
    checkVpnReachable,
    SINGBOX_EXE,
    CONFIG_FILE
};
