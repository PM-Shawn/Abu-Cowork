import { beforeEach, describe, expect, it } from 'vitest';
import { GENERAL_APP_ID } from '@/types/app';
import { useAppStore } from '@/stores/appStore';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { SHOP_TEAM_ID, activeConversation, enterShop, holdShopPicks, resetShell, shop } from '@/test/appShellFixtures';
import { createGeneralShellConversation } from './generalShellConversation';

beforeEach(resetShell);

describe('createGeneralShellConversation', () => {
  it('started inside an app: the conversation belongs to no app and the shell is the general one', () => {
    enterShop();

    const id = createGeneralShellConversation('/work/draft', { leaveApp: true });

    expect(useAppStore.getState().selectedAppId).toBe(GENERAL_APP_ID);
    expect(useChatStore.getState().activeConversationId).toBe(id);
    const conversation = activeConversation()!;
    expect(conversation.workspacePath).toBe('/work/draft');
    expect(conversation.appBinding).toBeUndefined();
    expect(conversation.teamId).toBeUndefined();
    expect(useChatStore.getState().conversationIndex[id].appBinding).toBeUndefined();
    expect(useChatStore.getState().conversationIndex[id].teamId).toBeUndefined();
  });

  it('an organization that keeps its employee in the app: the shell stays there and the conversation still belongs to no app', () => {
    enterShop();
    useSettingsStore.setState({ viewMode: 'extensions' });

    createGeneralShellConversation(null, { leaveApp: false });

    expect(useAppStore.getState().selectedAppId).toBe(shop.appId);
    expect(useSettingsStore.getState().viewMode).toBe('extensions');
    expect(activeConversation()!.appBinding).toBeUndefined();
    expect(activeConversation()!.teamId).toBeUndefined();
  });

  it('carries no team of the app when only the team is still held ready', () => {
    enterShop();
    // Opening a conversation from the sidebar drops the binding and keeps the team.
    useChatStore.getState().setPendingAppBinding(undefined);

    createGeneralShellConversation(null, { leaveApp: false });

    expect(activeConversation()!.teamId).toBeUndefined();
  });

  it('started in the general shell: the shell and the page in view stay as they are', () => {
    useSettingsStore.setState({ viewMode: 'extensions' });

    const id = createGeneralShellConversation('/work/draft', { leaveApp: true });

    expect(useAppStore.getState().selectedAppId).toBe(GENERAL_APP_ID);
    expect(useSettingsStore.getState().viewMode).toBe('extensions');
    expect(useChatStore.getState().activeConversationId).toBe(id);
    expect(activeConversation()!.workspacePath).toBe('/work/draft');
    expect(activeConversation()!.appBinding).toBeUndefined();
  });

  it('an ordinary conversation started inside the app is bound to it, before and after', () => {
    enterShop();
    const first = useChatStore.getState().createConversation(null);
    expect(useChatStore.getState().conversations[first].appBinding).toMatchObject({ appId: shop.appId });
    expect(useChatStore.getState().conversations[first].teamId).toBe(SHOP_TEAM_ID);

    createGeneralShellConversation(null, { leaveApp: false });
    // 新任务 brings the home back into view, and the home holds its picks again.
    useChatStore.getState().startNewConversation();
    holdShopPicks();
    const next = useChatStore.getState().createConversation(null);

    expect(useChatStore.getState().conversations[next].appBinding).toMatchObject({ appId: shop.appId });
    expect(useChatStore.getState().conversations[next].teamId).toBe(SHOP_TEAM_ID);
  });
});
