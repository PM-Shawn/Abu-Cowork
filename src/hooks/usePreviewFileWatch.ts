/**
 * Preview File Watch — auto-refresh the preview panel on disk changes.
 *
 * Reverse of `core/agent/fileWatcher.ts` (which watches for changes to
 * *trigger* an Agent task): this watches the file currently open in the
 * preview panel and bumps `previewStore`'s `reloadNonce` so the panel
 * re-reads content when an Agent (or an external editor) writes it.
 *
 * Mirrors `core/agent/fileWatcher.ts`'s approach: watch the parent
 * directory (single-file `watch()` targets are less reliable across
 * platforms) and filter `event.paths` down to the target file's basename.
 * Also reuses its exists()-before-watch guard to avoid Tauri's
 * "resource id is invalid" error on a non-existent path.
 */
import { useEffect, useRef } from 'react';
import { watch, exists, type UnwatchFn } from '@tauri-apps/plugin-fs';
import { getBaseName, getParentDir } from '@/utils/pathUtils';
import { usePreviewStore } from '@/stores/previewStore';

const DEBOUNCE_MS = 250;

function isDataUrl(path: string): boolean {
  return path.startsWith('data:');
}

/**
 * Watch `filePath` for external changes and auto-refresh the preview panel.
 *
 * P2 note (in-panel editor autosave): once the editor writes the file itself,
 * that write will also land in this watcher (self-triggered refresh). If that
 * turns out to cause visible flicker / cursor loss, add a re-entrancy guard
 * here (e.g. a `suppressNextChange()` escape hatch set right before the
 * editor's own save call, checked — and cleared — in the watch callback
 * before scheduling the debounced refresh). Not needed for P1 (read-only
 * preview; only external writers touch the file).
 */
export function usePreviewFileWatch(filePath: string | null): void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!filePath || isDataUrl(filePath)) return;

    let unwatch: UnwatchFn | null = null;
    let cancelled = false;
    const targetName = getBaseName(filePath);
    const dir = getParentDir(filePath);

    const setup = async () => {
      try {
        // Validate the directory exists before creating a watcher resource —
        // avoids Tauri plugin-fs "resource id is invalid" on missing paths.
        const dirExists = await exists(dir);
        if (cancelled || !dirExists) return;

        unwatch = await watch(
          dir,
          (event) => {
            const touchesTarget = event.paths.some((p) => getBaseName(p) === targetName);
            if (!touchesTarget) return;

            if (timerRef.current) clearTimeout(timerRef.current);
            timerRef.current = setTimeout(() => {
              timerRef.current = null;
              usePreviewStore.getState().refreshPreview();
            }, DEBOUNCE_MS);
          },
          { recursive: false },
        );
        if (cancelled && unwatch) {
          unwatch();
          unwatch = null;
        }
      } catch (err) {
        console.error('[usePreviewFileWatch] Failed to start watcher:', err);
      }
    };

    setup();

    return () => {
      cancelled = true;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (unwatch) unwatch();
    };
  }, [filePath]);
}
