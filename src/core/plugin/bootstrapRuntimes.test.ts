import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  browser: vi.fn(), browserCleanup: vi.fn(), sync: vi.fn(), syncCleanup: vi.fn(), recovery: vi.fn(),
}));
vi.mock('../browser/builtinBrowserRuntime', () => ({ initBuiltinBrowserRuntime: mocks.browser, cleanupBuiltinBrowserRuntime: mocks.browserCleanup }));
vi.mock('@/stores/mcpStore', () => ({ initMCPStoreSync: mocks.sync, cleanupMCPStoreSync: mocks.syncCleanup }));
vi.mock('@/stores/pluginStore', () => ({ bootstrapPluginUpdates: mocks.recovery }));
import { startCapabilityRuntimes } from './bootstrapRuntimes';

beforeEach(() => vi.clearAllMocks());

it('starts the private browser immediately and MCP synchronization once recovery settles', async () => {
  let finish!: () => void;
  mocks.recovery.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
  const stop = startCapabilityRuntimes();
  expect(mocks.browser).toHaveBeenCalledOnce();
  // Not before: until plugin ownership is published, a plugin's own server
  // looks independent and would be connected, then invalidated by epoch.
  expect(mocks.sync).not.toHaveBeenCalled();
  finish();
  await Promise.resolve();
  await Promise.resolve();
  expect(mocks.sync).toHaveBeenCalledOnce();
  stop();
  expect(mocks.browserCleanup).toHaveBeenCalledOnce();
  expect(mocks.syncCleanup).toHaveBeenCalledOnce();
});

it('does not start MCP synchronization after the owning effect is cleaned up', async () => {
  let finish!: () => void;
  mocks.recovery.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
  startCapabilityRuntimes()();
  finish();
  await Promise.resolve();
  await Promise.resolve();
  expect(mocks.sync).not.toHaveBeenCalled();
});

/**
 * Regression: plugin recovery and MCP startup used to be one promise chain, so
 * an unreadable plugin journal left every user-configured connector offline
 * with the only explanation buried in the plugins tab.
 */
it('keeps user MCP connectors running when plugin recovery fails', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  mocks.recovery.mockRejectedValue(new Error('recovery blocked'));
  const stop = startCapabilityRuntimes();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(mocks.browser).toHaveBeenCalledOnce();
  expect(mocks.sync).toHaveBeenCalledOnce();
  expect(mocks.browserCleanup).not.toHaveBeenCalled();
  expect(warning).toHaveBeenCalled();
  stop();
  warning.mockRestore();
});

it('tears both runtimes down on cleanup', async () => {
  mocks.recovery.mockResolvedValue(undefined);
  startCapabilityRuntimes()();
  await Promise.resolve();
  await Promise.resolve();
  expect(mocks.browserCleanup).toHaveBeenCalledOnce();
  expect(mocks.syncCleanup).toHaveBeenCalledOnce();
});
