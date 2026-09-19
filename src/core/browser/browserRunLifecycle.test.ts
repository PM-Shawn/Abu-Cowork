import { beforeEach, describe, expect, it, vi } from 'vitest';
const { invoke, desktop } = vi.hoisted(() => ({ invoke: vi.fn(), desktop: vi.fn(() => true) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@/utils/tauriEnv', () => ({ isTauriEnv: desktop }));

describe('trusted browser child-run lifecycle', () => {
  beforeEach(() => { vi.resetModules(); invoke.mockReset().mockResolvedValue(undefined); desktop.mockReturnValue(true); });
  it('does not grant registration to an unknown or ended run', async () => {
    const lifecycle = await import('./browserRunLifecycle');
    await expect(lifecycle.ensureBrowserRunRegistered('c', 'unknown')).rejects.toThrow(/never started/);
    expect(invoke).not.toHaveBeenCalled();
    lifecycle.startBrowserRun('c', 'r');
    await lifecycle.ensureBrowserRunRegistered('c', 'r');
    await lifecycle.endBrowserRun('c', 'r');
    invoke.mockClear();
    await expect(lifecycle.ensureBrowserRunRegistered('c', 'r')).rejects.toThrow(/ended/);
    expect(invoke).not.toHaveBeenCalled();
  });
  it('orders revocation after a pending registration and sends no late browser call', async () => {
    const lifecycle = await import('./browserRunLifecycle');
    let registered!: () => void;
    invoke.mockImplementation((command) => command === 'browser_register_run' ? new Promise<void>((resolve) => { registered = resolve; }) : Promise.resolve());
    lifecycle.startBrowserRun('c', 'r');
    const pending = lifecycle.ensureBrowserRunRegistered('c', 'r');
    const rejected = expect(pending).rejects.toThrow(/ended while registering/);
    const end = lifecycle.endBrowserRun('c', 'r');
    expect(invoke).toHaveBeenCalledTimes(1);
    registered();
    await rejected;
    await end;
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(['browser_register_run', 'browser_dispose_owner']);
  });
  it('deduplicates registration across concurrent probes and keeps sibling lifetimes independent', async () => {
    const lifecycle = await import('./browserRunLifecycle');
    lifecycle.startBrowserRun('c', 'one'); lifecycle.startBrowserRun('c', 'two');
    await Promise.all([lifecycle.ensureBrowserRunRegistered('c', 'one'), lifecycle.ensureBrowserRunRegistered('c', 'one')]);
    expect(invoke).toHaveBeenCalledTimes(1);
    await lifecycle.endBrowserRun('c', 'one');
    await lifecycle.ensureBrowserRunRegistered('c', 'two');
    expect(invoke).toHaveBeenLastCalledWith('browser_register_run', { conversationId: 'c', runKey: 'two' });
  });
  it('does not hide an unsuccessful host revocation', async () => {
    const lifecycle = await import('./browserRunLifecycle');
    lifecycle.startBrowserRun('c', 'r');
    invoke.mockRejectedValue(new Error('host unavailable'));
    await expect(lifecycle.endBrowserRun('c', 'r')).rejects.toThrow(/host unavailable/);
    await expect(lifecycle.ensureBrowserRunRegistered('c', 'r')).rejects.toThrow(/ended/);
  });
});
