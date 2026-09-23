/**
 * Real Windows browser-origin verification for Computer Use.
 *
 * Starts Microsoft Edge or Google Chrome with a disposable profile against the public,
 * content-stable HTTPS example domain,
 * observes its native UIA tree through the release Helper, and proves that the
 * trusted Host parser derives only the normalized origin from the real native
 * Chromium omnibox. No existing browser profile or window is touched.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');
const { resolveBrowserOriginFromSnapshot } = require('../computerUseGate.cjs');

if (process.platform !== 'win32') {
  console.error('[windows-cu-browser] Windows is required');
  process.exit(2);
}

const helperPath = process.env.ABU_NATIVE_HELPER_PATH
  ? path.resolve(process.env.ABU_NATIVE_HELPER_PATH)
  : path.join(__dirname, '..', 'native-helper', 'target', 'release', 'native-helper.exe');
const verifyChrome = process.argv.includes('--chrome');
const browser = verifyChrome
  ? {
      id: 'chrome-isolated',
      processName: 'chrome.exe',
      profilePrefix: 'abu-cu-chrome-',
      executable: [
        path.join(process.env.ProgramFiles || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env['ProgramFiles(x86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ].find((candidate) => candidate && fs.existsSync(candidate)),
    }
  : {
      id: 'edge-isolated',
      processName: 'msedge.exe',
      profilePrefix: 'abu-cu-edge-',
      executable: [
        path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(process.env.ProgramFiles || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ].find((candidate) => candidate && fs.existsSync(candidate)),
    };

assert.ok(fs.existsSync(helperPath), `release Helper missing: ${helperPath}`);
assert.ok(browser.executable, `${verifyChrome ? 'Google Chrome' : 'Microsoft Edge'} is not installed`);

const helper = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const lines = readline.createInterface({ input: helper.stdout });
const pending = new Map();
let nextId = 1;

lines.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (typeof message.event === 'string') return;
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  clearTimeout(request.timer);
  if (message.error != null) request.reject(helperError(message.error));
  else request.resolve(message.result);
});

// The helper reports failures as { code, execution, retryable, message }
// (native-helper/src/error.rs). Keep the message for the assertions below and
// carry the verdict on error.helper, the way nativeHelperManager.cjs does.
function helperError(raw) {
  const message = typeof raw === 'string'
    ? raw
    : raw && typeof raw.message === 'string' ? raw.message : JSON.stringify(raw);
  const error = new Error(message);
  if (raw && typeof raw === 'object') {
    error.helper = { code: raw.code, execution: raw.execution, retryable: raw.retryable === true };
  }
  return error;
}

function call(method, params = {}, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    helper.stdin.write(`${JSON.stringify({
      id,
      method,
      params,
      context: {
        conversation_id: 'windows-browser-origin-verifier',
        loop_id: browser.id,
      },
    })}\n`);
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForWindow(titleMarker, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const windows = await call('list_windows');
    const match = windows.find((window) => (
      path.basename(String(window.executable_path || '')).toLowerCase() === browser.processName
      && String(window.title || '').includes(titleMarker)
    ));
    if (match) return match;
    await delay(250);
  }
  throw new Error(`isolated ${browser.id} fixture window did not appear`);
}

function closeProcessTree(child) {
  if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0) return;
  spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
  });
}

function closeProfileProcesses(profile) {
  const result = spawnSync('wmic.exe', [
    'process',
    'where',
    `name='${browser.processName}'`,
    'get',
    'CommandLine,ProcessId',
    '/format:csv',
  ], { encoding: 'utf8', windowsHide: true });
  const needle = path.resolve(profile).toLowerCase();
  const pids = String(result.stdout || '')
    .split(/\r?\n/)
    .filter((line) => line.toLowerCase().includes(needle))
    .map((line) => Number(line.match(/,(\d+)\s*$/)?.[1]))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  for (const pid of new Set(pids)) {
    closeProcessTree({ pid });
  }
}

async function cleanupStaleProfiles() {
  const tempRoot = path.resolve(os.tmpdir());
  const cutoff = Date.now() - 60_000;
  const stale = fs.readdirSync(tempRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(browser.profilePrefix))
    .map((entry) => path.join(tempRoot, entry.name))
    .filter((profile) => fs.statSync(profile).mtimeMs < cutoff);
  for (const profile of stale) {
    closeProfileProcesses(profile);
  }
  if (stale.length > 0) await delay(750);
  let removed = 0;
  for (const profile of stale) {
    const resolved = path.resolve(profile);
    if (
      path.dirname(resolved).toLowerCase() !== tempRoot.toLowerCase()
      || !path.basename(resolved).startsWith(browser.profilePrefix)
    ) continue;
    try {
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      removed += 1;
    } catch {
      // A surviving Edge crash handler may release the profile shortly. The
      // next verifier run will retry this exact validated temp directory.
    }
  }
  return removed;
}

async function main() {
  const staleProfilesRemoved = await cleanupStaleProfiles();
  const titleMarker = 'Example Domain';
  const expectedOrigin = 'https://example.com';
  const fixtureUrl = `${expectedOrigin}/`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), browser.profilePrefix));
  const browserProcess = spawn(browser.executable, [
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-extensions',
    '--new-window',
    fixtureUrl,
  ], { stdio: 'ignore', windowsHide: false });

  let sessionId = null;
  let windowProcessId = null;
  try {
    const window = await waitForWindow(titleMarker);
    windowProcessId = window.process_id;
    await call('activate_window', { window_id: window.window_id });
    await delay(200);
    const snapshot = await call('ax_snapshot', {
      app_name: window.app_name,
      expected_bundle_id: window.app_id,
      expected_process_id: window.process_id,
      expected_window_id: window.window_id,
    });
    sessionId = snapshot.session_id;
    const origin = resolveBrowserOriginFromSnapshot(snapshot);
    const addressFieldShape = snapshot.elements
      .filter((element) => (
        element.role === 'TextField'
        || /omnibox/i.test(String(element.class_name || ''))
      ))
      .map((element) => ({
        role: element.role,
        className: element.class_name,
        automationId: element.automation_id,
        hasValue: typeof element.value === 'string' && element.value.length > 0,
        valueLength: typeof element.value === 'string' ? element.value.length : 0,
        valueHasHttpScheme: /^https?:\/\//i.test(String(element.value || '')),
        valueHasExpectedAuthority: String(element.value || '').toLowerCase().includes('example.com'),
      }));
    const securityChromeShape = snapshot.elements
      .filter((element) => /security|location|identity|permission|chip/i.test(String(element.class_name || '')))
      .map((element) => {
        const text = `${String(element.label || '')} ${String(element.value || '')}`.toLowerCase();
        return {
          role: element.role,
          className: element.class_name,
          automationId: element.automation_id,
          saysNotSecure: /not secure|不安全/.test(text),
          saysSecure: /connection is secure|连接是安全的/.test(text),
          saysSiteInformation: /view site information|查看站点信息|查看网站信息/.test(text),
        };
      });
    assert.equal(
      origin,
      expectedOrigin,
      `real ${browser.id} omnibox was not trusted: ${JSON.stringify({ addressFieldShape, securityChromeShape })}`,
    );
    const nativeOmniboxes = snapshot.elements.filter((element) => (
      element.role === 'TextField'
      && element.class_name === 'OmniboxViewViews'
      && /^view_\d+$/.test(String(element.automation_id || ''))
    ));
    assert.equal(nativeOmniboxes.length, 1, 'expected exactly one native Chromium omnibox');
    console.log(`[windows-cu-browser] ${JSON.stringify({
      browser: browser.id,
      nativeOmniboxCount: nativeOmniboxes.length,
      normalizedOriginVerified: true,
      existingProfilesTouched: false,
      staleProfilesRemoved,
    })}`);
    console.log('[windows-cu-browser] PASSED=true');
  } finally {
    if (sessionId) {
      try { await call('ax_close_session', { session_id: sessionId }); } catch {}
    }
    helper.stdin.end();
    if (Number.isSafeInteger(windowProcessId) && windowProcessId > 0) {
      closeProcessTree({ pid: windowProcessId });
    }
    closeProcessTree(browserProcess);
    closeProfileProcesses(profile);
    await delay(750);
    const tempRoot = `${path.resolve(os.tmpdir())}${path.sep}`.toLowerCase();
    const resolvedProfile = path.resolve(profile);
    if (
      resolvedProfile.toLowerCase().startsWith(tempRoot)
      && path.basename(resolvedProfile).startsWith(browser.profilePrefix)
    ) {
      try {
        fs.rmSync(resolvedProfile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      } catch (error) {
        // Cleanup is best-effort and must never replace the origin assertion.
        // The directory contains only this verifier's disposable browser profile.
        console.error(`[windows-cu-browser] cleanup deferred: ${String(error?.code || 'unknown')}`);
      }
    }
  }
}

main().catch((error) => {
  console.error(`[windows-cu-browser] FAILED: ${String(error?.message ?? error)}`);
  process.exitCode = 1;
});
