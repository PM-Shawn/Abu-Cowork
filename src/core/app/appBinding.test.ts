import { describe, expect, it } from 'vitest';
import type { AppDefinition } from '@/types/app';
import { GENERAL_APP_ID } from '@/types/app';
import { buildAppBinding, effectiveRun, joinPromptAppend, pickMode, runExpertName, runTeamId } from './appBinding';
import { DEFAULT_APP_CONFIG } from '@/data/defaultAppConfig';

const app: AppDefinition = {
  appId: 'shop@market', name: '店铺运营', pluginKey: 'shop@market', pluginVersion: '1.0.0', logo: '/pkg/assets/logo.png',
  config: {
    version: 1,
    defaultRun: { team: 'store-ops' },
    promptAppend: '  app text  ',
    home: { modes: { defaultSelected: 'listing', items: [
      { modeId: 'sourcing', title: '选品', promptAppend: 'mode text', scenes: [
        { id: 'shortlist', title: '选品分析', templates: [] },
        { id: 'reply', title: '回复', run: { expert: 'builtin:数据分析师' }, promptAppend: 'scene text', templates: [] },
        { id: 'write', title: '写', run: { skill: 'product-listing' }, templates: [] },
      ] },
      { modeId: 'listing', title: '详情页', scenes: [{ id: 'x', title: 'X', templates: [] }] },
    ] } },
  },
};

describe('pickMode', () => {
  it('prefers the remembered mode, then defaultSelected, then the first', () => {
    expect(pickMode(app, 'sourcing').modeId).toBe('sourcing');
    expect(pickMode(app, 'gone').modeId).toBe('listing');
    expect(pickMode(app, undefined).modeId).toBe('listing');
    expect(pickMode({ ...app, config: { ...app.config, home: { modes: { items: app.config.home.modes.items } } } }, undefined).modeId).toBe('sourcing');
  });
});

describe('runs', () => {
  const sourcing = app.config.home.modes.items[0];
  it('falls back to defaultRun for a scene without its own run', () => {
    expect(effectiveRun(app, sourcing.scenes[0])).toEqual({ team: 'store-ops' });
    expect(effectiveRun(app, sourcing.scenes[1])).toEqual({ expert: 'builtin:数据分析师' });
    expect(effectiveRun(app, undefined)).toEqual({ team: 'store-ops' });
  });

  it('maps team runs to team-store ids and expert runs to registry names', () => {
    expect(runTeamId(app, { team: 'store-ops' })).toBe('plugin-team:shop@market/store-ops');
    expect(runTeamId(app, { team: 'builtin-team:recruiting' })).toBe('builtin-team:recruiting');
    expect(runTeamId(app, { expert: 'x' })).toBeUndefined();
    expect(runTeamId({ ...app, pluginKey: null }, { team: 'store-ops' })).toBeUndefined();
    expect(runExpertName({ expert: 'builtin:数据分析师' })).toBe('数据分析师');
    expect(runExpertName({ expert: '店铺客服顾问' })).toBe('店铺客服顾问');
    expect(runExpertName({ skill: 's' })).toBeUndefined();
  });
});

describe('buildAppBinding', () => {
  const sourcing = app.config.home.modes.items[0];
  it('joins app, mode and scene prompts in order, dropping empty pieces', () => {
    expect(joinPromptAppend(app, sourcing, sourcing.scenes[1])).toBe('app text\n\nmode text\n\nscene text');
    expect(joinPromptAppend(app, app.config.home.modes.items[1], undefined)).toBe('app text');
    expect(joinPromptAppend({ ...app, config: { ...app.config, promptAppend: undefined } }, app.config.home.modes.items[1], undefined)).toBeUndefined();
  });

  it('captures the app, mode, scene and effective run', () => {
    expect(buildAppBinding(app, sourcing, sourcing.scenes[2])).toEqual({
      version: 1, appId: 'shop@market', pluginKey: 'shop@market', pluginVersion: '1.0.0', appName: '店铺运营',
      appLogo: '/pkg/assets/logo.png', appLogoDark: undefined,
      modeId: 'sourcing', sceneId: 'write', run: { skill: 'product-listing' }, promptAppend: 'app text\n\nmode text',
    });
    expect(buildAppBinding(app, sourcing, undefined)?.run).toEqual({ team: 'store-ops' });
  });

  it('binds nothing for the general shell', () => {
    const general: AppDefinition = { appId: GENERAL_APP_ID, name: '通用', config: DEFAULT_APP_CONFIG, pluginKey: null, pluginVersion: null };
    expect(buildAppBinding(general, DEFAULT_APP_CONFIG.home.modes.items[0], undefined)).toBeUndefined();
  });
});
