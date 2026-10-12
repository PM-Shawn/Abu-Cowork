// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { mkdir } from '@tauri-apps/plugin-fs';
import { DesignSystemProvider } from '@/components/ds/provider';
import { createAppDraft } from '@/core/app/appDraft';
import { useAppDraftStore } from '@/stores/appDraftStore';
import { useAppStore } from '@/stores/appStore';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useTeamStore, type Team } from '@/stores/teamStore';
import type { AppDefinition } from '@/types/app';
import { GENERAL_APP_ID } from '@/types/app';
import { createPluginAuthor, listPluginAuthors, type PluginAuthor } from '@/core/plugin/authorBridge';
import { petMessageConversation } from '@/core/pet/petQuickMessage';
import { usePluginAuthorStore } from '@/stores/pluginAuthorStore';
import AppHome from './AppHome';

vi.mock('@/core/plugin/authorBridge', () => ({ deletePluginAuthor: vi.fn(), bindPluginAuthor: vi.fn(), createPluginAuthor: vi.fn(), listPluginAuthors: vi.fn(), preparePluginAuthor: vi.fn(), validatePluginAuthor: vi.fn() }));
const draft: PluginAuthor = { id: 'a'.repeat(32), createdAt: '2026-10-12', conversationId: null, name: null, prepared: null, sourceDir: '/home/Abu Plugins/a', marketplace: 'author-a', key: null };

// The home of an app owns what the next conversation started there carries: the app binding for
// the mode and scene in view, and the app's default team. It keeps both ready for as long as it
// shows with no conversation, whatever started the new task.
const team = { id: 'team-shop', name: '店铺运营小组', leaderRoleId: 'role-lead', memberRoleIds: ['role-lead'], createdAt: 1, updatedAt: 1 } as Team;
const scene = { id: 'reply', title: '客服回复', templates: [] };
const shop: AppDefinition = {
  appId: 'created-app:shop', name: '店铺运营', version: '1.0.0', origin: { kind: 'created', authoringId: 'draft-1' }, plugins: [],
  config: {
    version: 1,
    defaultRun: { team: `mine:${team.id}` },
    promptAppend: 'The user runs an online shop.',
    home: { modes: { items: [{ modeId: 'service', title: '客服', scenes: [scene] }] } },
  },
};

const chat = () => useChatStore.getState();
const created = () => chat().conversations[chat().activeConversationId!];

function renderHome() {
  render(<AppHome app={shop} onPlaceholderChange={() => undefined} />, { wrapper: DesignSystemProvider });
}

describe('the app home keeps the next conversation bound to its app', () => {
  beforeEach(() => {
    vi.mocked(mkdir).mockReset().mockResolvedValue(undefined);
    useTeamStore.setState({ teams: [team], managedTeamSources: {} });
    useAppDraftStore.setState({ draftsByConversation: {} });
    useAppStore.setState({ addedApps: [shop], managedApps: {}, seenAppIds: { [shop.appId]: true }, selectedAppId: shop.appId, selectedModeIdByApp: {}, expandedSceneIdByApp: {}, activeAppPage: null });
    useChatStore.setState({ conversations: {}, conversationIndex: {}, activeConversationId: null, pendingAppBinding: undefined, pendingTeamId: undefined, pendingInput: null });
    useSettingsStore.setState({ viewMode: 'chat' });
  });

  afterEach(() => {
    cleanup();
    useTeamStore.setState({ teams: [], managedTeamSources: {} });
    useAppStore.setState({ addedApps: [], managedApps: {}, seenAppIds: {}, selectedAppId: GENERAL_APP_ID, selectedModeIdByApp: {}, expandedSceneIdByApp: {} });
    useChatStore.setState({ conversations: {}, conversationIndex: {}, activeConversationId: null, pendingAppBinding: undefined, pendingTeamId: undefined, pendingInput: null });
  });

  it('has the binding and the default team ready when it comes into view', () => {
    renderHome();
    expect(chat().pendingAppBinding).toMatchObject({ appId: shop.appId, modeId: 'service' });
    expect(chat().pendingTeamId).toBe(team.id);
  });

  it('has them ready again after a new task is started with the home already in view', () => {
    renderHome();
    act(() => { chat().startNewConversation(); });
    expect(chat().pendingAppBinding).toMatchObject({ appId: shop.appId, modeId: 'service' });
    expect(chat().pendingTeamId).toBe(team.id);
  });

  it('binds the conversation of the next send after two new tasks in a row', () => {
    renderHome();
    act(() => { chat().startNewConversation(); });
    act(() => { chat().startNewConversation(); });
    act(() => { chat().createConversation(null); });
    expect(created().appBinding).toMatchObject({ appId: shop.appId, appName: shop.name, modeId: 'service' });
    expect(created().teamId).toBe(team.id);
    expect(chat().conversationIndex[created().id].appBinding).toMatchObject({ appId: shop.appId });
  });

  it('leaves a team the user took off the composer off', () => {
    renderHome();
    act(() => { chat().setPendingTeamId(undefined); });
    expect(chat().pendingTeamId).toBeUndefined();
    expect(chat().pendingAppBinding).toMatchObject({ appId: shop.appId });
  });

  it('leaves the team and the scene a template handed over as they are', () => {
    useAppStore.setState({ expandedSceneIdByApp: { [shop.appId]: scene.id } });
    renderHome();
    const handedOver = { ...chat().pendingAppBinding!, sceneId: scene.id };
    // What a template does in one step: a new task, its own team, then the binding of its scene.
    act(() => {
      chat().startNewConversation();
      chat().setPendingTeamId('team-of-the-scene');
      chat().setPendingAppBinding(handedOver);
    });
    expect(chat().pendingTeamId).toBe('team-of-the-scene');
    expect(chat().pendingAppBinding).toBe(handedOver);
  });

  it('leaves the creation conversation of 「创建应用」 unbound when the shell stays in the app', async () => {
    renderHome();
    await act(async () => { await createAppDraft({ leaveApp: false }); });
    expect(useAppStore.getState().selectedAppId).toBe(shop.appId);
    expect(created().appBinding).toBeUndefined();
    expect(created().teamId).toBeUndefined();
    expect(chat().pendingAppBinding).toBeUndefined();
    expect(chat().pendingTeamId).toBeUndefined();
  });

  it('leaves the creation conversation of 「创建插件」 unbound, in the general shell or in the app the organization keeps the employee in', async () => {
    vi.mocked(createPluginAuthor).mockResolvedValue(draft);
    vi.mocked(listPluginAuthors).mockResolvedValue([draft]);
    renderHome();
    for (const leaveApp of [true, false]) {
      useAppStore.setState({ selectedAppId: shop.appId });
      act(() => { chat().startNewConversation(); });
      expect(chat().pendingAppBinding).toMatchObject({ appId: shop.appId });
      await act(async () => { await usePluginAuthorStore.getState().create({ leaveApp }); });
      expect(useAppStore.getState().selectedAppId).toBe(leaveApp ? GENERAL_APP_ID : shop.appId);
      expect(created().workspacePath).toBe(draft.sourceDir);
      expect(created().appBinding).toBeUndefined();
      expect(created().teamId).toBeUndefined();
    }
  });

  it('leaves the conversation a pet message starts unbound, in the general shell or in the app the organization keeps the employee in', () => {
    renderHome();
    for (const leaveApp of [true, false]) {
      useAppStore.setState({ selectedAppId: shop.appId });
      act(() => { chat().startNewConversation(); });
      expect(chat().pendingAppBinding).toMatchObject({ appId: shop.appId });
      act(() => { petMessageConversation(null, { leaveApp }); });
      expect(useAppStore.getState().selectedAppId).toBe(leaveApp ? GENERAL_APP_ID : shop.appId);
      expect(created().appBinding).toBeUndefined();
      expect(created().teamId).toBeUndefined();
    }
  });

  it('binds the next task started on the home after a conversation of the general shell opened there', () => {
    renderHome();
    act(() => { petMessageConversation(null, { leaveApp: false }); });
    expect(created().appBinding).toBeUndefined();
    act(() => { chat().startNewConversation(); });
    act(() => { chat().createConversation(null); });
    expect(created().appBinding).toMatchObject({ appId: shop.appId, modeId: 'service' });
    expect(created().teamId).toBe(team.id);
  });
});
