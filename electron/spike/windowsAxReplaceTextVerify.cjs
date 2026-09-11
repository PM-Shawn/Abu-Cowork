/**
 * Verifies the generic Windows accessibility text-replacement contract.
 *
 * A disposable WinForms TextBox is used as the editable-control fixture. The
 * command under test is app-agnostic: it binds a UIA element to an exact
 * app/PID/HWND and input epoch, focuses that element, then performs guarded
 * user-visible input. Success is independently verified through the fixture's
 * TextChanged event writing a temporary file.
 *
 * Run after `npm run build:native-helper`:
 *   npm run verify:windows-computer-use:text
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');

if (process.platform !== 'win32') {
  console.error('[windows-cu-text] Windows is required');
  process.exit(2);
}

const helperPath = process.env.ABU_NATIVE_HELPER_PATH
  ? path.resolve(process.env.ABU_NATIVE_HELPER_PATH)
  : path.join(__dirname, '..', 'native-helper', 'target', 'release', 'native-helper.exe');
if (!fs.existsSync(helperPath)) {
  console.error(`[windows-cu-text] release helper missing: ${helperPath}`);
  process.exit(2);
}

const helper = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
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
  if (message.error != null) request.reject(new Error(String(message.error)));
  else request.resolve(message.result);
});

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
    await delay(200);
  }
  throw new Error('disposable editable target did not appear');
}

async function waitForFileText(filePath, expected, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.readFileSync(filePath, 'utf8') === expected) return;
    await delay(100);
  }
  assert.equal(fs.readFileSync(filePath, 'utf8'), expected, 'saved text did not match input');
}

function editableElement(snapshot) {
  return snapshot.elements.find((element) => (
    Array.isArray(element.actions)
    && element.actions.includes('SetValue')
    && (element.role === 'TextField' || element.role === 'Document')
  )) ?? snapshot.elements.find((element) => element.actions?.includes('SetValue'));
}

function stopExactProcess(processId, executablePath) {
  if (!Number.isInteger(processId) || typeof executablePath !== 'string') return;
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

const tempFile = path.join(os.tmpdir(), `abu-cu-text-${process.pid}-${Date.now()}.txt`);
const fixtureScript = path.join(os.tmpdir(), `abu-cu-text-${process.pid}-${Date.now()}.ps1`);
const fixtureTitle = `Abu CU editable fixture ${process.pid} ${Date.now()}`;
const leaseId = `windows-cu-text-${process.pid}-${Date.now()}`;
let ownedWindow = null;
let fixtureProcess = null;
let leaseStarted = false;

async function main() {
  fs.writeFileSync(tempFile, '', { encoding: 'utf8', flag: 'wx' });
  fs.writeFileSync(fixtureScript, [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$form = New-Object System.Windows.Forms.Form',
    '$form.Text = $env:ABU_CU_FIXTURE_TITLE',
    '$form.Width = 720',
    '$form.Height = 420',
    '$textBox = New-Object System.Windows.Forms.TextBox',
    '$textBox.Multiline = $true',
    '$textBox.Dock = [System.Windows.Forms.DockStyle]::Fill',
    '$textBox.Add_TextChanged({',
    '  [System.IO.File]::WriteAllText($env:ABU_CU_TEXT_OUTPUT, $textBox.Text, (New-Object System.Text.UTF8Encoding($false)))',
    '})',
    '$form.Controls.Add($textBox)',
    '$form.Add_Shown({ $textBox.Focus() })',
    '[void]$form.ShowDialog()',
  ].join('\r\n'), { encoding: 'utf8', flag: 'wx' });
  const hello = await call('hello');
  assert.ok(hello.supported_commands.includes('ax_replace_text'));

  const initialLease = await call('input_lease_begin', { lease_id: leaseId });
  leaseStarted = true;
  assert.equal(initialLease.phase, 'observing');

  const existingWindowIds = new Set(
    (await call('list_windows')).map((window) => window.window_id),
  );
  fixtureProcess = spawn('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Sta',
    '-File',
    fixtureScript,
  ], {
    stdio: 'ignore',
    env: {
      ...process.env,
      ABU_CU_FIXTURE_TITLE: fixtureTitle,
      ABU_CU_TEXT_OUTPUT: tempFile,
    },
  });
  ownedWindow = await waitForWindow((window) => (
    !existingWindowIds.has(window.window_id)
    && window.process_id === fixtureProcess.pid
    && window.title === fixtureTitle
  ));
  ownedWindow = await call('activate_window', { window_id: ownedWindow.window_id });
  await delay(150);

  const before = await call('ax_snapshot', {
    app_name: ownedWindow.app_name,
    expected_bundle_id: ownedWindow.app_id,
    expected_process_id: ownedWindow.process_id,
    expected_window_id: ownedWindow.window_id,
  });
  const editable = editableElement(before);
  assert.ok(editable, 'editable UIA element unavailable');

  const marker = `Abu generic Windows Computer Use ${Date.now()} ✓`;
  await call('input_lease_commit_observation', {
    lease_id: leaseId,
    expected_input_epoch: before.input_epoch,
  });
  await call('input_lease_activate', {
    lease_id: leaseId,
    expected_input_epoch: before.input_epoch,
  });
  try {
    await call('ax_replace_text', {
      session_id: before.session_id,
      element_id: editable.id,
      text: marker,
      expected_bundle_id: ownedWindow.app_id,
      expected_process_id: ownedWindow.process_id,
      expected_window_id: ownedWindow.window_id,
      expected_input_epoch: before.input_epoch,
    });
  } finally {
    await call('input_lease_observe', { lease_id: leaseId });
  }

  await waitForFileText(tempFile, marker);
  await call('ax_close_session', { session_id: before.session_id });
  console.log('[windows-cu-text] targetBinding=true');
  console.log('[windows-cu-text] guardedVisibleInput=true');
  console.log('[windows-cu-text] independentPersistenceVerification=true');
  console.log('[windows-cu-text] PASSED=true');
}

main().catch((error) => {
  console.error(`[windows-cu-text] FAILED: ${String(error?.message ?? error).slice(0, 500)}`);
  process.exitCode = 1;
}).finally(async () => {
  if (leaseStarted) {
    try { await call('input_lease_end', { lease_id: leaseId }); } catch { /* helper unavailable */ }
  }
  try { helper.stdin.end(); } catch { /* already closed */ }
  try { helper.kill(); } catch { /* already exited */ }
  if (fixtureProcess?.pid) {
    try { fixtureProcess.kill(); } catch { /* already exited */ }
  }
  if (ownedWindow) stopExactProcess(ownedWindow.process_id, ownedWindow.executable_path);
  await delay(200);
  try { fs.unlinkSync(tempFile); } catch { /* absent or still held by fixture */ }
  try { fs.unlinkSync(fixtureScript); } catch { /* absent or still held by fixture */ }
});
