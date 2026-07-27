/**
 * Unit tests for the `run_command` tool.
 *
 * `run_command` had ZERO test coverage before P1-3d-5. These tests (a) pin its
 * existing behavior (invoke('run_shell_command') arg construction, timeout
 * clamping, launcher sandbox-exemption, output formatting, sandbox-blocked
 * toast, error handling) and (b) cover the P1-3d-5 slice 2a refactor that
 * routes its two former direct store reads through ports
 * (`getWorkspaceReader()` + `getAuthorizedPathsReader()`) so the tool can be
 * bundled into the sidecar without dragging `useWorkspaceStore` /
 * `getAuthorizedWritablePaths` / the store-coupled toast into the bundle.
 * The port defaults return exactly what the direct reads returned, so shell
 * behavior is unchanged — these tests assert that contract via mocked ports.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { runCommandTool } from './commandTools';
import { getWorkspaceReader } from '../../agent/ports/workspaceReader';
import { getAuthorizedPathsReader } from '../../agent/ports/authorizedPathsReader';
import { isSandboxEnabled, isNetworkIsolationEnabled } from '../../sandbox/config';
import { showSandboxBlockedToast } from '../../sandbox/recovery';
import { isWindows } from '../../../utils/platform';

vi.mock('../../../utils/platform', () => ({
  initPlatform: vi.fn(),
  isWindows: vi.fn(() => false),
  isMacOS: vi.fn(() => true),
  getPlatform: vi.fn(() => 'macos'),
  getShell: vi.fn(() => 'zsh'),
}));

vi.mock('../../../utils/pythonRuntime', () => ({
  // Pass-through: the resolved command equals the input command unless a test
  // overrides this — keeps assertions about the forwarded command literal.
  resolveCommandPython: vi.fn(async (c: string) => c),
}));

vi.mock('../../sandbox/config', () => ({
  isSandboxEnabled: vi.fn(() => true),
  isNetworkIsolationEnabled: vi.fn(() => false),
}));

vi.mock('../../sandbox/recovery', () => ({
  showSandboxBlockedToast: vi.fn(),
}));

vi.mock('../../agent/ports/workspaceReader', () => ({
  getWorkspaceReader: vi.fn(() => ({ getCurrentPath: () => null })),
}));

vi.mock('../../agent/ports/authorizedPathsReader', () => ({
  getAuthorizedPathsReader: vi.fn(() => ({ getAuthorizedWritablePaths: vi.fn(async () => []) })),
}));

/** Extract the single `run_shell_command` invoke payload (asserts exactly one). */
function shellPayload(): Record<string, unknown> {
  const calls = vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'run_shell_command');
  expect(calls).toHaveLength(1);
  return calls[0][1] as Record<string, unknown>;
}

function mockReader(currentPath: string | null): void {
  vi.mocked(getWorkspaceReader).mockReturnValue({ getCurrentPath: () => currentPath });
}

function mockAuthorized(paths: string[]): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async () => paths);
  vi.mocked(getAuthorizedPathsReader).mockReturnValue({ getAuthorizedWritablePaths: spy });
  return spy;
}

describe('runCommandTool', () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & {
      __ABU_SHELL__?: { mainSupervisesSidecar?: boolean };
    }).__ABU_SHELL__ = { mainSupervisesSidecar: true };
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    vi.mocked(isWindows).mockReturnValue(false);
    vi.mocked(isSandboxEnabled).mockReturnValue(true);
    vi.mocked(isNetworkIsolationEnabled).mockReturnValue(false);
    vi.mocked(showSandboxBlockedToast).mockClear();
    mockReader(null);
    mockAuthorized([]);
  });

  afterEach(() => {
    delete (globalThis as typeof globalThis & {
      __ABU_SHELL__?: { mainSupervisesSidecar?: boolean };
    }).__ABU_SHELL__;
  });

  it('forwards the resolved command, clamps timeout, and merges workspace + authorized paths', async () => {
    mockAuthorized(['/auth/one']);

    await runCommandTool.execute(
      { command: 'ls -la', timeout: 500 },
      { workspacePath: '/ws' },
    );

    const p = shellPayload();
    expect(typeof p.commandId).toBe('string');
    expect(p.commandId).toMatch(/^run-command-/);
    expect(p.command).toBe('ls -la');
    expect(p.cwd).toBe('/ws'); // no input.cwd → falls back to workspacePath
    expect(p.timeout).toBe(300); // clamped from 500 to max 300
    expect(p.sandboxEnabled).toBe(true);
    expect(p.networkIsolation).toBe(false);
    // workspacePath first, then authorized paths.
    expect(p.extraWritablePaths).toEqual(['/ws', '/auth/one']);
  });

  it('does not add commandId to the locked Tauri run_shell_command payload when Electron markers are absent', async () => {
    delete (globalThis as typeof globalThis & {
      __ABU_SHELL__?: { mainSupervisesSidecar?: boolean };
    }).__ABU_SHELL__;

    await runCommandTool.execute(
      { command: 'ls -la', timeout: 30 },
      { workspacePath: '/ws' },
    );

    const p = shellPayload();
    expect(p.command).toBe('ls -la');
    expect(p.cwd).toBe('/ws');
    expect(p).not.toHaveProperty('commandId');
  });

  it('falls back to getWorkspaceReader().getCurrentPath() when context has no workspacePath', async () => {
    mockReader('/reader/ws');

    await runCommandTool.execute({ command: 'pwd' }, undefined);

    const p = shellPayload();
    expect(p.cwd).toBe('/reader/ws');
    expect(p.extraWritablePaths).toEqual(['/reader/ws']);
  });

  it('degrades to "no workspace" (cwd-less spawn) when the fallback reader throws — never fails the command (sidecar outside-run guard)', async () => {
    vi.mocked(getWorkspaceReader).mockReturnValue({
      getCurrentPath: () => {
        throw new Error('[sidecar] resolved outside a registered agent run');
      },
    });

    await runCommandTool.execute({ command: 'pwd' }, undefined);

    const p = shellPayload();
    expect(p.cwd).toBeNull();
    expect(p.extraWritablePaths).toEqual([]);
  });

  it('prefers an explicit input.cwd over the workspace path', async () => {
    await runCommandTool.execute({ command: 'pwd', cwd: '/explicit' }, { workspacePath: '/ws' });
    expect(shellPayload().cwd).toBe('/explicit');
  });

  it('clamps timeout to a minimum of 1 second', async () => {
    await runCommandTool.execute({ command: 'ls', timeout: 0 }, undefined);
    expect(shellPayload().timeout).toBe(1);
  });

  it('exempts a macOS `open` launcher command from the sandbox and skips the authorized-paths fetch', async () => {
    const authSpy = mockAuthorized(['/auth/one']);

    await runCommandTool.execute({ command: 'open /Applications/Safari.app' }, { workspacePath: '/ws' });

    const p = shellPayload();
    expect(p.sandboxEnabled).toBe(false);
    // sandbox off → authorized-paths reader is NOT consulted, and only the
    // workspace path is passed as writable.
    expect(authSpy).not.toHaveBeenCalled();
    expect(p.extraWritablePaths).toEqual(['/ws']);
  });

  it('exempts a Windows `start` launcher command from the sandbox', async () => {
    vi.mocked(isWindows).mockReturnValue(true);

    await runCommandTool.execute({ command: 'start notepad.exe' }, undefined);

    expect(shellPayload().sandboxEnabled).toBe(false);
  });

  it('formats stdout, stderr, and the exit code into the result', async () => {
    vi.mocked(invoke).mockResolvedValue({ code: 2, stdout: 'the output', stderr: 'the warning' });

    const result = await runCommandTool.execute({ command: 'ls' }, undefined);

    expect(result).toContain('stdout:\nthe output');
    expect(result).toContain('stderr:\nthe warning');
    expect(result).toContain('exit code: 2');
  });

  it('shows the sandbox-blocked toast when a sandboxed command is blocked', async () => {
    vi.mocked(invoke).mockResolvedValue({
      code: 1,
      stdout: '',
      stderr: '[sandbox-blocked] file write blocked by sandbox policy',
    });

    await runCommandTool.execute({ command: 'cp a.txt /etc/b.txt' }, undefined);

    expect(showSandboxBlockedToast).toHaveBeenCalledWith('cp a.txt /etc/b.txt');
  });

  it('does not show the toast for a non-sandboxed (launcher) command even if stderr mentions sandbox', async () => {
    vi.mocked(invoke).mockResolvedValue({ code: 1, stdout: '', stderr: '[sandbox-blocked] x' });

    await runCommandTool.execute({ command: 'open /x' }, undefined);

    expect(showSandboxBlockedToast).not.toHaveBeenCalled();
  });

  it('returns an error string (never throws) when invoke rejects', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('spawn failed'));

    const result = await runCommandTool.execute({ command: 'ls' }, undefined);

    expect(typeof result).toBe('string');
    expect(result as string).toContain('Error executing command: spawn failed');
  });

  it('does not spawn when the abort signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runCommandTool.execute(
      { command: 'sleep 60' },
      { workspacePath: '/ws', abortSignal: controller.signal },
    );

    expect(result).toContain('aborted before it started');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('sends abort_command for the active command id when the tool aborts mid-run', async () => {
    const controller = new AbortController();
    let resolveShell!: (value: unknown) => void;
    vi.mocked(invoke).mockImplementation(async (cmd, _args) => {
      if (cmd === 'run_shell_command') {
        return await new Promise((resolve) => {
          resolveShell = resolve;
        });
      }
      if (cmd === 'abort_command') return true;
      return { code: 0, stdout: '', stderr: '' };
    });

    const running = runCommandTool.execute(
      { command: 'sleep 60' },
      { workspacePath: '/ws', abortSignal: controller.signal },
    );

    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('run_shell_command', expect.objectContaining({ command: 'sleep 60' }));
    });
    const p = shellPayload();
    controller.abort();
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('abort_command', { commandId: p.commandId });
    });
    resolveShell({ code: -1, stdout: '', stderr: '[Command aborted]' });

    const result = await running;
    expect(result).toContain('exit code: -1');
  });

  it('keeps the abort listener after a successful background command returns', async () => {
    const controller = new AbortController();
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'run_shell_command') return { code: 0, stdout: '服务已在后台启动', stderr: '' };
      if (cmd === 'abort_command') return true;
      return { code: 0, stdout: '', stderr: '' };
    });

    await runCommandTool.execute(
      { command: 'npm run dev', background: true },
      { workspacePath: '/ws', abortSignal: controller.signal },
    );
    const p = shellPayload();

    controller.abort();

    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('abort_command', { commandId: p.commandId });
    });
  });

  // Regression test for a code-review finding (P1-3d-5 slice 2b): if the
  // sidecar's reverse `getAuthorizedPathsReader().getAuthorizedWritablePaths()`
  // RPC rejects (e.g. a dead shell<->sidecar transport), the whole outer
  // try/catch in execute() catches it and returns a clean error string —
  // execution never reaches `invoke('run_shell_command', ...)`, so no command
  // spawns. This is the accepted fail-closed behavior (decision made, not a
  // bug): an early, honest error is strictly better than silently proceeding
  // with an empty (under-authorized) writable-paths list. See
  // sidecar/src/localTools/index.ts's "P1-3d-5 slice 2b: run_command" doc
  // section for the full rationale.
  it('fails closed (never spawns the command) when the authorized-paths RPC rejects, with sandbox on', async () => {
    vi.mocked(getAuthorizedPathsReader).mockReturnValue({
      getAuthorizedWritablePaths: vi.fn(async () => {
        throw new Error('authorized-paths RPC transport down');
      }),
    });

    const result = await runCommandTool.execute({ command: 'ls -la' }, { workspacePath: '/ws' });

    expect(typeof result).toBe('string');
    expect(result as string).toContain('Error executing command');
    expect(invoke).not.toHaveBeenCalledWith('run_shell_command', expect.anything());
  });
});
