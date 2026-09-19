/**
 * A managed provider's models next to the user's own, in the real Electron shell.
 *
 * Two loopback servers record the Authorization header of every request: one
 * belongs to the external system that registers the managed provider, the other
 * is the user's own provider. "Each provider's calls carry only that provider's
 * credential" is asserted against what actually reached the wire.
 *
 * The external system is supplied by a fixture outside this repository. The
 * spec skips itself unless both are set:
 *   ABU_BUILD_TARGET=enterprise   a renderer build that can register a managed provider
 *   ABU_E2E_ORG_FIXTURE           absolute path of a module exporting
 *                                 `startOrganization({ appDataDir, reply })`
 * The fixture starts its server, arranges for the shell to register the managed
 * provider on the next launch, and returns what the assertions below need.
 */
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { ElectronApplication, Locator, Page } from 'playwright';
import {
  closeAbuElectron,
  configureLocalMockProvider,
  createElectronDataRoot,
  dismissFirstRunOverlays,
  launchAbuElectron,
  removeElectronDataRoot,
  REPO_ROOT,
  type ElectronDataRoot,
} from './electronHelpers';

const READY_TIMEOUT = 45_000;
const CHAT_PLACEHOLDER = '想让阿布帮你做点什么？';
const SCREENSHOT_DIR = path.join(REPO_ROOT, 'test-results');
const ORG_FIXTURE = process.env.ABU_E2E_ORG_FIXTURE ?? '';

const PERSONAL_KEY = 'abu-e2e-personal-key-not-a-real-secret';
const PERSONAL = { id: 'mpm-own', name: 'MPM Own Provider', modelId: 'own-model', modelLabel: 'Own Model' };

// The memory extractor quotes the transcript in its own request; it is
// background traffic, not a task turn.
const MEMORY_EXTRACTOR_PROMPT = '记忆提取助手';

interface RecordedChat {
  authorization: string;
  isTask: boolean;
  lastUser: string;
  model: unknown;
}

interface Organization {
  name: string;
  models: string[];
  credential: string;
  /** What the sidebar account trigger shows while the managed provider is registered. */
  accountLabel: string;
  chats: RecordedChat[];
  modelListAuthorizations: string[];
  /** Replaces the grant the next model-list pull returns. */
  setModels: (ids: string[]) => void;
  close: () => Promise<void>;
}

interface OwnProviderMock {
  baseUrl: string;
  chats: RecordedChat[];
  close: () => Promise<void>;
}

function sseChunk(delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-abu-e2e-mpm',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'mpm-mock',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function messageText(message: { content?: unknown }): string {
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
}

async function startOwnProviderMock(reply: string): Promise<OwnProviderMock> {
  const chats: RecordedChat[] = [];
  const open = new Set<ServerResponse>();
  const server: Server = createServer(async (req, res) => {
    open.add(res);
    res.once('close', () => open.delete(res));
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    const body = JSON.parse(raw) as Record<string, unknown>;
    const messages = Array.isArray(body.messages) ? (body.messages as Array<{ role?: unknown; content?: unknown }>) : [];
    const system = messages.filter((m) => m.role === 'system').map(messageText).join('\n');
    const isMemory = system.includes(MEMORY_EXTRACTOR_PROMPT);
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    chats.push({
      authorization: String(req.headers.authorization ?? ''),
      isTask: hasTools && !isMemory,
      lastUser: messages.filter((m) => m.role === 'user').map(messageText).at(-1) ?? '',
      model: body.model,
    });
    const content = isMemory ? '[]' : reply;
    if (body.stream === false) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        id: 'chatcmpl-abu-e2e-mpm',
        object: 'chat.completion',
        created: 0,
        model: 'mpm-mock',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      }));
      return;
    }
    res.writeHead(200, {
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'content-type': 'text/event-stream; charset=utf-8',
    });
    res.write(sseChunk({ content }, null));
    res.write(sseChunk({}, 'stop'));
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('own-provider mock got no TCP port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    chats,
    close: () => new Promise<void>((resolve) => {
      for (const response of open) response.destroy();
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}

function taskChats(side: { chats: RecordedChat[] }, marker: string): RecordedChat[] {
  return side.chats.filter((c) => c.isTask && c.lastUser.includes(marker));
}

function composerInput(page: Page): Locator {
  return page.getByPlaceholder(CHAT_PLACEHOLDER);
}

function composerModelButton(page: Page, label: string): Locator {
  return page.getByTestId('composer-toolbar').locator(`button[title="${label}"]`);
}

function pickerRow(page: Page, label: string): Locator {
  return page.locator('div[role="button"]').filter({ hasText: new RegExp(`^${label}$`) }).last();
}

async function launch(dataRoot: ElectronDataRoot): Promise<{ app: ElectronApplication; page: Page }> {
  const launched = await launchAbuElectron(dataRoot);
  const page = await launched.app.firstWindow({ timeout: READY_TIMEOUT });
  await launched.app.evaluate(({ BrowserWindow }) => {
    const [win] = BrowserWindow.getAllWindows();
    if (win.isMaximized()) win.unmaximize();
    win.setContentSize(1440, 960);
  });
  await page.waitForLoadState('domcontentloaded');
  await expect(composerInput(page)).toBeVisible({ timeout: READY_TIMEOUT });
  await dismissFirstRunOverlays(page);
  return { app: launched.app, page };
}

async function showSidebar(page: Page): Promise<void> {
  const sidebarToggle = page.locator('[data-window-control="sidebar"]').first();
  if (/^显示/.test((await sidebarToggle.getAttribute('aria-label')) ?? '')) {
    await sidebarToggle.click();
    await expect(sidebarToggle).not.toHaveAttribute('aria-label', /^显示/);
  }
}

// The sidebar account trigger shows the managed account's name when the build
// displays one, and the default nickname otherwise.
const DEFAULT_ACCOUNT_LABEL = /^(我|Me)$/;

async function openModelSettings(page: Page, accountLabel: string): Promise<Locator> {
  await showSidebar(page);
  const triggers = page.locator('button[aria-haspopup="menu"]');
  await triggers.filter({ hasText: accountLabel }).or(triggers.filter({ hasText: DEFAULT_ACCOUNT_LABEL })).first().click();
  await page.getByText('设置', { exact: true }).last().click();
  const dialog = page.locator('[data-abu-settings-dialog]');
  await expect(dialog).toBeVisible({ timeout: READY_TIMEOUT });
  await dialog.getByText('模型', { exact: true }).first().click();
  return dialog;
}

async function closeSettings(page: Page): Promise<void> {
  await page.locator('[data-abu-settings-close]').click();
  await expect(page.locator('[data-abu-settings-dialog]')).toHaveCount(0);
}

async function send(page: Page, marker: string, reply: string): Promise<void> {
  const input = composerInput(page);
  await input.fill(marker);
  await input.press('Enter');
  await expect(page.getByText(reply, { exact: true }).last()).toBeVisible({ timeout: READY_TIMEOUT });
  await expect(page.getByRole('button', { name: '停止' })).toHaveCount(0, { timeout: READY_TIMEOUT });
}

test.describe('managed provider models', () => {
  test.skip(
    process.env.ABU_BUILD_TARGET !== 'enterprise' || !ORG_FIXTURE,
    'needs ABU_BUILD_TARGET=enterprise and ABU_E2E_ORG_FIXTURE',
  );

  let app: ElectronApplication | undefined;
  let dataRoot: ElectronDataRoot | undefined;
  let organization: Organization | undefined;
  let own: OwnProviderMock | undefined;

  test.afterEach(async () => {
    const [openApp, openOrganization, openOwn, openDataRoot] = [app, organization, own, dataRoot];
    app = undefined;
    organization = undefined;
    own = undefined;
    dataRoot = undefined;
    try {
      if (openApp) await closeAbuElectron(openApp);
    } finally {
      try {
        await Promise.allSettled([openOrganization?.close(), openOwn?.close()]);
      } finally {
        if (openDataRoot) removeElectronDataRoot(openDataRoot);
      }
    }
  });

  test('a managed provider\'s models sit beside the user\'s own, and each call carries only its own credential', async () => {
    test.setTimeout(420_000);
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const mine = await startOwnProviderMock('OWN-REPLY');
    own = mine;
    dataRoot = createElectronDataRoot();

    await test.step('the user configures a provider of their own first', async () => {
      const first = await launch(dataRoot!);
      app = first.app;
      await configureLocalMockProvider(first.page, mine.baseUrl, {
        apiKey: PERSONAL_KEY,
        providerId: PERSONAL.id,
        providerName: PERSONAL.name,
        modelId: PERSONAL.modelId,
        modelLabel: PERSONAL.modelLabel,
        supportsTools: true,
      });
      await expect(composerModelButton(first.page, PERSONAL.modelLabel)).toBeVisible({ timeout: READY_TIMEOUT });
      await closeAbuElectron(first.app);
      app = undefined;
    });

    const fixture = await import(pathToFileURL(ORG_FIXTURE).href) as {
      startOrganization: (options: { appDataDir: string; reply: string }) => Promise<Organization>;
    };
    const org = await fixture.startOrganization({ appDataDir: dataRoot.appDataDir, reply: 'ORG-REPLY' });
    organization = org;
    let { app: shell, page } = await launch(dataRoot);
    app = shell;

    // The one-time notice that goes with this is not asserted here: `launch`
    // reloads the page to dismiss first-run overlays, and the notice belongs to
    // the load before that reload.
    await test.step('the first launch that finds the managed provider makes its first model the default', async () => {
      await expect(composerModelButton(page, org.models[0])).toBeVisible({ timeout: READY_TIMEOUT });
    });

    await test.step('settings lists the managed provider as a read-only card next to the user\'s own', async () => {
      const dialog = await openModelSettings(page, org.accountLabel);
      const orgCard = dialog.locator('div.group', { hasText: `由 ${org.name} 提供` }).first();
      await expect(orgCard).toBeVisible({ timeout: READY_TIMEOUT });
      await expect(orgCard.getByText(`已连接 · ${org.models.length} 个模型`)).toBeVisible({ timeout: READY_TIMEOUT });
      await expect(orgCard.getByRole('switch')).toHaveCount(0);
      await expect(orgCard.getByTitle('编辑', { exact: true })).toHaveCount(0);
      await expect(orgCard.getByTitle('删除', { exact: true })).toHaveCount(0);
      await expect(orgCard.getByTitle('重新同步', { exact: true })).toHaveCount(1);

      const ownCard = dialog.locator('div.group', { hasText: PERSONAL.name }).first();
      await expect(ownCard).toBeVisible();
      await expect(ownCard.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
      await expect(dialog.getByText(org.credential)).toHaveCount(0);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'managed-models-01-settings.png') });
      await closeSettings(page);
      expect(org.modelListAuthorizations.length).toBeGreaterThan(0);
      expect(org.modelListAuthorizations.every((a) => a === `Bearer ${org.credential}`)).toBe(true);
    });

    await test.step('the picker lists the managed provider first and the user\'s own under 我的模型', async () => {
      await composerModelButton(page, org.models[0]).click();
      const orgHeader = page.getByText(org.name, { exact: true }).last();
      const mineHeader = page.getByText('我的模型', { exact: true });
      await expect(orgHeader).toBeVisible();
      await expect(mineHeader).toBeVisible();
      const [orgBox, mineBox] = [await orgHeader.boundingBox(), await mineHeader.boundingBox()];
      expect(orgBox!.y).toBeLessThan(mineBox!.y);
      await expect(pickerRow(page, org.models[0])).toBeVisible();
      await expect(pickerRow(page, PERSONAL.modelLabel)).toBeVisible();
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'managed-models-02-picker.png') });
      await pickerRow(page, org.models[0]).click();
      await expect(composerModelButton(page, org.models[0])).toBeVisible();
    });

    await test.step('a managed model is called with the managed credential only', async () => {
      const marker = 'mpm-org-turn';
      await send(page, marker, 'ORG-REPLY');
      const calls = taskChats(org, marker);
      expect(calls.map((c) => c.model)).toEqual([org.models[0]]);
      expect(calls.map((c) => c.authorization)).toEqual([`Bearer ${org.credential}`]);
      expect(taskChats(mine, marker)).toEqual([]);
    });

    await test.step('switching this conversation to the user\'s own model calls their provider with their key only', async () => {
      const marker = 'mpm-own-turn';
      await composerModelButton(page, org.models[0]).click();
      await pickerRow(page, PERSONAL.modelLabel).click();
      await expect(composerModelButton(page, PERSONAL.modelLabel)).toBeVisible();
      await send(page, marker, 'OWN-REPLY');
      const calls = taskChats(mine, marker);
      expect(calls.map((c) => c.model)).toEqual([PERSONAL.modelId]);
      expect(calls.map((c) => c.authorization)).toEqual([`Bearer ${PERSONAL_KEY}`]);
      expect(taskChats(org, marker)).toEqual([]);
    });

    await test.step('no request to either side ever carried the other side\'s credential', async () => {
      expect(org.chats.some((c) => c.authorization.includes(PERSONAL_KEY))).toBe(false);
      expect(mine.chats.some((c) => c.authorization.includes(org.credential))).toBe(false);
    });

    await test.step('the managed credential never reaches localStorage', async () => {
      const stored = await page.evaluate(() => window.localStorage.getItem('abu-settings') ?? '');
      expect(stored).not.toContain(org.credential);
      expect(stored).not.toContain('"source":"managed"');
    });

    await test.step('a conversation bound to a managed model is still bound to it after a restart', async () => {
      await composerModelButton(page, PERSONAL.modelLabel).click();
      await pickerRow(page, org.models[1]).click();
      await expect(composerModelButton(page, org.models[1])).toBeVisible();
      await send(page, 'mpm-before-restart', 'ORG-REPLY');

      await closeAbuElectron(shell);
      app = undefined;
      ({ app: shell, page } = await launch(dataRoot!));
      app = shell;
      // The conversation is titled after its first message.
      await showSidebar(page);
      await page.getByText('mpm-org-turn').first().click();
      await expect(page.getByText('mpm-before-restart').first()).toBeVisible({ timeout: READY_TIMEOUT });
      await expect(composerModelButton(page, org.models[1])).toBeVisible({ timeout: READY_TIMEOUT });
      const marker = 'mpm-after-restart';
      await send(page, marker, 'ORG-REPLY');
      expect(taskChats(org, marker).map((c) => c.model)).toEqual([org.models[1]]);
    });

    await test.step('a model the organization withdraws is blocked before the next send, and the picker opens', async () => {
      org.setModels([org.models[0]]);
      // The list on hand is re-pulled when a turn ends, so the turn in flight still runs.
      await send(page, 'mpm-revoked-turn', 'ORG-REPLY');
      await expect(composerModelButton(page, `${org.models[1]}（不可用）`)).toBeVisible({ timeout: READY_TIMEOUT });

      const input = composerInput(page);
      await input.fill('mpm-revoked-blocked');
      await input.press('Enter');
      await expect(page.getByText(`模型「${org.models[1]}」已不可用，请重新选择`).first()).toBeVisible({ timeout: READY_TIMEOUT });
      await expect(pickerRow(page, org.models[0])).toBeVisible();
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'managed-models-04-revoked.png') });
      expect(taskChats(org, 'mpm-revoked-blocked')).toEqual([]);

      await pickerRow(page, org.models[0]).click();
      await expect(composerModelButton(page, org.models[0])).toBeVisible();
      await send(page, 'mpm-after-revoke', 'ORG-REPLY');
      expect(taskChats(org, 'mpm-after-revoke').map((c) => c.model)).toEqual([org.models[0]]);
    });

    await test.step('when the managed provider cannot be reached the composer says so and offers the user\'s own model', async () => {
      await org.close();
      const input = composerInput(page);
      await input.fill('mpm-unreachable');
      await input.press('Enter');
      await expect(page.getByText(`暂时连不上 ${org.name} 的模型服务`, { exact: false }).first()).toBeVisible({ timeout: READY_TIMEOUT });
      await expect(page.getByRole('button', { name: '停止' })).toHaveCount(0, { timeout: READY_TIMEOUT });
      expect(taskChats(mine, 'mpm-unreachable')).toEqual([]);

      const notice = page.getByTestId('managed-provider-offline');
      await expect(notice).toBeVisible({ timeout: READY_TIMEOUT });
      await expect(notice).toContainText(`暂时连不上 ${org.name} 的模型服务`);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'managed-models-03-unreachable.png') });

      // The switch happens only on the click, and only for this conversation.
      await notice.getByRole('button', { name: '用我自己的模型' }).click();
      await expect(composerModelButton(page, PERSONAL.modelLabel)).toBeVisible();
      await expect(notice).toHaveCount(0);
      await send(page, 'mpm-own-after-outage', 'OWN-REPLY');
      expect(taskChats(mine, 'mpm-own-after-outage').map((c) => c.authorization)).toEqual([`Bearer ${PERSONAL_KEY}`]);
    });
  });
});
