import { createServer, type Server } from 'node:http';
import { expect, test } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import {
  closeAbuElectron, dismissFirstRunOverlays,
  launchAbuElectron, removeElectronDataRoot, type ElectronDataRoot,
} from './electronHelpers';

const READY_TIMEOUT = 45_000;
const CHAT_PLACEHOLDER = '想让阿布帮你做点什么？';

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;
let server: Server | undefined;

test.afterEach(async () => {
  if (app) await closeAbuElectron(app);
  app = undefined;
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  }
  server = undefined;
  if (dataRoot) removeElectronDataRoot(dataRoot);
  dataRoot = undefined;
});

test('WeChat distinguishes connection errors from each account authentication expiry', async () => {
  const expiredAccounts: string[] = [];
  server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/ilink/bot/getupdates') {
      response.writeHead(404).end();
      return;
    }
    expiredAccounts.push(request.headers.authorization ?? '');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ret: -14 }));
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a loopback server address');
  const endpoint = `http://127.0.0.1:${address.port}`;

  const launched = await launchAbuElectron();
  app = launched.app;
  dataRoot = launched;
  const page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
  await dismissFirstRunOverlays(page);

  // Redirect only the external service boundary; the adapter, manager, store,
  // Electron HTTP bridge and settings page all run their shipped code.
  await app.evaluate((_electron, baseUrl) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return originalFetch(url.hostname === 'wechat.example.test' ? `${baseUrl}${url.pathname}` : input, init);
    };
  }, endpoint);

  await page.evaluate(() => {
    const channels = Object.fromEntries(['connection-error', 'expired-first', 'expired-second'].map(id => [id, {
      id, platform: 'wechat', name: id, appId: id,
      appSecret: id === 'connection-error' ? 'invalid-json' : JSON.stringify({
        botToken: id, baseurl: 'wechat.example.test', ilinkBotId: id,
      }),
      capability: 'safe_tools', responseMode: 'mention_only', allowedUsers: [],
      workspacePaths: [], sessionTimeoutMinutes: 0, maxRoundsPerSession: 0,
      enabled: true, status: 'disconnected', createdAt: 0, updatedAt: 0,
    }]));
    localStorage.setItem('abu-im-channel', JSON.stringify({
      version: 2, state: { channels, sessions: {}, archivedSessions: {} },
    }));
  });
  await page.reload();
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
  await expect.poll(() => [...expiredAccounts].sort()).toEqual(['Bearer expired-first', 'Bearer expired-second']);
  await page.getByRole('button', { name: /^(我|Me|登录 \/ 注册|Sign in \/ Sign up)$/ }).first().click();
  await page.getByRole('menuitem', { name: /^(设置|Settings)$/ }).click();
  await page.getByRole('button', { name: '频道', exact: true }).click();

  await page.getByRole('button', { name: /connection-error/ }).click();
  const unavailable = page.getByRole('group', { name: 'connection-error', exact: true });
  await expect(unavailable.getByText(/JSON|Unexpected token/)).toBeVisible();
  await expect(unavailable.getByRole('button', { name: '重新扫码绑定' })).toHaveCount(0);
  await expect(unavailable.getByText('微信登录已过期，请重新扫码绑定')).toHaveCount(0);

  for (const account of ['expired-first', 'expired-second']) {
    await page.getByRole('button', { name: new RegExp(account) }).click();
    const group = page.getByRole('group', { name: account, exact: true });
    await expect(group.getByRole('button', { name: '重新扫码绑定' })).toBeVisible();
    await expect(group.getByText('微信登录已过期，请重新扫码绑定')).toHaveCount(1);
  }
});
