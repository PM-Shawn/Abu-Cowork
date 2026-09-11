/**
 * Windows Microsoft 365 Computer Use verifier.
 *
 * Launches isolated blank Word, Excel, and PowerPoint instances and verifies
 * exact WindowRef identity, bounded UIA snapshots, and WGC capture. It never
 * reads user documents, prints UIA text, or sends keyboard/mouse input.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');

if (process.platform !== 'win32') {
  console.error('[windows-cu-office] Windows is required');
  process.exit(2);
}

const officeRoot = process.env.ABU_OFFICE_ROOT
  ? path.resolve(process.env.ABU_OFFICE_ROOT)
  : 'C:\\Program Files\\Microsoft Office\\root\\Office16';
const helperPath = process.env.ABU_NATIVE_HELPER_PATH
  ? path.resolve(process.env.ABU_NATIVE_HELPER_PATH)
  : path.join(__dirname, '..', 'native-helper', 'target', 'release', 'native-helper.exe');

const officeApps = [
  { key: 'word', executable: 'WINWORD.EXE', args: ['/q', '/n'] },
  { key: 'excel', executable: 'EXCEL.EXE', args: ['/x'] },
  { key: 'powerpoint', executable: 'POWERPNT.EXE', args: ['/n'] },
].map((app) => ({ ...app, executablePath: path.join(officeRoot, app.executable) }));

for (const file of [helperPath, ...officeApps.map((app) => app.executablePath)]) {
  if (!fs.existsSync(file)) {
    console.error(`[windows-cu-office] required executable missing: ${file}`);
    process.exit(2);
  }
}

const helper = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
const lines = readline.createInterface({ input: helper.stdout });
const pending = new Map();
const ownedProcesses = new Map();
let nextId = 1;
let currentStage = 'startup';

lines.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (typeof message.event === 'string') return;
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  clearTimeout(request.timer);
  if (message.error != null) request.reject(new Error(String(message.error)));
  else request.resolve(message.result);
});

function call(method, params = {}, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    helper.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const normalizedPath = (value) => path.resolve(String(value || '')).toLowerCase();

function stopOwnedProcess(processId, executablePath) {
  const script = [
    '$target = Get-Process -Id ([int]$env:ABU_VERIFY_PID) -ErrorAction SilentlyContinue',
    'if ($null -ne $target -and $target.Path -eq $env:ABU_VERIFY_EXPECTED_PATH) {',
    '  Stop-Process -Id $target.Id -Force -ErrorAction SilentlyContinue',
    '}',
  ].join('; ');
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: 'ignore',
    env: {
      ...process.env,
      ABU_VERIFY_PID: String(processId),
      ABU_VERIFY_EXPECTED_PATH: executablePath,
    },
    timeout: 5_000,
  });
}

async function waitForOfficeWindow(app, windowsBefore, processId, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const windows = await call('list_windows');
    const candidates = windows.filter((window) => (
      !windowsBefore.has(window.window_id)
      && normalizedPath(window.executable_path) === normalizedPath(app.executablePath)
      && window.bounds[2] >= 500
      && window.bounds[3] >= 300
    )).sort((left, right) => (
      right.bounds[2] * right.bounds[3] - left.bounds[2] * left.bounds[3]
    ));
    const exactProcess = candidates.find((window) => window.process_id === processId);
    if (exactProcess || candidates[0]) return exactProcess || candidates[0];
    await delay(250);
  }
  throw new Error(`${app.key} main window did not appear`);
}

async function verifyOfficeApp(app) {
  const windowsBefore = new Set(
    (await call('list_windows')).map((window) => window.window_id),
  );
  const child = spawn(app.executablePath, app.args, { stdio: 'ignore' });
  ownedProcesses.set(child.pid, app.executablePath);
  let sessionId = null;
  try {
    let window = await waitForOfficeWindow(app, windowsBefore, child.pid);
    ownedProcesses.set(window.process_id, window.executable_path);
    window = await call('activate_window', { window_id: window.window_id });
    const exact = await call('get_window', { window_id: window.window_id });
    assert.equal(exact.process_id, window.process_id);
    assert.equal(exact.app_id, window.app_id);
    assert.equal(normalizedPath(exact.executable_path), normalizedPath(app.executablePath));
    const snapshot = await call('ax_snapshot', {
      app_name: window.app_name,
      expected_bundle_id: window.app_id,
      expected_process_id: window.process_id,
      expected_window_id: window.window_id,
    });
    sessionId = snapshot.session_id;
    assert.equal(snapshot.window_id, window.window_id);
    assert.ok(snapshot.total_visited > 0, `${app.key} UIA tree was empty`);
    assert.ok(snapshot.elements.length > 0, `${app.key} exposed no actionable UIA elements`);
    const capture = await call('capture_screen', {
      max_width: 1280,
      expected_bundle_id: window.app_id,
      expected_process_id: window.process_id,
      expected_window_id: window.window_id,
    });
    assert.ok(typeof capture.screenshot_id === 'string' && capture.screenshot_id.length > 0);
    await call('ax_close_session', { session_id: sessionId });
    sessionId = null;
    return {
      exactWindowRef: true,
      uiaElements: snapshot.elements.length,
      totalVisited: snapshot.total_visited,
      truncated: snapshot.truncated,
      wgcCapture: true,
    };
  } finally {
    if (sessionId) {
      try { await call('ax_close_session', { session_id: sessionId }); } catch { /* helper closing */ }
    }
    for (const [processId, executablePath] of [...ownedProcesses]) {
      if (normalizedPath(executablePath) === normalizedPath(app.executablePath)) {
        stopOwnedProcess(processId, executablePath);
        ownedProcesses.delete(processId);
      }
    }
    await delay(500);
  }
}

async function main() {
  const hello = await call('hello');
  assert.equal(hello.protocol_version, 2);
  assert.equal(hello.capabilities.accessibility, 'windows-uia');
  assert.equal(hello.capabilities.screen_capture, 'wgc-monitor');
  const results = {};
  for (const app of officeApps) {
    currentStage = app.key;
    results[app.key] = await verifyOfficeApp(app);
  }
  console.log(`[windows-cu-office] ${JSON.stringify(results)}`);
  console.log('[windows-cu-office] PASSED=true');
}

main().catch((error) => {
  console.error(
    `[windows-cu-office] FAILED (${currentStage}): ${String(error?.message ?? error).slice(0, 500)}`,
  );
  process.exitCode = 1;
}).finally(() => {
  try { helper.stdin.end(); } catch { /* already closed */ }
  try { helper.kill(); } catch { /* already exited */ }
  for (const [processId, executablePath] of ownedProcesses) {
    stopOwnedProcess(processId, executablePath);
  }
});
