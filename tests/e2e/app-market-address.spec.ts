/**
 * Markets added by address (product brief story 1's market steps and story 11)
 * in the real Electron shell. A loopback HTTPS server stands in for the
 * developer's download address; its self-signed certificate is handed to the
 * main process through NODE_EXTRA_CA_CERTS, so the fetch runs the real
 * `https` path. The server serves:
 *
 *   /acme.zip      the developer's market: an app and the plugin it needs,
 *                  plus an app that needs a newer Abu; version 2 adds a scene
 *                  on a team the plugin's version 2 brings
 *   /private.zip   401, a market behind a login
 *   /nothing.zip   a zip without a market in it
 *   /impostor.zip  another market with the same name
 */
import { createServer as createHttpsServer, type Server } from 'node:https';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { generate as generateCertificate } from 'selfsigned';
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import {
  closeAbuElectron,
  configureLocalMockProvider,
  createElectronDataRoot,
  dismissFirstRunOverlays,
  launchAbuElectron,
  removeElectronDataRoot,
  type ElectronDataRoot,
} from './electronHelpers';

const READY_TIMEOUT = 45_000;
const MARKET = 'acme-apps';
const APP_ID = `contract-review@${MARKET}`;
const APP_NAME = '合同审阅';
const PLUGIN_NAME = 'contract-tools';
const EXPERT = '条款审阅员';

const templates = (prefix: string) => [
  { id: `${prefix}-a`, title: '审一份合同', prompt: '帮我审一下这份合同的风险条款' },
  { id: `${prefix}-b`, title: '列出问题', prompt: '列出这份合同里需要对方修改的地方' },
  { id: `${prefix}-c`, title: '写修改意见', prompt: '把修改意见写成一封给对方的邮件' },
];

type Files = Record<string, string>;

/** The developer's market, as files under one top folder. */
function marketFiles(version: 1 | 2, name = MARKET): Files {
  const pluginVersion = version === 1 ? '1.0.0' : '1.1.0';
  const files: Files = {
    '.abu-plugin/marketplace.json': JSON.stringify({
      name,
      owner: { name: 'Acme' },
      plugins: [{ name: PLUGIN_NAME, displayName: '合同工具', version: pluginVersion, minAbuVersion: '0.51.0', source: `./plugins/${PLUGIN_NAME}` }],
      apps: [
        { name: 'contract-review', source: './apps/contract-review' },
        { name: 'future-app', source: './apps/future-app' },
      ],
    }),
    [`plugins/${PLUGIN_NAME}/.abu-plugin/plugin.json`]: JSON.stringify({ name: PLUGIN_NAME, version: pluginVersion, minAbuVersion: '0.51.0', interface: { displayName: '合同工具', shortDescription: '合同审阅的专家和专家团' } }),
    [`plugins/${PLUGIN_NAME}/agents/${EXPERT}.md`]: `---\nname: ${EXPERT}\ndescription: 逐条审阅合同条款\n---\nReview contract clauses one by one.\n`,
    [`plugins/${PLUGIN_NAME}/teams/review.json`]: JSON.stringify({ name: '合同审阅组', leader: EXPERT, members: [EXPERT, 'builtin:合同审阅专家'], description: '审合同、提修改意见' }),
    'apps/contract-review/.abu-app/app.json': JSON.stringify({
      name: 'contract-review',
      version: version === 1 ? '1.0.0' : '1.1.0',
      minAbuVersion: '0.51.0',
      interface: { displayName: APP_NAME, shortDescription: '按律所的做法审合同' },
      plugins: [PLUGIN_NAME],
      defaultRun: { team: `plugin:${PLUGIN_NAME}/review` },
      home: { modes: { items: [{ modeId: 'review', title: '审阅', scenes: [
        { id: 'review', title: '审合同', run: { team: `plugin:${PLUGIN_NAME}/review` }, templates: templates('review') },
        ...(version === 2 ? [{ id: 'clause', title: '改条款', run: { team: `plugin:${PLUGIN_NAME}/clause` }, templates: templates('clause') }] : []),
      ] }] } },
    }),
    'apps/future-app/.abu-app/app.json': JSON.stringify({
      name: 'future-app',
      version: '1.0.0',
      minAbuVersion: '99.0.0',
      interface: { displayName: '未来应用', shortDescription: '需要更新的阿布' },
      home: { modes: { items: [{ modeId: 'm', title: 'M', scenes: [{ id: 's', title: 'S', run: { team: 'builtin-team:reporting' }, templates: templates('s') }] }] } },
    }),
  };
  if (version === 2) {
    files[`plugins/${PLUGIN_NAME}/teams/clause.json`] = JSON.stringify({ name: '条款修改组', leader: EXPERT, members: [EXPERT, 'builtin:办公文档专家'], description: '改写需要修改的条款' });
  }
  return files;
}

function zip(files: Files, top = 'market'): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([file, text]) => [`${top}/${file}`, strToU8(text)])));
}

interface MarketServer { origin: string; version: { current: 1 | 2 }; close: () => Promise<void> }

async function startMarketServer(cert: string, key: string): Promise<MarketServer> {
  const version: { current: 1 | 2 } = { current: 1 };
  const server: Server = createHttpsServer({ cert, key }, (req, res) => {
    const route = req.url ?? '/';
    if (route === '/private.zip') { res.writeHead(401); res.end(); return; }
    const body = route === '/acme.zip' ? zip(marketFiles(version.current))
      : route === '/nothing.zip' ? zip({ 'README.md': 'no market here' })
        : route === '/impostor.zip' ? zip(marketFiles(1))
          : null;
    if (!body) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/zip', 'content-length': body.byteLength });
    res.end(Buffer.from(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    origin: `https://localhost:${port}`,
    version,
    close: () => new Promise((resolve, reject) => { server.closeAllConnections?.(); server.close((error) => (error ? reject(error) : resolve())); }),
  };
}

function sse(text: string): string {
  const chunk = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({ id: 'chatcmpl-abu-e2e-market', object: 'chat.completion.chunk', created: 0, model: 'abu-e2e-local-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  return chunk({ content: text }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n';
}

async function startLlmMock(): Promise<{ baseUrl: string; count: () => number; close: () => Promise<void> }> {
  let count = 0;
  const server: HttpServer = createHttpServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    count += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.end(sse('Abu E2E market reply.'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    baseUrl: `http://2130706433:${port}/v1`,
    count: () => count,
    close: () => new Promise((resolve, reject) => { server.closeAllConnections?.(); server.close((error) => (error ? reject(error) : resolve())); }),
  };
}

async function openMarket(page: Page): Promise<void> {
  const toggle = page.getByRole('button', { name: /^(显示侧栏|Show sidebar)$/ });
  if (await toggle.isVisible()) await toggle.click();
  await page.getByTestId('app-switcher-trigger').click();
  await page.getByTestId('app-switcher-discover').click();
  await expect(page.getByTestId('app-market-dialog')).toBeVisible({ timeout: READY_TIMEOUT });
}

async function addMarket(page: Page, address: string): Promise<void> {
  await page.getByTestId('app-market-dialog').getByTestId('app-market-add-market').click();
  await page.getByTestId('plugin-marketplace-dir-input').fill(address);
  await page.getByTestId('plugin-marketplace-submit').click();
}

test.describe.serial('app market by address', () => {
  let dataRoot: ElectronDataRoot;
  let app: ElectronApplication;
  let page: Page;
  let server: MarketServer;
  let llm: Awaited<ReturnType<typeof startLlmMock>>;
  let certFile: string;

  test.beforeAll(async () => {
    dataRoot = createElectronDataRoot();
    // Electron's main process trusts an extra certificate only when it is marked
    // as a CA (plain Node also accepts a self-signed leaf).
    const pems = await generateCertificate([{ name: 'commonName', value: 'localhost' }], {
      algorithm: 'sha256',
      extensions: [
        { name: 'basicConstraints', cA: true },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, keyCertSign: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] },
      ],
    });
    certFile = path.join(dataRoot.rootDir, 'market-ca.pem');
    fs.mkdirSync(dataRoot.rootDir, { recursive: true });
    fs.writeFileSync(certFile, pems.cert);
    server = await startMarketServer(pems.cert, pems.private);
    llm = await startLlmMock();
    app = (await launchAbuElectron(dataRoot, { extraEnv: { NODE_EXTRA_CA_CERTS: certFile } })).app;
    page = await app.firstWindow();
    await expect(page.getByTestId('app-switcher-trigger')).toBeVisible({ timeout: READY_TIMEOUT });
    await dismissFirstRunOverlays(page);
    await configureLocalMockProvider(page, llm.baseUrl);
  });

  test.afterAll(async () => {
    if (app) await closeAbuElectron(app);
    await server?.close();
    await llm?.close();
    if (dataRoot) removeElectronDataRoot(dataRoot);
  });

  test('an address that cannot be added says why, and nothing is added', async () => {
    await openMarket(page);
    const error = page.getByTestId('plugin-marketplace-error');
    await addMarket(page, `${server.origin}/private.zip`);
    await expect(error).toContainText('这个地址需要登录才能访问', { timeout: READY_TIMEOUT });
    await page.getByTestId('plugin-marketplace-dir-input').fill(`${server.origin}/nothing.zip`);
    await page.getByTestId('plugin-marketplace-submit').click();
    await expect(error).toContainText('这个地址里没有市场', { timeout: READY_TIMEOUT });
    await page.getByRole('button', { name: /^(取消|Cancel)$/ }).click();
    await expect(page.getByTestId('app-market-markets')).toHaveCount(0);
  });

  test('adding the developer\'s address lists its apps; one that needs a newer Abu cannot be used', async () => {
    await addMarket(page, `${server.origin}/acme.zip`);
    const market = page.getByTestId('app-market-dialog');
    await expect(market.getByTestId('app-market-market')).toContainText(MARKET, { timeout: READY_TIMEOUT });
    await expect(market.locator(`[data-testid="app-market-entry"][data-app-id="${APP_ID}"]`)).toContainText(APP_NAME);
    const future = market.locator(`[data-testid="app-market-entry"][data-app-id="future-app@${MARKET}"]`);
    await expect(future.getByTestId('app-market-needs-upgrade')).toHaveText('需要先升级阿布');
    await expect(future.getByTestId('app-market-use')).toBeDisabled();
    const source = JSON.parse(fs.readFileSync(path.join(dataRoot.appDataDir, 'Home', '.abu', 'markets', MARKET, '.abu-market-source.json'), 'utf8')) as { address: string };
    expect(source.address).toBe(`${server.origin}/acme.zip`);
  });

  test('another address with the same market name is refused', async () => {
    await addMarket(page, `${server.origin}/impostor.zip`);
    await expect(page.getByTestId('plugin-marketplace-error')).toContainText('已经有一个同名的市场，请联系提供地址的人', { timeout: READY_TIMEOUT });
    await page.getByRole('button', { name: /^(取消|Cancel)$/ }).click();
    await expect(page.getByTestId('app-market-dialog').getByTestId('app-market-market')).toHaveCount(1);
  });

  test('使用 installs the plugin the app needs with it; the scene runs on the plugin\'s team', async () => {
    const entry = page.getByTestId('app-market-dialog').locator(`[data-testid="app-market-entry"][data-app-id="${APP_ID}"]`);
    await entry.getByTestId('app-market-use').click();
    const dialog = page.getByTestId('app-add-dialog');
    await expect(dialog.getByTestId('app-add-plugins')).toContainText('需要一起安装', { timeout: READY_TIMEOUT });
    await expect(dialog.getByTestId('app-add-plugin')).toHaveAttribute('data-plugin', PLUGIN_NAME);
    await expect(dialog.getByTestId('plugin-disclosure-team')).toContainText('合同审阅组');
    await dialog.getByTestId('app-add-confirm').click();

    await expect(page.getByTestId('app-switcher-current')).toHaveText(APP_NAME, { timeout: READY_TIMEOUT });
    await page.getByTestId('app-home-scene-review').click();
    await page.getByTestId('app-home-template-review-a').click();
    await expect(page.getByTestId('composer-team-chip')).toContainText('合同审阅组');
    const composer = page.locator('[data-chat-composer]');
    const before = llm.count();
    await composer.click();
    await composer.press('Enter');
    await expect.poll(() => llm.count(), { timeout: READY_TIMEOUT }).toBeGreaterThan(before);
    await expect(page.getByTestId('chat-title-team-badge')).toContainText('合同审阅组', { timeout: READY_TIMEOUT });
    await expect(page.getByTestId('chat-title-app-badge')).toContainText(APP_NAME);
  });

  test('a new version shows 更新; the plugin is updated with it and the old conversation carries on', async () => {
    // An hour passes: the copy is fetched again the next time the market opens.
    server.version.current = 2;
    const sourceFile = path.join(dataRoot.appDataDir, 'Home', '.abu', 'markets', MARKET, '.abu-market-source.json');
    fs.writeFileSync(sourceFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(sourceFile, 'utf8')), fetchedAt: 0 }));

    await openMarket(page);
    const entry = page.getByTestId('app-market-dialog').locator(`[data-testid="app-market-entry"][data-app-id="${APP_ID}"]`);
    await entry.getByTestId('app-market-update').click({ timeout: READY_TIMEOUT });
    const dialog = page.getByTestId('app-add-dialog');
    await expect(dialog.getByTestId('app-add-plugins')).toContainText('需要一起更新', { timeout: READY_TIMEOUT });
    await expect(dialog.getByTestId('app-add-plugin')).toHaveAttribute('data-plugin', PLUGIN_NAME);
    await dialog.getByTestId('app-add-confirm').click();
    await expect(dialog).toBeHidden({ timeout: READY_TIMEOUT });
    await page.keyboard.press('Escape');

    await page.getByLabel('Main navigation').getByRole('button', { name: /^(新任务|New task)$/ }).click();
    await expect(page.getByTestId('app-home-scene-clause')).toContainText('条款修改组', { timeout: READY_TIMEOUT });
    await page.getByTestId('conversation-app-icon').first().click();
    await expect(page.getByTestId('chat-title-app-badge')).toContainText(APP_NAME, { timeout: READY_TIMEOUT });
    await expect(page.getByTestId('conversation-app-removed')).toHaveCount(0);
  });

  test('removing the market warns that its apps stop updating; the added app stays', async () => {
    await openMarket(page);
    await page.getByTestId(`app-market-remove-market-${MARKET}`).click();
    await expect(page.getByText('从这个市场添加的应用以后不能更新')).toBeVisible();
    await page.getByRole('button', { name: /^(移除|Remove)$/ }).last().click();
    await expect(page.getByTestId('app-market-dialog').getByTestId('app-market-markets')).toHaveCount(0, { timeout: READY_TIMEOUT });
    await expect(page.getByTestId('app-market-dialog').locator(`[data-testid="app-market-entry"][data-app-id="${APP_ID}"]`)).toHaveCount(0);
    expect(fs.existsSync(path.join(dataRoot.appDataDir, 'Home', '.abu', 'markets', MARKET))).toBe(false);
    await page.keyboard.press('Escape');
    await page.getByTestId('app-switcher-trigger').click();
    await expect(page.getByTestId(`app-switcher-item-${APP_ID}`)).toBeVisible();
  });
});
