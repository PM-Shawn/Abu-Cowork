import { createRoot, type Root } from 'react-dom/client';
import { DesignPreview } from '@/components/design-preview/DesignPreview';

// Cmd+Option+Shift+D on macOS, Ctrl+Alt+Shift+D on Windows/Linux.
export const DESIGN_PREVIEW_SHORTCUT = { code: 'KeyD', alt: true, shift: true } as const;

function isShortcut(event: KeyboardEvent): boolean {
  return event.code === DESIGN_PREVIEW_SHORTCUT.code
    && event.altKey
    && event.shiftKey
    && (event.metaKey || event.ctrlKey);
}

export function installDesignPreview(): () => void {
  let host: HTMLDivElement | null = null;
  let root: Root | null = null;

  const close = () => {
    root?.unmount();
    host?.remove();
    root = null;
    host = null;
  };

  const open = () => {
    host = document.createElement('div');
    host.setAttribute('data-design-preview-host', '');
    host.setAttribute('data-electron-no-drag', '');
    // eslint-disable-next-line no-restricted-syntax -- the preview itself is the full-window layer
    host.className = 'fixed inset-0 z-tooltip';
    document.body.appendChild(host);
    root = createRoot(host);
    root.render(<DesignPreview portalContainer={host} />);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (isShortcut(event)) {
      event.preventDefault();
      if (host) close(); else open();
      return;
    }
    if (event.key === 'Escape' && host) {
      // An open menu, popover or dialog inside the preview handles its own Escape.
      if (host.querySelector('[data-ds-layer]')) return;
      // Keep Escape from reaching the app's own handlers behind the preview.
      event.preventDefault();
      // Immediate: other window capture listeners (e.g. dialogs) must not see it either.
      event.stopImmediatePropagation();
      close();
    }
  };

  // Capture phase on window runs before any app handler, so stopPropagation takes effect.
  window.addEventListener('keydown', onKeyDown, { capture: true });
  return () => {
    window.removeEventListener('keydown', onKeyDown, { capture: true });
    close();
  };
}
