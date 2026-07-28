/**
 * Global setup for the real-Electron E2E smoke suite.
 *
 *  1. Kills any stray Electron/sidecar process left over from THIS worktree
 *     (dev shell, a spike harness, or a previous crashed test run) so it can
 *     never fight our isolated-userData-dir launches for OS resources or
 *     leave a duplicate sidecar around. Scoped to processes whose command
 *     line contains this worktree's absolute path — never touches another
 *     worktree's or a different app's processes.
 *  2. Prepares the pinned Electron runtimes, built-in browser runtime, and
 *     native helper used by capability, browser, and Computer Use checks.
 *  3. Rebuilds the sidecar from the current worktree sources so Electron
 *     never exercises a stale ignored sidecar/index.mjs bundle.
 *  4. Rebuilds dist-electron-spike/ from the current renderer sources so the
 *     Electron shell and sidecar are always tested as one current-source unit.
 *
 * macOS has no `timeout` binary (see feedback-macos-no-timeout-binary in
 * project memory) — everything here is synchronous / self-terminating, no
 * reliance on a `timeout` wrapper.
 */
import { execSync } from 'node:child_process';

const REPO_ROOT = process.cwd();

/** Best-effort SIGKILL of any process whose full command line matches `pattern`. */
function killStray(pattern: string): void {
  let out: string;
  try {
    out = execSync(`pgrep -f ${JSON.stringify(pattern)}`, { encoding: 'utf8' });
  } catch {
    // pgrep exits 1 when there are no matches — not an error
    return;
  }
  const pids = out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const pidStr of pids) {
    const pid = Number(pidStr);
    if (!Number.isFinite(pid) || pid === process.pid) continue;
    try {
      process.kill(pid, 'SIGKILL');
      console.log(`[e2e:global-setup] killed stray pid ${pid} matching "${pattern}"`);
    } catch {
      // already exited between pgrep and kill — fine
    }
  }
}

export default async function globalSetup(): Promise<void> {
  killStray(`${REPO_ROOT}/electron/main.cjs`);
  killStray(`${REPO_ROOT}/sidecar/index.mjs`);

  console.log('[e2e:global-setup] preparing Electron and browser runtimes...');
  execSync(
    'npm run setup:electron-runtimes && npm run verify:electron-runtimes && npm run build:electron-browser-runtime && npm run build:native-helper',
    {
      cwd: REPO_ROOT,
      stdio: 'inherit',
    },
  );

  console.log('[e2e:global-setup] building sidecar from current sources…');
  execSync('npm run build:sidecar', {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });

  console.log('[e2e:global-setup] building renderer from current sources…');
  execSync('npx vite build --base=./ --outDir dist-electron-spike', {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
}
