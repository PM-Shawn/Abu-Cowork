/**
 * Unit tests for the `process_image` tool, extracted from `mediaTools.ts`
 * into its own file (P1-3d-5 slice 1) so it can be registered in the
 * sidecar's local tool registry without dragging in `generateImageTool`'s
 * store imports. Behavior must stay byte-identical to the pre-extraction
 * version — these tests cover that contract (invalid action, per-platform
 * command building via `buildMacImageCommand`/`buildWindowsImageCommand`,
 * success/error output formatting), mirroring `computerTools.test.ts`'s
 * pattern for mocking `../../../utils/platform`'s `isWindows()`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { isWindows } from '../../../utils/platform';
import { processImageTool } from './processImageTool';

vi.mock('../../../utils/platform', () => ({
  initPlatform: vi.fn(),
  isWindows: vi.fn(() => false),
  isMacOS: vi.fn(() => true),
  getPlatform: vi.fn(() => 'macos'),
  getShell: vi.fn(() => 'zsh/bash'),
}));

function shellCommands(): string[] {
  return vi.mocked(invoke).mock.calls
    .filter(([cmd]) => cmd === 'run_shell_command')
    .map(([, payload]) => (payload as { command: string }).command);
}

describe('processImageTool', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(isWindows).mockReturnValue(false);
  });

  afterEach(() => {
    delete (globalThis as typeof globalThis & {
      __ABU_SHELL__?: { mainSupervisesSidecar?: boolean };
    }).__ABU_SHELL__;
  });

  it('rejects an invalid action before doing any work', async () => {
    const result = await processImageTool.execute(
      { input_path: '/tmp/in.png', output_path: '/tmp/out.png', action: 'rotate' },
      undefined,
    );

    expect(typeof result).toBe('string');
    expect(result as string).toContain('Unsupported action "rotate"');
    expect(invoke).not.toHaveBeenCalledWith('run_shell_command', expect.anything());
  });

  it('builds the macOS sips command via buildMacImageCommand for a resize action', async () => {
    vi.mocked(isWindows).mockReturnValue(false);
    vi.mocked(invoke).mockResolvedValue({ code: 0, stdout: '', stderr: '' });

    await processImageTool.execute(
      { input_path: '/tmp/in.png', output_path: '/tmp/out.png', action: 'resize', width: 100, height: 200 },
      undefined,
    );

    const commands = shellCommands();
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain('sips -z 200 100');
    expect(commands[0]).toContain("cp '/tmp/in.png' '/tmp/out.png'");
  });

  it('builds the Windows PowerShell command via buildWindowsImageCommand for a resize action', async () => {
    vi.mocked(isWindows).mockReturnValue(true);
    vi.mocked(invoke).mockResolvedValue({ code: 0, stdout: '', stderr: '' });

    await processImageTool.execute(
      { input_path: '/tmp/in.png', output_path: '/tmp/out.png', action: 'resize', width: 100, height: 200 },
      undefined,
    );

    const commands = shellCommands();
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain('powershell -NoProfile -Command');
    expect(commands[0]).toContain('System.Drawing');
  });

  it('passes sandbox/network-isolation flags and extraWritablePaths to invoke', async () => {
    vi.mocked(invoke).mockResolvedValue({ code: 0, stdout: '', stderr: '' });

    await processImageTool.execute(
      { input_path: '/tmp/in.png', output_path: '/tmp/x/out.png', action: 'resize', width: 100, height: 200 },
      undefined,
    );

    expect(invoke).toHaveBeenCalledWith(
      'run_shell_command',
      expect.objectContaining({
        cwd: null,
        background: false,
        timeout: 30,
        // isMacOS() is mocked to true (see the module-level vi.mock above), so
        // isSandboxEnabled() falls through to settingsStore's default (true) —
        // not the "unsupported platform" early-return.
        sandboxEnabled: true,
        networkIsolation: false,
        extraWritablePaths: ['/tmp/x'],
      }),
    );
  });

  it('routes task aborts to abort_command for the active image processor in Electron', async () => {
    (globalThis as typeof globalThis & {
      __ABU_SHELL__?: { mainSupervisesSidecar?: boolean };
    }).__ABU_SHELL__ = { mainSupervisesSidecar: true };
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

    const running = processImageTool.execute(
      { input_path: '/tmp/in.png', output_path: '/tmp/x/out.png', action: 'resize', width: 100, height: 200 },
      { abortSignal: controller.signal },
    );

    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        'run_shell_command',
        expect.objectContaining({ commandId: expect.stringMatching(/^process-image-/) }),
      );
    });
    const shellCall = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === 'run_shell_command');
    const commandId = (shellCall?.[1] as { commandId: string }).commandId;

    controller.abort();

    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('abort_command', { commandId });
    });
    resolveCommand({ code: -1, stdout: '', stderr: '[Command aborted]' });
    const result = await running;
    expect(String(result)).toContain('Error processing image');
  });

  it('formats a success result with the output path on exit code 0', async () => {
    vi.mocked(invoke).mockResolvedValue({ code: 0, stdout: '', stderr: '' });

    const result = await processImageTool.execute(
      { input_path: '/tmp/in.png', output_path: '/tmp/out.png', action: 'convert', format: 'jpeg' },
      undefined,
    );

    expect(result).toBe('Image processed successfully: /tmp/out.png');
  });

  it('formats an error result on a non-zero exit code, preferring stderr', async () => {
    vi.mocked(invoke).mockResolvedValue({ code: 1, stdout: 'out text', stderr: 'sips: bad format' });

    const result = await processImageTool.execute(
      { input_path: '/tmp/in.png', output_path: '/tmp/out.png', action: 'compress', quality: 50 },
      undefined,
    );

    expect(result).toBe('Error processing image: sips: bad format');
  });

  it('falls back to stdout in the error message when stderr is empty', async () => {
    vi.mocked(invoke).mockResolvedValue({ code: 1, stdout: 'only stdout', stderr: '' });

    const result = await processImageTool.execute(
      { input_path: '/tmp/in.png', output_path: '/tmp/out.png', action: 'compress', quality: 50 },
      undefined,
    );

    expect(result).toBe('Error processing image: only stdout');
  });

  it('catches a thrown invoke() rejection and returns it as an error string (never throws)', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('sandbox denied'));

    const result = await processImageTool.execute(
      { input_path: '/tmp/in.png', output_path: '/tmp/out.png', action: 'resize', width: 10, height: 10 },
      undefined,
    );

    expect(typeof result).toBe('string');
    expect(result as string).toContain('Error processing image: sandbox denied');
  });
});
