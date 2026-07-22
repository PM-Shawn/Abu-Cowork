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
const { spawn, execFileSync } = require('node:child_process');

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
  profile += '(allow signal)\n\n';

  // ── Mach IPC ──
  profile += ';; Mach IPC (required by most macOS programs)\n';
  profile += '(allow mach*)\n\n';

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
 * DEVIATION from the Rust source: the Rust build_sandboxed_command ALSO
 * layers a weaker sandbox on Windows (PowerShell ConstrainedLanguage mode)
 * when sandbox_enabled is true. Per this port's explicit scope (macOS
 * seatbelt only), Windows/Linux always run unsandboxed here — see report.
 */
function buildSandboxedCommandSpec(command, cwd, extraWritablePaths, sandboxEnabled, networkProxyPort) {
  const env = proxyEnvVars(networkProxyPort);

  if (process.platform === 'darwin' && sandboxEnabled) {
    const homeDir = os.homedir() || '/tmp';
    const profile = generateSeatbeltProfile(cwd, extraWritablePaths, homeDir, networkProxyPort);
    const shell = process.env.SHELL || '/bin/zsh';
    return { file: 'sandbox-exec', args: ['-p', profile, shell, '-lc', command], env };
  }

  if (process.platform === 'win32') {
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
function buildSandboxedArgvCommandSpec(program, args, cwd, extraWritablePaths, sandboxEnabled, networkProxyPort) {
  const env = proxyEnvVars(networkProxyPort);

  if (process.platform === 'darwin' && sandboxEnabled) {
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

// ── Network proxy port threading (F14 not built yet) ──

/**
 * Always undefined for now — the network-isolation proxy (F14,
 * start_network_proxy / update_network_whitelist in the Rust source) hasn't
 * been ported to the Electron shell. This matches Tauri's own behavior
 * before a proxy has been started (proxy::get_proxy_port() returns None),
 * so `networkIsolation: true` today has no effect on either side until F14
 * lands — network is unrestricted. Structured as its own function so a real
 * proxy port can be threaded in later without touching call sites.
 */
function getNetworkProxyPort() {
  return undefined;
}

// ── Foreground / background process execution ──

const MAX_OUTPUT_BUF_CHARS = 2_000_000; // ~2M chars per stream; generous cap against runaway output

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
 * Spawn a prepared command spec in the foreground, honoring a timeout, and
 * resolve with {stdout, stderr, code}. Port of lib.rs's
 * execute_foreground_command (spawn + collect + timeout-kill).
 */
function spawnForeground(spec, opts, timeoutSecs) {
  return new Promise((resolve) => {
    const { file, args, env } = spec;
    const spawnEnv = { ...process.env, ...(env || {}), ...(opts.envOverride || {}) };

    let child;
    try {
      child = spawn(file, args, { cwd: opts.cwd || undefined, env: spawnEnv, windowsHide: true });
    } catch (e) {
      resolve({ stdout: '', stderr: `Failed to spawn command: ${e instanceof Error ? e.message : String(e)}`, code: -1 });
      return;
    }

    const stdoutC = makeCappedCollector();
    const stderrC = makeCappedCollector();
    child.stdout?.on('data', (chunk) => stdoutC.push(chunk.toString('utf8')));
    child.stderr?.on('data', (chunk) => stderrC.push(chunk.toString('utf8')));

    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* best-effort */
      }
    }, timeoutSecs * 1000);

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
      clearTimeout(timer);
      resolve({ stdout: stdoutC.value, stderr: stderrC.value || String(e.message || e), code: -1 });
    });
    child.once('close', (code) => finish(code));
  });
}

/**
 * Spawn a prepared command spec in "background" mode: wait up to 3s
 * collecting initial output OR until the process exits early, then return —
 * leaving the process running untracked if it's still alive. Port of
 * lib.rs's run_shell_command background branch (identical 3s wait window +
 * identical placeholder string for empty output).
 */
function spawnBackground(spec, opts) {
  return new Promise((resolve) => {
    const { file, args, env } = spec;
    const spawnEnv = { ...process.env, ...(env || {}), ...(opts.envOverride || {}) };

    let child;
    try {
      child = spawn(file, args, { cwd: opts.cwd || undefined, env: spawnEnv, windowsHide: true });
    } catch (e) {
      resolve({ stdout: '', stderr: `Failed to spawn command: ${e instanceof Error ? e.message : String(e)}`, code: -1 });
      return;
    }

    const stdoutC = makeCappedCollector();
    const stderrC = makeCappedCollector();
    child.stdout?.on('data', (chunk) => stdoutC.push(chunk.toString('utf8')));
    child.stderr?.on('data', (chunk) => stderrC.push(chunk.toString('utf8')));

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
      // background (matches Tauri semantics). Listeners stay attached via
      // this closure so stdout/stderr keep draining and don't block the
      // child on a full pipe buffer.
    }, 3000);

    child.once('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(waitTimer);
      resolve({ stdout: stdoutC.value, stderr: stderrC.value || String(e.message || e), code: -1 });
    });
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(waitTimer);
      resolve({ stdout: stdoutC.value, stderr: stderrC.value, code: code ?? -1 });
    });
  });
}

// ── run_shell_command / run_argv_command ──

async function runShellCommand(args) {
  const a = args || {};
  const command = String(a.command ?? '');
  const cwd = typeof a.cwd === 'string' && a.cwd ? a.cwd : undefined;
  const isBackground = !!a.background;
  const timeoutSecs = Math.min(Math.max(1, Number(a.timeout ?? 30) || 30), 300); // default 30s, max 300s
  const sandboxEnabled = a.sandboxEnabled !== false; // unwrap_or(true)
  const extraWritablePaths = Array.isArray(a.extraWritablePaths) ? a.extraWritablePaths : [];
  const networkIsolation = !!a.networkIsolation;
  const networkProxyPort = networkIsolation ? getNetworkProxyPort() : undefined;

  const spec = buildSandboxedCommandSpec(command, cwd, extraWritablePaths, sandboxEnabled, networkProxyPort);
  const envOverride = {};
  const enhancedPath = getEnhancedPath();
  if (enhancedPath) envOverride.PATH = enhancedPath;

  const result = isBackground
    ? await spawnBackground(spec, { cwd, envOverride })
    : await spawnForeground(spec, { cwd, envOverride }, timeoutSecs);

  return {
    stdout: result.stdout,
    stderr: annotateSandboxViolations(result.stderr, command, sandboxEnabled),
    code: result.code,
  };
}

/** No background mode: argv tools are always foreground with a timeout (matches Rust). */
async function runArgvCommand(args) {
  const a = args || {};
  const program = String(a.program ?? '');
  const argv = Array.isArray(a.args) ? a.args.map(String) : [];
  const cwd = typeof a.cwd === 'string' && a.cwd ? a.cwd : undefined;
  const timeoutSecs = Math.min(Math.max(1, Number(a.timeout ?? 30) || 30), 300);
  const sandboxEnabled = a.sandboxEnabled !== false;
  const extraWritablePaths = Array.isArray(a.extraWritablePaths) ? a.extraWritablePaths : [];
  const networkIsolation = !!a.networkIsolation;
  const networkProxyPort = networkIsolation ? getNetworkProxyPort() : undefined;

  const spec = buildSandboxedArgvCommandSpec(program, argv, cwd, extraWritablePaths, sandboxEnabled, networkProxyPort);
  const envOverride = {};
  const enhancedPath = getEnhancedPath();
  if (enhancedPath) envOverride.PATH = enhancedPath;

  const result = await spawnForeground(spec, { cwd, envOverride }, timeoutSecs);

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

const COMMAND_MISS = Symbol('command-dispatch-miss');

/**
 * @param {import('electron').App} app unused today — kept for signature
 *   parity with the other *Dispatch(app, cmd, args) functions and in case a
 *   future command in this family needs app-scoped state.
 * @param {string} cmd
 * @param {Record<string, unknown>} args
 */
async function commandDispatch(app, cmd, args) {
  void app;
  switch (cmd) {
    case 'run_shell_command':
      return runShellCommand(args);
    case 'run_argv_command':
      return runArgvCommand(args);
    case 'get_env_vars':
      return getEnvVars(args);
    default:
      return COMMAND_MISS;
  }
}

module.exports = {
  commandDispatch,
  COMMAND_MISS,
  // exported for the verify harness + potential reuse
  generateSeatbeltProfile,
  annotateSandboxViolations,
  isEnvVarAllowed,
  SENSITIVE_READ_PATHS,
  ENV_VAR_ALLOWED_PREFIXES,
};
