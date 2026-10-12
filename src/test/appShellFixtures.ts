import type { AppDefinition, ConversationAppBinding } from '@/types/app';
import { GENERAL_APP_ID } from '@/types/app';
import { DEFAULT_APP_CONFIG } from '@/data/defaultAppConfig';
import { useAppStore } from '@/stores/appStore';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';

/** An app the user added, and what its home keeps ready for the next conversation started there. */
export const shop: AppDefinition = {
  appId: 'shop@abu-examples', name: 'Shop desk', config: DEFAULT_APP_CONFIG, version: '1.0.0',
  origin: { kind: 'market', market: 'abu-examples' }, plugins: [],
};
export const shopBinding: ConversationAppBinding = {
  version: 2, appId: shop.appId, appVersion: '1.0.0', origin: 'market', appName: shop.name, modeId: 'default',
  promptAppend: 'The user runs an online shop.',
};
export const SHOP_TEAM_ID = 'team-shop';

/** The general shell on the chat page, with no conversation and nothing held ready. */
export function resetShell(): void {
  useChatStore.setState({ conversations: {}, conversationIndex: {}, activeConversationId: null, pendingAppBinding: undefined, pendingTeamId: undefined, pendingInput: null });
  useAppStore.setState({ addedApps: [], managedApps: {}, recentAppIds: [], seenAppIds: {}, selectedAppId: GENERAL_APP_ID, activeAppPage: null });
  useSettingsStore.setState({ viewMode: 'chat' });
}

/** Put the picks of the shop's home in place, as the home does while it shows with no conversation. */
export function holdShopPicks(): void {
  useChatStore.getState().setPendingAppBinding(shopBinding);
  useChatStore.getState().setPendingTeamId(SHOP_TEAM_ID);
}

/** Enter the shop, with its home in view. */
export function enterShop(): void {
  useAppStore.setState({ addedApps: [shop], seenAppIds: { [shop.appId]: true } });
  useAppStore.getState().enterApp(shop.appId);
  holdShopPicks();
}

export function activeConversation() {
  const chat = useChatStore.getState();
  return chat.activeConversationId === null ? undefined : chat.conversations[chat.activeConversationId];
}
