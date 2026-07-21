/**
 * Automated acceptance harness (inner half) — runs UNDER Electron.
 *
 * Proves the slice-1 deliverable end-to-end, windowless (no BrowserWindow, so
 * an unattended overnight run never pops a window on the user's screen):
 *   1. supervisor.start() ⇒ sidecar spawns (pid captured)
 *   2. ping / echo / fs.readTextFile round-trip over the NDJSON bridge
 *   3. `kill -9` the sidecar ⇒ supervisor auto-revives it (new pid, ping ok)
 *   4. supervisor.stop() ⇒ child killed (graceful teardown)
 * Writes results/acceptance.json (incl. every sidecar pid it saw) and exits
 * 0/1. The OUTER half (scripts/electron-acceptance.mjs) then confirms none of
 * those pids survived the Electron process exit ⇒ no orphan.
 *
 * A hard overall timeout guarantees the unattended run can't hang.
 */
'use strict';

const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SidecarSupervisor } = require('./sidecarSupervisor.cjs');
const { resolveSidecarLaunch, sidecarBundleExists, SIDECAR_PATH } = require('./appEnv.cjs');

const RESULTS_DIR = path.join(__dirname, '..', 'electron-results');
const RESULT_FILE = path.join(RESULTS_DIR, 'acceptance.json');
const OVERALL_TIMEOUT_MS = 30_000;

const out = {
  startedAt: new Date().toISOString(),
  electron: process.versions.electron,
  node: process.versions.node,
  checks: {},
  pids: [],
  ok: false,
};

function log(level, msg, extra) {
  const line = `[acceptance:${level}] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`;
  (level === 'error' ? console.error : console.log)(line);
}

function finish(code) {
  out.finishedAt = new Date().toISOString();
  try {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    fs.writeFileSync(RESULT_FILE, JSON.stringify(out, null, 2));
  } catch (err) {
    log('error', 'failed to write result file', { error: String(err) });
  }
  log(out.ok ? 'info' : 'error', out.ok ? 'ACCEPTANCE PASS' : 'ACCEPTANCE FAIL');
  app.exit(code);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll until the supervisor has a running sidecar with a pid != avoidPid. */
async function waitForRunning(sup, avoidPid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = sup.getSidecarPid();
    if (sup.getStatus() === 'running' && pid && pid !== avoidPid) {
      try {
        await sup.request('ping', undefined, 2000);
        return pid;
      } catch {
        /* not ready yet */
      }
    }
    await sleep(150);
  }
  return null;
}

async function run() {
  if (!sidecarBundleExists()) {
    out.error = `sidecar bundle missing at ${SIDECAR_PATH} — run \`npm run build:sidecar\``;
    log('error', out.error);
    finish(1);
    return;
  }

  const sup = new SidecarSupervisor({ ...resolveSidecarLaunch(app), log });
  sup.start();

  // 1. start ⇒ running with a pid
  const pid1 = await waitForRunning(sup, null, 8000);
  out.checks.start = { ok: pid1 != null, pid: pid1 };
  if (pid1) out.pids.push(pid1);
  if (!pid1) {
    finish(1);
    return;
  }

  // 2. ping / echo / fs round-trip
  try {
    const pong = await sup.request('ping');
    out.checks.ping = { ok: !!pong && pong.pong === true, raw: pong };
  } catch (err) {
    out.checks.ping = { ok: false, error: String(err) };
  }

  try {
    const payload = { hello: 'electron-shell', n: 42, nested: { ok: true } };
    const echoed = await sup.request('echo', payload);
    out.checks.echo = { ok: JSON.stringify(echoed) === JSON.stringify(payload), raw: echoed };
  } catch (err) {
    out.checks.echo = { ok: false, error: String(err) };
  }

  try {
    const probe = path.join(os.tmpdir(), `abu-electron-p2-probe-${process.pid}.txt`);
    const content = `electron-shell-probe ${Date.now()}`;
    fs.writeFileSync(probe, content);
    const readBack = await sup.request('fs.readTextFile', { path: probe });
    out.checks.fs = { ok: readBack === content, raw: readBack };
    fs.rmSync(probe, { force: true });
  } catch (err) {
    out.checks.fs = { ok: false, error: String(err) };
  }

  // 3. kill -9 the sidecar ⇒ supervisor auto-revives
  try {
    process.kill(pid1, 'SIGKILL');
    log('info', 'sent SIGKILL to sidecar', { pid: pid1 });
    const pid2 = await waitForRunning(sup, pid1, 8000);
    if (pid2) out.pids.push(pid2);
    out.checks.killRevive = { ok: pid2 != null && pid2 !== pid1, killedPid: pid1, revivedPid: pid2 };
  } catch (err) {
    out.checks.killRevive = { ok: false, error: String(err) };
  }

  // 4. graceful teardown ⇒ child killed
  try {
    await sup.stop();
    out.checks.stop = { ok: sup.getSidecarPid() == null && sup.getStatus() === 'stopped' };
  } catch (err) {
    out.checks.stop = { ok: false, error: String(err) };
  }

  out.ok = Object.values(out.checks).every((c) => c.ok);
  finish(out.ok ? 0 : 1);
}

// Hard timeout so the unattended run can never hang.
setTimeout(() => {
  if (!out.finishedAt) {
    out.error = 'overall timeout';
    log('error', 'overall timeout — forcing FAIL');
    finish(1);
  }
}, OVERALL_TIMEOUT_MS).unref?.();

app.whenReady().then(run);
