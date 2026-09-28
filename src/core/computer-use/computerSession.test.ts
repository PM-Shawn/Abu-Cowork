import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { hasElectronCommandHost } from '@/utils/electronHost';
import { invokeComputerUse, type ComputerUseCommand } from '@/core/computer-use/computerSession';

vi.mock('@/utils/electronHost', () => ({ hasElectronCommandHost: vi.fn(() => true) }));

describe('computer session guarded dispatch', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(hasElectronCommandHost).mockReturnValue(true);
  });

  it('rejects missing Host authorization before dispatch', async () => {
    await expect(invokeComputerUse({ token: null, abortSignal: null }, 'ax_snapshot'))
      .rejects.toThrow('not authorized');
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each(['run_shell_command', '__proto__', 'computer_use_begin_session'])('rejects non-session command %s', async (command) => {
    await expect(invokeComputerUse({ token: 'host-token', abortSignal: null }, command as ComputerUseCommand))
      .rejects.toThrow('Unsupported Computer Use command');
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each(['ax_snapshot', 'keyboard_type'] as const)('dispatches %s with trusted token overriding caller arguments', async (command) => {
    vi.mocked(invoke).mockResolvedValue('native-result');
    await expect(invokeComputerUse({ token: 'host-token', abortSignal: null }, command, {
      text: 'hello', __abuComputerUseToken: 'untrusted',
    })).resolves.toBe('native-result');
    expect(invoke).toHaveBeenCalledExactlyOnceWith(command, { text: 'hello', __abuComputerUseToken: 'host-token' });
  });

  it('does not dispatch after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(invokeComputerUse({ token: 'host-token', abortSignal: controller.signal }, 'ax_snapshot'))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not publish a late native result after cancellation', async () => {
    const controller = new AbortController();
    vi.mocked(invoke).mockImplementation(async () => { controller.abort(); return 'late-result'; });
    await expect(invokeComputerUse({ token: 'host-token', abortSignal: controller.signal }, 'ax_snapshot'))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('propagates dispatch failure without retrying a possible side effect', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('outcome unknown'));
    await expect(invokeComputerUse({ token: 'host-token', abortSignal: null }, 'keyboard_type', { text: 'once' }))
      .rejects.toThrow('outcome unknown');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('preserves legacy macOS transport arguments without a Host token', async () => {
    vi.mocked(hasElectronCommandHost).mockReturnValue(false);
    vi.mocked(invoke).mockResolvedValue('legacy-result');
    await expect(invokeComputerUse({ token: null, abortSignal: null }, 'ax_snapshot', { appName: 'Notes' }))
      .resolves.toBe('legacy-result');
    expect(invoke).toHaveBeenCalledExactlyOnceWith('ax_snapshot', { appName: 'Notes' });
  });
});
