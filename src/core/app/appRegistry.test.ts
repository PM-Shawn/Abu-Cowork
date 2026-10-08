import { describe, expect, it } from 'vitest';
import { GENERAL_APP_ID, type AppDefinition } from '@/types/app';
import { DEFAULT_APP_CONFIG } from '@/data/defaultAppConfig';
import { appHomeTitle, generalApp, getApp, listApps } from './appRegistry';

function app(appId: string, overrides: Partial<AppDefinition> = {}): AppDefinition {
  return { appId, name: appId, config: DEFAULT_APP_CONFIG, version: '1.0.0', origin: { kind: 'market', market: 'm' }, plugins: [], ...overrides };
}

describe('listApps', () => {
  it('puts the general shell first, then organization apps, then the apps the user added', () => {
    const added = app('shop@market');
    const managed = app('enterprise-app:1', { origin: { kind: 'enterprise' } });
    const apps = listApps([added], [managed], 'zh-CN');
    expect(apps.map((item) => item.appId)).toEqual([GENERAL_APP_ID, 'enterprise-app:1', 'shop@market']);
    expect(apps[0].name).toBe(generalApp('zh-CN').name);
    expect(getApp(apps, 'enterprise-app:1')).toBe(managed);
    expect(listApps([], [], 'en-US').map((item) => item.appId)).toEqual([GENERAL_APP_ID]);
    expect(generalApp('en-US')).toMatchObject({ name: 'General', version: null, origin: null, plugins: [] });
  });
});

describe('appHomeTitle', () => {
  it('uses the home header title, else the app name', () => {
    const titled = app('shop@market', { name: '店铺运营', config: { ...DEFAULT_APP_CONFIG, home: { ...DEFAULT_APP_CONFIG.home, header: { title: { 'zh-CN': '店铺运营中心', 'en-US': 'Shop ops' } } } } });
    expect(appHomeTitle(titled, 'en-US')).toBe('Shop ops');
    expect(appHomeTitle({ ...titled, config: { ...titled.config, home: { modes: titled.config.home.modes } } }, 'en-US')).toBe('店铺运营');
  });
});
