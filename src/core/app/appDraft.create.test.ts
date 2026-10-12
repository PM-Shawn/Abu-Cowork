import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir } from '@tauri-apps/plugin-fs';
import type { AppDefinition, ConversationAppBinding } from '@/types/app';
import { GENERAL_APP_ID } from '@/types/app';
import { DEFAULT_APP_CONFIG } from '@/data/defaultAppConfig';
import { useAppStore } from '@/stores/appStore';
import { useAppDraftStore } from '@/stores/appDraftStore';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { createAppDraft } from './appDraft';

// 「创建应用」 is an activity of the general shell: the creation conversation is
// the page in view, it belongs to no app, and the shell leaves the app it was
// started from unless the organization keeps the employee in it.
const shop: AppDefinition = {
  appId: 'shop@abu-examples', name: 'Shop desk', config: DEFAULT_APP_CONFIG, version: '1.0.0',
  origin: { kind: 'market', market: 'abu-examples' }, plugins: [],
};
const shopBinding: ConversationAppBinding = {
  version: 2, appId: shop.appId, appVersion: '1.0.0', origin: 'market', appName: shop.name, modeId: 'default',
  promptAppend: 'The user runs an online shop.',
};

const created = () => {
  const chat = useChatStore.getState();
  return chat.conversations[chat.activeConversationId!];
};

beforeEach(() => {
  vi.mocked(mkdir).mockReset().mockResolvedValue(undefined);
  useChatStore.setState({ conversations: {}, conversationIndex: {}, activeConversationId: null, pendingAppBinding: undefined, pendingTeamId: undefined, pendingInput: null });
  useAppDraftStore.setState({ draftsByConversation: {} });
  useAppStore.setState({ addedApps: [], managedApps: {}, recentAppIds: [], seenAppIds: {}, selectedAppId: GENERAL_APP_ID, activeAppPage: null });
  useSettingsStore.setState({ viewMode: 'chat' });
});

describe('createAppDraft', () => {
  it('shows the creation conversation when another page was in view', async () => {
    useSettingsStore.setState({ viewMode: 'extensions' });
    await createAppDraft({ leaveApp: true });
    expect(useSettingsStore.getState().viewMode).toBe('chat');
    const conversation = created();
    expect(conversation.title).toBe('Create app');
    expect(useAppDraftStore.getState().draftsByConversation[conversation.id]?.dir).toBe(conversation.workspacePath);
    expect(useChatStore.getState().pendingInput).toMatch(/^\/abu-app-builder /);
  });

  it('started inside an app: the conversation belongs to no app and the shell is the general one', async () => {
    useAppStore.setState({ addedApps: [shop], seenAppIds: { [shop.appId]: true } });
    useAppStore.getState().enterApp(shop.appId);
    // What the app's home keeps ready for the next conversation the user starts there.
    useChatStore.getState().setPendingAppBinding(shopBinding);
    useChatStore.getState().setPendingTeamId('team-shop');

    await createAppDraft({ leaveApp: true });

    expect(useAppStore.getState().selectedAppId).toBe(GENERAL_APP_ID);
    const conversation = created();
    expect(conversation.appBinding).toBeUndefined();
    expect(conversation.teamId).toBeUndefined();
    expect(useChatStore.getState().conversationIndex[conversation.id].appBinding).toBeUndefined();
    expect(useSettingsStore.getState().viewMode).toBe('chat');
  });

  it('an organization that keeps its employee in the app: the shell stays there and the conversation still belongs to no app', async () => {
    useAppStore.setState({ addedApps: [shop], seenAppIds: { [shop.appId]: true } });
    useAppStore.getState().enterApp(shop.appId);
    useChatStore.getState().setPendingAppBinding(shopBinding);
    useChatStore.getState().setPendingTeamId('team-shop');
    useSettingsStore.setState({ viewMode: 'team' });

    await createAppDraft({ leaveApp: false });

    expect(useAppStore.getState().selectedAppId).toBe(shop.appId);
    const conversation = created();
    expect(conversation.appBinding).toBeUndefined();
    expect(conversation.teamId).toBeUndefined();
    expect(useSettingsStore.getState().viewMode).toBe('chat');
  });

  it('leaves the page and the app as they are when the draft folder cannot be made', async () => {
    useAppStore.setState({ addedApps: [shop], seenAppIds: { [shop.appId]: true } });
    useAppStore.getState().enterApp(shop.appId);
    useSettingsStore.setState({ viewMode: 'extensions' });
    vi.mocked(mkdir).mockRejectedValue(new Error('EACCES: permission denied, mkdir /Users/testuser/Abu Apps'));

    await expect(createAppDraft({ leaveApp: true })).rejects.toThrow('EACCES');

    expect(useAppStore.getState().selectedAppId).toBe(shop.appId);
    expect(useSettingsStore.getState().viewMode).toBe('extensions');
    expect(useChatStore.getState().activeConversationId).toBeNull();
  });
});
