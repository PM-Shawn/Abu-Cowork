import { useSyncExternalStore } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useChatStore } from '@/stores/chatStore';
import { useImageLightboxStore } from '@/stores/imageLightboxStore';
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

/**
 * Is a React overlay up that a native `WebContentsView` would paint over?
 *
 * The signals are the ones `BrowserTab` hides its view for: the system
 * settings dialog, a workspace popover, an app-level modal, the image lightbox
 * and a blocking approval for the active conversation. Any surface that hosts
 * a native view (the app page, the built-in browser) hides it while this is
 * true, since CSS stacking is invisible to the native layer.
 */
export function useNativeViewOcclusion(): boolean {
  const systemSettingsOpen = useSettingsStore((s) => s.systemSettingsOpen);
  const menuOpen = usePreviewStore((s) => s.menuOpen);
  const appModalOpen = usePreviewStore((s) => s.appModalOpen);
  const lightboxOpen = useImageLightboxStore((s) => s.isOpen);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const commandApproval = useSyncExternalStore(subscribeToCommandConfirmation, getPendingCommandConfirmation);
  const fileApproval = useSyncExternalStore(subscribeToFilePermission, getPendingFilePermission);
  const workspaceApproval = useSyncExternalStore(subscribeToWorkspaceRequest, getPendingWorkspaceRequest);
  const capabilitySetup = useSyncExternalStore(subscribeCapabilitySetup, getPendingCapabilitySetup);
  const blockingApprovalOpen = hasVisibleBlockingApproval(
    activeConversationId,
    [commandApproval, fileApproval, workspaceApproval],
    capabilitySetup !== null || appModalOpen,
  );
  return systemSettingsOpen || menuOpen || appModalOpen || lightboxOpen || blockingApprovalOpen;
}
