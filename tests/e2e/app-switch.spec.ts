/**
 * Apps (product spec §8): the switcher, discovering and installing an app,
 * its home page, a conversation bound to it, the `url:` page, persistence
 * across a restart, and the way back out. Runs the real Electron shell with
 * the example market shipped in `examples/plugin-market/`, a loopback mock
 * LLM (to read the system prompt the app injects) and a loopback page server
 * (to stand in for the app's web page).
 */
import { createServer, type Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import {
  REPO_ROOT,
  closeAbuElectron,
  configureLocalMockProvider,
  dismissFirstRunOverlays,
  launchAbuElectron,
  removeElectronDataRoot,
  type ElectronDataRoot,
} from './electronHelpers';

const READY_TIMEOUT = 45_000;
const APP_NAME = '店铺运营';
const ENTRY_NAME = 'abu-example-shop-ops';
const EXTENSIONS = /^(扩展|Extensions)(\s.*)?$/;
const TEAM_NAV = /^(专家|Experts)$/;

interface MockRequest { system: string; user: string }

function sse(text: string): string {
  const chunk = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({ id: 'chatcmpl-abu-e2e-app', object: 'chat.completion.chunk', created: 0, model: 'abu-e2e-local-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  return chunk({ content: text }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n';
}

/** Loopback OpenAI-compatible mock: answers every task with one line and records the prompts. */
async function startLlmMock(): Promise<{ baseUrl: string; requests: MockRequest[]; close: () => Promise<void> }> {
  const requests: MockRequest[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    const body = JSON.parse(raw) as { messages?: Array<{ role: string; content: unknown }> };
    const messages = body.messages ?? [];
    const system = messages.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n');
    const user = messages.filter((m) => m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
    const background = system.includes('你是一个记忆提取助手') || user.includes('请将以下对话内容压缩为一段简洁的摘要');
    if (!background) requests.push({ system, user });
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.end(sse(background ? '[]' : 'Abu E2E app reply.'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { baseUrl: `http://2130706433:${port}/v1`, requests, close: () => closeServer(server) };
}

/** The app's "web page": a loopback origin the package copy is rewritten to allow. */
async function startPageServer(): Promise<{ origin: string; hits: string[]; close: () => Promise<void> }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? '/');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Portal</title><h1 id="portal">Shop portal</h1><a id="outside" href="https://example.org/outside">outside</a>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { origin: `http://127.0.0.1:${port}`, hits, close: () => closeServer(server) };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections?.();
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/** A private copy of the example market, its page pointed at the loopback server. */
function seedExampleMarket(pageOrigin: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abu-e2e-app-market-'));
  fs.cpSync(path.join(REPO_ROOT, 'examples', 'plugin-market'), dir, { recursive: true });
  const manifestPath = path.join(dir, 'plugins', ENTRY_NAME, '.abu-plugin', 'plugin.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { app: { allowedOrigins: string[]; nav: { items: Array<{ id: string; target: string }> } } };
  manifest.app.allowedOrigins = [pageOrigin];
  for (const item of manifest.app.nav.items) if (item.id === 'portal') item.target = `url:${pageOrigin}/portal`;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

async function openSwitcher(page: Page): Promise<void> {
  await page.getByTestId('app-switcher-trigger').click();
  await expect(page.getByTestId('app-switcher-menu')).toBeVisible();
}

/** Sending the first message of a conversation collapses the sidebar; the switcher and the navigation live there. */
async function showSidebar(page: Page): Promise<void> {
  const toggle = page.getByRole('button', { name: /^(显示侧栏|Show sidebar)$/ });
  if (await toggle.isVisible()) await toggle.click();
  await expect(page.getByTestId('app-switcher-trigger')).toBeVisible();
}

test.describe.serial('apps', () => {
  let dataRoot: ElectronDataRoot;
  let app: ElectronApplication;
  let page: Page;
  let marketDir: string;
  let llm: Awaited<ReturnType<typeof startLlmMock>>;
  let pages: Awaited<ReturnType<typeof startPageServer>>;

  test.beforeAll(async () => {
    llm = await startLlmMock();
    pages = await startPageServer();
    marketDir = seedExampleMarket(pages.origin);
    const launched = await launchAbuElectron();
    dataRoot = launched;
    app = launched.app;
    page = await app.firstWindow();
    await expect(page.getByTestId('app-switcher-trigger')).toBeVisible({ timeout: READY_TIMEOUT });
    await dismissFirstRunOverlays(page);
    await configureLocalMockProvider(page, llm.baseUrl);
  });

  test.afterAll(async () => {
    if (app) await closeAbuElectron(app);
    if (dataRoot) removeElectronDataRoot(dataRoot);
    if (marketDir) fs.rmSync(marketDir, { recursive: true, force: true });
    await llm?.close();
    await pages?.close();
  });

  test('a fresh install shows 通用 and offers discovery and creation', async () => {
    await expect(page.getByTestId('app-switcher-current')).toHaveText(/通用|General/);
    await openSwitcher(page);
    await expect(page.getByTestId('app-switcher-item-__general__')).toHaveAttribute('aria-current', 'true');
    await expect(page.getByTestId('app-switcher-discover')).toBeVisible();
    await expect(page.getByTestId('app-switcher-create')).toBeVisible();
    await expect(page.getByTestId('app-switcher-exit')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('app-switcher-menu')).toBeHidden();
  });

  test('发现应用 opens the market on apps; 使用 installs and enters the app', async () => {
    // Add the example market first (the built-in market ships no app yet).
    await page.getByLabel('Main navigation').getByRole('button', { name: EXTENSIONS }).click();
    await page.getByRole('main').getByRole('button', { name: /^(插件|Plugins)(\s.*)?$/ }).click();
    await page.getByTestId('plugin-create-trigger').click();
    await page.getByTestId('plugin-create-menu').getByRole('button', { name: /添加插件市场|Add marketplace/ }).click();
    await page.getByTestId('plugin-marketplace-dir-input').fill(marketDir);
    await page.getByTestId('plugin-marketplace-submit').click();
    await expect(page.getByTestId('plugin-marketplace-entry').filter({ hasText: ENTRY_NAME })).toBeVisible({ timeout: READY_TIMEOUT });

    // Back to the switcher: 发现应用 lands on the apps half of the market.
    await page.getByLabel('Main navigation').getByRole('button', { name: /^(新任务|New task)$/ }).click();
    await openSwitcher(page);
    await page.getByTestId('app-switcher-discover').click();
    await expect(page.getByTestId('plugin-market-filter-apps')).toHaveAttribute('aria-selected', 'true');
    const entry = page.getByTestId('plugin-marketplace-entry').filter({ hasText: ENTRY_NAME });
    await expect(entry).toBeVisible();
    await entry.getByRole('button', { name: /^(使用|Use): / }).click();

    // The disclosure names the teams and the app's entries and pages.
    const disclosure = page.getByTestId('plugin-install-disclosure');
    await expect(disclosure).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(disclosure.getByTestId('plugin-disclosure-team')).toContainText('店铺运营小组');
    await expect(disclosure.getByTestId('plugin-disclosure-app')).toContainText('店铺后台');
    await expect(disclosure.getByTestId('plugin-disclosure-app-pages')).toContainText(pages.origin);
    await expect(page.getByTestId('plugin-install-confirm')).toHaveText(/安装并进入|Install and enter/);
    // The shop connector reads `${config.SHOP_TOKEN}`; the install waits for that value.
    await expect(page.getByTestId('plugin-install-confirm')).toBeDisabled();
    await page.getByLabel('SHOP_TOKEN', { exact: true }).fill('e2e-shop-token-placeholder');
    await page.getByTestId('plugin-install-confirm').click();

    // Straight into the app: switcher, home title, the app's own navigation.
    await expect(page.getByTestId('app-switcher-current')).toHaveText(APP_NAME, { timeout: READY_TIMEOUT });
    await expect(page.getByTestId('app-home-title')).toHaveText(APP_NAME);
    await expect(page.getByTestId('sidebar-app-page-portal')).toBeVisible();
    await expect(page.getByLabel('Main navigation').getByRole('button')).toHaveCount(4);
    await expect(page.getByTestId('app-connector-hint')).toContainText('shop-api');
    await page.getByTestId('app-connector-hint').getByRole('button', { name: /先不连接|Not now/ }).click();
    await expect(page.getByTestId('app-connector-hint')).toHaveCount(0);
  });

  test('the home offers modes, scenes and templates; a template starts a conversation bound to the app', async () => {
    await page.getByTestId('app-home-mode-listing').click();
    await expect(page.getByTestId('app-home-mode-listing')).toHaveAttribute('aria-selected', 'true');
    await page.getByTestId('app-home-scene-write-listing').click();
    await expect(page.getByTestId('app-home-templates')).toBeVisible();
    await page.getByTestId('app-home-template-rewrite').click();
    const composer = page.locator('[data-chat-composer]');
    const composerText = () => composer.evaluate((element) => element instanceof HTMLTextAreaElement ? element.value : element.textContent ?? '');
    await expect(composer).toBeVisible();
    await expect.poll(composerText).toMatch(/改成三个更吸引点击的版本/);
    // The scene runs the product-listing skill: the composer carries the skill chip.
    await expect(page.getByRole('button', { name: '/product-listing', exact: true })).toBeVisible();

    await composer.click();
    await composer.press('Enter');
    await expect.poll(() => llm.requests.length, { timeout: READY_TIMEOUT }).toBeGreaterThan(0);
    const [request] = llm.requests;
    expect(request.system).toContain('## App Context');
    expect(request.system).toContain(`inside the app "${APP_NAME}"`);
    expect(request.system).toContain('<app-instructions>');
    expect(request.system).toContain('The user runs an online shop.');
    await expect(page.getByTestId('chat-title-app-badge')).toContainText(APP_NAME, { timeout: READY_TIMEOUT });
    await expect(page.getByTestId('conversation-app-icon')).toHaveCount(1);
  });

  test('typing straight into the composer runs on the team the scene names', async () => {
    // Product spec §8 path 4: no template picked, so the scene's own run —
    // here the app's default team — takes the work.
    await showSidebar(page);
    await page.getByLabel('Main navigation').getByRole('button', { name: /^(新任务|New task)$/ }).click();
    await expect(page.getByTestId('app-home-title')).toBeVisible();
    const before = llm.requests.length;
    const composer = page.locator('[data-chat-composer]');
    await composer.click();
    await page.keyboard.type('上个月哪些商品退货最多？');
    await composer.press('Enter');
    await expect.poll(() => llm.requests.length, { timeout: READY_TIMEOUT }).toBeGreaterThan(before);
    await expect(page.getByTestId('chat-title-team-badge')).toContainText('店铺运营小组', { timeout: READY_TIMEOUT });
    await expect(page.getByTestId('chat-title-app-badge')).toContainText(APP_NAME);
  });

  test('the 专家 page opens on 本应用 and can widen to 全部', async () => {
    await showSidebar(page);
    await page.getByLabel('Main navigation').getByRole('button', { name: TEAM_NAV }).click();
    await expect(page.getByTestId('team-app-scope-app')).toHaveAttribute('aria-selected', 'true');
    await page.getByTestId('team-source-mine').click();
    await expect(page.getByText('店铺客服顾问', { exact: true })).toBeVisible({ timeout: READY_TIMEOUT });
    await expect(page.getByText('我的助手', { exact: true })).toHaveCount(0);
    await page.getByTestId('team-app-scope-all').click();
    await expect(page.getByTestId('team-app-scope-all')).toHaveAttribute('aria-selected', 'true');
    await page.getByLabel('Main navigation').getByRole('button', { name: /^(新任务|New task)$/ }).click();
  });

  test('the url: entry shows the app page in the main area and keeps it inside its origin', async () => {
    await page.getByTestId('sidebar-app-page-portal').click();
    await expect(page.getByTestId('app-page-view')).toHaveAttribute('data-nav-item', 'portal');
    await expect.poll(() => pages.hits.length, { timeout: READY_TIMEOUT }).toBeGreaterThan(0);
    expect(pages.hits[0]).toBe('/portal');
    // Leaving the page hides the native view; nothing else is requested.
    const hitsBefore = pages.hits.length;
    await page.getByLabel('Main navigation').getByRole('button', { name: /^(新任务|New task)$/ }).click();
    await expect(page.getByTestId('app-home-title')).toBeVisible();
    expect(pages.hits.length).toBe(hitsBefore);
  });

  test('the selection survives a restart; exiting returns to 通用 with the six entries', async () => {
    await closeAbuElectron(app);
    const relaunched = await launchAbuElectron(dataRoot);
    app = relaunched.app;
    page = await app.firstWindow();
    await expect(page.getByRole('button', { name: /^(显示侧栏|隐藏侧栏|Show sidebar|Hide sidebar)$/ })).toBeVisible({ timeout: READY_TIMEOUT });
    await showSidebar(page);
    await expect(page.getByTestId('app-switcher-current')).toHaveText(APP_NAME, { timeout: READY_TIMEOUT });
    await expect(page.getByTestId('app-home-title')).toBeVisible({ timeout: READY_TIMEOUT });

    // The bound conversation reopens with its badge, whatever app is current.
    await page.getByTestId('conversation-app-icon').first().click();
    await expect(page.getByTestId('chat-title-app-badge')).toContainText(APP_NAME, { timeout: READY_TIMEOUT });
    await expect(page.getByTestId('app-switcher-current')).toHaveText(APP_NAME);

    await openSwitcher(page);
    await page.getByTestId('app-switcher-exit').click();
    await expect(page.getByTestId('app-switcher-current')).toHaveText(/通用|General/);
    await expect(page.getByTestId('sidebar-app-page-portal')).toHaveCount(0);
    await expect(page.getByLabel('Main navigation').getByRole('button', { name: /^(自动化|Automation)$/ })).toBeVisible();
    await openSwitcher(page);
    await expect(page.getByTestId('app-switcher-menu')).toContainText(/最近使用|Recent/);
    await page.getByTestId(`app-switcher-item-${ENTRY_NAME}@abu-examples`).click();
    await expect(page.getByTestId('app-switcher-current')).toHaveText(APP_NAME);
  });

  test('uninstalling the app leaves its conversation readable with a removed notice', async () => {
    await showSidebar(page);
    await page.getByLabel('Main navigation').getByRole('button', { name: EXTENSIONS }).click();
    await page.getByRole('main').getByRole('button', { name: /^(插件|Plugins)(\s.*)?$/ }).click();
    await page.getByTestId('extensions-source-mine').click();
    const row = page.getByTestId('plugin-installed-group').getByTestId('plugin-mine-row');
    await expect(row).toContainText(ENTRY_NAME);
    await row.getByRole('button', { name: /^(卸载|Uninstall): / }).click();
    await page.getByRole('button', { name: /^(卸载|Uninstall)$/ }).click();
    await expect(row).toHaveCount(0, { timeout: READY_TIMEOUT });

    await expect(page.getByTestId('app-switcher-current')).toHaveText(/通用|General/, { timeout: READY_TIMEOUT });
    await page.getByTestId('conversation-app-icon').first().click();
    await expect(page.getByTestId('conversation-app-removed')).toContainText(APP_NAME, { timeout: READY_TIMEOUT });
    await expect(page.getByTestId('chat-title-app-badge')).toContainText(APP_NAME);
  });
});
