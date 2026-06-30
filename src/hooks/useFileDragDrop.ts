import { useEffect, useState, useRef } from 'react';
import { listen, TauriEvent } from '@tauri-apps/api/event';
import { isTauriEnv } from '@/utils/tauriEnv';

interface DragDropPayload {
  paths: string[];
  position: { x: number; y: number };
}

/** Debounce window to deduplicate rapid DRAG_DROP events (ms) */
const DROP_DEBOUNCE_MS = 300;

export function useFileDragDrop(onDrop: (paths: string[]) => void) {
  const [isDragging, setIsDragging] = useState(false);
  const onDropRef = useRef(onDrop);
  // Sync ref during render to avoid stale closure — useEffect would leave a timing gap
  // eslint-disable-next-line react-hooks/refs
  onDropRef.current = onDrop;

  const lastDropTimeRef = useRef(0);
  const lastDropPathsRef = useRef<string>('');

  useEffect(() => {
    if (!isTauriEnv()) return; // web / E2E: no Tauri file-drag-drop API
    const unlisteners: (() => void)[] = [];

    async function setup() {
      unlisteners.push(
        await listen<DragDropPayload>(TauriEvent.DRAG_ENTER, () => {
          setIsDragging(true);
        })
      );
      unlisteners.push(
        await listen<DragDropPayload>(TauriEvent.DRAG_LEAVE, () => {
          setIsDragging(false);
        })
      );
      unlisteners.push(
        await listen<DragDropPayload>(TauriEvent.DRAG_DROP, (event) => {
          setIsDragging(false);

          // Deduplicate rapid duplicate drop events
          const now = Date.now();
          const key = event.payload.paths.join('|');
          if (now - lastDropTimeRef.current < DROP_DEBOUNCE_MS && key === lastDropPathsRef.current) {
            return;
          }
          lastDropTimeRef.current = now;
          lastDropPathsRef.current = key;

          onDropRef.current(event.payload.paths);
        })
      );
    }

    setup();
    return () => unlisteners.forEach((fn) => fn());
  }, []);

  return { isDragging };
}
