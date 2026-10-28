export type BrowserHistoryAction = 'back' | 'forward' | 'reload';

export interface BrowserNavigationPin {
  backend: 'built-in' | 'chrome';
  action: BrowserHistoryAction;
  sourceEntry: string;
  sourceUrl: string;
  targetEntry: string;
  targetUrl: string;
}

export function browserHistoryAction(input: Record<string, unknown>): BrowserHistoryAction | undefined {
  return input.action === 'back' || input.action === 'forward' || input.action === 'reload'
    ? input.action : undefined;
}

export function readBrowserNavigationPin(value: unknown, action: BrowserHistoryAction, backend: BrowserNavigationPin['backend']): BrowserNavigationPin | null {
  if (!value || typeof value !== 'object') return null;
  const pin = value as Record<string, unknown>;
  if (pin.backend !== backend || pin.action !== action) return null;
  if (['sourceEntry', 'sourceUrl', 'targetEntry', 'targetUrl'].some(key => typeof pin[key] !== 'string' || !pin[key])) return null;
  return { backend, action, sourceEntry: pin.sourceEntry as string, sourceUrl: pin.sourceUrl as string,
    targetEntry: pin.targetEntry as string, targetUrl: pin.targetUrl as string };
}
