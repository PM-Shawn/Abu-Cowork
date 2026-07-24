/**
 * Consolidated automated test-report generator — plain Node ESM, run via
 * `npm run test:e2e-report` (mirrors the style of `scripts/electron-acceptance.mjs`).
 *
 * Runs, in order, and aggregates into one Markdown report:
 *   1. The full vitest suite (`npx vitest run`) — the backbone, most reliable.
 *   2. A SAFE subset of the headless Electron spike harnesses
 *      (`electron/spike/*.cjs`) — best-effort, each spawned via the Electron
 *      binary with an own hard timeout (macOS has no `timeout` binary).
 *   3. A static SKIPPED list (GUI / TCC-Screen-Recording / heavy-boot
 *      harnesses) recorded with a reason, never executed.
 *
 * Exit 0 iff the vitest suite passed AND every RUN harness passed.
 * Skipped harnesses never affect the exit code.
 */
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const spikeDir = path.join(repoRoot, 'electron', 'spike');
const reportDir = path.join(repoRoot, 'test-reports');

// `require('electron')` from Node returns the path to the Electron binary
// (same trick as electron-acceptance.mjs).
const nodeRequire = createRequire(import.meta.url);
const electronBin = nodeRequire('electron');

// Per-harness hard timeout. macOS ships no `timeout` binary — verified on
// this machine — so a hung Electron process would stall the whole run
// forever without our own kill switch. Raised from the original 60s to 90s
// to cover f1HeartbeatE2E.cjs, which drives 3 consecutive missed heartbeat
// pings (interval 10s + timeout 5s each, ~55s worst case) before its
// mcp-hung-* assertion resolves — 60s was cutting that too close and could
// false-TIMEOUT a passing run.
const HARNESS_TIMEOUT_MS = 90_000;

// SAFE subset: pure shell-contract logic, no Screen-Recording/TCC/display
// dependency. Run sequentially (not parallel) to avoid Electron
// single-instance / resource contention.
const HARNESSES_TO_RUN = [
  'f1aE2E.cjs',
  'f1HeartbeatE2E.cjs',
  'shellGlobalShortcutVerify.cjs',
  'deepLinkVerify.cjs',
  'f2Verify.cjs',
  'f3Verify.cjs',
  'f4Verify.cjs',
  'f6Verify.cjs',
  'f7Verify.cjs',
  'f9Verify.cjs',
  'f13Verify.cjs',
  'f1bVerify.cjs',
  'f14Verify.cjs',
  'httpVerify.cjs',
  'reviewFixVerify.cjs',
  'migrationVerify.cjs',
  'updaterVerify.cjs',
];

// Explicitly NOT run — would need a display / TCC Screen-Recording grant
// and would hang or false-fail unattended. Recorded so the report stays
// honest about coverage gaps.
const HARNESSES_SKIPPED = [
  { name: 'f8GuiVerify.cjs', reason: 'tray/pet/overlay visual assertions — needs a real GUI/display' },
  { name: 'f10CuVerify.cjs', reason: 'computer-use control loop — needs Screen-Recording/TCC permission' },
  { name: 'f10AxVerify.cjs', reason: 'Accessibility (AX) API probing — needs Accessibility/TCC permission' },
  { name: 'f10IntVerify.cjs', reason: 'computer-use integration — needs Screen-Recording/TCC permission' },
  { name: 'f10TccProbe.cjs', reason: 'directly probes TCC permission state — needs interactive grant' },
  { name: 'f10HelperLoop.cjs', reason: 'native helper loop for computer-use — needs Screen-Recording/TCC permission' },
  { name: 'devSmoke.cjs', reason: 'heavy full dev-mode boot smoke test — too slow/flaky unattended' },
  { name: 'bootSpike.cjs', reason: 'heavy full boot spike — too slow/flaky unattended' },
];

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtMs(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function tailLines(s, n) {
  const lines = s.split('\n');
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

function gitInfo() {
  const out = { branch: 'unknown', commit: 'unknown' };
  try {
    out.branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
  } catch {
    /* best-effort only */
  }
  try {
    out.commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
  } catch {
    /* best-effort only */
  }
  return out;
}

/** Pull a `X failed | Y passed | Z skipped (N)`-style count off a labeled
 *  vitest summary line, tolerant of which parts are present/order. */
function parseCounts(fullOutput, label) {
  const lineMatch = new RegExp(`^\\s*${label}\\s+(.*)$`, 'm').exec(fullOutput);
  if (!lineMatch) return null;
  const seg = lineMatch[1];
  const grab = (re) => {
    const m = re.exec(seg);
    return m ? parseInt(m[1], 10) : 0;
  };
  return {
    failed: grab(/(\d+)\s+failed/),
    passed: grab(/(\d+)\s+passed/),
    skipped: grab(/(\d+)\s+skipped/),
    todo: grab(/(\d+)\s+todo/),
    total: grab(/\((\d+)\)/),
    raw: seg.trim(),
  };
}

/** Best-effort: kill any stray Electron process launched from this worktree
 *  so one harness's leftovers never contaminate the next. */
function reapStrayElectron() {
  try {
    const out = execFileSync('ps', ['ax', '-o', 'pid=,command='], { encoding: 'utf8' });
    for (const line of out.split('\n')) {
      if (!line.includes(repoRoot)) continue;
      if (!/Electron|electron/.test(line)) continue;
      const m = /^\s*(\d+)\s+/.exec(line);
      if (!m) continue;
      const pid = parseInt(m[1], 10);
      if (pid === process.pid) continue;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* ps failure is non-fatal — best effort only */
  }
}

/** Run the full vitest suite once and parse its final counts. */
async function runVitest() {
  console.log('\n[e2e-report] ── running vitest (full suite) ──');
  const start = Date.now();
  let out = '';
  const code = await new Promise((resolve) => {
    const child = spawn('npx', ['vitest', 'run'], {
      cwd: repoRoot,
      env: { ...process.env, CI: process.env.CI ?? '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => {
      const s = d.toString();
      out += s;
      process.stdout.write(s);
    });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      out += s;
      process.stderr.write(s);
    });
    child.on('exit', (c) => resolve(c ?? 1));
    child.on('error', (err) => {
      out += `\n[e2e-report] failed to launch vitest: ${err.message}\n`;
      resolve(1);
    });
  });
  const duration = Date.now() - start;
  const clean = stripAnsi(out);
  const testsSummary = parseCounts(clean, 'Tests');
  const filesSummary = parseCounts(clean, 'Test Files');

  const passed = code === 0 && !!testsSummary && testsSummary.failed === 0;

  return {
    name: 'vitest (unit/integration)',
    code,
    duration,
    passed,
    testsSummary,
    filesSummary,
    tail: tailLines(clean, 60),
  };
}

/** Spawn one headless Electron harness with our own hard timeout. */
async function runHarness(name) {
  const entry = path.join(spikeDir, name);
  console.log(`\n[e2e-report] ── running harness ${name} ──`);
  const start = Date.now();
  let out = '';
  let timedOut = false;

  const code = await new Promise((resolve) => {
    const child = spawn(electronBin, [entry], {
      cwd: repoRoot,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const killer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, HARNESS_TIMEOUT_MS);

    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.stderr.on('data', (d) => {
      out += d.toString();
    });
    child.on('exit', (c) => {
      clearTimeout(killer);
      resolve(c ?? 1);
    });
    child.on('error', (err) => {
      clearTimeout(killer);
      out += `\n[e2e-report] failed to launch ${name}: ${err.message}\n`;
      resolve(1);
    });
  });

  const duration = Date.now() - start;
  reapStrayElectron();

  const status = timedOut ? 'TIMEOUT' : code === 0 ? 'PASS' : 'FAIL';
  console.log(`[e2e-report] ${name}: ${status} (exit=${code}, ${fmtMs(duration)})`);

  return {
    name,
    status,
    code,
    duration,
    tail: tailLines(stripAnsi(out), 25),
  };
}

function renderReport({ date, git, vitestResult, harnessResults, overallPass }) {
  const lines = [];
  lines.push(`# Electron E2E / Automated Test Report — ${date}`);
  lines.push('');
  lines.push(`- **Branch**: \`${git.branch}\` (\`${git.commit}\`)`);
  lines.push(`- **Generated**: ${new Date().toISOString()}`);
  lines.push(`- **Generator**: \`scripts/e2e-report.mjs\``);
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  lines.push('| Suite | Result | Passed/Failed | Duration |');
  lines.push('|---|---|---|---|');
  const vt = vitestResult.testsSummary;
  const vtCounts = vt ? `${vt.passed} passed / ${vt.failed} failed / ${vt.skipped} skipped (of ${vt.total})` : 'unparsed';
  lines.push(`| vitest (unit/integration) | ${vitestResult.passed ? 'PASS' : 'FAIL'} | ${vtCounts} | ${fmtMs(vitestResult.duration)} |`);
  const harnessPassCount = harnessResults.filter((h) => h.status === 'PASS').length;
  const harnessFailCount = harnessResults.length - harnessPassCount;
  const harnessDuration = harnessResults.reduce((s, h) => s + h.duration, 0);
  lines.push(`| Electron headless harnesses (safe subset) | ${harnessFailCount === 0 ? 'PASS' : 'FAIL'} | ${harnessPassCount} passed / ${harnessFailCount} failed-or-timeout (of ${harnessResults.length}) | ${fmtMs(harnessDuration)} |`);
  lines.push(`| Skipped harnesses (GUI/TCC/heavy-boot) | SKIP | 0 run / ${HARNESSES_SKIPPED.length} skipped | — |`);
  lines.push('');

  lines.push('## 1. Unit/integration suite (`npx vitest run`)');
  lines.push('');
  lines.push(`Result: **${vitestResult.passed ? 'PASS' : 'FAIL'}** (exit code ${vitestResult.code}, ${fmtMs(vitestResult.duration)})`);
  lines.push('');
  if (vitestResult.filesSummary) {
    lines.push(`- Test Files: ${vitestResult.filesSummary.raw}`);
  }
  if (vt) {
    lines.push(`- Tests: ${vt.raw}`);
  } else {
    lines.push('- Could not parse a `Tests` summary line from vitest output — see tail below.');
  }
  lines.push('');
  lines.push('<details><summary>vitest output tail</summary>');
  lines.push('');
  lines.push('```');
  lines.push(vitestResult.tail);
  lines.push('```');
  lines.push('');
  lines.push('</details>');
  lines.push('');

  lines.push('## 2. Headless Electron harnesses (best-effort, safe subset)');
  lines.push('');
  lines.push('Each harness spawns its own Electron process running `electron/spike/<name>.cjs`,');
  lines.push('asserts internally, and exits non-zero on failure. Run sequentially with a');
  lines.push(`${HARNESS_TIMEOUT_MS / 1000}s per-harness hard kill timeout (this machine has no \`timeout\` binary).`);
  lines.push('');
  lines.push('| Harness | Result | Exit code | Duration |');
  lines.push('|---|---|---|---|');
  for (const h of harnessResults) {
    lines.push(`| \`${h.name}\` | ${h.status} | ${h.code} | ${fmtMs(h.duration)} |`);
  }
  lines.push('');
  const failedHarnesses = harnessResults.filter((h) => h.status !== 'PASS');
  if (failedHarnesses.length > 0) {
    lines.push('<details><summary>Failed/timed-out harness output tails</summary>');
    lines.push('');
    for (const h of failedHarnesses) {
      lines.push(`**${h.name}** (${h.status}, exit=${h.code}):`);
      lines.push('```');
      lines.push(h.tail || '(no output captured)');
      lines.push('```');
      lines.push('');
    }
    lines.push('</details>');
    lines.push('');
  }

  lines.push('## 3. Skipped (not run — need GUI / TCC-Screen-Recording / heavy boot)');
  lines.push('');
  lines.push('| Harness | Reason not run |');
  lines.push('|---|---|');
  for (const s of HARNESSES_SKIPPED) {
    lines.push(`| \`${s.name}\` | ${s.reason} |`);
  }
  lines.push('');
  lines.push('These do not count against the overall verdict — they are an honest coverage gap,');
  lines.push('not a failure, and running them unattended would hang or false-fail (no display /');
  lines.push('no interactive TCC grant in this environment).');
  lines.push('');

  lines.push('## Overall verdict');
  lines.push('');
  lines.push(
    overallPass
      ? `**PASS** — vitest suite and all ${harnessResults.length} run harnesses succeeded (${HARNESSES_SKIPPED.length} harnesses intentionally skipped, see above).`
      : `**FAIL** — ${!vitestResult.passed ? 'vitest suite failed. ' : ''}${harnessFailCount > 0 ? `${harnessFailCount} harness(es) failed or timed out. ` : ''}See sections above for detail.`
  );
  lines.push('');

  return lines.join('\n');
}

async function main() {
  const date = nowStamp();
  const git = gitInfo();

  if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });

  // 1. vitest — the backbone.
  const vitestResult = await runVitest();

  // 2. Headless Electron harnesses — sequential, own timeout each.
  reapStrayElectron();
  const harnessResults = [];
  for (const name of HARNESSES_TO_RUN) {
    const entry = path.join(spikeDir, name);
    if (!existsSync(entry)) {
      harnessResults.push({ name, status: 'FAIL', code: -1, duration: 0, tail: `harness file not found: ${entry}` });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const result = await runHarness(name);
    harnessResults.push(result);
  }
  reapStrayElectron();

  const harnessAllPassed = harnessResults.every((h) => h.status === 'PASS');
  const overallPass = vitestResult.passed && harnessAllPassed;

  const report = renderReport({ date, git, vitestResult, harnessResults, overallPass });
  const reportFile = path.join(reportDir, `electron-e2e-${date}.md`);
  writeFileSync(reportFile, report, 'utf8');

  console.log('\n[e2e-report] ── final summary ──');
  console.log(`  vitest: ${vitestResult.passed ? 'PASS' : 'FAIL'} — ${vitestResult.testsSummary ? vitestResult.testsSummary.raw : 'unparsed'} (${fmtMs(vitestResult.duration)})`);
  for (const h of harnessResults) {
    console.log(`  ${h.status === 'PASS' ? '✓' : '✗'} ${h.name}: ${h.status} (exit=${h.code}, ${fmtMs(h.duration)})`);
  }
  console.log(`  skipped: ${HARNESSES_SKIPPED.map((s) => s.name).join(', ')}`);
  console.log(`[e2e-report] report written to ${reportFile}`);
  console.log(`[e2e-report] ${overallPass ? 'PASS' : 'FAIL'}\n`);

  process.exit(overallPass ? 0 : 1);
}

main();
