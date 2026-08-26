import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { clearLogs, getRecentLogs } from '@/core/logging/logger';
import { invokeTaskCommand, TaskCommandAbortedError } from './scopedCommand';

function setElectronMarker(enabled: boolean): void {
  const runtime = globalThis as typeof globalThis & {
    __ABU_SHELL__?: { mainSupervisesSidecar?: boolean };
  };
  if (enabled) {
    runtime.__ABU_SHELL__ = { mainSupervisesSidecar: true };
  } else {
    delete runtime.__ABU_SHELL__;
  }
}

describe('invokeTaskCommand', () => {
  const oldElectronRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
  const oldElectronCommandHost = process.env.ABU_ELECTRON_COMMAND_HOST;

  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    clearLogs();
    delete process.env.ELECTRON_RUN_AS_NODE;
    delete process.env.ABU_ELECTRON_COMMAND_HOST;
    setElectronMarker(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(invoke).mockReset();
    if (oldElectronRunAsNode === undefined) {
      delete process.env.ELECTRON_RUN_AS_NODE;
    } else {
      process.env.ELECTRON_RUN_AS_NODE = oldElectronRunAsNode;
    }
    if (oldElectronCommandHost === undefined) {
      delete process.env.ABU_ELECTRON_COMMAND_HOST;
    } else {
      process.env.ABU_ELECTRON_COMMAND_HOST = oldElectronCommandHost;
    }
    setElectronMarker(false);
  });

  it('keeps the Tauri invoke payload unchanged when the Electron command host marker is absent', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ code: 0, stdout: 'ok', stderr: '' });
    const payload = {
      program: 'pdftotext',
      args: ['/tmp/a.pdf', '-'],
      timeout: 30,
    };

    await invokeTaskCommand('run_argv_command', payload, { workspacePath: '/ws' });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('run_argv_command', payload);
  });

  it('adds an Electron-only commandId and sends abort_command with the same id', async () => {
    setElectronMarker(true);
    const controller = new AbortController();
    let resolveCommand!: (value: unknown) => void;
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'run_shell_command') {
        return await new Promise((resolve) => {
          resolveCommand = resolve;
        });
      }
      if (cmd === 'abort_command') return true;
      return { code: 0, stdout: '', stderr: '' };
    });

    const running = invokeTaskCommand(
      'run_shell_command',
      { command: 'sleep 60', cwd: null, background: false, timeout: 30 },
      { abortSignal: controller.signal },
      { commandIdPrefix: 'test-command' },
    );

    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        'run_shell_command',
        expect.objectContaining({ command: 'sleep 60', commandId: expect.stringMatching(/^test-command-/) }),
      );
    });
    const shellCall = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === 'run_shell_command');
    const commandId = (shellCall?.[1] as { commandId: string }).commandId;

    controller.abort();

    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('abort_command', { commandId });
    });
    resolveCommand({ code: -1, stdout: '', stderr: '[Command aborted]' });
    await running;
  });

  it('recognizes the standalone Electron sidecar command-host marker', async () => {
    process.env.ABU_ELECTRON_COMMAND_HOST = '1';
    vi.mocked(invoke).mockResolvedValueOnce({ code: 0, stdout: 'ok', stderr: '' });

    await invokeTaskCommand(
      'run_shell_command',
      { command: 'echo ok' },
      { workspacePath: '/ws' },
    );

    expect(invoke).toHaveBeenCalledWith(
      'run_shell_command',
      expect.objectContaining({
        command: 'echo ok',
        commandId: expect.stringMatching(/^task-command-/),
      }),
    );
  });

  it('does not invoke anything when the task signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(invokeTaskCommand('run_shell_command', { command: 'sleep 60' }, { abortSignal: controller.signal }))
      .rejects
      .toThrow(TaskCommandAbortedError);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('records a warning when abort_command dispatch fails', async () => {
    vi.useFakeTimers();
    setElectronMarker(true);
    const controller = new AbortController();
    let resolveCommand!: (value: unknown) => void;
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'run_shell_command') {
        return await new Promise((resolve) => {
          resolveCommand = resolve;
        });
      }
      if (cmd === 'abort_command') throw new Error('sidecar transport closed');
      return undefined;
    });

    const running = invokeTaskCommand(
      'run_shell_command',
      { command: 'sleep 60' },
      { abortSignal: controller.signal },
      { commandIdPrefix: 'warn-test' },
    );

    controller.abort();
    await Promise.resolve();

    const warning = getRecentLogs({ module: 'scoped-command', level: 'warn' }).at(-1);
    expect(warning).toMatchObject({
      message: 'abort_command dispatch failed',
      data: {
        commandId: expect.stringMatching(/^warn-test-/),
        error: 'sidecar transport closed',
      },
    });

    resolveCommand({ code: -1, stdout: '', stderr: '[Command aborted]' });
    await running;
    await vi.advanceTimersByTimeAsync(500);
  });
});
