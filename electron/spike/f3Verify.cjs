/**
 * F3 "command execution" verification — plain Node (no Electron app/window
 * needed: commandDispatch(app, cmd, args) never touches `app` for
 * run_shell_command/run_argv_command/get_env_vars, so this exercises the
 * REAL electron/commandHost.cjs module directly, same code path tauriHost.cjs
 * wires up).
 *
 * Checks 1-5 are functional parity checks against the Tauri contract
 * (src-tauri/src/lib.rs). Check 6 is the SECURITY assertion this port exists
 * for: proves the macOS seatbelt (sandbox-exec) is actually confining reads,
 * not a no-op passthrough — a naive child_process port would pass checks 1-5
 * while silently failing 6.
 *
 * Run: node electron/spike/f3Verify.cjs
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { commandDispatch } = require('../commandHost.cjs');

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`[f3-verify] ${pass ? 'PASS' : 'FAIL'} — ${name}${detail ? ' — ' + detail : ''}`);
}

async function main() {
  // ── 1. sandboxed echo ──
  const r1 = await commandDispatch(null, 'run_shell_command', {
    command: 'echo hello',
    cwd: null,
    background: false,
    timeout: 10,
    sandboxEnabled: true,
  });
  check(
    '1. sandboxed echo hello',
    r1.stdout.includes('hello') && r1.code === 0,
    `stdout=${JSON.stringify(r1.stdout)} code=${r1.code} stderr=${JSON.stringify(r1.stderr.slice(0, 300))}`
  );

  // ── 2. cwd is honored ──
  const cwdDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'f3-verify-cwd-')));
  const r2 = await commandDispatch(null, 'run_shell_command', {
    command: 'pwd',
    cwd: cwdDir,
    background: false,
    timeout: 10,
    sandboxEnabled: true,
  });
  const pwdOut = r2.stdout.trim();
  const cwdMatches = pwdOut === cwdDir || fs.existsSync(pwdOut) && fs.realpathSync(pwdOut) === cwdDir;
  check('2. cwd honored', cwdMatches, `expected=${cwdDir} got=${JSON.stringify(pwdOut)} code=${r2.code}`);

  // ── 3. timeout kills a hanging command instead of a 5s hang ──
  const t0 = Date.now();
  const r3 = await commandDispatch(null, 'run_shell_command', {
    command: 'sleep 5',
    cwd: null,
    background: false,
    timeout: 1,
    sandboxEnabled: true,
  });
  const elapsedMs = Date.now() - t0;
  check(
    '3. timeout kills hanging command',
    elapsedMs < 4000 && r3.code !== 0 && /timed out/i.test(r3.stderr),
    `elapsedMs=${elapsedMs} code=${r3.code} stderr=${JSON.stringify(r3.stderr.slice(0, 200))}`
  );

  // ── 4. run_argv_command (no shell parsing) ──
  const r4 = await commandDispatch(null, 'run_argv_command', {
    program: 'echo',
    args: ['world'],
    timeout: 10,
    sandboxEnabled: true,
  });
  check('4. run_argv_command echo world', r4.stdout.includes('world') && r4.code === 0, `stdout=${JSON.stringify(r4.stdout)} code=${r4.code}`);

  // ── 5. get_env_vars whitelist filtering ──
  const SECRET_VAR = 'F3_VERIFY_TOTALLY_SECRET_TOKEN';
  process.env[SECRET_VAR] = 'should-never-leak';
  process.env.ABU_F3_VERIFY_TEST = 'allowed-value';
  const r5 = await commandDispatch(null, 'get_env_vars', {
    names: [SECRET_VAR, 'ABU_F3_VERIFY_TEST', 'HOME'],
  });
  delete process.env[SECRET_VAR];
  delete process.env.ABU_F3_VERIFY_TEST;
  const secretAbsent = !(SECRET_VAR in r5);
  const allowedPresent = r5.ABU_F3_VERIFY_TEST === 'allowed-value' && typeof r5.HOME === 'string';
  check('5. get_env_vars whitelist', secretAbsent && allowedPresent, `result=${JSON.stringify(r5)}`);

  // ── 6. SECURITY: seatbelt actually blocks a denylisted read path, while an
  // allowed path still reads fine — proves the sandbox is live, not a no-op. ──
  const home = os.homedir();
  const sensitiveDir = path.join(home, '.password-store');
  const sensitiveFile = path.join(sensitiveDir, 'f3-verify-secret.txt');
  const secretMarker = 'F3-VERIFY-SUPER-SECRET-MARKER';
  const createdSensitiveDir = !fs.existsSync(sensitiveDir);
  let securityCheckError = null;
  let r6blocked = null;
  let r6allowed = null;
  try {
    fs.mkdirSync(sensitiveDir, { recursive: true });
    fs.writeFileSync(sensitiveFile, `${secretMarker}\n`);

    r6blocked = await commandDispatch(null, 'run_shell_command', {
      command: `cat "${sensitiveFile}"`,
      cwd: null,
      background: false,
      timeout: 10,
      sandboxEnabled: true,
    });

    // Allowed comparison: same `cat`, same sandbox, but the file lives in the
    // sandboxed cwd (always writable+readable) instead of the denylist.
    const allowedDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'f3-verify-allowed-')));
    const allowedFile = path.join(allowedDir, 'ok.txt');
    fs.writeFileSync(allowedFile, `${secretMarker}-ALLOWED\n`);
    r6allowed = await commandDispatch(null, 'run_shell_command', {
      command: `cat "${allowedFile}"`,
      cwd: allowedDir,
      background: false,
      timeout: 10,
      sandboxEnabled: true,
    });
  } catch (e) {
    securityCheckError = e instanceof Error ? e.message : String(e);
  } finally {
    try {
      fs.rmSync(sensitiveFile, { force: true });
      if (createdSensitiveDir) fs.rmSync(sensitiveDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }

  const blockedOk =
    r6blocked && !r6blocked.stdout.includes(secretMarker) && (r6blocked.code !== 0 || /sandbox-blocked|operation not permitted/i.test(r6blocked.stderr));
  const allowedOk = r6allowed && r6allowed.stdout.includes(`${secretMarker}-ALLOWED`) && r6allowed.code === 0;
  check(
    '6. SECURITY: sensitive path read blocked, allowed path read succeeds',
    !securityCheckError && blockedOk && allowedOk,
    securityCheckError
      ? `harness error: ${securityCheckError}`
      : `blocked: code=${r6blocked.code} stdout=${JSON.stringify(r6blocked.stdout)} stderr=${JSON.stringify(r6blocked.stderr.slice(0, 300))} | allowed: code=${r6allowed.code} stdout=${JSON.stringify(r6allowed.stdout)}`
  );

  const allPassed = results.every((r) => r.pass);
  console.log(`[f3-verify] PASSED = ${allPassed}`);
  process.exit(allPassed ? 0 : 1);
}

main().catch((e) => {
  console.error('[f3-verify] harness crashed:', e);
  console.log('[f3-verify] PASSED = false');
  process.exit(1);
});
