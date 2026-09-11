'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');

const SCENARIOS = new Set(['edit', 'modal-cancel', 'nested-modal', 'window-switch']);
const STATE_KEYS = ['version', 'sequence', 'pid', 'scenario', 'windows', 'dialogDepth',
  'cancelCount', 'markerPresent', 'mainMarkerPresent', 'secondaryMarkerPresent', 'unexpectedWrites'];
const ROLES = ['main', 'dialog', 'nested', 'secondary'];
const MARKER = /^ABU_CU_[A-Z0-9_]{1,80}$/;
const MAX_OUTPUT = 4 * 1024 * 1024;
const MAX_LINE = 16 * 1024;
const COMPILE_SCRIPT = '$ErrorActionPreference = "Stop"; Add-Type -Path $env:ABU_CU_FIXTURE_SOURCE -ReferencedAssemblies System.Windows.Forms,System.Drawing -OutputAssembly $env:ABU_CU_FIXTURE_EXE -OutputType ConsoleApplication';
class OwnedChildDidNotExitError extends Error {
  constructor() { super('Owned fixture child did not exit; temporary files retained'); }
}

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/**
 * JSONL oracle boundary; returns immutable, detached state without arbitrary text.
 * markerPresent is false during the 400 ms text debounce, even if a field already
 * equals the marker. A true value therefore certifies a settled final observation.
 * unexpectedWrites counts incorrect nonempty fields in that settled observation,
 * not intermediate keystrokes. HWND IDs match the native helper's uppercase 0xHEX.
 */
function validateFixtureState(raw, expected) {
  if (!exactKeys(raw, STATE_KEYS) || !expected || !SCENARIOS.has(expected.scenario)
    || !Number.isSafeInteger(expected.pid) || expected.pid <= 0
    || !Number.isSafeInteger(expected.sequence) || expected.sequence < 0
    || raw.version !== 1 || raw.pid !== expected.pid || raw.scenario !== expected.scenario
    || !Number.isSafeInteger(raw.sequence) || raw.sequence <= expected.sequence) return null;
  if (['dialogDepth', 'cancelCount', 'unexpectedWrites'].some((key) => !Number.isSafeInteger(raw[key]) || raw[key] < 0)
    || raw.dialogDepth > 2 || raw.unexpectedWrites > 2
    || ['markerPresent', 'mainMarkerPresent', 'secondaryMarkerPresent'].some((key) => typeof raw[key] !== 'boolean')
    || !Array.isArray(raw.windows) || raw.windows.length > 4) return null;
  const roles = new Set();
  const ids = new Set();
  for (const window of raw.windows) {
    if (!exactKeys(window, ['role', 'windowId']) || !ROLES.includes(window.role)
      || typeof window.windowId !== 'string' || !/^0x[1-9A-F][0-9A-F]{0,15}$/.test(window.windowId)
      || roles.has(window.role) || ids.has(window.windowId)) return null;
    roles.add(window.role);
    ids.add(window.windowId);
  }
  if ((roles.size > 0 && !roles.has('main')) || (roles.has('nested') && !roles.has('dialog'))
    || raw.dialogDepth !== Number(roles.has('dialog')) + Number(roles.has('nested'))
    || (raw.scenario !== 'nested-modal' && roles.has('nested'))
    || (!['modal-cancel', 'nested-modal'].includes(raw.scenario) && roles.has('dialog'))
    || (raw.scenario !== 'window-switch' && (roles.has('secondary') || raw.secondaryMarkerPresent))) return null;
  const targetMarker = raw.scenario === 'window-switch' ? raw.secondaryMarkerPresent : raw.mainMarkerPresent;
  if ((raw.mainMarkerPresent && !roles.has('main')) || (raw.secondaryMarkerPresent && !roles.has('secondary'))) return null;
  if (raw.markerPresent && (!targetMarker || roles.size === 0)) return null;
  return Object.freeze({ ...raw, windows: Object.freeze(raw.windows.map((window) => Object.freeze({ ...window }))) });
}

async function startDesktopFixture(options) {
  if (!options || typeof options !== 'object') throw new Error('Fixture options are required');
  if (!SCENARIOS.has(options.scenario)) throw new Error('Invalid fixture scenario');
  if (typeof options.marker !== 'string' || !MARKER.test(options.marker) || options.marker.includes('\n')) throw new Error('Invalid fixture marker');
  if (process.platform !== 'win32') throw new Error('Desktop fixture requires Windows');
  const { scenario, marker } = options;
  const tempRoot = await fs.realpath(os.tmpdir());
  const tempDirectory = await fs.mkdtemp(path.join(tempRoot, 'abu-cu-desktop-'));
  const appName = 'AbuCuFixture-' + crypto.randomBytes(12).toString('hex');
  const executablePath = path.join(tempDirectory, appName + '.exe');
  const childEnv = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => key.toUpperCase() !== 'ABU_CU_EVAL_API_KEY'));

  // Never accept a removal path from a caller; this closure owns exactly mkdtemp's result.
  async function removeOwnedDirectory() {
    if (path.dirname(tempDirectory) !== tempRoot || !/^abu-cu-desktop-[A-Za-z0-9]+$/.test(path.basename(tempDirectory))) {
      throw new Error('Unsafe fixture cleanup directory');
    }
    const stat = await fs.lstat(tempDirectory).catch((error) => { if (error.code !== 'ENOENT') throw error; return null; });
    if (!stat) return;
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(tempDirectory) !== tempDirectory) {
      throw new Error('Fixture cleanup directory identity changed');
    }
    await fs.rm(tempDirectory, { recursive: true, force: false, maxRetries: 3, retryDelay: 100 });
  }

  try {
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    await compileFixture(powershell, {
      ...childEnv, ABU_CU_FIXTURE_SOURCE: path.join(__dirname, '..', 'tests', 'fixtures', 'windows-cu-desktop.cs'),
      ABU_CU_FIXTURE_EXE: executablePath,
    });
  } catch (error) {
    if (!(error instanceof OwnedChildDidNotExitError)) await removeOwnedDirectory();
    throw error;
  }

  let child;
  try {
    child = childProcess.spawn(executablePath, [scenario, marker], {
      env: childEnv, cwd: tempDirectory, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    await removeOwnedDirectory();
    throw error;
  }
  const lifetime = ownChild(child);
  let latest = null;
  let terminalError = null;
  let closePromise = null;
  let closing = false;
  let buffer = '';
  let outputBytes = 0;
  const waiters = new Set();

  function rejectWaiters(error) {
    terminalError ||= error;
    for (const waiter of [...waiters]) waiter.finish(terminalError);
  }

  function fail(error) {
    rejectWaiters(error);
    void close().catch(() => {}); // close() retains its rejection for the caller.
  }

  function waitFor(predicate, timeoutMs = 10000) {
    if (typeof predicate !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
      return Promise.reject(new Error('Invalid fixture wait predicate or timeout'));
    }
    if (terminalError) return Promise.reject(terminalError);
    return new Promise((resolve, reject) => {
      const waiter = {
        finish(error, value) {
          clearTimeout(waiter.timer);
          waiters.delete(waiter);
          if (error) reject(error); else resolve(value);
        },
        check() {
          try { if (latest && predicate(latest)) waiter.finish(null, latest); }
          catch (error) { waiter.finish(error); }
        },
      };
      waiter.timer = setTimeout(() => waiter.finish(new Error('Fixture state wait timed out')), timeoutMs);
      waiters.add(waiter);
      waiter.check();
    });
  }

  function close() {
    if (!closePromise) {
      closing = true;
      rejectWaiters(new Error('Fixture is closed'));
      closePromise = (async () => {
        await lifetime.stop();
        await removeOwnedDirectory();
      })();
    }
    return closePromise;
  }

  child.on('error', () => fail(new Error('Fixture process failed')));
  child.stdin.on('error', () => { if (!closing) fail(new Error('Fixture input pipe failed')); });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    if (closing) return;
    outputBytes += Buffer.byteLength(chunk);
    if (outputBytes > MAX_OUTPUT) return fail(new Error('Fixture output exceeded limit'));
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      if (newline > MAX_LINE) return fail(new Error('Fixture state line exceeded limit'));
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      let raw;
      try { raw = JSON.parse(line); } catch { return fail(new Error('Fixture emitted invalid JSON')); }
      const state = validateFixtureState(raw, { pid: child.pid, scenario, sequence: latest?.sequence ?? 0 });
      if (!state) return fail(new Error('Fixture emitted invalid state'));
      latest = state;
      for (const waiter of [...waiters]) waiter.check();
    }
    if (buffer.length > MAX_LINE) fail(new Error('Fixture state line exceeded limit'));
  });
  child.stderr.on('data', (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes > MAX_OUTPUT) fail(new Error('Fixture output exceeded limit'));
  });
  child.stdout.on('error', () => fail(new Error('Fixture output pipe failed')));
  child.stderr.on('error', () => fail(new Error('Fixture error pipe failed')));
  const onExit = () => { if (!closing) fail(new Error('Fixture exited unexpectedly')); };
  child.once('exit', onExit);
  child.once('close', onExit);

  const fixture = Object.freeze({ pid: child.pid, appName, executablePath,
    get state() { return terminalError || closing ? null : latest; }, waitFor, close });
  try {
    const depth = scenario === 'nested-modal' ? 2 : scenario === 'modal-cancel' ? 1 : 0;
    await waitFor((state) => state.dialogDepth === depth && state.windows.length === depth + 1);
    return fixture;
  } catch (error) {
    await close();
    throw error;
  }
}

// Only the exact ChildProcess handle we spawned can be stopped; never PID/name scans.
function ownChild(child) {
  let didExit = false;
  const exited = new Promise((resolve) => child.once('close', (code) => { didExit = true; resolve(code); }));
  async function boundedExit(timeoutMs) {
    let timer;
    try { return await Promise.race([exited.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
  return {
    exited,
    async stop() {
      if (didExit) return;
      if (child.stdin && !child.stdin.destroyed) child.stdin.end();
      if (await boundedExit(3000)) return;
      try { if (!didExit) child.kill(); }
      catch { throw new OwnedChildDidNotExitError(); }
      if (!await boundedExit(3000)) throw new OwnedChildDidNotExitError();
    },
  };
}

async function compileFixture(powershell, env) {
  const child = childProcess.spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', COMPILE_SCRIPT], {
    env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lifetime = ownChild(child);
  let bytes = 0;
  let failure = null;
  let timer;
  const failed = new Promise((resolve) => {
    const fail = (message) => { failure ||= new Error(message); resolve(); };
    child.on('error', () => fail('Fixture compiler process failed'));
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => { bytes += chunk.length; if (bytes > MAX_OUTPUT) fail('Fixture compiler output exceeded limit'); });
      stream.on('error', () => fail('Fixture compiler pipe failed'));
    }
    timer = setTimeout(() => fail('Fixture compilation timed out'), 30000);
  });
  try {
    const code = await Promise.race([lifetime.exited, failed]);
    if (failure || code !== 0) {
      await lifetime.stop();
      throw failure || new Error('Fixture compilation failed');
    }
  } finally { clearTimeout(timer); }
}
module.exports = { startDesktopFixture, validateFixtureState };
