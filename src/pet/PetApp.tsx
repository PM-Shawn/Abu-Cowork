import { useCallback, useEffect, useState } from 'react';
import { listen, TauriEvent } from '@tauri-apps/api/event';
import abuAvatar from '@/assets/abu-avatar.png';
import StatusLight from './StatusLight';
import MiniInput from './MiniInput';
import { useStatusLight } from './useStatusLight';
import { usePetDrag } from './usePetDrag';
import { useClickMenu } from './useClickMenu';
import {
  emitDropFiles,
  emitFocusMain,
  emitOpenSettings,
  petResize,
  petHideSelf,
  quitApp,
} from './petBridge';

const PET_SIZE = 80;
const EXPANDED_WIDTH = 420;
const EXPANDED_HEIGHT = 180;

interface DropPayload {
  paths: string[];
}

/**
 * Desktop pet root (Phase C).
 *
 * Layout modes:
 * - collapsed (80×80): just the avatar
 * - expanded (420×180): avatar on the left, MiniInput to the right
 *
 * Interactions:
 * - left-click  → expand (after 260ms to disambiguate from dblclick)
 * - dblclick    → focus main window, stay collapsed
 * - right-click → context menu (settings / hide / quit)
 * - file drop (collapsed) → forward to main, open new conv with files
 * - file drop (expanded) → add to MiniInput chips
 */
export default function PetApp() {
  const dragRef = usePetDrag<HTMLDivElement>();
  const status = useStatusLight();
  const [expanded, setExpanded] = useState(false);
  const [droppedFiles, setDroppedFiles] = useState<string[]>([]);

  const expand = useCallback(async () => {
    setExpanded(true);
    await petResize(EXPANDED_WIDTH, EXPANDED_HEIGHT);
  }, []);

  const collapse = useCallback(async () => {
    setExpanded(false);
    setDroppedFiles([]);
    await petResize(PET_SIZE, PET_SIZE);
  }, []);

  const { menuPos, closeMenu, handlers } = useClickMenu({
    onSingleClick: () => void expand(),
    onDoubleClick: () => {
      void emitFocusMain();
    },
  });

  // File drops on the pet window.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    listen<DropPayload>(TauriEvent.DRAG_DROP, (event) => {
      const paths = event.payload.paths;
      if (!paths || paths.length === 0) return;

      if (expanded) {
        // Accumulate into mini-input chips.
        setDroppedFiles((prev) => Array.from(new Set([...prev, ...paths])));
      } else {
        // Strong intent: skip mini input, go straight to main.
        void emitDropFiles(paths);
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [expanded]);

  const removeFile = useCallback((path: string) => {
    setDroppedFiles((prev) => prev.filter((p) => p !== path));
  }, []);

  return (
    <div
      style={{
        position: 'relative',
        width: '100vw',
        height: '100vh',
        overflow: 'hidden',
      }}
    >
      <div
        ref={dragRef}
        {...handlers}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: PET_SIZE,
          height: PET_SIZE,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'transparent',
          cursor: 'grab',
        }}
      >
        <img
          src={abuAvatar}
          alt="Abu"
          draggable={false}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            pointerEvents: 'none',
          }}
        />
        <StatusLight status={status} />
      </div>

      {expanded && (
        <MiniInput
          files={droppedFiles}
          onRemoveFile={removeFile}
          onClose={() => void collapse()}
          onAfterSend={() => void collapse()}
        />
      )}

      {menuPos && (
        <ul
          role="menu"
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            top: menuPos.y,
            left: menuPos.x,
            minWidth: 140,
            background: 'rgba(28, 26, 24, 0.95)',
            color: '#f5f3ef',
            borderRadius: 8,
            padding: 4,
            margin: 0,
            listStyle: 'none',
            boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
            fontSize: 12,
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            zIndex: 999,
          }}
        >
          <MenuItem onClick={() => { void emitOpenSettings(); closeMenu(); }}>打开设置</MenuItem>
          <MenuItem onClick={() => { void petHideSelf(); closeMenu(); }}>隐藏桌宠</MenuItem>
          <MenuItem onClick={() => { void quitApp(); }}>退出 Abu</MenuItem>
        </ul>
      )}
    </div>
  );
}

function MenuItem({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <li
      role="menuitem"
      onClick={onClick}
      style={{
        padding: '6px 10px',
        borderRadius: 4,
        cursor: 'pointer',
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLLIElement).style.background = 'rgba(255,255,255,0.1)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLLIElement).style.background = 'transparent';
      }}
    >
      {children}
    </li>
  );
}
