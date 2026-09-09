import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  browser: vi.fn(), browserCleanup: vi.fn(), sync: vi.fn(), syncCleanup: vi.fn(), recovery: vi.fn(),
}));
vi.mock('../browser/builtinBrowserRuntime', () => ({ initBuiltinBrowserRuntime: mocks.browser, cleanupBuiltinBrowserRuntime: mocks.browserCleanup }));
vi.mock('@/stores/mcpStore', () => ({ initMCPStoreSync: mocks.sync, cleanupMCPStoreSync: mocks.syncCleanup }));
vi.mock('@/stores/pluginStore', () => ({ bootstrapPluginUpdates: mocks.recovery }));
import { startCapabilityRuntimes } from './bootstrapRuntimes';

beforeEach(() => vi.clearAllMocks());

it('starts the private browser while plugin recovery is still pending, but defers user MCP startup', async () => {
  let finish!: () => void;
  mocks.recovery.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
  const stop = startCapabilityRuntimes();
  expect(mocks.browser).toHaveBeenCalledOnce();
  expect(mocks.sync).not.toHaveBeenCalled();
  finish();
  await Promise.resolve();
  expect(mocks.sync).toHaveBeenCalledOnce();
  expect(mocks.browser).toHaveBeenCalledOnce();
  stop();
  expect(mocks.browserCleanup).toHaveBeenCalledOnce();
  expect(mocks.syncCleanup).toHaveBeenCalledOnce();
});

it('does not restart user MCP synchronization after the owning effect is cleaned up', async () => {
  let finish!: () => void;
  mocks.recovery.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
  startCapabilityRuntimes()();
  finish();
  await Promise.resolve();
  expect(mocks.sync).not.toHaveBeenCalled();
});

it('keeps the private browser available when plugin recovery fails', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  mocks.recovery.mockRejectedValue(new Error('recovery blocked'));
  const stop = startCapabilityRuntimes();
  await Promise.resolve();
  await Promise.resolve();
  expect(mocks.browser).toHaveBeenCalledOnce();
  expect(mocks.browserCleanup).not.toHaveBeenCalled();
  expect(mocks.sync).not.toHaveBeenCalled();
  expect(warning).toHaveBeenCalled();
  stop();
  warning.mockRestore();
});
