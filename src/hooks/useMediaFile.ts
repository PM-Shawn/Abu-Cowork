import { useEffect, useState } from 'react';
import { invokeElectronMedia } from '@/utils/electronHost';
import type { MediaFileRef } from '@/types/media';

export interface MediaFileGrant {
  token: string;
  url: string;
  mimeType: string;
  byteLength: number;
}

export function useMediaFile(conversationId: string, filePath: string, revision = 0, fileRef?: MediaFileRef) {
  const captureId = fileRef?.captureId;
  const contentDigest = fileRef?.contentDigest;
  const key = `${conversationId}\0${filePath}\0${revision}\0${captureId ?? ''}\0${contentDigest ?? ''}`;
  const [loaded, setLoaded] = useState<{ key: string; grant?: MediaFileGrant; error?: Error }>();
  useEffect(() => {
    if (!conversationId) return;
    let disposed = false;
    let grant: MediaFileGrant | undefined;
    let renewal: ReturnType<typeof setInterval> | undefined;
    const release = (value: MediaFileGrant) => invokeElectronMedia<void>('release', { token: value.token });
    void invokeElectronMedia<MediaFileGrant>('open', { conversationId, fileRef: { originalPath: filePath, ...(captureId ? { captureId } : {}), ...(contentDigest ? { contentDigest } : {}) } }).then(
      value => {
        if (disposed) return release(value);
        grant = value;
        setLoaded({ key, grant: value });
        renewal = setInterval(() => {
          void invokeElectronMedia<void>('renew', { token: value.token }).then(undefined, error => {
            clearInterval(renewal);
            if (!disposed) setLoaded({ key, error: error instanceof Error ? error : new Error(String(error)) });
          });
        }, 2 * 60 * 1000);
      },
      error => { if (!disposed) setLoaded({ key, error: error instanceof Error ? error : new Error(String(error)) }); },
    );
    return () => { disposed = true; clearInterval(renewal); if (grant) void release(grant); };
  }, [conversationId, filePath, key, captureId, contentDigest]);
  return loaded?.key === key ? loaded : undefined;
}
