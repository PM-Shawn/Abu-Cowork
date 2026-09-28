import { beforeEach, expect, it, vi } from 'vitest';
import { preparePluginTool } from './pluginTools';
import { readInstalledResult } from '@/core/plugin/installedStore';
import { releasePreparedInstall } from '@/core/plugin/installer';
import { PluginManifestError } from '../../../../electron/shared/pluginManifestError.mjs';
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

it('reports the teams the user will see, without the connector configuration', async () => {
  const teams = [{ id: 'store-ops', name: '店铺运营小组', leaderRoleId: 'plugin:店铺运营顾问', memberRoleIds: ['plugin:店铺运营顾问', 'builtin:数据分析师'], requirePlanApproval: false, description: 'd', expertise: [], samplePrompts: [] }];
  prepareMock.mockResolvedValue({ author: { name: 'shop' }, disclosure: { preparedToken: 'token', version: '1', skills: ['product-listing'], agents: [], mcpServers: [{ name: 'shop-api', headers: { Authorization: 'Bearer must-not-return' } }], teams, ignoredPayloads: [] } });
  const result = JSON.parse(String(await preparePluginTool.execute({}, { conversationId: 'creator' })));
  expect(result.teams).toEqual([{ id: 'store-ops', name: '店铺运营小组', leader: 'plugin:店铺运营顾问', members: ['plugin:店铺运营顾问', 'builtin:数据分析师'] }]);
  expect(result.connectors).toEqual(['shop-api']);
  expect(JSON.stringify(result)).not.toContain('must-not-return');
});

// The model corrects the package by the field the validator names, so the path
// has to reach it — `pluginSpec` puts it in front of the message for exactly
// this reason, and nothing here may replace the error with a generic one.
it('hands the failing field back to the model when validation refuses the package', async () => {
  const field = 'teams.store-ops.leader';
  prepareMock.mockRejectedValue(new PluginManifestError(`${field}: expert "ghost" is not in this package's agents/`, field, 'unknown-reference'));
  await expect(preparePluginTool.execute({}, { conversationId: 'creator' })).rejects.toThrow(field);
});

it('reports an empty team list for a plain plugin', async () => {
  prepareMock.mockResolvedValue({ author: { name: 'demo' }, disclosure: { preparedToken: 'token', version: '1', skills: ['hello'], agents: [], mcpServers: [], teams: [], ignoredPayloads: [] } });
  const result = JSON.parse(String(await preparePluginTool.execute({}, { conversationId: 'creator' })));
  expect(result.teams).toEqual([]);
  expect(result).not.toHaveProperty('app');
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
