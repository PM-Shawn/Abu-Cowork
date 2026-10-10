import { useEffect, useState } from 'react';
import { exists } from '@/core/tools/fsBridge';
import type { PresentedFile } from '@/utils/presentedFiles';

const NO_FILES: PresentedFile[] = [];

interface DiskCheck {
  key: string;
  files: PresentedFile[];
}

/**
 * The presented files that are on disk right now, in their declared order.
 *
 * `null` means the check for this list has not answered yet. While `enabled`
 * is false the result is an empty list and nothing is read from disk. The
 * list is checked when it changes and each time the window regains focus.
 */
export function usePresentFilesOnDisk(files: readonly PresentedFile[], enabled: boolean): PresentedFile[] | null {
  // Callers pass a fresh array per render; the serialized list is the identity.
  const key = JSON.stringify(files);
  const active = enabled && files.length > 0;
  const [check, setCheck] = useState<DiskCheck | null>(null);

  useEffect(() => {
    if (!active) return;
    const declared = JSON.parse(key) as PresentedFile[];
    let cancelled = false;
    let latestRun = 0;

    const run = async () => {
      const runId = ++latestRun;
      const present = await Promise.all(declared.map((file) => exists(file.path)));
      if (cancelled || runId !== latestRun) return;
      setCheck({ key, files: declared.filter((_, index) => present[index]) });
    };

    void run();
    const onFocus = () => { void run(); };
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
    };
  }, [key, active]);

  if (!active) return NO_FILES;
  return check !== null && check.key === key ? check.files : null;
}
