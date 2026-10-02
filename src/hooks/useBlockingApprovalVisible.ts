import { useSyncExternalStore } from 'react';
import { hasVisibleBlockingApproval } from '@/core/browser/nativeBrowserVisibility';
import {
  getPendingCommandConfirmation,
  getPendingFilePermission,
  getPendingWorkspaceRequest,
  subscribeToCommandConfirmation,
  subscribeToFilePermission,
  subscribeToWorkspaceRequest,
} from '@/core/agent/permissionBridge';
import { getPendingCapabilitySetup, subscribeCapabilitySetup } from '@/core/capabilityPlugins/setupBridge';
import { useChatStore } from '@/stores/chatStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useSettingsStore } from '@/stores/settingsStore';

// True while a legacy blocking modal is on screen: a command, file or workspace approval of
// the conversation in view (the chat view draws them, so only while that view is in front),
// a task's capability grant window, or the close-window question.
// A design-system dialog is modal (everything outside it is inert), so the settings window
// closes itself while this is true.
// Remove with batch 8, when those modals become design-system dialogs.
export function useBlockingApprovalVisible(): boolean {
  const appModalOpen = usePreviewStore((s) => s.appModalOpen);
  const chatInView = useSettingsStore((s) => s.viewMode === 'chat' || !s.viewMode);
  const conversationInView = useChatStore((s) => s.activeConversationId);
  const activeConversationId = chatInView ? conversationInView : null;
  const command = useSyncExternalStore(subscribeToCommandConfirmation, getPendingCommandConfirmation);
  const file = useSyncExternalStore(subscribeToFilePermission, getPendingFilePermission);
  const workspace = useSyncExternalStore(subscribeToWorkspaceRequest, getPendingWorkspaceRequest);
  const capabilitySetup = useSyncExternalStore(subscribeCapabilitySetup, getPendingCapabilitySetup);
  return hasVisibleBlockingApproval(activeConversationId, [command, file, workspace], capabilitySetup !== null || appModalOpen);
}
