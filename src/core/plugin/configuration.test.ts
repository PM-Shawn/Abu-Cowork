import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { finishPluginConfiguration, sweepPluginConfigurations, pluginConfigFields, resolvePluginConfiguration, savePluginConfiguration } from './configuration';
import { deleteSecret, listSecrets, getSecret, setSecret } from '@/utils/secretStore';
vi.mock('@/utils/secretStore', () => ({ getSecret: vi.fn(), setSecret: vi.fn(), listSecrets: vi.fn(), deleteSecret: vi.fn() }));
afterEach(() => vi.restoreAllMocks());
vi.mock('./operationBridge', () => ({ hasPluginOperationHost: () => true, pluginOperationStatus: vi.fn() }));
import { pluginOperationStatus } from './operationBridge';
beforeEach(() => { vi.clearAllMocks(); vi.mocked(pluginOperationStatus).mockResolvedValue(null); vi.mocked(listSecrets).mockResolvedValue([]); vi.mocked(getSecret).mockResolvedValue(null); });
it('finds only explicit config slots and deduplicates them', () => {
  expect(pluginConfigFields({ a: { env: { TOKEN: '${config.TOKEN}', BASE: '${HOME}' } }, b: { headers: { Authorization: 'Bearer ${config.TOKEN}', Other: '${config.OTHER}' } } })).toEqual(['OTHER', 'TOKEN']);
});
it('refuses missing configuration before saving anything', async () => {
  await expect(savePluginConfiguration('demo@market', ['TOKEN'], {})).rejects.toThrow('incomplete');
  expect(setSecret).not.toHaveBeenCalled();
  await expect(resolvePluginConfiguration({ name: 'demo', env: { TOKEN: '${config.TOKEN}' } })).rejects.toThrow('incomplete');
});
it('persists values separately and resolves only transient execution copies', async () => {
  vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  const reference = await savePluginConfiguration('demo@market', ['TOKEN'], { TOKEN: 'secret-test-token' });
  expect(reference).toBe('plugin-config:demo@market:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  expect(setSecret).toHaveBeenCalledWith(reference, '{"TOKEN":"secret-test-token"}');
  vi.mocked(getSecret).mockResolvedValue('{"TOKEN":"secret-test-token"}');
  const template = { name: 'demo', pluginConfiguration: reference, env: { TOKEN: '${config.TOKEN}' }, headers: { Authorization: 'Bearer ${config.TOKEN}' } };
  const resolved = await resolvePluginConfiguration(template);
  expect(resolved.config.headers?.Authorization).toBe('Bearer secret-test-token');
  expect(resolved.redact('failed: secret-test-token')).toBe('failed: [redacted]');
  expect(JSON.stringify(template)).not.toContain('secret-test-token');
});
it.each(['null', '[]', '{}', '{"TOKEN":1}', '{"TOKEN":""}'])('fails closed for unusable encrypted configuration %s', async raw => {
  vi.mocked(getSecret).mockResolvedValue(raw);
  await expect(resolvePluginConfiguration({ name: 'demo', pluginConfiguration: 'plugin-config:demo', env: { TOKEN: '${config.TOKEN}' } })).rejects.toThrow('incomplete');
});

it('does not expose malformed encrypted data in parser errors', async () => {
  vi.mocked(getSecret).mockResolvedValue('private-secret-not-json');
  await expect(resolvePluginConfiguration({ name: 'demo', pluginConfiguration: 'plugin-config:demo', env: { TOKEN: '${config.TOKEN}' } })).rejects.toThrow('Plugin configuration is incomplete');
});
it('redacts overlapping values longest first', async () => {
  vi.mocked(getSecret).mockResolvedValue('{"A":"secret","B":"secret-longer"}');
  const resolved = await resolvePluginConfiguration({ name: 'demo', pluginConfiguration: 'plugin-config:demo', env: { A: '${config.A}', B: '${config.B}' } });
  expect(resolved.redact('secret-longer secret')).toBe('[redacted] [redacted]');
});

it('cleans unreferenced credentials while retaining live and still-saving revisions', async () => {
  vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  const pending = await savePluginConfiguration('demo@market', ['TOKEN'], { TOKEN: 'fake' });
  vi.mocked(listSecrets).mockResolvedValue(['provider:keep', 'plugin-config:live', 'plugin-config:orphan', pending!]);
  await sweepPluginConfigurations(() => ['plugin-config:live']);
  expect(deleteSecret).toHaveBeenCalledExactlyOnceWith('plugin-config:orphan');
  vi.mocked(deleteSecret).mockClear();
  finishPluginConfiguration(pending);
  await sweepPluginConfigurations(() => ['plugin-config:live']);
  expect(deleteSecret).toHaveBeenCalledWith(pending);
});
it('does not collect any revision while a journal needs recovery', async () => {
  vi.mocked(pluginOperationStatus).mockResolvedValue({ id: 'pending', key: 'demo@market', phase: 'committed' });
  vi.mocked(listSecrets).mockResolvedValue(['plugin-config:old', 'plugin-config:new']);
  await sweepPluginConfigurations(() => []);
  expect(deleteSecret).not.toHaveBeenCalled();
});
it('rechecks state after listing credentials before collection', async () => {
  let live: string[] | null = [];
  vi.mocked(listSecrets).mockImplementation(async () => { live = null; return ['plugin-config:old']; });
  await sweepPluginConfigurations(() => live);
  expect(deleteSecret).not.toHaveBeenCalled();
});
it('bounds configuration fields and values before encryption', async () => {
  expect(() => pluginConfigFields({ a: { env: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`K${i}`, '${config.K' + i + '}'])) } })).toThrow('32 fields');
  await expect(savePluginConfiguration('demo', ['TOKEN'], { TOKEN: 'x'.repeat(16385) })).rejects.toThrow('size limit');
  expect(setSecret).not.toHaveBeenCalled();
});
