/**
 * Renderer side of `electron/appPageHost.cjs`. The renderer names a plugin
 * and a nav item and gives the rectangle to paint into; it never sends a URL
 * — the host resolves the page from the installed package itself.
 */
export interface AppPageBounds { x: number; y: number; width: number; height: number }

export interface AppPageStateEvent {
  pluginKey: string;
  navItemId: string;
  state: 'loading' | 'ready' | 'failed';
  errorDescription?: string;
}

export const APP_PAGE_STATE_EVENT = 'app-page://state';

type AppPageAction = 'show' | 'setBounds' | 'hide' | 'reload' | 'destroyForPlugin';

async function request(action: AppPageAction, input: object = {}): Promise<void> {
  const bridge = (globalThis as typeof globalThis & { __ABU_SHELL__?: {
    appPage?: (action: string, input: object) => Promise<unknown>;
  } }).__ABU_SHELL__?.appPage;
  if (!bridge) throw new Error('App pages require the Electron desktop host');
  await bridge(action, input);
}

export const showAppPage = (pluginKey: string, navItemId: string, bounds: AppPageBounds) => request('show', { pluginKey, navItemId, bounds });
export const setAppPageBounds = (pluginKey: string, navItemId: string, bounds: AppPageBounds) => request('setBounds', { pluginKey, navItemId, bounds });
export const hideAppPages = () => request('hide');
export const reloadAppPage = (pluginKey: string, navItemId: string) => request('reload', { pluginKey, navItemId });
export const destroyAppPagesForPlugin = (pluginKey: string, clearStorage: boolean) => request('destroyForPlugin', { pluginKey, clearStorage });
