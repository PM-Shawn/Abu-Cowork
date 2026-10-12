import { GENERAL_APP_ID } from '@/types/app';
import { useAppStore } from '@/stores/appStore';
import { useChatStore } from '@/stores/chatStore';

/**
 * Create a conversation that belongs to the general shell, make it the active
 * one, and return its id.
 *
 * Creating an app, creating a plugin and a message typed into the pet with no
 * conversation open are activities of the general shell, whichever app the
 * shell shows when they start. The conversation carries no app binding and no
 * team of an app home, and the shell leaves that app (`leaveApp`); an
 * organization that keeps its employees inside its app passes `false`, and the
 * conversation opens there, still unbound.
 */
export function createGeneralShellConversation(workspacePath: string | null, { leaveApp }: { leaveApp: boolean }): string {
  const apps = useAppStore.getState();
  if (leaveApp && apps.selectedAppId !== GENERAL_APP_ID) apps.exitApp();
  const chat = useChatStore.getState();
  // An app home keeps its binding and its team ready for the next conversation started there.
  chat.setPendingAppBinding(undefined);
  chat.setPendingTeamId(undefined);
  return chat.createConversation(workspacePath);
}
