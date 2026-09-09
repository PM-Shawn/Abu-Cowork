import { beforeEach, expect, it, vi } from 'vitest';
import { preparePluginTool } from './pluginTools';
import { readInstalledResult } from '@/core/plugin/installedStore';
import { releasePreparedInstall } from '@/core/plugin/installer';
vi.mock('@/stores/pluginAuthorStore', () => ({ usePluginAuthorStore: { getState: () => ({ prepare: prepareMock }) } }));
vi.mock('@/core/plugin/installer', () => ({ releasePreparedInstall: vi.fn() }));
vi.mock('@/core/plugin/installedStore', () => ({ readInstalledResult: vi.fn() }));
beforeEach(() => { vi.mocked(readInstalledResult).mockResolvedValue({ ok: true, plugins: [] }); });
const prepareMock = vi.hoisted(() => vi.fn());
it('requires trusted execution context and accepts no user path or identity', async () => {
  await expect(preparePluginTool.execute({})).rejects.toThrow('creation conversation');
  await expect(preparePluginTool.execute({ id: 'other' })).rejects.toThrow('no arguments');
  expect(prepareMock).not.toHaveBeenCalled();
});
it('validates only the executing conversation and releases the non-installing preview', async () => {
  prepareMock.mockResolvedValue({ author: { name: 'demo' }, disclosure: { preparedToken: 'token', version: '1', skills: ['hello'], agents: [], mcpServers: [{ name: 'remote', env: { TOKEN: 'must-not-return' } }], ignoredPayloads: [] } });
  const result = await preparePluginTool.execute({}, { conversationId: 'creator' });
  expect(prepareMock).toHaveBeenCalledWith({ conversationId: 'creator' });
  expect(String(result)).not.toContain('must-not-return');
  expect(releasePreparedInstall).toHaveBeenCalledWith('token');
});

it('distinguishes validated source updates from content already installed', async () => {
  prepareMock.mockResolvedValue({ author: { id: 'author', key: 'demo@author', name: 'demo', prepared: { checksum: 'new' } }, disclosure: { preparedToken: 'token', version: '1', skills: ['hello'], agents: [], mcpServers: [], ignoredPayloads: [] } });
  vi.mocked(readInstalledResult).mockResolvedValue({ ok: true, plugins: [{ key: 'demo@author', authoringId: 'author', checksum: 'old' }] } as never);
  const updated = JSON.parse(String(await preparePluginTool.execute({}, { conversationId: 'creator' })));
  expect(updated.status).toBe('update-available');
  expect(updated.next).toContain('Preview update');
  vi.mocked(readInstalledResult).mockResolvedValue({ ok: true, plugins: [{ key: 'demo@author', authoringId: 'author', checksum: 'new' }] } as never);
  expect(JSON.parse(String(await preparePluginTool.execute({}, { conversationId: 'creator' }))).status).toBe('unchanged');
});
