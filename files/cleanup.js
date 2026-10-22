'use strict';

// Runs after a VPN-mode Claude Code session ends. Stops sing-box only when no
// other Claude window still uses the proxy.

const vpn = require('./vpn-manager');

const pid = Number(process.argv[2]) || Number(process.env.CLAUDE_LAUNCHER_PARENT_PID) || process.ppid;

try {
    vpn.releaseSession(pid);
    vpn.stopVpnIfIdle();
} catch (e) {}
