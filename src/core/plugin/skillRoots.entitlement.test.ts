import { describe, it, expect, vi, beforeEach } from 'vitest';

const entitlement = vi.hoisted(() => ({ active: true }));
vi.mock('../enterprise/entitlement', () => ({
  isEnterpriseModuleActive: () => entitlement.active,
}));
vi.mock('./installedStore', () => ({
  readInstalled: vi.fn().mockResolvedValue([
    { key: 'a@abu-official', marketplace: 'abu-official', name: 'a', version: '1.0.0', installedAt: '', contributed: { skills: [], mcpServers: [] } },
    { key: 'b@enterprise', marketplace: 'enterprise', name: 'b', version: '2.0.0', installedAt: '', contributed: { skills: [], mcpServers: [] } },
  ]),
}));

import { pluginSkillDirs } from './skillRoots';

describe('pluginSkillDirs entitlement gate', () => {
  beforeEach(() => { entitlement.active = true; });

  it('includes enterprise plugin skill roots when the skills module is entitled', async () => {
    const dirs = await pluginSkillDirs('/home/u');
    expect(dirs).toEqual([
      '/home/u/.abu/plugin-packages/abu-official/a/1.0.0/skills',
      '/home/u/.abu/plugin-packages/enterprise/b/2.0.0/skills',
    ]);
  });

  it('drops enterprise plugin skill roots when entitlement is off (fail-closed, files stay on disk)', async () => {
    entitlement.active = false;
    const dirs = await pluginSkillDirs('/home/u');
    expect(dirs).toEqual(['/home/u/.abu/plugin-packages/abu-official/a/1.0.0/skills']);
  });
});
