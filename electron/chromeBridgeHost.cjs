/**
 * Resolve Abu's first-party Chrome bridge runtime without exposing a mutable
 * absolute resource path to the renderer or downloading an npm package at
 * runtime. The renderer stores the stable command id below; Electron main
 * expands it to the current dev/packaged bundle path.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const http = require('node:http');

const { resourceRoot, REPO_ROOT } = require('./appEnv.cjs');

const CHROME_BRIDGE_RUNTIME_COMMAND = 'abu-chrome-bridge-runtime';
const DISCOVERY_PORT = 9875;
const WS_PORT = 9876;

function isApprovedBridgeCommand(commandLine) {
  if (typeof commandLine !== 'string') return false;
  const normalized = commandLine.replace(/\\/g, '/');
  return (
    /\/node_modules\/\.bin\/abu-browser-bridge(?:\s|$)/i.test(normalized) ||
    /\/abu-browser-bridge\/(?:dist\/)?index\.(?:js|mjs)(?:\s|$)/i.test(normalized) ||
    /\/chrome-bridge-runtime\/(?:dist\/)?server\.mjs(?:\s|$)/i.test(normalized)
  );
}

function readDiscoveryStatus(options = {}) {
  const requestImpl = options.requestImpl || http.get;
  const timeoutMs = options.timeoutMs || 800;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let request;
    try {
      request = requestImpl(
        {
          host: '127.0.0.1',
          port: DISCOVERY_PORT,
          path: '/status',
          method: 'GET',
          headers: { Accept: 'application/json' },
        },
        (response) => {
          const chunks = [];
          let bytes = 0;
          response.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes <= 64 * 1024) chunks.push(chunk);
          });
          response.on('end', () => {
            if (response.statusCode !== 200 || bytes > 64 * 1024) {
              finish(null);
              return;
            }
            try {
              const status = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              finish(status);
            } catch {
              finish(null);
            }
          });
        }
      );
      request.setTimeout(timeoutMs, () => {
        request.destroy();
        finish(null);
      });
      request.on('error', () => finish(null));
    } catch {
      finish(null);
    }
  });
}

function posixBridgeProcess(pid, options = {}) {
  const exec = options.execFileSync || execFileSync;
  const expectedUid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : null);
  try {
    const ps = exec('/bin/ps', ['-o', 'uid=', '-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2_000,
      maxBuffer: 64 * 1024,
    }).trim();
    const match = ps.match(/^(\d+)\s+([\s\S]+)$/);
    if (!match || expectedUid === null || Number(match[1]) !== expectedUid) return null;
    const commandLine = match[2];
    if (!isApprovedBridgeCommand(commandLine)) return null;

    const lsof =
      options.lsofPath ||
      ['/usr/sbin/lsof', '/usr/bin/lsof'].find((candidate) => fs.existsSync(candidate));
    if (!lsof) return null;
    const listening = exec(
      lsof,
      ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'],
      { encoding: 'utf8', timeout: 2_000, maxBuffer: 128 * 1024 }
    );
    const ports = new Set(
      [...listening.matchAll(/127\.0\.0\.1:(\d+)\s+\(LISTEN\)/g)].map((entry) => Number(entry[1]))
    );
    if (!ports.has(DISCOVERY_PORT) || !ports.has(WS_PORT)) return null;
    return { pid, commandLine, ports: [...ports] };
  } catch {
    return null;
  }
}

function windowsBridgeProcess(pid, options = {}) {
  const exec = options.execFileSync || execFileSync;
  const powershell =
    process.env.SystemRoot
      ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe';
  const script = [
    `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"`,
    'if(-not $p){exit 3}',
    '$o=Invoke-CimMethod -InputObject $p -MethodName GetOwner',
    '$ports=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |',
    `  Where-Object {$_.OwningProcess -eq ${pid} -and ($_.LocalPort -eq ${DISCOVERY_PORT} -or $_.LocalPort -eq ${WS_PORT})} |`,
    '  Select-Object -ExpandProperty LocalPort)',
    '[pscustomobject]@{CommandLine=$p.CommandLine;User=$o.User;Ports=$ports}|ConvertTo-Json -Compress',
  ].join(';');
  try {
    const raw = exec(
      powershell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', timeout: 4_000, windowsHide: true, maxBuffer: 128 * 1024 }
    );
    const info = JSON.parse(raw);
    const currentUser = String(process.env.USERNAME || '').toLowerCase();
    if (!currentUser || String(info.User || '').toLowerCase() !== currentUser) return null;
    if (!isApprovedBridgeCommand(info.CommandLine)) return null;
    const ports = new Set(
      (Array.isArray(info.Ports) ? info.Ports : [info.Ports]).map(Number)
    );
    if (!ports.has(DISCOVERY_PORT) || !ports.has(WS_PORT)) return null;
    return { pid, commandLine: info.CommandLine, ports: [...ports] };
  } catch {
    return null;
  }
}

function verifiedBridgeProcess(pid, options = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return null;
  const platform = options.platform || process.platform;
  return platform === 'win32'
    ? windowsBridgeProcess(pid, options)
    : posixBridgeProcess(pid, options);
}

async function waitForExit(pid, options = {}) {
  const kill = options.kill || process.kill.bind(process);
  const deadline = Date.now() + (options.timeoutMs || 3_000);
  while (Date.now() < deadline) {
    try {
      kill(pid, 0);
    } catch (error) {
      if (error?.code === 'ESRCH') return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function retireStaleChromeBridge(options = {}) {
  const status = options.statusOverride || await readDiscoveryStatus(options);
  if (!status) return { status: 'none' };
  if (
    status.service !== 'abu-browser-bridge' ||
    !Number.isSafeInteger(status.pid) ||
    Number(status.wsPort) !== WS_PORT
  ) {
    return { status: 'unverified-owner' };
  }
  const verified = verifiedBridgeProcess(status.pid, options);
  if (!verified) return { status: 'unverified-owner', pid: status.pid };

  const kill = options.kill || process.kill.bind(process);
  try {
    kill(status.pid, 'SIGTERM');
  } catch (error) {
    if (error?.code === 'ESRCH') return { status: 'retired', pid: status.pid };
    return { status: 'retire-failed', pid: status.pid };
  }
  if (!(await waitForExit(status.pid, { ...options, kill }))) {
    try {
      kill(status.pid, 'SIGKILL');
    } catch (error) {
      if (error?.code !== 'ESRCH') return { status: 'retire-failed', pid: status.pid };
    }
    if (!(await waitForExit(status.pid, { ...options, kill, timeoutMs: 1_000 }))) {
      return { status: 'retire-failed', pid: status.pid };
    }
  }
  return { status: 'retired', pid: status.pid };
}

function chromeBridgeRuntimePath(app) {
  return app && app.isPackaged
    ? path.join(resourceRoot(app), 'chrome-bridge-runtime', 'server.mjs')
    : path.join(REPO_ROOT, 'electron', 'chrome-bridge-runtime', 'dist', 'server.mjs');
}

function bundledChromeBridgeArgs(args = []) {
  if (!Array.isArray(args)) return [];
  const normalized = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    if (
      arg === '-y'
      || arg === '--yes'
      || /^--package=abu-browser-bridge(?:@[^/\\]+)?$/i.test(arg)
      || /^abu-browser-bridge(?:@[^/\\]+)?$/i.test(arg)
    ) {
      continue;
    }
    if (arg === '--port') {
      const value = String(args[index + 1] ?? '');
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
        throw new Error(`Invalid Chrome bridge port: ${value || '(missing)'}`);
      }
      normalized.push('--port', value);
      index += 1;
      continue;
    }
    if (arg.startsWith('--port=')) {
      const value = arg.slice('--port='.length);
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
        throw new Error(`Invalid Chrome bridge port: ${value || '(missing)'}`);
      }
      normalized.push('--port', value);
      continue;
    }
    throw new Error(`Unsupported Chrome bridge argument: ${arg}`);
  }
  return normalized;
}

async function resolveChromeBridgeRuntimeLaunch(app, originalArgs = [], options = {}) {
  const takeover = await (options.takeoverImpl || retireStaleChromeBridge)(options);
  if (takeover.status === 'unverified-owner' || takeover.status === 'retire-failed') {
    throw new Error(
      'Chrome bridge ports are occupied by a process Abu could not safely take over. ' +
      'Close the other Abu/browser bridge instance and retry.'
    );
  }
  const script = chromeBridgeRuntimePath(app);
  if (!fs.existsSync(script)) {
    throw new Error(
      `Bundled Chrome bridge runtime is missing: ${script}. ` +
      'Run npm run build:electron-chrome-bridge-runtime.'
    );
  }
  return {
    command: 'node',
    args: [script, ...bundledChromeBridgeArgs(originalArgs)],
    env: {},
  };
}

module.exports = {
  CHROME_BRIDGE_RUNTIME_COMMAND,
  DISCOVERY_PORT,
  WS_PORT,
  bundledChromeBridgeArgs,
  chromeBridgeRuntimePath,
  isApprovedBridgeCommand,
  readDiscoveryStatus,
  retireStaleChromeBridge,
  resolveChromeBridgeRuntimeLaunch,
  verifiedBridgeProcess,
};
