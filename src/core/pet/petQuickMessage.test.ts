import { beforeEach, describe, expect, it } from 'vitest';
import { GENERAL_APP_ID } from '@/types/app';
import { useAppStore } from '@/stores/appStore';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { SHOP_TEAM_ID, activeConversation, enterShop, resetShell, shop, shopBinding } from '@/test/appShellFixtures';
import { petMessageConversation } from './petQuickMessage';

beforeEach(resetShell);

describe('petMessageConversation', () => {
  describe('with no conversation open', () => {
    it('inside an app: starts a conversation that belongs to no app, in the general shell', () => {
      enterShop();

      const id = petMessageConversation(null, { leaveApp: true });

      expect(useAppStore.getState().selectedAppId).toBe(GENERAL_APP_ID);
      expect(useChatStore.getState().activeConversationId).toBe(id);
      expect(activeConversation()!.appBinding).toBeUndefined();
      expect(activeConversation()!.teamId).toBeUndefined();
      expect(useChatStore.getState().conversationIndex[id].appBinding).toBeUndefined();
    });

    it('an organization that keeps its employee in the app: the shell stays there and the conversation still belongs to no app', () => {
      enterShop();
      useSettingsStore.setState({ viewMode: 'team' });

      const id = petMessageConversation(undefined, { leaveApp: false });

      expect(useAppStore.getState().selectedAppId).toBe(shop.appId);
      expect(useSettingsStore.getState().viewMode).toBe('team');
      expect(useChatStore.getState().activeConversationId).toBe(id);
      expect(activeConversation()!.appBinding).toBeUndefined();
      expect(activeConversation()!.teamId).toBeUndefined();
    });

    it('a notice whose conversation is not loaded starts one the same way', () => {
      enterShop();

      const id = petMessageConversation('unloaded-conversation', { leaveApp: true });

      expect(id).not.toBe('unloaded-conversation');
      expect(useAppStore.getState().selectedAppId).toBe(GENERAL_APP_ID);
      expect(activeConversation()!.appBinding).toBeUndefined();
    });

    it('in the general shell: starts a conversation with no workspace and leaves the page in view', () => {
      useSettingsStore.setState({ viewMode: 'automation' });

      const id = petMessageConversation(null, { leaveApp: true });

      expect(useAppStore.getState().selectedAppId).toBe(GENERAL_APP_ID);
      expect(useSettingsStore.getState().viewMode).toBe('automation');
      expect(useChatStore.getState().activeConversationId).toBe(id);
      expect(activeConversation()!.workspacePath).toBeNull();
      expect(activeConversation()!.appBinding).toBeUndefined();
    });
  });

  describe('with a conversation open', () => {
    it('goes to the open conversation of an app and leaves the shell in that app', () => {
      enterShop();
      const open = useChatStore.getState().createConversation(null);

      expect(petMessageConversation(null, { leaveApp: true })).toBe(open);

      expect(useAppStore.getState().selectedAppId).toBe(shop.appId);
      expect(useChatStore.getState().activeConversationId).toBe(open);
      expect(Object.keys(useChatStore.getState().conversations)).toEqual([open]);
      expect(activeConversation()!.appBinding).toEqual(shopBinding);
      expect(activeConversation()!.teamId).toBe(SHOP_TEAM_ID);
    });

    it('a reply to a notice goes to the conversation the notice pointed at, whichever is open', () => {
      const noticed = useChatStore.getState().createConversation(null);
      const open = useChatStore.getState().createConversation(null);
      enterShop();
      useChatStore.setState({ activeConversationId: open });

      expect(petMessageConversation(noticed, { leaveApp: true })).toBe(noticed);

      expect(useAppStore.getState().selectedAppId).toBe(shop.appId);
      expect(useChatStore.getState().activeConversationId).toBe(open);
      expect(useChatStore.getState().pendingAppBinding).toEqual(shopBinding);
    });

    it('a reply to a notice whose conversation is not loaded goes to the open one', () => {
      const open = useChatStore.getState().createConversation(null);

      expect(petMessageConversation('unloaded-conversation', { leaveApp: true })).toBe(open);
    });
  });
});
