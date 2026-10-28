export interface ChromeNavigationPin {
  backend: 'chrome';
  action: 'back' | 'forward' | 'reload';
  sourceEntry: string;
  sourceUrl: string;
  targetEntry: string;
  targetUrl: string;
}

/** Runs wholly in the isolated world, with the native Navigation API. */
export function pageHistoryNavigation(action: string, approved: ChromeNavigationPin | null, expectedOrigin: string | null): ChromeNavigationPin | null {
  const navigation = (window as unknown as {
    navigation?: {
      currentEntry: { key: string; url: string; index: number } | null;
      entries(): Array<{ key: string; url: string; index: number }>;
      canGoBack: boolean;
      canGoForward: boolean;
      traverseTo(key: string): unknown;
    };
  }).navigation;
  if (!navigation || !['back', 'forward', 'reload'].includes(action)) return null;
  const source = navigation.currentEntry;
  if (!source || source.url !== location.href) return null;
  const offset = action === 'back' ? -1 : action === 'forward' ? 1 : 0;
  if ((offset < 0 && !navigation.canGoBack) || (offset > 0 && !navigation.canGoForward)) return null;
  const target = navigation.entries().find(entry => entry.index === source.index + offset);
  if (!target || !target.url || !target.key || !source.key) return null;
  const url = new URL(target.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hostname = url.hostname.replace(/\.+$/, '');
  const pin: ChromeNavigationPin = { backend: 'chrome', action: action as ChromeNavigationPin['action'],
    sourceEntry: source.key, sourceUrl: source.url, targetEntry: target.key, targetUrl: target.url };
  if (approved) {
    if (Object.keys(pin).some(key => pin[key as keyof ChromeNavigationPin] !== approved[key as keyof ChromeNavigationPin])
      || url.origin !== expectedOrigin) return null;
    if (action === 'reload') location.reload();
    else navigation.traverseTo(target.key);
  }
  return pin;
}

export async function probeHistoryNavigation(tabId: number, action: string): Promise<ChromeNavigationPin | null> {
  const results = await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED',
    func: pageHistoryNavigation, args: [action, null, null] });
  return results[0]?.result ?? null;
}

export async function executeHistoryNavigation(tabId: number, payload: Record<string, unknown>): Promise<void> {
  const approved = payload.navigation;
  if (!approved || typeof approved !== 'object' || typeof payload.expectedOrigin !== 'string') {
    throw new Error('origin-unverified: navigation requires a verified destination');
  }
  const results = await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED',
    func: pageHistoryNavigation, args: [String(payload.action), approved as ChromeNavigationPin, payload.expectedOrigin] });
  if (!results[0]?.result) throw new Error('origin-unverified: navigation destination changed or could not be verified');
}
