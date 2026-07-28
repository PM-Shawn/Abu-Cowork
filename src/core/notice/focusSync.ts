import { getCurrentWindow } from '@tauri-apps/api/window';
import { clearDockBadge } from '@/utils/notifications';
import { useNoticeMenubarStore } from '@/stores/noticeMenubarStore';
import { setFocused } from './contextProvider';

function clearAttentionIndicators(): void {
  clearDockBadge();
  useNoticeMenubarStore.getState().dismissAll();
}

/**
 * Synchronize notice focus state with both native-window and renderer focus.
 *
 * Electron normally delivers both signals, but startup/reload timing can lose
 * the native subscription event. The DOM signal is a clearing fallback only;
 * queued inbox draining remains on native focus so one focus transition cannot
 * dispatch the same pending notice twice.
 */
export function installNoticeFocusSync(onNativeFocused: () => void): () => void {
  let cancelled = false;
  let unlistenNative: (() => void) | null = null;

  const handleRendererFocus = () => {
    setFocused(true);
    clearAttentionIndicators();
  };

  window.addEventListener('focus', handleRendererFocus);

  getCurrentWindow()
    .onFocusChanged(({ payload: focused }) => {
      setFocused(focused);
      if (!focused) return;
      clearAttentionIndicators();
      onNativeFocused();
    })
    .then((unlisten) => {
      if (cancelled) unlisten();
      else unlistenNative = unlisten;
    })
    .catch(() => {
      // Renderer focus remains as the fail-soft clearing path.
    });

  return () => {
    cancelled = true;
    window.removeEventListener('focus', handleRendererFocus);
    unlistenNative?.();
  };
}
