/**
 * Automated acceptance harness (outer half) — plain Node, run via
 * `npm run electron:test`.
 *
 * Launches Electron on electron/acceptance.cjs (which does the start /
 * round-trip / kill-revive / stop flow and writes electron-results/
 * acceptance.json), then INDEPENDENTLY verifies the no-orphan guarantee:
 * every sidecar pid the inner run touched must be dead once the Electron
 * process has exited. Doing the orphan check from a separate process is the
 * point — it proves teardown from the outside, not the shell's own say-so.
 *
 * Exit 0 iff the inner run passed AND no sidecar pid survived.
 */
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const acceptanceEntry = path.join(repoRoot, 'electron', 'acceptance.cjs');
const resultFile = path.join(repoRoot, 'electron-results', 'acceptance.json');

// `require('electron')` from Node returns the path to the Electron binary.
const nodeRequire = createRequire(import.meta.url);
const electronBin = nodeRequire('electron');

// Identity-aware liveness: a bare pid existence check (process.kill(pid, 0))
// would false-positive on pid reuse — the OS can reassign a killed sidecar's
// pid to an unrelated process — causing a spurious orphan FAIL and, worse,
// SIGKILLing that innocent process in the reap loop below. Confirm the pid is
// actually our sidecar by matching its command line. (macOS/Linux `ps`;
// Windows handled in a later slice.)
function sidecarAlive(pid) {
  try {
    const cmd = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
    }).trim();
    return cmd.includes('index.mjs');
  } catch {
    return false; // ps exits non-zero when the pid no longer exists
  }
}

async function main() {
  if (existsSync(resultFile)) rmSync(resultFile, { force: true });

  const code = await new Promise((resolve) => {
    const child = spawn(electronBin, [acceptanceEntry], {
      stdio: 'inherit',
      env: { ...process.env },
    });
    child.on('exit', (c) => resolve(c ?? 1));
    child.on('error', (err) => {
      console.error('[electron:test] failed to launch Electron:', err.message);
      resolve(1);
    });
  });

  if (!existsSync(resultFile)) {
    console.error('[electron:test] FAIL — no result file produced (Electron did not complete)');
    process.exit(1);
  }

  const result = JSON.parse(readFileSync(resultFile, 'utf-8'));

  // Independent no-orphan check: give the OS a beat to reap, then confirm every
  // sidecar pid is gone now that Electron has exited.
  await new Promise((r) => setTimeout(r, 500));
  const survivors = (result.pids || []).filter(sidecarAlive);
  const noOrphan = survivors.length === 0;

  const innerOk = result.ok === true && code === 0;
  const pass = innerOk && noOrphan;

  console.log('\n[electron:test] ── acceptance summary ──');
  for (const [name, c] of Object.entries(result.checks || {})) {
    console.log(`  ${c.ok ? '✓' : '✗'} ${name}${c.ok ? '' : '  ' + JSON.stringify(c)}`);
  }
  console.log(`  ${noOrphan ? '✓' : '✗'} no-orphan (sidecar pids dead after exit)${noOrphan ? '' : '  survivors=' + JSON.stringify(survivors)}`);
  console.log(`[electron:test] ${pass ? 'PASS' : 'FAIL'} (electron exit=${code}, inner ok=${result.ok})\n`);

  // Best-effort: reap any survivor so a failed run doesn't leak processes.
  for (const pid of survivors) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* ignore */
    }
  }

  process.exit(pass ? 0 : 1);
}

main();
