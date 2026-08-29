import { useCallback, useEffect, useState, useRef, type DragEvent as ReactDragEvent } from 'react';
import { listen, TauriEvent } from '@tauri-apps/api/event';
import { isTauriEnv } from '@/utils/tauriEnv';
import { getElectronFilePath, hasElectronCommandHost, type ElectronUserAttachmentToken } from '@/utils/electronHost';

interface DragDropPayload {
  paths: string[];
  position: { x: number; y: number };
}

/** Debounce window to deduplicate rapid DRAG_DROP events (ms) */
const DROP_DEBOUNCE_MS = 300;

type FileDropHandler = (
  paths: string[],
  attachments?: ElectronUserAttachmentToken[],
) => void | Promise<void>;

export interface FileDragDropAdmissionOptions {
  /** Called in the native drop event, before any asynchronous authorization. */
  onAdmissionStart?: () => (() => void);
  /** Reports native path or opaque-token admission failures to the user. */
  onAdmissionError?: () => void;
}

export function useFileDragDrop(
  onDrop: FileDropHandler,
  admissionOptions: FileDragDropAdmissionOptions = {},
) {
  const [isDragging, setIsDragging] = useState(false);
  const onDropRef = useRef(onDrop);
  const admissionOptionsRef = useRef(admissionOptions);
  // Sync ref during render to avoid stale closure — useEffect would leave a timing gap
  // eslint-disable-next-line react-hooks/refs
  onDropRef.current = onDrop;
  // eslint-disable-next-line react-hooks/refs
  admissionOptionsRef.current = admissionOptions;

  const lastDropTimeRef = useRef(0);
  const lastDropPathsRef = useRef<string>('');
  const dragDepthRef = useRef(0);

  const deliverPaths = useCallback(async (
    paths: string[],
    attachments: ElectronUserAttachmentToken[] = [],
    callback: FileDropHandler = onDropRef.current,
  ): Promise<void> => {
    if (paths.length === 0 && attachments.length === 0) return;

    // Deduplicate rapid duplicate drop events
    const now = Date.now();
    const key = `${paths.join('|')}::${attachments.map((attachment) => attachment.token).join('|')}`;
    if (now - lastDropTimeRef.current < DROP_DEBOUNCE_MS && key === lastDropPathsRef.current) {
      return;
    }
    lastDropTimeRef.current = now;
    lastDropPathsRef.current = key;

    if (attachments.length > 0) {
      await callback(paths, attachments);
    } else {
      await callback(paths);
    }
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

    const files = Array.from(event.dataTransfer.files);
    if (files.length === 0) return;
    const dropStartedWithCallback = onDropRef.current;
    const admissionAtDropStart = admissionOptionsRef.current;
    const finishAdmission = admissionAtDropStart.onAdmissionStart?.();
    void (async () => {
      const paths: string[] = [];
      const attachments: ElectronUserAttachmentToken[] = [];
      let admissionFailed = false;
      try {
        for (const file of files) {
          const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
          if (isPdf) { admissionFailed = true; continue; }
          try {
            const path = getElectronFilePath(file);
            if (path) paths.push(path);
            else admissionFailed = true;
          } catch {
            // Synthetic/no-native-path file; fail closed.
            admissionFailed = true;
          }
        }
        await deliverPaths(paths, attachments, dropStartedWithCallback);
        if (admissionFailed) admissionAtDropStart.onAdmissionError?.();
      } catch {
        admissionAtDropStart.onAdmissionError?.();
      } finally {
        finishAdmission?.();
      }
    })();
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
          const callbackAtDropStart = onDropRef.current;
          const admissionAtDropStart = admissionOptionsRef.current;
          const finishAdmission = admissionAtDropStart.onAdmissionStart?.();
          void deliverPaths(event.payload.paths, [], callbackAtDropStart)
            .catch(() => admissionAtDropStart.onAdmissionError?.())
            .finally(() => finishAdmission?.());
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
