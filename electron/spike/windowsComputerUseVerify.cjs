/**
 * Windows native Computer Use golden-journey verifier.
 *
 * Runs against the release native-helper and exercises real UIA, WGC,
 * screenshot/window guards, Unicode-safe semantic editing, and SendInput
 * injection filtering. It creates one disposable Notepad file and one empty
 * Explorer directory in the OS temp directory and never prints screenshots,
 * UIA text, or typed content.
 *
 * Run after `npm run build:native-helper`:
 *   node electron/spike/windowsComputerUseVerify.cjs
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');
const {
  assertPrivateTextEqual,
  keyboardLayoutSummary,
} = require('./windowsComputerUseVerifyPrivacy.cjs');

if (process.platform !== 'win32') {
  console.error('[windows-cu] Windows is required');
  process.exit(2);
}

const helperPath = process.env.ABU_NATIVE_HELPER_PATH
  ? path.resolve(process.env.ABU_NATIVE_HELPER_PATH)
  : path.join(
    __dirname,
    '..',
    'native-helper',
    'target',
    'release',
    'native-helper.exe',
  );
if (!fs.existsSync(helperPath)) {
  console.error(`[windows-cu] release helper missing: ${helperPath}`);
  process.exit(2);
}

const helper = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
const lines = readline.createInterface({ input: helper.stdout });
const pending = new Map();
const events = [];
let nextId = 1;
const inputLeaseId = `windows-cu-verify-${process.pid}-${Date.now()}`;
let inputLeaseStarted = false;

lines.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (typeof message.event === 'string') {
    events.push({ event: message.event, reason: message.reason ?? null });
    return;
  }
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
    helper.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForWindow(predicate, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const windows = await call('list_windows');
    const match = windows.find(predicate);
    if (match) return match;
    await delay(250);
  }
  throw new Error('target window did not appear');
}

async function activate(window) {
  const activated = await call('activate_window', { window_id: window.window_id });
  await delay(100);
  return activated;
}

async function snapshot(window) {
  const result = await call('ax_snapshot', {
    app_name: window.app_name,
    // Helper protocol v2 keeps `expected_bundle_id` as the cross-platform
    // wire name. On Windows its value is the stable app ID/AUMID.
    expected_bundle_id: window.app_id,
    expected_process_id: window.process_id,
    expected_window_id: window.window_id,
  });
  if (inputLeaseStarted) {
    await call('input_lease_commit_observation', {
      lease_id: inputLeaseId,
      expected_input_epoch: result.input_epoch,
    });
  }
  return result;
}

async function captureWindow(window, extra = {}) {
  const result = await call('capture_screen', {
    ...extra,
    expected_bundle_id: window.app_id,
    expected_process_id: window.process_id,
    expected_window_id: window.window_id,
  });
  if (inputLeaseStarted) {
    await call('input_lease_commit_observation', {
      lease_id: inputLeaseId,
      expected_input_epoch: result.input_epoch,
    });
  }
  return result;
}

async function withGuardedInput(expectedInputEpoch, operation) {
  await call('input_lease_activate', {
    lease_id: inputLeaseId,
    expected_input_epoch: expectedInputEpoch,
  });
  try {
    return await operation();
  } finally {
    await call('input_lease_observe', { lease_id: inputLeaseId });
  }
}

function byAutomationId(result, ids) {
  const expected = new Set(ids.map((value) => value.toLowerCase()));
  return result.elements.find((element) => (
    typeof element.automation_id === 'string'
    && expected.has(element.automation_id.toLowerCase())
  ));
}

async function pressCalculatorControl(window, automationIds) {
  const state = await snapshot(window);
  const element = byAutomationId(state, automationIds);
  assert.ok(element, `calculator control unavailable (${automationIds[0]})`);
  await withGuardedInput(state.input_epoch, () => call('ax_press', {
    session_id: state.session_id,
    element_id: element.id,
  }));
  await call('ax_close_session', { session_id: state.session_id });
}

async function calculatorJourney(window) {
  await pressCalculatorControl(window, ['clearButton', 'clearEntryButton']);
  await pressCalculatorControl(window, ['num1Button']);
  await pressCalculatorControl(window, ['plusButton']);
  await pressCalculatorControl(window, ['num3Button']);
  await pressCalculatorControl(window, ['equalButton']);
  const state = await snapshot(window);
  const result = byAutomationId(state, ['CalculatorResults']);
  const structuralResult = `${result?.label ?? ''} ${result?.value ?? ''}`;
  assert.match(structuralResult, /(^|\D)4(\D|$)/, 'calculator result was not four');
  await call('ax_close_session', { session_id: state.session_id });
}

function editableNotepadElement(state) {
  return state.elements.find((element) => (
    Array.isArray(element.actions)
    && element.actions.some((action) => action === 'SetValue')
    && (element.role === 'TextField' || element.role === 'Document')
  )) ?? state.elements.find((element) => element.actions?.includes('SetValue'));
}

async function notepadJourney(window, iteration) {
  const marker = `Abu Windows UIA ${String(iteration).padStart(2, '0')} ✓`;
  const before = await snapshot(window);
  const editable = editableNotepadElement(before);
  assert.ok(editable, 'Notepad editable UIA element unavailable');
  assert.ok(editable.patterns?.includes('Value'), 'Notepad Value pattern state unavailable');
  assert.equal(editable.value_read_only, false, 'Notepad Value read-only state is incorrect');
  await withGuardedInput(before.input_epoch, () => call('ax_set_value', {
    session_id: before.session_id,
    element_id: editable.id,
    text: marker,
  }));
  await call('ax_close_session', { session_id: before.session_id });
  const after = await snapshot(window);
  const observed = editableNotepadElement(after);
  assert.equal(observed?.value, marker, 'Notepad UIA value verification failed');
  await call('ax_close_session', { session_id: after.session_id });
}

async function verifyNotepadKeyboardLayout(window) {
  const initial = await snapshot(window);
  const editable = editableNotepadElement(initial);
  assert.ok(editable, 'Notepad editable UIA element unavailable for keyboard verification');
  await withGuardedInput(initial.input_epoch, () => call('ax_set_value', {
    session_id: initial.session_id,
    element_id: editable.id,
    text: '',
  }));
  await call('ax_close_session', { session_id: initial.session_id });

  const expected = '+=!@:?aA';
  for (const key of expected) {
    const before = await snapshot(window);
    await withGuardedInput(before.input_epoch, () => call('keyboard_press', {
      key,
      modifiers: [],
      expected_bundle_id: window.app_id,
      expected_process_id: window.process_id,
      expected_window_id: window.window_id,
      expected_input_epoch: before.input_epoch,
    }));
    await call('ax_close_session', { session_id: before.session_id });
  }
  const typed = await snapshot(window);
  assertPrivateTextEqual(
    editableNotepadElement(typed)?.value,
    expected,
    'target-layout character key verification failed',
  );
  await call('ax_close_session', { session_id: typed.session_id });

  const beforeSelectAll = await snapshot(window);
  await withGuardedInput(beforeSelectAll.input_epoch, () => call('keyboard_press', {
    key: 'a',
    modifiers: ['ctrl'],
    expected_bundle_id: window.app_id,
    expected_process_id: window.process_id,
    expected_window_id: window.window_id,
    expected_input_epoch: beforeSelectAll.input_epoch,
  }));
  await call('ax_close_session', { session_id: beforeSelectAll.session_id });
  const beforeDelete = await snapshot(window);
  await withGuardedInput(beforeDelete.input_epoch, () => call('keyboard_press', {
    key: 'Backspace',
    modifiers: [],
    expected_bundle_id: window.app_id,
    expected_process_id: window.process_id,
    expected_window_id: window.window_id,
    expected_input_epoch: beforeDelete.input_epoch,
  }));
  await call('ax_close_session', { session_id: beforeDelete.session_id });
  const cleared = await snapshot(window);
  assertPrivateTextEqual(
    editableNotepadElement(cleared)?.value,
    '',
    'Ctrl+A keyboard shortcut did not select the temporary fixture text',
  );
  await call('ax_close_session', { session_id: cleared.session_id });
  return keyboardLayoutSummary(expected, true);
}

async function runThirty(name, journey) {
  let passed = 0;
  const failures = [];
  for (let iteration = 1; iteration <= 30; iteration++) {
    try {
      await journey(iteration);
      passed += 1;
    } catch (error) {
      failures.push({ iteration, error: String(error?.message ?? error).slice(0, 240) });
    }
  }
  return { name, passed, total: 30, rate: passed / 30, failures };
}

async function verifyWgcAndGuardedInput(window) {
  const state = await snapshot(window);
  const capture = await captureWindow(window, {
    max_width: 1280,
  });
  assert.equal(typeof capture.screenshot_id, 'string');
  assert.ok(Number.isSafeInteger(capture.snapshot_revision) && capture.snapshot_revision > 0);
  assert.ok(Number.isSafeInteger(capture.z_index) && capture.z_index >= 0);
  assert.ok(capture.width > 0 && capture.height > 0 && capture.base64.length > 1000);
  const target = state.elements.find((element) => (
    element.bounds[2] > 2 && element.bounds[3] > 2 && element.actions.includes('Invoke')
  )) ?? state.elements.find((element) => (
    element.bounds[2] > 2 && element.bounds[3] > 2
    && element.bounds[0] >= window.bounds[0]
    && element.bounds[1] >= window.bounds[1]
  ));
  assert.ok(target, 'no visible calculator point target');
  const x = Math.round(target.bounds[0] + target.bounds[2] / 2);
  const y = Math.round(target.bounds[1] + target.bounds[3] / 2);
  await assert.rejects(withGuardedInput(state.input_epoch, () => call('mouse_move', {
    x,
    y,
    screenshot_id: 'shot-invalid',
    expected_bundle_id: window.app_id,
    expected_process_id: window.process_id,
    expected_window_id: window.window_id,
    expected_input_epoch: state.input_epoch,
  })), (error) => {
    assert.match(error.message, /unknown or expired/);
    assert.equal(error.helper?.code, 'screenshot-stale');
    assert.equal(error.helper?.execution, 'not-executed');
    assert.equal(error.helper?.retryable, true);
    return true;
  });
  await withGuardedInput(state.input_epoch, () => call('mouse_move', {
    x,
    y,
    screenshot_id: capture.screenshot_id,
    expected_bundle_id: window.app_id,
    expected_process_id: window.process_id,
    expected_window_id: window.window_id,
    expected_input_epoch: state.input_epoch,
  }));
  await delay(100);
  assert.equal(
    events.some(({ event }) => event === 'user-input-detected'),
    false,
    'Abu-injected SendInput was misclassified as physical user input',
  );
  await call('ax_close_session', { session_id: state.session_id });
  return {
    backend: 'wgc-monitor',
    screenshotId: true,
    guardedMove: true,
    injectedInputIgnored: true,
  };
}

async function verifyCrossWindowGuard(sourceWindow, activeOtherWindow) {
  sourceWindow = await activate(sourceWindow);
  let state = await snapshot(sourceWindow);
  let capture = await captureWindow(sourceWindow);
  const x = Math.round(sourceWindow.bounds[0] + sourceWindow.bounds[2] / 2);
  const y = Math.round(sourceWindow.bounds[1] + sourceWindow.bounds[3] / 2);
  await activate(activeOtherWindow);
  await assert.rejects(withGuardedInput(state.input_epoch, () => call('mouse_move', {
    x,
    y,
    screenshot_id: capture.screenshot_id,
    expected_bundle_id: sourceWindow.app_id,
    expected_process_id: sourceWindow.process_id,
    expected_window_id: sourceWindow.window_id,
    expected_input_epoch: state.input_epoch,
  })), /target changed|active foreground/i);
  await call('ax_close_session', { session_id: state.session_id });

  sourceWindow = await activate(sourceWindow);
  state = await snapshot(sourceWindow);
  capture = await captureWindow(sourceWindow);
  await activate(activeOtherWindow);
  await assert.rejects(withGuardedInput(state.input_epoch, () => call('mouse_move', {
    x,
    y,
    screenshot_id: capture.screenshot_id,
    expected_bundle_id: activeOtherWindow.app_id,
    expected_process_id: activeOtherWindow.process_id,
    expected_window_id: activeOtherWindow.window_id,
    expected_input_epoch: state.input_epoch,
  })), /different target window/);
  await call('ax_close_session', { session_id: state.session_id });
  return { wrongForegroundRejected: true, crossTargetScreenshotRejected: true };
}

async function verifyMovedWindowInvalidation(window) {
  window = await activate(window);
  window = await call('get_window', { window_id: window.window_id });
  let state = await snapshot(window);
  let capture = await captureWindow(window);
  const originalBounds = [...window.bounds];
  let moved = null;
  for (const key of ['ArrowLeft', 'ArrowRight']) {
    await withGuardedInput(state.input_epoch, () => call('keyboard_press', {
      key,
      modifiers: ['meta'],
      expected_bundle_id: window.app_id,
      expected_process_id: window.process_id,
      expected_window_id: window.window_id,
      expected_input_epoch: state.input_epoch,
    }));
    await delay(300);
    moved = await call('get_window', { window_id: window.window_id });
    if (JSON.stringify(moved.bounds) !== JSON.stringify(originalBounds)) break;
    await call('ax_close_session', { session_id: state.session_id });
    state = await snapshot(window);
    capture = await captureWindow(window);
  }
  assert.notDeepEqual(moved?.bounds, originalBounds, 'Notepad bounds did not change during stale-state test');
  await assert.rejects(withGuardedInput(state.input_epoch, () => call('mouse_move', {
    x: Math.round(originalBounds[0] + originalBounds[2] / 2),
    y: Math.round(originalBounds[1] + originalBounds[3] / 2),
    screenshot_id: capture.screenshot_id,
    expected_bundle_id: window.app_id,
    expected_process_id: window.process_id,
    expected_window_id: window.window_id,
    expected_input_epoch: state.input_epoch,
  })), /moved or resized|bounds changed|observe again/i);
  await call('ax_close_session', { session_id: state.session_id });
  return { staleScreenshotRejectedAfterMove: true };
}

async function verifyUserTakeover(window, timeoutMs = 10_000) {
  const state = await snapshot(window);
  const capture = await captureWindow(window, {
    max_width: 1280,
  });
  const eventCount = events.length;
  console.error(`[windows-cu] Move the physical mouse now to verify user takeover (${Math.round(timeoutMs / 1000)} seconds)`);
  const deadline = Date.now() + timeoutMs;
  while (events.length === eventCount && Date.now() < deadline) await delay(25);
  assert.ok(
    events.slice(eventCount).some(({ event }) => event === 'user-input-detected'),
    'physical user input was not observed before the manual verification timeout',
  );
  await assert.rejects(withGuardedInput(state.input_epoch, () => call('mouse_move', {
    x: Math.round(window.bounds[0] + window.bounds[2] / 2),
    y: Math.round(window.bounds[1] + window.bounds[3] / 2),
    screenshot_id: capture.screenshot_id,
    expected_bundle_id: window.app_id,
    expected_process_id: window.process_id,
    expected_window_id: window.window_id,
    expected_input_epoch: state.input_epoch,
  })), /physical user input|stale/i);
  await call('ax_close_session', { session_id: state.session_id });
  return { nativeEvent: true, staleInputRejected: true };
}

let spawnedCalculator = null;
let spawnedNotepad = null;
let ownedExplorerWindow = null;
let currentStage = 'startup';
const ownedProcesses = new Map();
const tempFile = path.join(os.tmpdir(), `abu-cu-${process.pid}-${Date.now()}.txt`);
const tempExplorerDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-cu-explorer-'));

function rememberOwnedWindow(window) {
  if (Number.isInteger(window?.process_id) && typeof window?.executable_path === 'string') {
    ownedProcesses.set(window.process_id, window.executable_path);
  }
}

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

function closeOwnedExplorerWindow(window) {
  if (
    !window
    || !/^0x[0-9a-f]+$/i.test(String(window.window_id))
    || !Number.isInteger(window.process_id)
    || path.basename(String(window.executable_path || '')).toLowerCase() !== 'explorer.exe'
  ) return;
  const script = [
    "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class AbuVerifierWindow { [DllImport(\"user32.dll\")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l); }'",
    '$target = Get-Process -Id ([int]$env:ABU_VERIFY_PID) -ErrorAction SilentlyContinue',
    'if ($null -ne $target -and $target.Path -eq $env:ABU_VERIFY_EXPECTED_PATH) {',
    '  $hwnd = [IntPtr]::new([Convert]::ToInt64($env:ABU_VERIFY_HWND.Substring(2), 16))',
    '  [void][AbuVerifierWindow]::PostMessage($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)',
    '}',
  ].join('; ');
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: 'ignore',
    env: {
      ...process.env,
      ABU_VERIFY_PID: String(window.process_id),
      ABU_VERIFY_EXPECTED_PATH: window.executable_path,
      ABU_VERIFY_HWND: window.window_id,
    },
    timeout: 5_000,
  });
}

async function verifyExplorerReadOnly() {
  const windowsBefore = new Set(
    (await call('list_windows')).map((window) => window.window_id),
  );
  spawn('explorer.exe', [tempExplorerDirectory], { stdio: 'ignore' });
  const directoryName = path.basename(tempExplorerDirectory).toLowerCase();
  let explorer = await waitForWindow((window) => (
    !windowsBefore.has(window.window_id)
    && path.basename(String(window.executable_path || '')).toLowerCase() === 'explorer.exe'
    && String(window.title || '').toLowerCase().includes(directoryName)
  ));
  ownedExplorerWindow = explorer;
  explorer = await activate(explorer);
  ownedExplorerWindow = explorer;
  const exact = await call('get_window', { window_id: explorer.window_id });
  assert.equal(exact.process_id, explorer.process_id);
  assert.equal(exact.app_id, explorer.app_id);
  const state = await snapshot(explorer);
  assert.equal(state.window_id, explorer.window_id);
  assert.ok(state.total_visited > 0, 'Explorer UIA tree was empty');
  const capture = await captureWindow(explorer, {
    max_width: 1280,
  });
  assert.ok(typeof capture.screenshot_id === 'string' && capture.screenshot_id.length > 0);
  await call('ax_close_session', { session_id: state.session_id });
  return {
    exactWindowRef: true,
    uiaReadOnly: true,
    wgcCapture: true,
    sharedExplorerProcessPreserved: true,
  };
}

async function main() {
  const physicalOnly = process.argv.includes('--physical-input-only');
  const configuredPhysicalTimeout = Number(process.env.ABU_VERIFY_PHYSICAL_TIMEOUT_MS);
  const physicalTimeoutMs = Number.isFinite(configuredPhysicalTimeout)
    ? Math.min(5 * 60_000, Math.max(10_000, Math.round(configuredPhysicalTimeout)))
    : (physicalOnly ? 5 * 60_000 : 10_000);
  const physicalVerificationRequested = physicalOnly
    || process.env.ABU_VERIFY_PHYSICAL_INPUT === '1'
    || process.argv.includes('--physical-input');
  const hello = await call('hello');
  currentStage = 'calculator-launch';
  assert.equal(hello.protocol_version, 2);
  assert.equal(hello.capabilities.accessibility, 'windows-uia');
  assert.equal(hello.capabilities.screen_capture, 'wgc-monitor');
  assert.equal(hello.capabilities.input, 'sendinput-guarded');
  assert.equal(hello.capabilities.physical_input_monitoring, true);
  const lease = await call('input_lease_begin', { lease_id: inputLeaseId });
  assert.equal(lease.phase, 'observing');
  inputLeaseStarted = true;

  const windowsBeforeCalculator = new Set(
    (await call('list_windows')).map((window) => window.window_id),
  );
  spawnedCalculator = spawn('calc.exe', [], { stdio: 'ignore' });
  let calculator = await waitForWindow((window) => (
    /calculator/i.test(window.app_name) || /calculator/i.test(window.app_id)
  ) && !windowsBeforeCalculator.has(window.window_id)
    && window.bounds[2] >= 200 && window.bounds[3] >= 300);
  rememberOwnedWindow(calculator);
  calculator = await activate(calculator);
  currentStage = 'calculator-catalog-launch';
  const takeoverResult = physicalVerificationRequested
    ? await verifyUserTakeover(calculator, physicalTimeoutMs)
    : { manualVerificationRequired: true };
  if (physicalOnly) {
    console.log(`[windows-cu] ${JSON.stringify({
      protocol: hello.protocol_version,
      userTakeover: takeoverResult,
      physicalInputEvents: events.length,
    })}`);
    console.log('[windows-cu] PHYSICAL_TAKEOVER_VERIFIED=true');
    console.log('[windows-cu] PASSED=true');
    return;
  }
  const apps = await call('list_apps');
  assert.ok(apps.some((app) => app.app_id === calculator.app_id && app.running));
  const launchedCalculator = await call('launch_app', { app_name: calculator.app_id });
  assert.equal(launchedCalculator.app_id, calculator.app_id);
  if (!windowsBeforeCalculator.has(launchedCalculator.window_id)) {
    rememberOwnedWindow(launchedCalculator);
  }
  calculator = await activate(calculator);
  currentStage = 'calculator-golden';
  const calculatorResult = await runThirty(
    'calculator-1+3=4',
    () => calculatorJourney(calculator),
  );
  const captureResult = await verifyWgcAndGuardedInput(calculator);

  currentStage = 'notepad-launch';
  fs.writeFileSync(tempFile, '', { encoding: 'utf8', flag: 'wx' });
  spawnedNotepad = spawn('notepad.exe', [tempFile], { stdio: 'ignore' });
  const uniqueTitle = path.basename(tempFile, path.extname(tempFile)).toLowerCase();
  let notepad = await waitForWindow((window) => (
    /notepad/i.test(window.app_name)
    && window.title.toLowerCase().includes(uniqueTitle)
  ));
  rememberOwnedWindow(notepad);
  notepad = await activate(notepad);
  const crossWindowResult = await verifyCrossWindowGuard(calculator, notepad);
  notepad = await activate(notepad);
  const notepadResult = await runThirty(
    'notepad-uia-value',
    (iteration) => notepadJourney(notepad, iteration),
  );
  currentStage = 'notepad-keyboard-layout';
  const keyboardLayoutResult = await verifyNotepadKeyboardLayout(notepad);
  currentStage = 'moved-window-invalidation';
  const movedWindowResult = await verifyMovedWindowInvalidation(notepad);
  currentStage = 'explorer-read-only';
  const explorerResult = await verifyExplorerReadOnly();

  const summary = {
    protocol: hello.protocol_version,
    appCatalog: { entries: apps.length, runningActivation: true },
    calculator: calculatorResult,
    notepad: notepadResult,
    keyboardLayout: keyboardLayoutResult,
    capture: captureResult,
    crossWindow: crossWindowResult,
    movedWindow: movedWindowResult,
    explorer: explorerResult,
    userTakeover: takeoverResult,
    physicalInputEvents: events.length,
  };
  const automatedPassed = calculatorResult.rate >= 0.95 && notepadResult.rate >= 0.95;
  const physicalTakeoverVerified = takeoverResult.nativeEvent === true
    && takeoverResult.staleInputRejected === true;
  const passed = automatedPassed
    && (!physicalVerificationRequested || physicalTakeoverVerified);
  console.log(`[windows-cu] ${JSON.stringify(summary)}`);
  console.log(`[windows-cu] AUTOMATED_PASSED=${automatedPassed}`);
  console.log(`[windows-cu] PHYSICAL_TAKEOVER_VERIFIED=${physicalTakeoverVerified}`);
  console.log(`[windows-cu] PASSED=${passed}`);
  process.exitCode = passed ? 0 : 1;
}

main().catch((error) => {
  console.error(`[windows-cu] FAILED (${currentStage}): ${String(error?.message ?? error).slice(0, 500)}`);
  process.exitCode = 1;
}).finally(async () => {
  if (inputLeaseStarted) {
    try { await call('input_lease_end', { lease_id: inputLeaseId }, 5_000); } catch { /* helper exited */ }
    inputLeaseStarted = false;
  }
  try { helper.stdin.end(); } catch { /* already closed */ }
  try { helper.kill(); } catch { /* already exited */ }
  if (spawnedNotepad?.pid) {
    try { spawnedNotepad.kill(); } catch { /* already exited */ }
  }
  if (spawnedCalculator?.pid) {
    try { spawnedCalculator.kill(); } catch { /* already exited */ }
  }
  for (const [processId, executablePath] of ownedProcesses) {
    stopOwnedProcess(processId, executablePath);
  }
  closeOwnedExplorerWindow(ownedExplorerWindow);
  await delay(200);
  try { fs.unlinkSync(tempFile); } catch { /* absent or still held by Notepad */ }
  try { fs.rmdirSync(tempExplorerDirectory); } catch { /* absent or Explorer still closing */ }
});
