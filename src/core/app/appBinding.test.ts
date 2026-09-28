import { describe, expect, it } from 'vitest';
import type { AppDefinition } from '@/types/app';
import { buildAppBinding, effectiveRun, joinPromptAppend, pickMode } from './appBinding';
import { generalApp } from './appRegistry';
import { DEFAULT_APP_CONFIG } from '@/data/defaultAppConfig';

const app: AppDefinition = {
  appId: 'shop-ops@market', name: '店铺运营', version: '1.0.0', origin: { kind: 'market', market: 'market' }, plugins: ['shop-assistant'], logo: '/apps/shop-ops@market/assets/logo.png',
  config: {
    version: 1,
    defaultRun: { team: 'plugin:shop-assistant/store-ops' },
    promptAppend: '  app text  ',
    home: { modes: { defaultSelected: 'listing', items: [
      { modeId: 'sourcing', title: '选品', promptAppend: 'mode text', scenes: [
        { id: 'shortlist', title: '选品分析', templates: [] },
        { id: 'reply', title: '回复', run: { expert: 'builtin:数据分析师' }, promptAppend: 'scene text', templates: [] },
        { id: 'write', title: '写', run: { skill: 'plugin:shop-assistant/product-listing' }, templates: [] },
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

describe('effectiveRun', () => {
  const sourcing = app.config.home.modes.items[0];
  it('falls back to defaultRun for a scene without its own run', () => {
    expect(effectiveRun(app, sourcing.scenes[0])).toEqual({ team: 'plugin:shop-assistant/store-ops' });
    expect(effectiveRun(app, sourcing.scenes[1])).toEqual({ expert: 'builtin:数据分析师' });
    expect(effectiveRun(app, undefined)).toEqual({ team: 'plugin:shop-assistant/store-ops' });
  });
});

describe('buildAppBinding', () => {
  const sourcing = app.config.home.modes.items[0];
  it('joins app, mode and scene prompts in order, dropping empty pieces', () => {
    expect(joinPromptAppend(app, sourcing, sourcing.scenes[1])).toBe('app text\n\nmode text\n\nscene text');
    expect(joinPromptAppend(app, app.config.home.modes.items[1], undefined)).toBe('app text');
    expect(joinPromptAppend({ ...app, config: { ...app.config, promptAppend: undefined } }, app.config.home.modes.items[1], undefined)).toBeUndefined();
  });

  it('captures the app, its version and origin, the mode, the scene and the effective run', () => {
    expect(buildAppBinding(app, sourcing, sourcing.scenes[2])).toEqual({
      version: 2, appId: 'shop-ops@market', appVersion: '1.0.0', origin: 'market', appName: '店铺运营',
      appLogo: '/apps/shop-ops@market/assets/logo.png', appLogoDark: undefined, appIcon: undefined,
      modeId: 'sourcing', sceneId: 'write', run: { skill: 'plugin:shop-assistant/product-listing' }, promptAppend: 'app text\n\nmode text',
    });
    expect(buildAppBinding(app, sourcing, undefined)?.run).toEqual({ team: 'plugin:shop-assistant/store-ops' });
    expect(buildAppBinding({ ...app, origin: { kind: 'enterprise' } }, sourcing, undefined)?.origin).toBe('enterprise');
  });

  it('binds nothing for the general shell', () => {
    expect(buildAppBinding(generalApp('zh-CN'), DEFAULT_APP_CONFIG.home.modes.items[0], undefined)).toBeUndefined();
  });
});
