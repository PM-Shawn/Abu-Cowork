import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import type { Skill } from '../../types';
import { clearAllHooks, emitHook } from '../agent/lifecycleHooks';
import { activateSkillHooks } from './skillHooks';

function setElectronMarker(enabled: boolean): void {
  const runtime = globalThis as typeof globalThis & {
    __ABU_SHELL__?: { mainSupervisesSidecar?: boolean };
  };
  if (enabled) runtime.__ABU_SHELL__ = { mainSupervisesSidecar: true };
  else delete runtime.__ABU_SHELL__;
}

function skillWithHooks(): Skill {
  return {
    name: 'hook-test',
    description: 'test',
    content: '',
    filePath: '/tmp/hook-test/SKILL.md',
    skillDir: '/tmp/hook-test',
    hooks: {
      PreToolUse: [{
        matcher: 'write_*',
        hooks: [{ type: 'command', command: 'pre-check' }],
      }],
      PostToolUse: [{
        matcher: 'write_*',
        hooks: [{ type: 'command', command: 'post-check' }],
      }],
    },
  };
}

describe('skill command hooks', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    clearAllHooks();
    setElectronMarker(true);
  });

  afterEach(() => {
    vi.mocked(invoke).mockReset();
    clearAllHooks();
    setElectronMarker(false);
  });

  it('uses the task signal to abort a running pre-tool hook command', async () => {
    const controller = new AbortController();
    let resolveCommand!: (value: unknown) => void;
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === 'run_shell_command') {
        return await new Promise((resolve) => {
          resolveCommand = resolve;
        });
      }
      if (cmd === 'abort_command') return true;
      return undefined;
    });
    const cleanup = activateSkillHooks(skillWithHooks());

    const running = emitHook({
      type: 'preToolCall',
      timestamp: Date.now(),
      toolName: 'write_file',
      toolInput: {},
      abortSignal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        'run_shell_command',
        expect.objectContaining({
          command: 'pre-check',
          commandId: expect.stringMatching(/^skill-hook-/),
          sandboxEnabled: true,
          extraWritablePaths: ['/tmp/hook-test'],
        }),
      );
    });
    const commandCall = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === 'run_shell_command');
    const commandId = (commandCall?.[1] as { commandId: string }).commandId;

    controller.abort();
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('abort_command', { commandId });
    });
    resolveCommand({ code: -1, stdout: '', stderr: '[Command aborted]' });
    const event = await running;
    expect(event.blocked).toBe(true);
    cleanup();
  });

  it('threads the task signal into post-tool hook commands too', async () => {
    const controller = new AbortController();
    vi.mocked(invoke).mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const cleanup = activateSkillHooks(skillWithHooks());

    await emitHook({
      type: 'postToolCall',
      timestamp: Date.now(),
      toolName: 'write_file',
      toolInput: {},
      abortSignal: controller.signal,
      result: 'ok',
      error: false,
      durationMs: 1,
    });

    expect(invoke).toHaveBeenCalledWith(
      'run_shell_command',
      expect.objectContaining({
        command: 'post-check',
        commandId: expect.stringMatching(/^skill-hook-/),
      }),
    );
    cleanup();
  });
});
