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

// True while a legacy blocking modal is on screen: a command, file or workspace approval of
// the conversation in view, a task's capability grant window, or the close-window question.
// A design-system dialog is modal (everything outside it is inert), so the settings window
// closes itself while this is true.
// Remove with batch 8, when those modals become design-system dialogs.
export function useBlockingApprovalVisible(): boolean {
  const appModalOpen = usePreviewStore((s) => s.appModalOpen);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const command = useSyncExternalStore(subscribeToCommandConfirmation, getPendingCommandConfirmation);
  const file = useSyncExternalStore(subscribeToFilePermission, getPendingFilePermission);
  const workspace = useSyncExternalStore(subscribeToWorkspaceRequest, getPendingWorkspaceRequest);
  const capabilitySetup = useSyncExternalStore(subscribeCapabilitySetup, getPendingCapabilitySetup);
  return hasVisibleBlockingApproval(activeConversationId, [command, file, workspace], capabilitySetup !== null || appModalOpen);
}
