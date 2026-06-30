/**
 * Tauri IPC contract tests — lock the "call shape" (command name + parameter key set)
 * for the 6 most drift-prone frontend ↔ Rust boundaries.
 *
 * Strategy:
 *   - @tauri-apps/api/core is mocked globally in src/test/setup.ts (invoke = vi.fn()).
 *   - Each test drives the REAL frontend wrapper, then asserts on invoke's captured args.
 *   - The test fails if a wrapper renames a parameter key, even if TypeScript still compiles.
 *
 * Adding a command: add a row to EXPECTED_CONTRACTS.
 * Removing a command from Rust: remove it from lib.rs — the dangling-command guard
 * parses lib.rs at test time and will fail automatically, prompting cleanup of the wrapper.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Parse the actual Rust-registered commands from src-tauri/src/lib.rs.
//
// Reads the tauri::generate_handler![...] macro and extracts command names so
// the guard test reflects the real Rust source, not a hand-maintained copy.
// For module-qualified names (e.g. accessibility::get_ui_snapshot) Tauri
// registers the function name (last segment), so we take only that part.
//
// If this parser throws, it means either lib.rs was not found or the macro
// syntax changed — fix the regex below rather than falling back to a copy.
// ---------------------------------------------------------------------------
function parseRustRegisteredCommands(): Set<string> {
  const libRsPath = resolve(__dirname, '../../../src-tauri/src/lib.rs');
  const content = readFileSync(libRsPath, 'utf-8');

  const match = content.match(/tauri::generate_handler!\s*\[([\s\S]*?)\]/);
  if (!match) {
    throw new Error(
      `Could not find tauri::generate_handler![...] in ${libRsPath}.\n` +
        'Update this parser if the macro syntax has changed.',
    );
  }

  const commands = new Set<string>();
  for (const raw of match[1].split(',')) {
    // Strip inline // comments and surrounding whitespace
    const entry = raw.replace(/\/\/[^\n]*/g, '').trim();
    if (!entry) continue;
    // Module-qualified names (foo::bar) → take the last segment (bar)
    const parts = entry.split('::');
    const name = parts[parts.length - 1].trim();
    if (/^\w+$/.test(name)) {
      commands.add(name);
    }
  }

  return commands;
}

// Parsed once at module load from the real lib.rs — no manual sync needed.
const RUST_REGISTERED_COMMANDS = parseRustRegisteredCommands();

// ---------------------------------------------------------------------------
// Expected contracts — locked call shapes
// ---------------------------------------------------------------------------
interface CommandContract {
  commandName: string;
  expectedParamKeys: Set<string>;
}

const EXPECTED_CONTRACTS: CommandContract[] = [
  {
    commandName: 'run_shell_command',
    // src/core/tools/definitions/commandTools.ts — invoke('run_shell_command', {...})
    expectedParamKeys: new Set([
      'command',
      'cwd',
      'background',
      'timeout',
      'sandboxEnabled',
      'networkIsolation',
      'extraWritablePaths',
    ]),
  },
  {
    commandName: 'secret_set',
    // src/utils/secretStore.ts — setSecret(key, value)
    expectedParamKeys: new Set(['key', 'value']),
  },
  {
    commandName: 'secret_get',
    // src/utils/secretStore.ts — getSecret(key)
    expectedParamKeys: new Set(['key']),
  },
  {
    commandName: 'secret_clear_all',
    // src/utils/secretStore.ts — clearAllSecrets(knownKeys)
    // CRITICAL: front-end sends camelCase `knownKeys`; Tauri auto-converts to
    // snake_case `known_keys` on the Rust side. If someone renames this to
    // `known_keys` on the frontend, Tauri would receive `known_keys` literally
    // (no conversion) and Rust deserialization would fail at runtime.
    expectedParamKeys: new Set(['knownKeys']),
  },
  {
    commandName: 'atomic_write_with_backup',
    // src/utils/atomicFs.ts — atomicWriteWithBackup(path, content)
    expectedParamKeys: new Set(['path', 'content']),
  },
  {
    commandName: 'start_network_proxy',
    // src/core/sandbox/config.ts — initNetworkProxy() reads settingsStore and
    // sends camelCase `allowPrivateNetworks` (Tauri auto-converts to snake_case
    // `allow_private_networks` on the Rust side). Distinct shape from the
    // secret/atomic wrappers, and exercises a second camelCase boundary key.
    expectedParamKeys: new Set(['whitelist', 'allowPrivateNetworks']),
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const mockedInvoke = vi.mocked(invoke);

/** Capture the param object passed to invoke for a specific command. */
function capturedParamsFor(commandName: string): Record<string, unknown> | undefined {
  const call = mockedInvoke.mock.calls.find(([cmd]) => cmd === commandName);
  return call?.[1] as Record<string, unknown> | undefined;
}

// ---------------------------------------------------------------------------
// Guard: all contracted commands are registered in Rust
// RUST_REGISTERED_COMMANDS is parsed live from src-tauri/src/lib.rs, so this
// guard turns red automatically when a command is renamed or removed in Rust.
// ---------------------------------------------------------------------------
describe('Tauri contract — dangling-command guard', () => {
  it('every EXPECTED_CONTRACTS command is present in the Rust invoke_handler (parsed from lib.rs)', () => {
    for (const { commandName } of EXPECTED_CONTRACTS) {
      expect(
        RUST_REGISTERED_COMMANDS.has(commandName),
        `Command "${commandName}" is in EXPECTED_CONTRACTS but NOT found in ` +
          'src-tauri/src/lib.rs tauri::generate_handler![...].\n' +
          'Either the Rust command was renamed/removed, or EXPECTED_CONTRACTS needs updating.',
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Per-wrapper contract tests
// ---------------------------------------------------------------------------
describe('Tauri contract — run_shell_command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Set a known workspace so the path appears in extraWritablePaths
    useWorkspaceStore.setState({ currentPath: '/workspace/contract-test' });
    // invoke must resolve with a CommandOutput shape
    mockedInvoke.mockResolvedValue({ stdout: '', stderr: '', code: 0 });
  });

  it('wrapper sends correct parameter key set to Rust', async () => {
    const { runCommandTool } = await import('@/core/tools/definitions/commandTools');

    await runCommandTool.execute({ command: 'echo hi' }, { workspacePath: '/workspace/contract-test' });

    const params = capturedParamsFor('run_shell_command');
    expect(params, 'invoke("run_shell_command", ...) was never called').toBeDefined();

    const contract = EXPECTED_CONTRACTS.find((c) => c.commandName === 'run_shell_command')!;
    expect(new Set(Object.keys(params!))).toEqual(contract.expectedParamKeys);
  });
});

describe('Tauri contract — secret_set', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedInvoke.mockResolvedValue(undefined);
  });

  it('wrapper sends correct parameter key set to Rust', async () => {
    const { setSecret } = await import('@/utils/secretStore');

    await setSecret('provider:test', 'sk-test-key');

    const params = capturedParamsFor('secret_set');
    expect(params).toBeDefined();

    const contract = EXPECTED_CONTRACTS.find((c) => c.commandName === 'secret_set')!;
    expect(new Set(Object.keys(params!))).toEqual(contract.expectedParamKeys);
  });
});

describe('Tauri contract — secret_get', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedInvoke.mockResolvedValue(null);
  });

  it('wrapper sends correct parameter key set to Rust', async () => {
    const { getSecret } = await import('@/utils/secretStore');

    await getSecret('provider:test');

    const params = capturedParamsFor('secret_get');
    expect(params).toBeDefined();

    const contract = EXPECTED_CONTRACTS.find((c) => c.commandName === 'secret_get')!;
    expect(new Set(Object.keys(params!))).toEqual(contract.expectedParamKeys);
  });
});

describe('Tauri contract — secret_clear_all (knownKeys camelCase guard)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedInvoke.mockResolvedValue(undefined);
  });

  it('wrapper sends camelCase `knownKeys` (NOT snake_case `known_keys`) to Tauri', async () => {
    const { clearAllSecrets } = await import('@/utils/secretStore');

    await clearAllSecrets(['provider:test', 'aux:webSearch']);

    const params = capturedParamsFor('secret_clear_all');
    expect(params).toBeDefined();

    // The critical assertion: key must be `knownKeys`, not `known_keys`.
    // Tauri's serde rename handles the JS→Rust conversion automatically,
    // but ONLY when the JS side sends camelCase. A snake_case key here
    // would bypass the rename and cause a Rust deserialization error at runtime.
    expect(params).toHaveProperty('knownKeys');
    expect(params).not.toHaveProperty('known_keys');

    const contract = EXPECTED_CONTRACTS.find((c) => c.commandName === 'secret_clear_all')!;
    expect(new Set(Object.keys(params!))).toEqual(contract.expectedParamKeys);
  });

  it('passes the full keys array unchanged', async () => {
    const { clearAllSecrets } = await import('@/utils/secretStore');
    const keys = ['provider:claude', 'aux:webSearch', 'aux:imageGen'];

    await clearAllSecrets(keys);

    const params = capturedParamsFor('secret_clear_all');
    expect(params?.knownKeys).toEqual(keys);
  });
});

describe('Tauri contract — atomic_write_with_backup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // invoke must return the raw Rust snake_case shape
    mockedInvoke.mockResolvedValue({ wrote: true, backup_path: null });
  });

  it('wrapper sends correct parameter key set to Rust', async () => {
    const { atomicWriteWithBackup } = await import('@/utils/atomicFs');

    await atomicWriteWithBackup('/some/file.json', '{"key": "value"}');

    const params = capturedParamsFor('atomic_write_with_backup');
    expect(params).toBeDefined();

    const contract = EXPECTED_CONTRACTS.find((c) => c.commandName === 'atomic_write_with_backup')!;
    expect(new Set(Object.keys(params!))).toEqual(contract.expectedParamKeys);
  });

  it('camelCase backupPath is correctly mapped from Rust snake_case backup_path', async () => {
    const { atomicWriteWithBackup } = await import('@/utils/atomicFs');
    mockedInvoke.mockResolvedValue({ wrote: true, backup_path: '/some/file.json.backup.123' });

    const result = await atomicWriteWithBackup('/some/file.json', 'content');

    // Wrapper must translate backup_path → backupPath
    expect(result.backupPath).toBe('/some/file.json.backup.123');
    expect(result).not.toHaveProperty('backup_path');
  });
});

describe('Tauri contract — start_network_proxy', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // initNetworkProxy() guards on isMacOS()/isWindows(), which read the cached
    // platform set by initPlatform(). plugin-os.platform is mocked to 'macos'
    // in src/test/setup.ts, so initialize the cache here.
    const { initPlatform } = await import('@/utils/platform');
    await initPlatform();
    // Wrapper only invokes when network isolation is enabled.
    const { useSettingsStore } = await import('@/stores/settingsStore');
    useSettingsStore.setState({
      networkIsolationEnabled: true,
      networkWhitelist: ['api.anthropic.com'],
      allowPrivateNetworks: false,
    });
    // start_network_proxy resolves with the listening port (a number).
    mockedInvoke.mockResolvedValue(8123);
  });

  // Single test: initNetworkProxy() flips a module-level `proxyStarted` flag to
  // true after a successful call, so a second invocation in this same module
  // would early-return without invoking. Assert key set + camelCase in one run.
  it('wrapper sends correct key set, with camelCase allowPrivateNetworks', async () => {
    const { initNetworkProxy } = await import('@/core/sandbox/config');

    await initNetworkProxy();

    const params = capturedParamsFor('start_network_proxy');
    expect(params, 'invoke("start_network_proxy", ...) was never called').toBeDefined();

    // Locked key set.
    const contract = EXPECTED_CONTRACTS.find((c) => c.commandName === 'start_network_proxy')!;
    expect(new Set(Object.keys(params!))).toEqual(contract.expectedParamKeys);

    // Tauri's serde rename converts camelCase → snake_case automatically, but
    // ONLY when the JS side sends camelCase. A snake_case key here would bypass
    // the rename and fail Rust deserialization at runtime.
    expect(params).toHaveProperty('allowPrivateNetworks');
    expect(params).not.toHaveProperty('allow_private_networks');

    // Values are passed through from the settings store unchanged.
    expect(params?.whitelist).toEqual(['api.anthropic.com']);
    expect(params?.allowPrivateNetworks).toBe(false);
  });
});
