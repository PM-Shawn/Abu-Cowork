import { onOpenUrl } from '@tauri-apps/plugin-deep-link';

let listener: Promise<void> | null = null;

/**
 * Install the account callback listener lazily, immediately before opening the
 * browser. A callback cannot be resumed after process restart because its PKCE
 * verifier intentionally lives only in memory.
 */
export function ensureAccountDeepLinkListener(
  handleUrl: (url: string) => Promise<boolean>,
): Promise<void> {
  if (listener) return listener;
  listener = onOpenUrl((urls) => {
    for (const url of urls) void handleUrl(url);
  }).then(() => undefined).catch((error) => {
    listener = null;
    throw error;
  });
  return listener;
}

export function __resetAccountDeepLinkListenerForTest(): void {
  listener = null;
}
