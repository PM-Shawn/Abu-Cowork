import { useSettingsStore } from '@/stores/settingsStore';
import { usePreviewStore } from '@/stores/previewStore';

/**
 * Is a React overlay up that a native `WebContentsView` would paint over?
 *
 * The signals are the ones `BrowserTab` hides its view for: the system
 * settings dialog, a workspace popover, and whatever the layer registry
 * reports as painted (`dsModalOpen`: every dialog, question, approval, viewer
 * and layered fullscreen surface, until its fade has ended). Any surface that
 * hosts a native view (the app page, the built-in browser) hides it while this
 * is true, since CSS stacking is invisible to the native layer.
 */
export function useNativeViewOcclusion(): boolean {
  const systemSettingsOpen = useSettingsStore((s) => s.systemSettingsOpen);
  const menuOpen = usePreviewStore((s) => s.menuOpen);
  const dsModalOpen = usePreviewStore((s) => s.dsModalOpen);
  return systemSettingsOpen || menuOpen || dsModalOpen;
}
