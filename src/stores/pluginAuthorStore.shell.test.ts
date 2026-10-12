import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GENERAL_APP_ID } from '@/types/app';
import { bindPluginAuthor, createPluginAuthor, listPluginAuthors, type PluginAuthor } from '@/core/plugin/authorBridge';
import { activeConversation, enterShop, resetShell, shop } from '@/test/appShellFixtures';
import { useAppStore } from './appStore';
import { useChatStore } from './chatStore';
import { usePluginAuthorStore } from './pluginAuthorStore';
import { useSettingsStore } from './settingsStore';

// 「创建插件」 is an activity of the general shell: its conversation belongs to no
// app, and the shell leaves the app it was started from unless the
// organization keeps the employee in it.
vi.mock('@/core/plugin/authorBridge', () => ({ deletePluginAuthor: vi.fn(), bindPluginAuthor: vi.fn(), createPluginAuthor: vi.fn(), listPluginAuthors: vi.fn(), preparePluginAuthor: vi.fn(), validatePluginAuthor: vi.fn() }));

const draft: PluginAuthor = { id: 'a'.repeat(32), createdAt: '2026-10-12', conversationId: null, name: null, prepared: null, sourceDir: '/home/Abu Plugins/a', marketplace: 'author-a', key: null };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createPluginAuthor).mockResolvedValue(draft);
  vi.mocked(listPluginAuthors).mockResolvedValue([draft]);
  vi.mocked(bindPluginAuthor).mockResolvedValue(draft);
  resetShell();
});

describe('创建插件', () => {
  it('started inside an app: the conversation belongs to no app and the shell is the general one', async () => {
    enterShop();
    useSettingsStore.getState().openExtensions('plugins');

    await usePluginAuthorStore.getState().create({ leaveApp: true });

    expect(useAppStore.getState().selectedAppId).toBe(GENERAL_APP_ID);
    const conversation = activeConversation()!;
    expect(conversation.workspacePath).toBe(draft.sourceDir);
    expect(conversation.appBinding).toBeUndefined();
    expect(conversation.teamId).toBeUndefined();
    expect(useChatStore.getState().conversationIndex[conversation.id].appBinding).toBeUndefined();
    expect(useChatStore.getState().conversationIndex[conversation.id].teamId).toBeUndefined();
    expect(bindPluginAuthor).toHaveBeenCalledWith(draft.id, conversation.id, null);
    expect(useSettingsStore.getState().viewMode).toBe('chat');
  });

  it('an organization that keeps its employee in the app: the shell stays there and the conversation still belongs to no app', async () => {
    enterShop();
    useSettingsStore.getState().openExtensions('plugins');

    await usePluginAuthorStore.getState().create({ leaveApp: false });

    expect(useAppStore.getState().selectedAppId).toBe(shop.appId);
    expect(activeConversation()!.appBinding).toBeUndefined();
    expect(activeConversation()!.teamId).toBeUndefined();
    expect(useSettingsStore.getState().viewMode).toBe('chat');
  });

  it('carries no team of the app when a conversation of the app was opened before', async () => {
    enterShop();
    // Opening a conversation from the sidebar drops the binding and keeps the team.
    useChatStore.getState().setPendingAppBinding(undefined);
    useSettingsStore.getState().openExtensions('plugins');

    await usePluginAuthorStore.getState().create({ leaveApp: false });

    expect(activeConversation()!.teamId).toBeUndefined();
  });

  it('started in the general shell: the creation conversation opens on the chat page with its prompt', async () => {
    useSettingsStore.getState().openExtensions('plugins');

    await usePluginAuthorStore.getState().create({ leaveApp: true });

    expect(useAppStore.getState().selectedAppId).toBe(GENERAL_APP_ID);
    const conversation = activeConversation()!;
    expect(conversation.workspacePath).toBe(draft.sourceDir);
    expect(conversation.title).toBe('Create plugin: Draft');
    expect(conversation.appBinding).toBeUndefined();
    expect(useChatStore.getState().pendingInput).toMatch(/^\/abu-plugin-builder /);
    expect(useSettingsStore.getState().viewMode).toBe('chat');
  });

  it('a draft whose conversation was deleted, edited inside an app: its new conversation follows the same rule', async () => {
    enterShop();
    useSettingsStore.getState().openExtensions('plugins');

    await usePluginAuthorStore.getState().edit({ ...draft, conversationId: 'deleted', name: 'demo' }, { leaveApp: true });

    expect(useAppStore.getState().selectedAppId).toBe(GENERAL_APP_ID);
    expect(activeConversation()!.appBinding).toBeUndefined();
    expect(activeConversation()!.teamId).toBeUndefined();
    expect(bindPluginAuthor).toHaveBeenCalledWith(draft.id, activeConversation()!.id, 'deleted');
  });
});
