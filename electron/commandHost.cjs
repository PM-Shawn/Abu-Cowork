/**
 * Electron main-side command-execution host — port of the Tauri
 * `run_shell_command` / `run_argv_command` / `get_env_vars` commands
 * (src-tauri/src/lib.rs) PLUS the macOS Seatbelt (sandbox-exec) integration
 * that wraps every sandboxed invocation (src-tauri/src/sandbox.rs).
 *
 * These three commands are the agent's core command-execution path — used by
 * ~15 frontend call sites (commandTools.ts, fileTools.ts, toolHelpers.ts,
 * skill/preprocessor.ts, mcp/client.ts, computerTools.ts). The Tauri version
 * wraps EVERY command in a macOS seatbelt sandbox via `sandbox-exec` (a macOS
 * SYSTEM binary — no native dep needed) unless the caller explicitly passes
 * `sandboxEnabled: false`. A naive child_process port would silently run
 * agent commands UNCONFINED — this file exists specifically to not do that.
 *
 * Argument-name contract (verified against actual frontend call sites, not
 * the Rust parameter names): Tauri's `invoke()` auto-converts camelCase JS
 * keys to the snake_case Rust parameter names (e.g. `allowPrivateNetworks` ->
 * `allow_private_networks`); Electron's raw IPC does no such conversion. So
 * this dispatcher reads the CAMELCASE keys the frontend actually sends
 * (`sandboxEnabled`, `extraWritablePaths`, `networkIsolation`) — matching,
 * byte for byte, what reaches the Rust side today. Two call sites
 * (skill/preprocessor.ts, skill/skillHooks.ts) pass `sandbox`/
 * `extra_writable_paths` (wrong casing / not a real param name) — those keys
 * don't match on the Tauri side either (silently ignored, falling back to
 * defaults), so reading only the camelCase names here reproduces the exact
 * same (accidental) behavior rather than "fixing" a pre-existing quirk.
 *
 * Wired from electron/tauriHost.cjs via commandDispatch(app, cmd, args) —
 * see the wiring comment there for the dispatch-order slot.
 */
'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { resourceRoot, REPO_ROOT } = require('./appEnv.cjs');
const {
  resolveBundledProgram,
  runtimeLayout,
  withBundledRuntimeEnv,
} = require('./runtimeResolver.cjs');
const { runtimeState } = require('./runtimeObservability.cjs');

// ── Seatbelt (SBPL) profile generation — line-for-line port of
// src-tauri/src/sandbox.rs's generate_seatbelt_profile() ──

/**
 * Sensitive paths under $HOME that should never be readable.
 * Maintained independently from TS pathSafety.ts (defense in depth).
 * IDENTICAL to sandbox.rs's SENSITIVE_READ_PATHS — do not let these drift.
 */
const SENSITIVE_READ_PATHS = [
  '.ssh',
  '.gnupg',
  '.gpg',
  '.aws/credentials',
  '.azure',
  '.config/gcloud',
  '.env',
  '.env.local',
  '.env.production',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.docker/config.json',
  '.kube/config',
  '.git-credentials',
  '.password-store',
  'Library/Keychains',
];

/** Escape special characters in path strings for SBPL (matches sandbox.rs's escape_sbpl_path). */
function escapeSbplPath(p) {
  return p.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Generate a Seatbelt Profile Language (SBPL) configuration string.
 * Whitelist model — `(deny default)` base with explicit allows. Port of
 * sandbox.rs's `generate_seatbelt_profile` — every line below corresponds to
 * the same-order `profile.push_str(...)` call in the Rust source.
 *
 * @param {string | null | undefined} cwd
 * @param {string[]} extraWritablePaths
 * @param {string} homeDir
 * @param {number | undefined} networkProxyPort
 */
function generateSeatbeltProfile(cwd, extraWritablePaths, homeDir, networkProxyPort) {
  let profile = '';

  // ── Base: deny everything by default ──
  profile += '(version 1)\n';
  profile += '(deny default)\n\n';

  // ── Process operations ──
  profile += ';; Process operations\n';
  profile += '(allow process*)\n';
  // Shell sandbox protects file paths, but an Apple Event asks another
  // unsandboxed app to perform the mutation. Deny the system AppleScript
  // interpreter at the kernel policy boundary so shell wrappers, variables,
  // eval, and nested interpreters cannot bypass the renderer preflight.
  profile += '(deny process-exec (literal "/usr/bin/osascript"))\n';
  profile += '(allow signal)\n\n';

  // ── Mach IPC ──
  profile += ';; Mach IPC (required by most macOS programs)\n';
  profile += '(allow mach*)\n\n';
  // Apple Events let a sandboxed command ask another application to mutate
  // data on its behalf. Keep that channel closed even if an alternate script
  // interpreter or a renamed executable avoids the path-specific deny above.
  profile += '(deny appleevent-send)\n\n';

  // ── System info ──
  profile += ';; System info queries\n';
  profile += '(allow sysctl*)\n\n';

  // ── POSIX IPC ──
  profile += ';; POSIX IPC (pipes, shared memory, semaphores)\n';
  profile += '(allow ipc-posix*)\n';
  profile += '(allow ipc-sysv*)\n\n';

  // ── Pseudo-TTY ──
  profile += ';; Terminal operations\n';
  profile += '(allow pseudo-tty)\n\n';

  // ── Network ──
  if (networkProxyPort != null) {
    profile += ';; Network: isolated — only localhost allowed (proxy)\n';
    profile += '(deny network-outbound)\n';
    profile += '(allow network-outbound (remote ip "localhost:*"))\n';
    profile += '(allow network-inbound)\n';
    profile += '(allow system-socket)\n\n';
  } else {
    profile += ';; Network: unrestricted\n';
    profile += '(allow network*)\n\n';
  }

  // ── File reads: broadly allow, then deny sensitive paths ──
  profile += ';; File reads: allow most, deny sensitive paths\n';
  profile += '(allow file-read*)\n';
  // Prevent copying the denied interpreter to a writable path and executing
  // it under another name.
  profile += '(deny file-read* (literal "/usr/bin/osascript"))\n';
  for (const sensitive of SENSITIVE_READ_PATHS) {
    const fullPath = `${homeDir}/${sensitive}`;
    const escaped = escapeSbplPath(fullPath);
    profile += `(deny file-read* (subpath "${escaped}"))\n`;
  }
  profile += '\n';

  // ── File writes: deny by default (from deny default), allow specific ──
  profile += ';; File writes: only specific directories\n';
  profile += '(allow file-write* (subpath "/tmp"))\n';
  profile += '(allow file-write* (subpath "/private/tmp"))\n';
  profile += '(allow file-write* (subpath "/dev"))\n';
  profile += '(allow file-write* (subpath "/private/var"))\n';

  // CWD — the working directory is writable
  if (cwd) {
    const escaped = escapeSbplPath(cwd);
    profile += `(allow file-write* (subpath "${escaped}"))\n`;
  }

  // Extra writable paths (e.g. process_image output directory)
  for (const p of extraWritablePaths || []) {
    if (p) {
      const escaped = escapeSbplPath(p);
      profile += `(allow file-write* (subpath "${escaped}"))\n`;
    }
  }

  // ── File ioctl (some programs need this) ──
  profile += '\n;; File ioctl\n';
  profile += '(allow file-ioctl)\n';

  return profile;
}

/** Proxy env vars injected when network isolation is active (port of both build_sandboxed_* fns). */
function proxyEnvVars(networkProxyPort) {
  if (networkProxyPort == null) return {};
  const proxyUrl = `http://127.0.0.1:${networkProxyPort}`;
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    ALL_PROXY: proxyUrl,
    NO_PROXY: 'localhost,127.0.0.1,::1',
    no_proxy: 'localhost,127.0.0.1,::1',
  };
}

/**
 * Build a shell-command spawn spec, sandboxed via sandbox-exec on macOS.
 * Port of sandbox.rs's `build_sandboxed_command`.
 *
 * macOS + sandboxEnabled: `sandbox-exec -p <profile> <shell> -lc <command>`
 * (NOTE: no `--` separator here — matches the Rust source exactly; `--` is
 * only used by the argv variant below).
 *
 * Windows parity: sandboxEnabled=true runs PowerShell in ConstrainedLanguage
 * mode with ExecutionPolicy Restricted as defense in depth. The launcher also
 * applies a restricted primary token and owns the tree through a Job Object.
 */
function buildSandboxedCommandSpec(command, cwd, extraWritablePaths, sandboxEnabled, networkProxyPort, platform = process.platform) {
  const env = proxyEnvVars(networkProxyPort);

  if (platform === 'darwin' && sandboxEnabled) {
    const homeDir = os.homedir() || '/tmp';
    const profile = generateSeatbeltProfile(cwd, extraWritablePaths, homeDir, networkProxyPort);
    const shell = process.env.SHELL || '/bin/zsh';
    return { file: 'sandbox-exec', args: ['-p', profile, shell, '-lc', command], env };
  }

  if (platform === 'win32') {
    if (sandboxEnabled) {
      return {
        file: 'powershell',
        args: [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Restricted',
          '-Command',
          `$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'; ${command}`,
        ],
        env,
      };
    }
    return { file: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', command], env };
  }

  // Linux, or macOS without sandbox: plain shell, no sandbox-exec wrapper.
  const shell = process.env.SHELL || '/bin/zsh';
  return { file: shell, args: ['-lc', command], env };
}

/**
 * Build an argv-array spawn spec (no shell parsing), sandboxed via
 * sandbox-exec on macOS. Port of sandbox.rs's `build_sandboxed_argv_command`.
 *
 * macOS + sandboxEnabled: `sandbox-exec -p <profile> -- <program> <args...>`
 * (the `--` separates sandbox-exec's own flags from the target argv so a
 * program name starting with `-` cannot be misinterpreted — matches Rust).
 */
function buildSandboxedArgvCommandSpec(program, args, cwd, extraWritablePaths, sandboxEnabled, networkProxyPort, platform = process.platform) {
  const env = proxyEnvVars(networkProxyPort);

  if (platform === 'darwin' && sandboxEnabled) {
    const homeDir = os.homedir() || '/tmp';
    const profile = generateSeatbeltProfile(cwd, extraWritablePaths, homeDir, networkProxyPort);
    return { file: 'sandbox-exec', args: ['-p', profile, '--', program, ...args], env };
  }

  // Windows, Linux, or macOS-without-sandbox: spawn the target directly —
  // no intermediate shell, so arguments are always literal (matches Rust).
  return { file: program, args: [...args], env };
}

// ── Sandbox-violation annotation — port of lib.rs's annotate_sandbox_violations ──

function annotateSandboxViolations(stderr, command, sandboxEnabled) {
  const s = stderr || '';
  if (!sandboxEnabled || s.length === 0) return s;

  const lower = s.toLowerCase();
  const reasons = [];

  if (lower.includes('operation not permitted')) {
    if (
      lower.includes('read') ||
      command.includes('cat ') ||
      command.includes('less ') ||
      command.includes('head ') ||
      command.includes('tail ')
    ) {
      reasons.push('file read blocked by sandbox policy');
    } else {
      reasons.push('file write or network access blocked by sandbox policy');
    }
  }

  if (lower.includes('could not resolve host')) {
    reasons.push('DNS resolution blocked — network isolation is active');
  }
  if (lower.includes('sandbox-network-blocked')) {
    reasons.push('domain not in network whitelist');
  }
  if (lower.includes('permission denied') && !lower.includes('sudo')) {
    reasons.push('access denied — possibly blocked by sandbox policy');
  }

  if (reasons.length === 0) return s;
  return `[sandbox-blocked] ${reasons.join('; ')}\n\n${s}`;
}

// ── PATH resolution — macOS/Linux desktop apps launched from Finder/Dock
// don't inherit the terminal's full PATH (no Homebrew/nvm/etc.), so
// commands like npx/python/node can't be found. Resolve once via the login
// shell, same rationale as lib.rs's get_login_shell_path (and this repo's
// existing electron/mcpBridge.cjs loginShellPath(), which does the same for
// MCP server spawns) — kept as a lighter port (no marker-based extraction, no
// nvm-glob fallback) since PATH correctness, not fidelity to every Rust
// fallback branch, is what matters here. NOT implemented for Windows (see
// report) — get_enhanced_path_windows reads the user registry PATH, which
// this port does not attempt.
let _cachedEnhancedPath;
function getEnhancedPath() {
  if (process.platform === 'win32') return undefined;
  if (_cachedEnhancedPath !== undefined) return _cachedEnhancedPath;
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const out = execFileSync(shell, ['-ilc', 'echo -n "$PATH"'], {
      encoding: 'utf8',
      timeout: 8000,
    });
    _cachedEnhancedPath = out && out.trim() ? out.trim() : process.env.PATH || '';
  } catch {
    _cachedEnhancedPath = process.env.PATH || '';
  }
  return _cachedEnhancedPath;
}

function bundledRuntimeEnv(app) {
  const baseEnv = { ...process.env };
  const enhancedPath = getEnhancedPath();
  if (enhancedPath) baseEnv.PATH = enhancedPath;
  return withBundledRuntimeEnv(app, baseEnv);
}

function quotePosixShell(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function quotePowerShellLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * PowerShell does not expose the bundled python.exe under the Unix-style
 * `python3` aliases. Rewrite only the command's first, bare executable token;
 * explicit paths and later pipeline/statement tokens remain untouched.
 */
function rewriteWindowsBundledPythonCommand(app, command, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32') return command;
  const match = /^(\s*)(?:&\s*)?(python(?:3(?:\.\d+)?)?|py)(?:\.(?:exe|cmd))?(?=\s|$)/i.exec(command);
  if (!match) return command;
  const resolved = resolveBundledProgram(app, match[2], [], { ...options, platform });
  if (!resolved.bundled || resolved.runtime !== 'python') return command;
  let remainder = command.slice(match[0].length);
  // `py -3` / `py -3.12` use a launcher-only interpreter selector. Once the
  // command is bound to Abu's bundled Python executable the selector must be
  // consumed; CPython itself treats `-3.12` as an invalid option.
  if (/^py$/i.test(match[2])) {
    const selector = /^\s+-3(?:\.\d+)?(?=\s|$)/i.exec(remainder);
    if (selector) {
      const afterSelector = remainder.slice(selector[0].length).trimStart();
      remainder = afterSelector ? ` ${afterSelector}` : '';
    }
  }
  return `${match[1]}& ${quotePowerShellLiteral(resolved.file)} -B${remainder}`;
}

function shellCommandWithBundledPath(app, command, options = {}) {
  const platform = options.platform || process.platform;
  if (platform === 'win32') return rewriteWindowsBundledPythonCommand(app, command, options);
  const layout = runtimeLayout(app, options);
  const prefix = [layout.node.binDir, layout.python.binDir]
    .filter((entry, index, entries) => entries.indexOf(entry) === index)
    .join(':');
  // A login shell can replace inherited PATH from .zprofile/.profile. Apply
  // Abu's prefix after shell startup so bare runtime commands stay deterministic.
  return `export PATH=${quotePosixShell(prefix)}:"$PATH"; ${command}`;
}

// ── Network proxy port threading (F14 not built yet) ──

/**
 * The running network-isolation proxy's port, or undefined if it hasn't been
 * started (F14, electron/networkProxy.cjs — port of proxy.rs). Mirrors Tauri's
 * proxy::get_proxy_port() returning None before start_network_proxy. When a
 * command runs with networkIsolation AND the proxy is up, the sandbox denies
 * all egress except localhost and points HTTP(S)_PROXY at this port, so the
 * command can only reach whitelisted hosts. Lazy require avoids any load-order
 * coupling (networkProxy.cjs depends on nothing here).
 */
function getNetworkProxyPort() {
  const port = require('./networkProxy.cjs').getProxyPort();
  return port == null ? undefined : port;
}

// ── Foreground / background process execution ──

const MAX_OUTPUT_BUF_CHARS = 2_000_000; // ~2M chars per stream; generous cap against runaway output
const COMMAND_MISS = Symbol('command-dispatch-miss');
const activeCommands = new Map();
let commandSeq = 0;
let lifecycleHooksRegistered = false;

function makeCappedCollector() {
  const state = { buf: '', truncated: false };
  return {
    push(chunkStr) {
      if (state.truncated) return;
      state.buf += chunkStr;
      if (state.buf.length > MAX_OUTPUT_BUF_CHARS) {
        state.buf = state.buf.slice(0, MAX_OUTPUT_BUF_CHARS) + '\n[truncated: output too large]';
        state.truncated = true;
      }
    },
    get value() {
      return state.buf;
    },
  };
}

/**
 * Resolve the one-shot launcher. Dev builds use the copied dist/<platform>
 * binary from `npm run build:sandbox-launcher`; packaged builds use
 * extraResources under process.resourcesPath.
 */
function sandboxLauncherPathFor(app) {
  const exe = process.platform === 'win32' ? 'sandbox-launcher.exe' : 'sandbox-launcher';
  const packaged = path.join(resourceRoot(app), 'sandbox-launcher', process.platform, exe);
  if (app?.isPackaged || fs.existsSync(packaged)) return packaged;
  const devDist = path.join(REPO_ROOT, 'electron', 'sandbox-launcher', 'dist', process.platform, exe);
  if (fs.existsSync(devDist)) return devDist;
  return path.join(REPO_ROOT, 'electron', 'sandbox-launcher', 'target', 'release', exe);
}

function makeLauncherConfig(spec, sandboxEnabled) {
  return {
    file: spec.file,
    args: spec.args,
    sandboxEnabled: sandboxEnabled === true,
    // stdin remains open after this newline-delimited frame. If Electron is
    // killed or crashes, the OS closes the pipe and the native launcher tears
    // down its process group / Job Object without relying on JavaScript hooks.
    monitorParent: true,
    // Also bind the launcher directly to Electron's main-process PID. This is
    // an independent native liveness signal on Windows, where another process
    // can briefly retain a duplicated pipe handle after abrupt termination.
    parentPid: process.pid,
  };
}

function makeCommandId(prefix = 'cmd') {
  commandSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${commandSeq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function addActiveCommand(entry) {
  let set = activeCommands.get(entry.commandId);
  if (!set) {
    set = new Set();
    activeCommands.set(entry.commandId, set);
  }
  set.add(entry);
}

function removeActiveCommand(entry) {
  const set = activeCommands.get(entry.commandId);
  if (!set) return;
  set.delete(entry);
  if (set.size === 0) activeCommands.delete(entry.commandId);
}

function unixDescendantPids(rootPid) {
  if (process.platform === 'win32' || !Number.isInteger(rootPid) || rootPid <= 0) return [];
  try {
    const rows = execFileSync('/bin/ps', ['-A', '-o', 'pid=', '-o', 'ppid='], {
      encoding: 'utf8',
      timeout: 2000,
    });
    const childrenByParent = new Map();
    for (const line of rows.split('\n')) {
      const match = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const ppid = Number(match[2]);
      let children = childrenByParent.get(ppid);
      if (!children) {
        children = [];
        childrenByParent.set(ppid, children);
      }
      children.push(pid);
    }

    const descendants = [];
    const visit = (pid) => {
      for (const childPid of childrenByParent.get(pid) || []) {
        visit(childPid);
        descendants.push(childPid);
      }
    };
    visit(rootPid);
    return descendants;
  } catch {
    return [];
  }
}

function killProcessTree(entry, signal = 'SIGKILL') {
  if (!entry || entry.killed || entry.completed) return;
  entry.killed = true;
  const child = entry.child;
  // A descendant can create a new Unix session/process group while retaining
  // this launcher as an ancestor. Kill those deepest-first before the normal
  // process-group signal. Deliberate double-fork daemonization can re-parent
  // before it is observed and remains unsupported.
  for (const pid of unixDescendantPids(child.pid)) {
    try {
      process.kill(pid, signal);
    } catch {
      /* descendant may already have exited */
    }
  }

  // Closing the launcher's stdin is the cross-platform lifecycle signal. The
  // launcher owns the target process group / Job Object and performs the real
  // tree termination. This also works automatically when Electron is SIGKILLed
  // because the OS closes the same pipe.
  try {
    child.stdin?.destroy();
  } catch {
    /* best-effort */
  }

  // A broken native launcher must not remain forever. Give its liveness
  // watcher time to close the owned tree, then force only the launcher group.
  entry.forceKillTimer = setTimeout(() => {
    try {
      if (process.platform !== 'win32' && child.pid) {
        process.kill(-child.pid, signal);
        return;
      }
    } catch {
      // Fall through to direct-child kill below.
    }
    try {
      child.kill(signal);
    } catch {
      /* best-effort */
    }
  }, 2000);
  entry.forceKillTimer.unref?.();
}

function abortCommand(commandId) {
  if (typeof commandId !== 'string' || commandId.length === 0) return false;
  const set = activeCommands.get(commandId);
  if (!set || set.size === 0) return false;
  for (const entry of Array.from(set)) killProcessTree(entry);
  return true;
}

function teardownCommandHost() {
  for (const set of Array.from(activeCommands.values())) {
    for (const entry of Array.from(set)) killProcessTree(entry);
  }
}

function ensureCommandHostLifecycleHooks(app) {
  if (lifecycleHooksRegistered) return;
  lifecycleHooksRegistered = true;
  const cleanup = () => teardownCommandHost();
  process.once('exit', cleanup);
  app?.once?.('before-quit', cleanup);
}

function __resetCommandHostForTests() {
  teardownCommandHost();
  activeCommands.clear();
}

/**
 * Spawn a prepared command spec through the sandbox-launcher, honoring a
 * timeout, and resolve with {stdout, stderr, code}. The launcher is the
 * process-tree root: Unix gets a detached process group, Windows gets a Job
 * Object with KILL_ON_JOB_CLOSE inside the launcher.
 */
function spawnForeground(app, spec, opts, timeoutSecs, commandId) {
  return new Promise((resolve) => {
    const { file, args, env } = spec;
    const launcherPath = sandboxLauncherPathFor(app);
    const spawnEnv = { ...process.env, ...(env || {}), ...(opts.envOverride || {}) };

    let child;
    try {
      child = spawn(launcherPath, [], {
        cwd: opts.cwd || undefined,
        env: spawnEnv,
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch (e) {
      resolve({ stdout: '', stderr: `Failed to spawn command: ${e instanceof Error ? e.message : String(e)}`, code: -1 });
      return;
    }

    const entry = { commandId, child, completed: false, killed: false, forceKillTimer: null };
    addActiveCommand(entry);

    const stdoutC = makeCappedCollector();
    const stderrC = makeCappedCollector();
    child.stdout?.on('data', (chunk) => stdoutC.push(chunk.toString('utf8')));
    child.stderr?.on('data', (chunk) => stderrC.push(chunk.toString('utf8')));
    child.stdin?.on('error', () => {});
    child.stdin?.write(`${JSON.stringify(makeLauncherConfig({ file, args }, opts.sandboxEnabled))}\n`);

    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(entry);
    }, timeoutSecs * 1000);

    const finish = (code) => {
      if (settled) return;
      settled = true;
      entry.completed = true;
      removeActiveCommand(entry);
      clearTimeout(timer);
      if (entry.forceKillTimer) clearTimeout(entry.forceKillTimer);
      if (timedOut) {
        resolve({
          stdout: stdoutC.value,
          stderr: `${stderrC.value}\n[Command timed out after ${timeoutSecs}s and was killed]`,
          code: -1,
        });
      } else {
        resolve({ stdout: stdoutC.value, stderr: stderrC.value, code: code ?? -1 });
      }
    };

    child.once('error', (e) => {
      if (settled) return;
      settled = true;
      entry.completed = true;
      removeActiveCommand(entry);
      clearTimeout(timer);
      if (entry.forceKillTimer) clearTimeout(entry.forceKillTimer);
      resolve({ stdout: stdoutC.value, stderr: stderrC.value || String(e.message || e), code: -1 });
    });
    child.once('close', (code) => finish(code));
  });
}

/**
 * Spawn a prepared command spec in "background" mode: wait up to 3s
 * collecting initial output OR until the process exits early, then return —
 * keeping the process tracked for abort_command/app teardown if still alive.
 * The 3s return semantics and placeholder string match Tauri.
 */
function spawnBackground(app, spec, opts, commandId) {
  return new Promise((resolve) => {
    const { file, args, env } = spec;
    const launcherPath = sandboxLauncherPathFor(app);
    const spawnEnv = { ...process.env, ...(env || {}), ...(opts.envOverride || {}) };

    let child;
    try {
      child = spawn(launcherPath, [], {
        cwd: opts.cwd || undefined,
        env: spawnEnv,
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch (e) {
      resolve({ stdout: '', stderr: `Failed to spawn command: ${e instanceof Error ? e.message : String(e)}`, code: -1 });
      return;
    }

    const entry = { commandId, child, completed: false, killed: false, forceKillTimer: null };
    addActiveCommand(entry);

    const stdoutC = makeCappedCollector();
    const stderrC = makeCappedCollector();
    child.stdout?.on('data', (chunk) => stdoutC.push(chunk.toString('utf8')));
    child.stderr?.on('data', (chunk) => stderrC.push(chunk.toString('utf8')));
    child.stdin?.on('error', () => {});
    child.stdin?.write(`${JSON.stringify(makeLauncherConfig({ file, args }, opts.sandboxEnabled))}\n`);

    let settled = false;

    const waitTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const stdoutResult = stdoutC.value;
      const stderrResult = stderrC.value;
      resolve({
        stdout: stdoutResult.trim() === '' && stderrResult.trim() === '' ? '服务已在后台启动' : stdoutResult,
        stderr: stderrResult,
        code: 0, // process is still running; 0 = "started successfully" (matches Rust)
      });
      // Deliberately NOT killed — the process continues running in the
      // background (matches Tauri semantics). It remains in activeCommands so
      // abort_command/teardownCommandHost can terminate the whole tree.
    }, 3000);

    child.once('error', (e) => {
      if (settled) return;
      settled = true;
      entry.completed = true;
      removeActiveCommand(entry);
      clearTimeout(waitTimer);
      if (entry.forceKillTimer) clearTimeout(entry.forceKillTimer);
      resolve({ stdout: stdoutC.value, stderr: stderrC.value || String(e.message || e), code: -1 });
    });
    child.once('close', (code) => {
      entry.completed = true;
      removeActiveCommand(entry);
      if (entry.forceKillTimer) clearTimeout(entry.forceKillTimer);
      if (settled) return;
      settled = true;
      clearTimeout(waitTimer);
      resolve({ stdout: stdoutC.value, stderr: stderrC.value, code: code ?? -1 });
    });
  });
}

// ── run_shell_command / run_argv_command ──

async function runShellCommand(app, args) {
  ensureCommandHostLifecycleHooks(app);
  const a = args || {};
  const command = String(a.command ?? '');
  const cwd = typeof a.cwd === 'string' && a.cwd ? a.cwd : undefined;
  const isBackground = !!a.background;
  const timeoutSecs = Math.min(Math.max(1, Number(a.timeout ?? 30) || 30), 300); // default 30s, max 300s
  const commandId = typeof a.commandId === 'string' && a.commandId ? a.commandId : makeCommandId('shell');
  const sandboxEnabled = a.sandboxEnabled !== false; // unwrap_or(true)
  const extraWritablePaths = Array.isArray(a.extraWritablePaths) ? a.extraWritablePaths : [];
  const networkIsolation = !!a.networkIsolation;
  const networkProxyPort = networkIsolation ? getNetworkProxyPort() : undefined;

  const runtimeCommand = shellCommandWithBundledPath(app, command);
  const spec = buildSandboxedCommandSpec(
    runtimeCommand,
    cwd,
    extraWritablePaths,
    sandboxEnabled,
    networkProxyPort,
  );
  const envOverride = bundledRuntimeEnv(app);

  const startedAt = Date.now();
  const result = isBackground
    ? await spawnBackground(app, spec, { cwd, envOverride, sandboxEnabled }, commandId)
    : await spawnForeground(app, spec, { cwd, envOverride, sandboxEnabled }, timeoutSecs, commandId);
  // The observability layer redacts and truncates `command` (see
  // runtimeObservability's sanitizeAttributes) — pass the raw caller command.
  runtimeState.noteCommandFinished({
    command,
    exitCode: result.code,
    durationMs: Date.now() - startedAt,
    sandboxEnabled,
    executionPath: isBackground ? 'background' : 'foreground',
  });

  return {
    stdout: result.stdout,
    stderr: annotateSandboxViolations(result.stderr, command, sandboxEnabled),
    code: result.code,
  };
}

/** No background mode: argv tools are always foreground with a timeout (matches Rust). */
async function runArgvCommand(app, args) {
  ensureCommandHostLifecycleHooks(app);
  const a = args || {};
  const program = String(a.program ?? '');
  const argv = Array.isArray(a.args) ? a.args.map(String) : [];
  const cwd = typeof a.cwd === 'string' && a.cwd ? a.cwd : undefined;
  const timeoutSecs = Math.min(Math.max(1, Number(a.timeout ?? 30) || 30), 300);
  const commandId = typeof a.commandId === 'string' && a.commandId ? a.commandId : makeCommandId('argv');
  const sandboxEnabled = a.sandboxEnabled !== false;
  const extraWritablePaths = Array.isArray(a.extraWritablePaths) ? a.extraWritablePaths : [];
  const networkIsolation = !!a.networkIsolation;
  const networkProxyPort = networkIsolation ? getNetworkProxyPort() : undefined;

  const resolved = resolveBundledProgram(app, program, argv);
  const spec = buildSandboxedArgvCommandSpec(
    resolved.file,
    resolved.args,
    cwd,
    extraWritablePaths,
    sandboxEnabled,
    networkProxyPort,
  );
  const envOverride = bundledRuntimeEnv(app);

  const startedAt = Date.now();
  const result = await spawnForeground(
    app,
    spec,
    { cwd, envOverride, sandboxEnabled },
    timeoutSecs,
    commandId
  );
  runtimeState.noteCommandFinished({
    command: [program, ...argv].join(' '),
    exitCode: result.code,
    durationMs: Date.now() - startedAt,
    sandboxEnabled,
    executionPath: 'foreground',
  });

  return {
    stdout: result.stdout,
    stderr: annotateSandboxViolations(result.stderr, program, sandboxEnabled),
    code: result.code,
  };
}

// ── get_env_vars ──

/**
 * Allowed environment variable name patterns for security.
 * IDENTICAL to lib.rs's ENV_VAR_ALLOWED_PREFIXES — do not let these drift.
 */
const ENV_VAR_ALLOWED_PREFIXES = [
  'HOME', 'USER', 'LANG', 'LC_', 'PATH', 'SHELL', 'TERM',
  'TMPDIR', 'XDG_',
  'NODE_', 'NPM_', 'NVM_', 'CARGO_', 'RUSTUP_', 'GOPATH', 'GOROOT',
  'JAVA_HOME', 'PYTHON', 'VIRTUAL_ENV', 'CONDA_',
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY',
  'GITHUB_TOKEN', 'GITHUB_PERSONAL_TOKEN', 'GH_TOKEN',
  'TAVILY_API_KEY', 'BRAVE_API_KEY', 'SERP_API_KEY',
  'FIRECRAWL_API_KEY', 'EXA_API_KEY', 'JINA_API_KEY',
  'ABU_', 'MCP_', 'CLAUDE_',
];

function isEnvVarAllowed(name) {
  return ENV_VAR_ALLOWED_PREFIXES.some((prefix) => {
    if (prefix.endsWith('_')) return name.startsWith(prefix);
    return name === prefix;
  });
}

function getEnvVars(args) {
  const names = Array.isArray((args || {}).names) ? args.names : [];
  const result = {};
  for (const name of names) {
    if (typeof name !== 'string' || !isEnvVarAllowed(name)) continue;
    const val = process.env[name];
    if (val !== undefined) result[name] = val;
  }
  return result;
}

// ── Dispatch ──

/**
 * @param {import('electron').App} app used to resolve packaged resources and
 *   register command-tree cleanup on application quit.
 * @param {string} cmd
 * @param {Record<string, unknown>} args
 */
async function commandDispatch(app, cmd, args) {
  switch (cmd) {
    case 'run_shell_command':
      return runShellCommand(app, args);
    case 'run_argv_command':
      return runArgvCommand(app, args);
    case 'abort_command':
      return abortCommand((args || {}).commandId);
    case 'get_env_vars':
      return getEnvVars(args);
    default:
      return COMMAND_MISS;
  }
}

module.exports = {
  commandDispatch,
  COMMAND_MISS,
  teardownCommandHost,
  // exported for the verify harness + potential reuse
  generateSeatbeltProfile,
  buildSandboxedCommandSpec,
  buildSandboxedArgvCommandSpec,
  makeLauncherConfig,
  annotateSandboxViolations,
  isEnvVarAllowed,
  SENSITIVE_READ_PATHS,
  ENV_VAR_ALLOWED_PREFIXES,
  __resetCommandHostForTests,
  unixDescendantPids,
  sandboxLauncherPathFor,
  rewriteWindowsBundledPythonCommand,
};
