import { beforeEach, describe, expect, it } from 'vitest';
import type { AppDefinition } from '@/types/app';
import { GENERAL_APP_ID } from '@/types/app';
import { MAX_RECENT_APPS, selectedApp, useAppStore } from './appStore';
import { useChatStore } from './chatStore';
import { useSettingsStore } from './settingsStore';

const make = (id: string, origin: AppDefinition['origin'] = { kind: 'market', market: 'm' }): AppDefinition => ({
  appId: id, name: id, version: '1.0.0', origin, plugins: [],
  config: {
    version: 1,
    home: { modes: { items: [{ modeId: 'm', title: 'M', scenes: [{ id: 's', title: 'S', templates: [] }] }] } },
    nav: { items: [{ id: 'chat', target: 'builtin:chat' }, { id: 'portal', title: 'P', target: 'url:https://a.example.com/p' }] },
    allowedOrigins: ['https://a.example.com'],
  },
});
const org = (id: string) => make(id, { kind: 'enterprise' });

function reset() {
  useAppStore.setState({
    selectedAppId: GENERAL_APP_ID, recentAppIds: [], selectedModeIdByApp: {}, addedApps: [], managedApps: {},
    suspendedManagedAppId: null, seenAppIds: {}, activeAppPage: null, dismissedConnectorHintByApp: {}, expandedSceneIdByApp: {}, pendingEnterAppId: null,
  });
  useSettingsStore.setState({ viewMode: 'chat' });
}

describe('appStore', () => {
  beforeEach(reset);

  it('enters an added app: selection, recents, home view; refuses one it does not list', () => {
    useAppStore.getState().setAddedApps([make('a'), make('b')]);
    useSettingsStore.setState({ viewMode: 'team' });
    useChatStore.setState({ activeConversationId: 'conv' });
    useAppStore.getState().enterApp('a');
    expect(useAppStore.getState().selectedAppId).toBe('a');
    expect(useAppStore.getState().recentAppIds).toEqual(['a']);
    expect(useSettingsStore.getState().viewMode).toBe('chat');
    expect(useChatStore.getState().activeConversationId).toBeNull();
    expect(() => useAppStore.getState().enterApp('ghost')).toThrow('not available');
    expect(useAppStore.getState().selectedAppId).toBe('a');
  });

  it('keeps at most three recents, newest first, and never the general shell', () => {
    useAppStore.getState().setAddedApps(['a', 'b', 'c', 'd'].map((id) => make(id)));
    for (const id of ['a', 'b', 'c', 'a', 'd']) useAppStore.getState().enterApp(id);
    expect(useAppStore.getState().recentAppIds).toEqual(['d', 'a', 'c']);
    expect(useAppStore.getState().recentAppIds).toHaveLength(MAX_RECENT_APPS);
    useAppStore.getState().enterApp(GENERAL_APP_ID);
    expect(useAppStore.getState().selectedAppId).toBe(GENERAL_APP_ID);
    expect(useAppStore.getState().recentAppIds).toEqual(['d', 'a', 'c']);
  });

  it('lists organization apps before the added ones', () => {
    useAppStore.getState().setAddedApps([make('mine@local')]);
    useAppStore.getState().replaceManagedApps('enterprise', [org('enterprise-app:1')]);
    const state = useAppStore.getState();
    expect(selectedApp(state).appId).toBe(GENERAL_APP_ID);
    useAppStore.getState().enterApp('enterprise-app:1');
    expect(selectedApp(useAppStore.getState()).origin).toEqual({ kind: 'enterprise' });
  });

  it('falls back to the general shell when the selected app is removed, and prunes recents', () => {
    useAppStore.getState().setAddedApps([make('a'), make('b')]);
    useAppStore.getState().enterApp('a');
    useAppStore.getState().enterApp('b');
    useAppStore.getState().setAddedApps([make('a')]);
    expect(useAppStore.getState().selectedAppId).toBe(GENERAL_APP_ID);
    expect(useAppStore.getState().recentAppIds).toEqual(['a']);
    expect(useAppStore.getState().suspendedManagedAppId).toBeNull();
  });

  it('keeps a remembered selection and recents that no list has reported yet', () => {
    // The added apps load at launch; the organization's arrive after sign-in.
    useAppStore.setState({ selectedAppId: 'enterprise-app:1', recentAppIds: ['enterprise-app:1'] });
    useAppStore.getState().setAddedApps([make('a')]);
    expect(useAppStore.getState().selectedAppId).toBe('enterprise-app:1');
    expect(useAppStore.getState().recentAppIds).toEqual(['enterprise-app:1']);
    expect(selectedApp(useAppStore.getState()).appId).toBe(GENERAL_APP_ID);
    useAppStore.getState().replaceManagedApps('enterprise', [org('enterprise-app:1')]);
    expect(selectedApp(useAppStore.getState()).appId).toBe('enterprise-app:1');
  });

  it('sends an employee to the general shell when offline and back to the same app once it returns', () => {
    useAppStore.getState().setAddedApps([make('a')]);
    useAppStore.getState().replaceManagedApps('enterprise', [org('enterprise-app:1')]);
    useAppStore.getState().enterApp('enterprise-app:1');
    useAppStore.getState().clearManagedApps('enterprise');
    expect(useAppStore.getState().selectedAppId).toBe(GENERAL_APP_ID);
    expect(useAppStore.getState().suspendedManagedAppId).toBe('enterprise-app:1');
    useAppStore.getState().replaceManagedApps('enterprise', [org('enterprise-app:1')]);
    expect(useAppStore.getState().selectedAppId).toBe('enterprise-app:1');
    expect(useAppStore.getState().suspendedManagedAppId).toBeNull();
  });

  it('does not pull the employee back once they chose another app in between', () => {
    useAppStore.getState().setAddedApps([make('a')]);
    useAppStore.getState().replaceManagedApps('enterprise', [org('enterprise-app:1')]);
    useAppStore.getState().enterApp('enterprise-app:1');
    useAppStore.getState().clearManagedApps('enterprise');
    useAppStore.getState().enterApp('a');
    useAppStore.getState().replaceManagedApps('enterprise', [org('enterprise-app:1')]);
    expect(useAppStore.getState().selectedAppId).toBe('a');
  });

  it('does not bring back an app the organization disabled while online', () => {
    useAppStore.getState().replaceManagedApps('enterprise', [org('enterprise-app:1')]);
    useAppStore.getState().enterApp('enterprise-app:1');
    useAppStore.getState().replaceManagedApps('enterprise', []);
    expect(useAppStore.getState().selectedAppId).toBe(GENERAL_APP_ID);
    expect(useAppStore.getState().suspendedManagedAppId).toBeNull();
  });

  it('enters an app on the refresh that first lists it (add-and-enter)', () => {
    useAppStore.getState().enterAppWhenAvailable('a');
    expect(useAppStore.getState().selectedAppId).toBe(GENERAL_APP_ID);
    useAppStore.getState().setAddedApps([make('b')]);
    expect(useAppStore.getState().selectedAppId).toBe(GENERAL_APP_ID);
    expect(useAppStore.getState().pendingEnterAppId).toBeNull();
    useAppStore.getState().enterAppWhenAvailable('b');
    expect(useAppStore.getState().selectedAppId).toBe('b');
    useAppStore.getState().enterAppWhenAvailable('c');
    useAppStore.getState().setAddedApps([make('b'), make('c')]);
    expect(useAppStore.getState().selectedAppId).toBe('c');
  });

  it('opens only the current app\'s url: pages, and closes them on exit', () => {
    useAppStore.getState().setAddedApps([make('a')]);
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
