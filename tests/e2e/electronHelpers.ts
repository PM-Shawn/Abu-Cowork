/**
 * Helpers for the real-Electron-app E2E smoke suite (tests/e2e/smoke.spec.ts).
 *
 * These launch the ACTUAL `electron/main.cjs` entry point via Playwright's
 * `_electron` API — the same code path as `npm run electron:dev` — not a
 * headless IPC harness. See electron/main.cjs for the full launch story.
 */
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { _electron as electron, type ElectronApplication } from 'playwright';

/**
 * Repo root. The npm script (`test:e2e:electron`) always invokes `playwright
 * test` from the repo root, so `process.cwd()` is reliable here — avoids the
 * __dirname-under-ESM footgun (package.json has `"type": "module"`).
 */
export const REPO_ROOT = process.cwd();
export const MAIN_ENTRY = path.join(REPO_ROOT, 'electron', 'main.cjs');
const E2E_APP_DATA_ROOT_ENV = 'ABU_E2E_APP_DATA_ROOT';
const execFileAsync = promisify(execFile);

export interface ElectronDataRoot {
  rootDir: string;
  userDataDir: string;
  appDataDir: string;
}

export interface LaunchedApp extends ElectronDataRoot {
  app: ElectronApplication;
}

/**
 * Create a unique root that contains the Chromium profile and Electron appData
 * parent separately. Keep this root alive until the test has finished every
 * launch that needs it; a persistence test can pass it to launchAbuElectron()
 * again after closing its first app instance.
 */
export function createElectronDataRoot(): ElectronDataRoot {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), `abu-e2e-${randomUUID().slice(0, 8)}-`));
  return {
    rootDir,
    userDataDir: path.join(rootDir, 'user-data'),
    appDataDir: path.join(rootDir, 'app-data'),
  };
}

/** Best-effort cleanup after a test has completed all launches using this root. */
export function removeElectronDataRoot(dataRoot: ElectronDataRoot): void {
  try {
    fs.rmSync(dataRoot.rootDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup only
  }
}

/**
 * Launch electron/main.cjs with fully isolated Chromium userData and appData.
 *
 * main.cjs calls `app.requestSingleInstanceLock()`; if a second instance's
 * lock loses the race against an already-running instance sharing the same
 * userData dir, it calls `app.quit()` and NO window is ever created. Chromium/
 * Electron honors `--user-data-dir` as a full override of the userData path
 * (independent of `app.setName('abu-electron-dev')`), so a fresh temp dir per
 * test data root guarantees this test always wins the lock, and Chromium-profile-backed
 * state (localStorage — the `abu-settings` store, onboarding/disclaimer flags)
 * starts fresh every run.
 *
 * main.cjs reads ABU_E2E_APP_DATA_ROOT before app readiness and uses it only
 * for non-packaged builds, so the renderer-facing appData subfolder and any
 * Electron service using app.getPath('appData') remain inside this same root.
 */
export async function launchAbuElectron(dataRoot = createElectronDataRoot()): Promise<LaunchedApp> {
  fs.mkdirSync(dataRoot.userDataDir, { recursive: true });
  fs.mkdirSync(dataRoot.appDataDir, { recursive: true });
  const app = await electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${dataRoot.userDataDir}`],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      [E2E_APP_DATA_ROOT_ENV]: dataRoot.appDataDir,
    },
    timeout: 60_000,
  });
  return { app, ...dataRoot };
}

/**
 * Close the app while preserving its data root for a possible relaunch.
 *
 * No orphan sidecar to chase down here: the frontend spawns the sidecar via
 * mcp_spawn, routed to electron/mcpBridge.cjs, whose own `process.on('exit', ...)`
 * / SIGINT/SIGTERM/SIGHUP guards SIGKILL every child it spawned when the
 * Electron process itself exits (see mcpBridge.cjs "No orphans" section) — so
 * closing the Electron app here is sufficient, nothing extra to kill.
 */
export async function closeAbuElectron(app: ElectronApplication): Promise<void> {
  const child = app.process();

  // Ask Electron itself to quit so main.cjs's before-quit path tears down
  // browser views, PTYs, helpers, and sidecars. ElectronApplication.close()
  // can otherwise close the BrowserWindow first; Abu's preventable
  // close-request handler may intentionally keep that window alive.
  try {
    await app.evaluate(({ app: electronApp }) => {
      electronApp.quit();
    });
  } catch {
    // The transport commonly closes before evaluate receives its result.
  }
  if (await waitForChildExit(child, 5_000)) return;

  // Bounded fallback for a broken teardown. Signals target only Playwright's
  // exact child process, never a name/pattern that could match a user app.
  child.kill('SIGTERM');
  if (await waitForChildExit(child, 3_000)) return;
  child.kill('SIGKILL');
  await waitForChildExit(child, 2_000);
}

/**
 * Terminate the exact Electron process without running the renderer's graceful
 * shutdown path. The main process still receives SIGTERM, so its no-orphan
 * guards kill the sidecar and other child processes before exiting.
 */
export async function terminateAbuElectron(app: ElectronApplication): Promise<void> {
  const child = app.process();
  child.kill('SIGTERM');
  if (await waitForChildExit(child, 5_000)) return;
  child.kill('SIGKILL');
  await waitForChildExit(child, 2_000);
}

/**
 * Resolve the one sidecar process spawned directly by this test's Electron
 * main process. The parent PID and absolute entry path jointly scope the
 * lookup, so another Abu/Codex/Electron process can never be selected.
 */
export async function waitForAbuSidecarPid(
  app: ElectronApplication,
  excludedPid?: number,
  timeoutMs = 10_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matches = (await listDirectSidecarPids(app)).filter((pid) => pid !== excludedPid);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new Error(`Found multiple Abu sidecars for Electron PID ${app.process().pid}: ${matches.join(', ')}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for Abu sidecar under Electron PID ${app.process().pid}`);
}

/** Kill only the currently verified sidecar child belonging to this app. */
export async function killAbuSidecar(app: ElectronApplication): Promise<number> {
  const pid = await waitForAbuSidecarPid(app);
  const verified = await listDirectSidecarPids(app);
  if (verified.length !== 1 || verified[0] !== pid) {
    throw new Error(`Abu sidecar changed before kill (expected ${pid}, found ${verified.join(', ') || 'none'})`);
  }
  process.kill(pid, 'SIGKILL');
  return pid;
}

interface ProcessRow {
  command: string;
  pid: number;
  ppid: number;
}

async function listDirectSidecarPids(app: ElectronApplication): Promise<number[]> {
  const parentPid = app.process().pid;
  const expectedEntry = path.join(REPO_ROOT, 'sidecar', 'index.mjs');
  const rows = process.platform === 'win32'
    ? await listWindowsProcesses(parentPid)
    : await listPosixProcesses();
  return rows
    .filter((row) => row.ppid === parentPid && row.command.includes(expectedEntry))
    .map((row) => row.pid);
}

async function listPosixProcesses(): Promise<ProcessRow[]> {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,command='], {
    encoding: 'utf8',
  });
  const rows: ProcessRow[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] });
  }
  return rows;
}

async function listWindowsProcesses(parentPid: number): Promise<ProcessRow[]> {
  const script = [
    `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${parentPid}"`,
    'Select-Object ProcessId, ParentProcessId, CommandLine',
    'ConvertTo-Json -Compress',
  ].join(' | ');
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ], { encoding: 'utf8' });
  if (!stdout.trim()) return [];
  const parsed = JSON.parse(stdout) as
    | { CommandLine?: unknown; ParentProcessId?: unknown; ProcessId?: unknown }
    | Array<{ CommandLine?: unknown; ParentProcessId?: unknown; ProcessId?: unknown }>;
  const records = Array.isArray(parsed) ? parsed : [parsed];
  return records.flatMap((record) => {
    const pid = Number(record.ProcessId);
    const ppid = Number(record.ParentProcessId);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) return [];
    return [{ pid, ppid, command: typeof record.CommandLine === 'string' ? record.CommandLine : '' }];
  });
}

function waitForChildExit(
  child: ReturnType<ElectronApplication['process']>,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}
