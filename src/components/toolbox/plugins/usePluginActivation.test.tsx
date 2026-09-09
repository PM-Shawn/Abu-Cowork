// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '@/core/plugin/installedStore';
const mock = vi.hoisted(() => ({ activationByKey: {} as Record<string, { enabled: boolean }>, setPluginEnabled: vi.fn() }));
vi.mock('@/stores/pluginStore', () => ({ usePluginStore: (select: (s: typeof mock) => unknown) => select(mock) }));
import { usePluginActivation } from './usePluginActivation';
const plugin: InstalledPlugin = { key: 'foo@market', name: 'foo', marketplace: 'market', version: '1', installedAt: '2026-09-08T00:00:00Z', contributed: { skills: ['skill'], agents: ['agent'], mcpServers: ['server'] } };
beforeEach(() => {
  vi.resetAllMocks();
  mock.activationByKey = { [plugin.key]: { enabled: true } };
  mock.setPluginEnabled.mockResolvedValue(undefined);
});
describe('plugin activation', () => {
  it('uses the persisted master switch and delegates its change to the store', async () => {
    const { result } = renderHook(() => usePluginActivation(plugin, '/home'));
    expect(result.current.enabled).toBe(true);
    await act(() => result.current.toggle());
    expect(mock.setPluginEnabled).toHaveBeenCalledWith(plugin.key, false);
  });
  it('shows off independently of the presence of contributed capabilities', async () => {
    mock.activationByKey[plugin.key].enabled = false;
    const { result } = renderHook(() => usePluginActivation(plugin, '/home'));
    expect(result.current.enabled).toBe(false);
    await act(() => result.current.toggle());
    expect(mock.setPluginEnabled).toHaveBeenCalledWith(plugin.key, true);
  });
  it('allows turning off while an enable request is still pending', async () => {
    mock.activationByKey[plugin.key].enabled = false;
    let finish!: () => void;
    mock.setPluginEnabled.mockImplementationOnce(async () => {
      mock.activationByKey[plugin.key] = { enabled: true };
      await new Promise<void>(resolve => { finish = resolve; });
    });
    const { result, rerender } = renderHook(() => usePluginActivation(plugin, '/home'));
    let pending!: Promise<void>;
    act(() => { pending = result.current.toggle(); });
    rerender();
    expect(result.current.busy).toBe(false);
    await act(() => result.current.toggle());
    expect(mock.setPluginEnabled).toHaveBeenLastCalledWith(plugin.key, false);
    await act(async () => { finish(); await pending; });
  });
  it('surfaces failures and unlocks the control', async () => {
    mock.setPluginEnabled.mockRejectedValue(new Error('disconnect failed'));
    const { result } = renderHook(() => usePluginActivation(plugin, '/home'));
    await act(async () => { await expect(result.current.toggle()).rejects.toThrow('disconnect failed'); });
    expect(result.current.busy).toBe(false);
  });
  it('does not offer activation before its installation is known', () => {
    mock.activationByKey = {};
    const { result } = renderHook(() => usePluginActivation(plugin, '/home'));
    expect(result.current.available).toBe(false);
  });
});
