import { useCallback, useEffect, useState, useRef, type DragEvent as ReactDragEvent } from 'react';
import { listen, TauriEvent } from '@tauri-apps/api/event';
import { isTauriEnv } from '@/utils/tauriEnv';
import { getElectronFilePath, hasElectronCommandHost } from '@/utils/electronHost';

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
  const dragDepthRef = useRef(0);

  const deliverPaths = useCallback((paths: string[]) => {
    if (paths.length === 0) return;

    // Deduplicate rapid duplicate drop events
    const now = Date.now();
    const key = paths.join('|');
    if (now - lastDropTimeRef.current < DROP_DEBOUNCE_MS && key === lastDropPathsRef.current) {
      return;
    }
    lastDropTimeRef.current = now;
    lastDropPathsRef.current = key;

    onDropRef.current(paths);
  }, []);

  const electronHost = hasElectronCommandHost();
  const containsFiles = (event: ReactDragEvent<HTMLElement>) =>
    Array.from(event.dataTransfer.types ?? []).includes('Files');

  const handleDragEnter = (event: ReactDragEvent<HTMLElement>) => {
    if (!containsFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current += 1;
    setIsDragging(true);
  };

  const handleDragOver = (event: ReactDragEvent<HTMLElement>) => {
    if (!containsFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    setIsDragging(true);
  };

  const handleDragLeave = (event: ReactDragEvent<HTMLElement>) => {
    if (!isDragging) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDragging(false);
    }
  };

  const handleDrop = (event: ReactDragEvent<HTMLElement>) => {
    if (!containsFiles(event) && !isDragging) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = 0;
    setIsDragging(false);

    const paths = Array.from(event.dataTransfer.files).flatMap((file) => {
      try {
        const path = getElectronFilePath(file);
        return path ? [path] : [];
      } catch {
        return [];
      }
    });
    deliverPaths(paths);
  };

  useEffect(() => {

    // Electron intentionally exposes the Tauri compatibility marker as well,
    // so this branch must run before isTauriEnv(). Native Chromium drag events
    // are the source of truth for files dragged in from Finder / Explorer.
    if (hasElectronCommandHost()) return;

    if (!isTauriEnv()) return; // web / E2E: no desktop file-drag-drop API
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
          deliverPaths(event.payload.paths);
        })
      );
    }

    setup();
    return () => unlisteners.forEach((fn) => fn());
  }, [deliverPaths]);

  return {
    isDragging,
    dropTargetProps: electronHost
      ? {
          onDragEnter: handleDragEnter,
          onDragOver: handleDragOver,
          onDragLeave: handleDragLeave,
          onDrop: handleDrop,
        }
      : {},
  };
}
