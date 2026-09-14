import { expect, test, type TestInfo } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { ElectronApplication, Page } from 'playwright';
import {
  closeAbuElectron,
  createElectronDataRoot,
  dismissFirstRunOverlays,
  launchAbuElectron,
  removeElectronDataRoot,
  type ElectronDataRoot,
} from './electronHelpers';

const READY_TIMEOUT = 45_000;
const ACCOUNT_SERVER_URL = process.env.VITE_PERSONAL_ACCOUNT_SERVER_URL || 'http://127.0.0.1:43119';
const CHAT_PLACEHOLDER = '想让阿布帮你做点什么？';
const BROWSER_TIMEOUT_MS = 10 * 60 * 1000;

type ServerMode = 'success' | 'unavailable' | 'refresh-required' | 'profile-unauthorized';

function tokenFor(userId: string, generation = 'initial'): string {
  return [
    Buffer.from('{"alg":"none"}').toString('base64url'),
    Buffer.from(JSON.stringify({ sub: userId, generation })).toString('base64url'),
    'e2e-signature',
  ].join('.');
}

function startAccountServer(
  mode: () => ServerMode,
  onLogout: () => void,
  onRefresh: () => void,
): Promise<http.Server> {
  const origin = new URL(ACCOUNT_SERVER_URL);
  if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) {
    throw new Error('Account E2E server must use a loopback origin');
  }
  const port = Number(origin.port || (origin.protocol === 'https:' ? 443 : 80));
  const initialAccessToken = tokenFor('user-1');
  const rotatedAccessToken = tokenFor('user-1', 'rotated');
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      if (request.method === 'POST' && request.url === '/api/client/v1/auth/logout') {
        onLogout();
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
        return;
      }
      if (mode() === 'unavailable') {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'server_error' }));
        return;
      }
      if (request.method === 'POST' && request.url === '/api/client/v1/auth/exchange') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          access_token: initialAccessToken,
          token_type: 'Bearer',
          expires_in: 900,
          refresh_token: 'e2e-refresh-token',
          refresh_idle_expires_at: '2026-09-28T00:00:00Z',
          refresh_absolute_expires_at: '2026-12-13T00:00:00Z',
          family_id: 'e2e-family',
        }));
        return;
      }
      if (request.method === 'POST' && request.url === '/api/client/v1/auth/refresh') {
        onRefresh();
        if (mode() === 'profile-unauthorized') {
          response.writeHead(401, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'expired_token' }));
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          access_token: rotatedAccessToken,
          token_type: 'Bearer',
          expires_in: 900,
          refresh_token: 'e2e-rotated-refresh-token',
          refresh_idle_expires_at: '2026-09-28T00:00:00Z',
          refresh_absolute_expires_at: '2026-12-13T00:00:00Z',
          family_id: 'e2e-family',
        }));
        return;
      }
      if (request.method === 'GET' && request.url === '/api/client/v1/account/profile') {
        if (mode() === 'profile-unauthorized') {
          response.writeHead(401, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        if (
          mode() === 'refresh-required' &&
          request.headers.authorization !== `Bearer ${rotatedAccessToken}`
        ) {
          response.writeHead(401, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'unauthenticated' }));
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: 'user-1', name: 'Ada', email: 'ada@example.com' }));
        return;
      }
      response.writeHead(404).end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, origin.hostname.replace(/^\[(.*)\]$/, '$1'), () => resolve(server));
  });
}

async function installMainBoundaryFixture(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app: electronApp, shell }) => {
    const fixture = { registered: true, opened: [] as string[] };
    (globalThis as typeof globalThis & { __abuAccountE2E?: typeof fixture }).__abuAccountE2E = fixture;
    (electronApp as typeof electronApp & {
      isDefaultProtocolClient: () => boolean;
    }).isDefaultProtocolClient = () => fixture.registered;
    shell.openExternal = async (url: string) => {
      fixture.opened.push(url);
    };
  });
}

async function setProtocolRegistered(app: ElectronApplication, registered: boolean): Promise<void> {
  await app.evaluate((_, value) => {
    const fixture = (globalThis as typeof globalThis & {
      __abuAccountE2E: { registered: boolean };
    }).__abuAccountE2E;
    fixture.registered = value;
  }, registered);
}

async function openedUrlCount(app: ElectronApplication): Promise<number> {
  return await app.evaluate(() => (
    globalThis as typeof globalThis & { __abuAccountE2E: { opened: string[] } }
  ).__abuAccountE2E.opened.length);
}

async function emitNextAuthReturn(app: ElectronApplication, previousCount: number): Promise<void> {
  let authorizeUrl: string | null = null;
  await expect.poll(async () => {
    authorizeUrl = await app.evaluate((_, count) => {
      const fixture = (globalThis as typeof globalThis & {
        __abuAccountE2E: { opened: string[] };
      }).__abuAccountE2E;
      return fixture.opened.length > count ? fixture.opened.at(-1) ?? null : null;
    }, previousCount);
    return authorizeUrl;
  }, { timeout: READY_TIMEOUT }).not.toBeNull();
  if (!authorizeUrl) throw new Error('Personal login did not open the browser');
  const state = new URL(authorizeUrl).searchParams.get('state');
  if (!state) throw new Error('Authorize URL did not include state');
  await app.evaluate(({ app: electronApp }, callbackUrl) => {
    electronApp.emit('open-url', { preventDefault() {} }, callbackUrl);
  }, `abu-dev://auth?code=e2e-one-time-code&state=${encodeURIComponent(state)}`);
}

function screenshotPath(testInfo: TestInfo, name: string): string {
  const artifactDir = process.env.ABU_ACCOUNT_SCREENSHOT_DIR;
  if (!artifactDir) return testInfo.outputPath(`${name}.png`);
  fs.mkdirSync(artifactDir, { recursive: true });
  return path.join(artifactDir, `${name}.png`);
}

async function captureLightAndDark(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.mouse.move(0, 0);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).not.toHaveClass(/(^|\s)dark(\s|$)/);
  await page.screenshot({ path: screenshotPath(testInfo, `${name}-light`), animations: 'disabled' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass(/(^|\s)dark(\s|$)/);
  await page.screenshot({ path: screenshotPath(testInfo, `${name}-dark`), animations: 'disabled' });
}

async function useSystemTheme(page: Page): Promise<void> {
  await page.getByRole('button', { name: '我', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  const settings = page.locator('[data-abu-settings-dialog]');
  await expect(settings).toBeVisible();
  await settings.getByRole('button', { name: '偏好', exact: true }).click();
  const appearanceRow = settings.getByText('外观', { exact: true }).locator('..');
  const themeSelect = appearanceRow.getByRole('button');
  const menuId = await themeSelect.getAttribute('aria-controls');
  if (!menuId) throw new Error('Appearance select did not expose its menu');
  await themeSelect.click();
  await page.locator(`[id="${menuId}"]`).locator('button[data-value="system"]').click();
  await expect(themeSelect).toHaveText('跟随系统');
  await settings.locator('[data-abu-settings-close]').click();
  await expect(settings).toBeHidden();
}

async function openLoginDialogFromSidebar(page: Page, label: '登录' | '重新登录') {
  await page.getByRole('button', { name: '我', exact: true }).click();
  await page.getByRole('menuitem', { name: label, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '登录 / 注册' });
  await expect(dialog).toBeVisible();
  return dialog;
}

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;
let server: http.Server | undefined;

test.describe.serial('personal account login UI', () => {
  test.afterEach(async () => {
    if (app) await closeAbuElectron(app);
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    if (dataRoot) removeElectronDataRoot(dataRoot);
    app = undefined;
    server = undefined;
    dataRoot = undefined;
  });

  test('walks the real dialog, failure paths, signed-in sidebar, and account settings', async () => {
    const testInfo = test.info();
    let serverMode: ServerMode = 'success';
    let logoutRequests = 0;
    let refreshRequests = 0;
    server = await startAccountServer(() => serverMode, () => {
      logoutRequests += 1;
    }, () => {
      refreshRequests += 1;
    });
    dataRoot = createElectronDataRoot();
    const launched = await launchAbuElectron(dataRoot);
    app = launched.app;
    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
    await dismissFirstRunOverlays(page);
    await installMainBoundaryFixture(app);
    await useSystemTheme(page);

    await page.getByRole('button', { name: '我', exact: true }).click();
    await expect(page.getByText('本地模式', { exact: true })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: '登录', exact: true })).toBeVisible();
    await captureLightAndDark(page, testInfo, '01-local-menu-signed-out');
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: '我', exact: true }).click();
    await page.getByRole('menuitem', { name: '登录', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '登录 / 注册' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: '个人账号登录' })).toBeVisible();
    await captureLightAndDark(page, testInfo, '02-login-initial');

    await dialog.getByRole('button', { name: '个人账号登录' }).click();
    await expect(dialog.getByText('请在浏览器中完成登录')).toBeVisible();
    await expect.poll(() => openedUrlCount(app!)).toBe(1);
    await captureLightAndDark(page, testInfo, '03-awaiting-browser');

    await dialog.getByRole('button', { name: '取消' }).click();
    await expect(dialog.getByText('已取消登录。')).toBeVisible();
    await captureLightAndDark(page, testInfo, '04-cancelled');

    const timeoutOpenCount = await openedUrlCount(app);
    await page.clock.install();
    await dialog.getByRole('button', { name: '个人账号登录' }).click();
    await expect(dialog.getByText('请在浏览器中完成登录')).toBeVisible();
    await expect.poll(() => openedUrlCount(app!)).toBe(timeoutOpenCount + 1);
    await page.clock.fastForward(BROWSER_TIMEOUT_MS + 1);
    await expect(dialog.getByText('登录等待已超时，请重新登录。')).toBeVisible();
    await captureLightAndDark(page, testInfo, '05-timeout');
    await page.clock.resume();

    await setProtocolRegistered(app, false);
    await dialog.getByRole('button', { name: '重新登录' }).click();
    await expect(dialog.getByText('当前阿布无法接收登录返回，请检查后重试。')).toBeVisible();
    await captureLightAndDark(page, testInfo, '06-protocol-not-ready');

    await setProtocolRegistered(app, true);
    serverMode = 'unavailable';
    const unavailableOpenCount = await openedUrlCount(app);
    await dialog.getByRole('button', { name: '个人账号登录' }).click();
    await emitNextAuthReturn(app, unavailableOpenCount);
    await expect(dialog.getByText('暂时无法连接账号服务，请稍后重试。')).toBeVisible();
    await captureLightAndDark(page, testInfo, '07-server-unavailable');

    serverMode = 'success';
    const successOpenCount = await openedUrlCount(app);
    await dialog.getByRole('button', { name: '个人账号登录' }).click();
    await emitNextAuthReturn(app, successOpenCount);
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'Ada', exact: true }).first()).toBeVisible();
    await captureLightAndDark(page, testInfo, '08-sidebar-signed-in');

    // A real renderer restart restores safeStorage, rotates exactly once after
    // profile rejects the old access token, and persists the replacement pair.
    serverMode = 'refresh-required';
    await page.reload();
    await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(page.getByRole('button', { name: 'Ada', exact: true }).first()).toBeVisible();
    await expect.poll(() => refreshRequests).toBe(1);
    await page.reload();
    await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(page.getByRole('button', { name: 'Ada', exact: true }).first()).toBeVisible();
    expect(refreshRequests).toBe(1);

    await page.getByRole('button', { name: 'Ada', exact: true }).first().click();
    const signedInMenu = page.getByRole('menu');
    await expect(signedInMenu.getByRole('menuitem').last()).toHaveAccessibleName('退出登录');
    await captureLightAndDark(page, testInfo, '08b-signed-in-menu');
    await signedInMenu.getByRole('menuitem', { name: '账号设置', exact: true }).click();
    const settings = page.locator('[data-abu-settings-dialog]');
    await expect(settings.getByRole('heading', { name: '账号' })).toBeVisible();
    await expect(settings.getByText('ada@example.com')).toBeVisible();
    await captureLightAndDark(page, testInfo, '09-account-settings');

    // Local credentials disappear immediately, while remote logout remains a
    // best-effort request against the account service.
    await settings.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(settings.getByRole('button', { name: '登录 / 注册', exact: true })).toBeVisible();
    await expect.poll(() => logoutRequests).toBe(1);
    await page.keyboard.press('Escape');
    await expect(settings).toBeHidden();

    // A 401 from the authenticated profile endpoint expires the stored login.
    serverMode = 'profile-unauthorized';
    let openCount = await openedUrlCount(app);
    let recoveryDialog = await openLoginDialogFromSidebar(page, '登录');
    await recoveryDialog.getByRole('button', { name: '个人账号登录' }).click();
    await emitNextAuthReturn(app, openCount);
    await page.getByRole('button', { name: '我', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: '重新登录', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');

    // The expired-session dialog offers a real local+remote sign-out path.
    recoveryDialog = await openLoginDialogFromSidebar(page, '重新登录');
    await expect(recoveryDialog.getByText('登录已过期，请重新登录。')).toBeVisible();
    await expect(recoveryDialog.getByRole('button', { name: '重新登录' })).toBeVisible();
    await recoveryDialog.getByRole('button', { name: '退出登录' }).click();
    await expect(recoveryDialog.getByRole('button', { name: '个人账号登录' })).toBeVisible();
    await expect.poll(() => logoutRequests).toBe(2);
    await recoveryDialog.getByRole('button', { name: '关闭' }).click();

    // Reproduce the 401 once more, then recover by completing a fresh login.
    openCount = await openedUrlCount(app);
    recoveryDialog = await openLoginDialogFromSidebar(page, '登录');
    await recoveryDialog.getByRole('button', { name: '个人账号登录' }).click();
    await emitNextAuthReturn(app, openCount);
    await page.getByRole('button', { name: '我', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: '重新登录', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');

    serverMode = 'success';
    openCount = await openedUrlCount(app);
    recoveryDialog = await openLoginDialogFromSidebar(page, '重新登录');
    await recoveryDialog.getByRole('button', { name: '重新登录' }).click();
    await emitNextAuthReturn(app, openCount);
    await expect(page.getByRole('button', { name: 'Ada', exact: true }).first()).toBeVisible();
  });
});
