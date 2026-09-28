import { beforeEach, describe, expect, it } from 'vitest';
import type { AppDefinition } from '@/types/app';
import { GENERAL_APP_ID } from '@/types/app';
import { MAX_RECENT_APPS, selectedApp, useAppStore } from './appStore';
import { useChatStore } from './chatStore';
import { useSettingsStore } from './settingsStore';

const make = (id: string): AppDefinition => ({
  appId: id, name: id, pluginKey: id, pluginVersion: '1.0.0',
  config: {
    version: 1,
    home: { modes: { items: [{ modeId: 'm', title: 'M', scenes: [{ id: 's', title: 'S', templates: [] }] }] } },
    nav: { items: [{ id: 'chat', target: 'builtin:chat' }, { id: 'portal', title: 'P', target: 'url:https://a.example.com/p' }] },
    allowedOrigins: ['https://a.example.com'],
  },
});

function reset() {
  useAppStore.setState({ selectedAppId: GENERAL_APP_ID, recentAppIds: [], selectedModeIdByApp: {}, installedApps: [], activeAppPage: null, dismissedConnectorHintByApp: {}, expandedSceneIdByApp: {}, pendingEnterAppId: null });
  useSettingsStore.setState({ viewMode: 'chat' });
}

describe('appStore', () => {
  beforeEach(reset);

  it('enters an installed app: selection, recents, home view; refuses one it does not list', () => {
    useAppStore.getState().setInstalledApps([make('a'), make('b')]);
    useSettingsStore.setState({ viewMode: 'team' });
    useChatStore.setState({ activeConversationId: 'conv' });
    useAppStore.getState().enterApp('a');
    expect(useAppStore.getState().selectedAppId).toBe('a');
    expect(useAppStore.getState().recentAppIds).toEqual(['a']);
    expect(useSettingsStore.getState().viewMode).toBe('chat');
    expect(useChatStore.getState().activeConversationId).toBeNull();
    expect(() => useAppStore.getState().enterApp('ghost')).toThrow('not installed');
    expect(useAppStore.getState().selectedAppId).toBe('a');
  });

  it('keeps at most three recents, newest first, and never the general shell', () => {
    useAppStore.getState().setInstalledApps(['a', 'b', 'c', 'd'].map(make));
    for (const id of ['a', 'b', 'c', 'a', 'd']) useAppStore.getState().enterApp(id);
    expect(useAppStore.getState().recentAppIds).toEqual(['d', 'a', 'c']);
    expect(useAppStore.getState().recentAppIds).toHaveLength(MAX_RECENT_APPS);
    useAppStore.getState().enterApp(GENERAL_APP_ID);
    expect(useAppStore.getState().selectedAppId).toBe(GENERAL_APP_ID);
    expect(useAppStore.getState().recentAppIds).toEqual(['d', 'a', 'c']);
  });

  it('falls back to the general shell when the selected app is uninstalled or disabled, and prunes recents', () => {
    useAppStore.getState().setInstalledApps([make('a'), make('b')]);
    useAppStore.getState().enterApp('a');
    useAppStore.getState().enterApp('b');
    useAppStore.getState().setInstalledApps([make('a')]);
    expect(useAppStore.getState().selectedAppId).toBe(GENERAL_APP_ID);
    expect(useAppStore.getState().recentAppIds).toEqual(['a']);
    expect(selectedApp(useAppStore.getState()).appId).toBe(GENERAL_APP_ID);
  });

  it('shows the general shell while a persisted selection has not been loaded yet, without forgetting it', () => {
    useAppStore.setState({ selectedAppId: 'a' });
    expect(selectedApp(useAppStore.getState()).appId).toBe(GENERAL_APP_ID);
    useAppStore.getState().setInstalledApps([make('a')]);
    expect(selectedApp(useAppStore.getState()).appId).toBe('a');
  });

  it('enters an app on the refresh that first lists it (install-and-enter)', () => {
    useAppStore.getState().enterAppWhenAvailable('a');
    expect(useAppStore.getState().selectedAppId).toBe(GENERAL_APP_ID);
    useAppStore.getState().setInstalledApps([make('b')]);
    expect(useAppStore.getState().selectedAppId).toBe(GENERAL_APP_ID);
    expect(useAppStore.getState().pendingEnterAppId).toBeNull();
    useAppStore.getState().enterAppWhenAvailable('b');
    expect(useAppStore.getState().selectedAppId).toBe('b');
  });

  it('opens only the current app\'s url: pages, and closes them on exit', () => {
    useAppStore.getState().setInstalledApps([make('a')]);
    expect(() => useAppStore.getState().openAppPage('portal')).toThrow('general shell');
    useAppStore.getState().enterApp('a');
    expect(() => useAppStore.getState().openAppPage('chat')).toThrow('not a page');
    useAppStore.getState().openAppPage('portal');
    expect(useAppStore.getState().activeAppPage).toEqual({ appId: 'a', navItemId: 'portal' });
    expect(useSettingsStore.getState().viewMode).toBe('app-page');
    useAppStore.getState().exitApp();
    expect(useAppStore.getState().activeAppPage).toBeNull();
    expect(useSettingsStore.getState().viewMode).toBe('chat');
  });

  it('remembers the mode and the expanded scene per app', () => {
    useAppStore.getState().selectMode('a', 'm2');
    useAppStore.getState().setExpandedScene('a', 's');
    useAppStore.getState().dismissConnectorHint('a');
    expect(useAppStore.getState().selectedModeIdByApp).toEqual({ a: 'm2' });
    expect(useAppStore.getState().expandedSceneIdByApp).toEqual({ a: 's' });
    expect(useAppStore.getState().dismissedConnectorHintByApp).toEqual({ a: true });
  });
});
