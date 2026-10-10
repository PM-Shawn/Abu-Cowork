/**
 * Renderer side of `electron/appPageHost.cjs`. The renderer names an app and
 * a nav item and gives the rectangle to paint into; it never sends a URL — the
 * host resolves the page from the app's own copied files, or from the
 * organization app configuration it was handed when the app was entered.
 */
export interface AppPageBounds { x: number; y: number; width: number; height: number }

export interface AppPageStateEvent {
  appId: string;
  navItemId: string;
  state: 'loading' | 'ready' | 'failed';
  errorDescription?: string;
}

export const APP_PAGE_STATE_EVENT = 'app-page://state';

type AppPageAction = 'show' | 'setBounds' | 'hide' | 'reload' | 'destroyForApp' | 'setManagedApps';

async function request(action: AppPageAction, input: object = {}): Promise<void> {
  const bridge = (globalThis as typeof globalThis & { __ABU_SHELL__?: {
    appPage?: (action: string, input: object) => Promise<unknown>;
  } }).__ABU_SHELL__?.appPage;
  if (!bridge) throw new Error('App pages require the Electron desktop host');
  await bridge(action, input);
}

export const showAppPage = (appId: string, navItemId: string, bounds: AppPageBounds) => request('show', { appId, navItemId, bounds });
export const setAppPageBounds = (appId: string, navItemId: string, bounds: AppPageBounds) => request('setBounds', { appId, navItemId, bounds });
export const hideAppPages = () => request('hide');
export const reloadAppPage = (appId: string, navItemId: string) => request('reload', { appId, navItemId });
export const destroyAppPages = (appId: string, clearStorage: boolean) => request('destroyForApp', { appId, clearStorage });
/**
 * The organization apps' page configuration (`nav` and `allowedOrigins`), by
 * app id. Organization apps have no files on this computer, so the host keeps
 * this copy and still does its own origin checks on it.
 */
export const setManagedAppPages = (apps: Array<{ appId: string; nav?: unknown; allowedOrigins?: string[] }>) => request('setManagedApps', { apps });
