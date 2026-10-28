import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import path from 'node:path';
import type { ElectronApplication, Page } from 'playwright';
import {
  closeAbuElectron,
  configureLocalMockProvider,
  createElectronDataRoot,
  dismissFirstRunOverlays,
  launchAbuElectron,
  pressWhenSettled,
  removeElectronDataRoot,
} from './electronHelpers';
import { CHAT_PLACEHOLDER, READY_TIMEOUT, closeServer, startOpenAiMock, taskRequests, waitForApp } from './openAiMock';

const MODEL_A = { id: 'llama3.2:latest', label: 'Llama Local' };
const FLASH = { id: 'deepseek-flash', label: 'DeepSeek Flash' };
const LLAMA_VISION = { id: 'llama3.2-vision:latest', label: 'Llama Vision' };

function modelButton(page: Page, label: string) {
  return page.getByTestId('composer-toolbar').getByRole('button', { name: label, exact: true });
}

async function chooseModel(page: Page, current: string, next: string) {
  await modelButton(page, current).click();
  const row = page.locator('div[role="button"]').filter({ has: page.getByText(next, { exact: true }) }).last();
  await expect(row).toBeVisible();
  if (next === FLASH.label) await expect(row).toContainText('能看图');
  if (next === MODEL_A.label) await expect(row).not.toContainText('能看图');
  await row.click();
  await expect(modelButton(page, next)).toBeVisible();
}

async function newTask(page: Page) {
  await showSidebar(page);
  await page.getByRole('button', { name: '新任务', exact: true }).first().click();
}

async function showSidebar(page: Page) {
  const show = page.getByRole('button', { name: '显示侧栏', exact: true });
  if (await show.isVisible()) await show.click();
}

async function openConversation(page: Page, id: string | null) {
  await showSidebar(page);
  await page.locator(`[data-conversation-row="${id}"]`).click();
}

async function send(page: Page, marker: string, reply: string) {
  const input = page.getByPlaceholder(CHAT_PLACEHOLDER);
  await input.fill(marker);
  await input.press('Enter');
  await expect(page.getByText(reply, { exact: true }).last()).toBeVisible({ timeout: READY_TIMEOUT });
  await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0, { timeout: READY_TIMEOUT });
}

async function openSettings(page: Page) {
  await showSidebar(page);
  await page.getByRole('button', { name: /^(我|登录 \/ 注册)$/ }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
}

async function expectSettingsModel(page: Page, model: typeof MODEL_A, providerName: string) {
  await openSettings(page);
  await page.getByRole('button', { name: '模型', exact: true }).click();
  const provider = page.getByTestId('provider-card').filter({ has: page.getByText(providerName, { exact: true }) });
  await expect(provider).toHaveClass(/bg-fill-selected/);
  await expect(page.getByTestId('provider-card').filter({ hasNot: page.getByText(providerName, { exact: true }) }))
    .not.toHaveClass(/bg-fill-selected/);
  await page.getByRole('button', { name: '能力', exact: true }).click();
  await page.getByRole('button', { name: /^电脑操控 ·/ }).click();
  const currentModel = page.getByRole('button', { name: '当前模型', exact: true });
  if (await currentModel.getAttribute('aria-expanded') === 'false') await currentModel.click();
  const mode = model.id === MODEL_A.id ? '结构化模式' : '截图 + 界面结构';
  await expect(page.getByText(`${model.id} · ${mode}`, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '诊断', exact: true }).click();
  const category = page.getByRole('button', { name: /^AI 服务 ·/ });
  if (await category.getAttribute('aria-expanded') === 'false') await category.click();
  const diagnosticMode = model.id === MODEL_A.id ? '结构化受限模式' : '完整模式';
  await expect(page.getByText(`${model.id} · ${diagnosticMode}`, { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(modelButton(page, model.label)).toBeVisible();
}

test('new tasks remember the latest pick, existing tasks keep their models, and Flash sends images', async () => {
  test.setTimeout(240_000);
  const dataRoot = createElectronDataRoot();
  const imagePath = path.join(dataRoot.rootDir, 'flash-image.png');
  const replies = ['FIRST-A', 'SECOND-A', 'SECOND-FLASH-IMAGE', 'THIRD-FLASH', 'FIRST-A-RESTART', 'SECOND-FLASH-RESTART'];
  const mock = await startOpenAiMock(replies.map((responseText) => ({ kind: 'complete', responseText })));
  let app: ElectronApplication | undefined;
  try {
    app = (await launchAbuElectron(dataRoot)).app;
    const imageData = await app.evaluate(({ nativeImage }) => nativeImage.createFromBitmap(
      Buffer.alloc(16 * 16 * 4, 255), { width: 16, height: 16 },
    ).toPNG().toString('base64'));
    fs.writeFileSync(imagePath, Buffer.from(imageData, 'base64'));
    let page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(page);
    await dismissFirstRunOverlays(page);
    await configureLocalMockProvider(page, mock.baseUrl, {
      modelId: MODEL_A.id,
      modelLabel: MODEL_A.label,
      extraModels: [FLASH, LLAMA_VISION],
      supportsTools: true,
    });

    await modelButton(page, MODEL_A.label).click();
    const visionRow = page.locator('div[role="button"]').filter({ has: page.getByText(LLAMA_VISION.label, { exact: true }) }).last();
    const localRow = page.locator('div[role="button"]').filter({ has: page.getByText(MODEL_A.label, { exact: true }) }).last();
    await expect(visionRow).toContainText('能看图');
    await expect(localRow).not.toContainText('能看图');
    await page.keyboard.press('Escape');

    await send(page, 'first conversation', replies[0]);
    const first = await page.locator('[data-conversation-row]').first().getAttribute('data-conversation-row');
    expect(first).toBeTruthy();
    await newTask(page);
    await expect(modelButton(page, MODEL_A.label)).toBeVisible();
    await send(page, 'second conversation', replies[1]);
    const second = await page.locator('[data-conversation-row]').first().getAttribute('data-conversation-row');
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);

    await chooseModel(page, MODEL_A.label, FLASH.label);
    // The dialog is the OS boundary; image loading, admission and request serialization run normally.
    await app.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] });
    }, imagePath);
    await page.getByTestId('composer-plus').click();
    await page.getByTestId('composer-menu-add-file').click();
    await expect(page.getByRole('button', { name: '点击查看大图', exact: true })).toBeVisible();
    await send(page, 'describe the attached image', replies[2]);
    const imageRequest = taskRequests(mock)[2].body as { model: string; messages: Array<{ role: string; content: unknown }> };
    expect(imageRequest.model).toBe(FLASH.id);
    const imageMessage = imageRequest.messages.filter((message) => message.role === 'user').at(-1);
    expect(imageMessage?.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'image_url', image_url: expect.objectContaining({ url: `data:image/png;base64,${imageData}` }) }),
    ]));

    await newTask(page);
    await expect(modelButton(page, FLASH.label)).toBeVisible();
    await send(page, 'third conversation', replies[3]);
    await openConversation(page, first);
    await expect(modelButton(page, MODEL_A.label)).toBeVisible();
    await newTask(page);
    await expect(modelButton(page, FLASH.label)).toBeVisible();

    await closeAbuElectron(app);
    app = undefined;
    app = (await launchAbuElectron(dataRoot)).app;
    page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(page);
    await newTask(page);
    await expect(modelButton(page, FLASH.label)).toBeVisible();
    await openConversation(page, first);
    await expect(modelButton(page, MODEL_A.label)).toBeVisible();
    await send(page, 'continue first after restart', replies[4]);
    await openConversation(page, second);
    await expect(modelButton(page, FLASH.label)).toBeVisible();
    await send(page, 'continue second after restart', replies[5]);
    expect(taskRequests(mock).map((request) => (request.body as { model: string }).model))
      .toEqual([MODEL_A.id, MODEL_A.id, FLASH.id, FLASH.id, MODEL_A.id, FLASH.id]);

    await newTask(page);
    await chooseModel(page, FLASH.label, MODEL_A.label);
    await openConversation(page, second);
    await expect(modelButton(page, FLASH.label)).toBeVisible();
    await newTask(page);
    await expect(modelButton(page, MODEL_A.label)).toBeVisible();
  } finally {
    if (app) await closeAbuElectron(app);
    await mock.close();
    removeElectronDataRoot(dataRoot);
  }
});

test('a computer setup request keeps its conversation model while another conversation is open', async () => {
  test.setTimeout(180_000);
  const dataRoot = createElectronDataRoot();
  const setupMarker = 'open computer use setup for the flash conversation';
  const toolCallId = 'call-model-scope-computer-setup';
  const mock = await startOpenAiMock([
    { kind: 'complete', responseText: 'SETUP-FLASH-CONVERSATION' },
    { kind: 'complete', responseText: 'SETUP-LOCAL-CONVERSATION' },
    {
      kind: 'tool-call', toolName: 'computer', toolCallId,
      arguments: { action: 'get_app_state', app: 'Abu', consequence: 'none' },
    },
    { kind: 'complete', responseText: 'SETUP-CANCELLED' },
  ]);
  let releaseToolResponse!: () => void;
  const toolResponseGate = new Promise<void>((resolve) => { releaseToolResponse = resolve; });
  const activeResponses = new Set<ServerResponse>();
  // Hold only the model response to this prompt until the other task is visible.
  const proxy = createServer(async (request, response) => {
    activeResponses.add(response);
    response.once('close', () => activeResponses.delete(response));
    let rawBody = '';
    for await (const chunk of request) rawBody += String(chunk);
    const body = JSON.parse(rawBody) as { messages: Array<{ role: string; content: unknown }> };
    const upstream = await fetch(`${mock.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: request.headers.authorization ?? '' },
      body: rawBody,
    });
    const responseBody = await upstream.arrayBuffer();
    const contentType = upstream.headers.get('content-type');
    if (!contentType) throw new Error('The model response has no content type');
    if (body.messages.some((message) => message.role === 'user' && message.content === setupMarker)) {
      await toolResponseGate;
    }
    response.writeHead(upstream.status, { 'content-type': contentType });
    response.end(Buffer.from(responseBody));
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(0, '127.0.0.1', () => {
      proxy.off('error', reject);
      resolve();
    });
  });
  const address = proxy.address();
  if (!address || typeof address === 'string') throw new Error('The response gate has no TCP port');
  let app: ElectronApplication | undefined;
  try {
    app = (await launchAbuElectron(dataRoot)).app;
    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(page);
    await dismissFirstRunOverlays(page);
    await configureLocalMockProvider(page, `http://127.0.0.1:${address.port}/v1`, {
      modelId: FLASH.id, modelLabel: FLASH.label, extraModels: [MODEL_A], supportsTools: true,
    });
    await send(page, 'keep this setup request task on flash', 'SETUP-FLASH-CONVERSATION');
    const flash = await page.locator('[data-conversation-row]').first().getAttribute('data-conversation-row');
    expect(flash).toBeTruthy();
    await newTask(page);
    await chooseModel(page, FLASH.label, MODEL_A.label);
    await send(page, 'keep this setup background page on local', 'SETUP-LOCAL-CONVERSATION');
    const local = await page.locator('[data-conversation-row]').first().getAttribute('data-conversation-row');
    expect(local).toBeTruthy();
    expect(flash).not.toBe(local);

    await openConversation(page, flash);
    await expect(modelButton(page, FLASH.label)).toBeVisible();
    await page.getByPlaceholder(CHAT_PLACEHOLDER).fill(setupMarker);
    await page.getByPlaceholder(CHAT_PLACEHOLDER).press('Enter');
    await expect.poll(() => taskRequests(mock).length, { timeout: READY_TIMEOUT }).toBe(3);
    await openConversation(page, local);
    await expect(modelButton(page, MODEL_A.label)).toBeVisible();
    await expect(page.getByText('SETUP-LOCAL-CONVERSATION', { exact: true }).last()).toBeVisible();
    releaseToolResponse();

    const setupDialog = page.getByRole('dialog', { name: '开启电脑操控', exact: true });
    await expect(setupDialog).toBeVisible({ timeout: READY_TIMEOUT });
    const currentModel = setupDialog.getByRole('button', { name: '当前模型', exact: true });
    if (await currentModel.getAttribute('aria-expanded') === 'false') await pressWhenSettled(currentModel);
    await expect(setupDialog.getByText(`${FLASH.id} · 截图 + 界面结构`, { exact: true })).toBeVisible();
    await expect(setupDialog.getByText(`${MODEL_A.id} · 结构化模式`, { exact: true })).toHaveCount(0);
    await pressWhenSettled(setupDialog.getByRole('button', { name: '取消', exact: true }));
    await expect(setupDialog).toBeHidden();
    await expect(modelButton(page, MODEL_A.label)).toBeVisible();
    await expect(page.getByText('SETUP-LOCAL-CONVERSATION', { exact: true }).last()).toBeVisible();
    await expect(page.getByText(setupMarker, { exact: true })).toHaveCount(0);
    await expect.poll(() => taskRequests(mock).length, { timeout: READY_TIMEOUT }).toBe(4);
    const continuation = taskRequests(mock)[3].body as {
      model: string;
      messages: Array<{
        role: string;
        tool_call_id?: string;
        tool_calls?: Array<{ id: string; function: { name: string } }>;
        content: unknown;
      }>;
    };
    expect(continuation.model).toBe(FLASH.id);
    const computerCalls = continuation.messages
      .flatMap((message) => message.role === 'assistant' ? message.tool_calls ?? [] : [])
      .filter((call) => call.function.name === 'computer');
    expect(computerCalls).toHaveLength(1);
    const results = continuation.messages.filter((message) =>
      message.role === 'tool' && message.tool_call_id === computerCalls[0].id);
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('本次电脑操作未执行');
    await expect(modelButton(page, MODEL_A.label)).toBeVisible();
    await expect(page.getByText('SETUP-LOCAL-CONVERSATION', { exact: true }).last()).toBeVisible();
    await openConversation(page, flash);
    await expect(modelButton(page, FLASH.label)).toBeVisible();
    await expect(page.getByText('SETUP-CANCELLED', { exact: true }).last()).toBeVisible({ timeout: READY_TIMEOUT });
  } finally {
    releaseToolResponse();
    if (app) await closeAbuElectron(app);
    await closeServer(proxy, activeResponses);
    await mock.close();
    removeElectronDataRoot(dataRoot);
  }
});

test('settings follow each conversation while pet permission sync preserves the latest selection through restart', async () => {
  test.setTimeout(240_000);
  const dataRoot = createElectronDataRoot();
  const replies = ['LOCAL-CONVERSATION', 'FLASH-CONVERSATION', 'LOCAL-CONTINUED', 'FLASH-CONTINUED'];
  const mock = await startOpenAiMock(replies.map((responseText) => ({ kind: 'complete', responseText })));
  let app: ElectronApplication | undefined;
  try {
    app = (await launchAbuElectron(dataRoot)).app;
    let page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(page);
    await dismissFirstRunOverlays(page);
    await configureLocalMockProvider(page, mock.baseUrl, {
      providerId: 'flash-provider', providerName: 'Flash Provider',
      modelId: FLASH.id, modelLabel: FLASH.label, supportsTools: true, computerUseEnabled: true,
    });
    await configureLocalMockProvider(page, mock.baseUrl, {
      providerId: 'local-provider', providerName: 'Local Provider',
      modelId: MODEL_A.id, modelLabel: MODEL_A.label, supportsTools: true, keepOtherProviders: true,
    });
    await page.evaluate(async () => {
      await navigator.locks.request('abu-browser-permission-config-v2', () => {
        const raw = localStorage.getItem('abu-settings');
        if (!raw) throw new Error('Settings are missing');
        const persisted = JSON.parse(raw);
        // Exercise a V54 profile with the image declarations saved by that version.
        persisted.version = 54;
        for (const provider of persisted.state.providers) {
          if (provider.id === 'local-provider') provider.models[0].declaredCapabilities.supportsImages = true;
          if (provider.id === 'flash-provider') provider.models[0].declaredCapabilities.supportsImages = false;
        }
        persisted.state.labs = { ...persisted.state.labs, pet: true };
        persisted.state.petOpen = true;
        localStorage.setItem('abu-settings', JSON.stringify(persisted));
        const diagnostic = JSON.parse(localStorage.getItem('abu-diagnostic-store') ?? '{"state":{}}');
        diagnostic.state.lastCheckedAt = 1_700_000_000_000;
        diagnostic.state.results = {
          'ai-services:computer-use-model': {
            id: 'ai-services:computer-use-model', category: 'ai-services',
            name: '当前模型的电脑操控适配', status: 'passed',
            metric: 'deepseek-flash · 完整模式', checkedAt: 1_700_000_000_000, durationMs: 0,
          },
        };
        localStorage.setItem('abu-diagnostic-store', JSON.stringify(diagnostic));
      });
    });
    await page.reload();
    await waitForApp(page);
    await expect.poll(() => page.evaluate(() => {
      const providers = JSON.parse(localStorage.getItem('abu-settings')!).state.providers as Array<{
        id: string; models: Array<{ declaredCapabilities: { supportsImages: boolean } }>;
      }>;
      return ['local-provider', 'flash-provider'].map((id) => providers.find((provider) => provider.id === id)!.models[0].declaredCapabilities.supportsImages);
    })).toEqual([false, true]);
    await expect.poll(() => app!.windows().some((window) => window.url().endsWith('/pet.html')), { timeout: READY_TIMEOUT }).toBe(true);
    const pet = app.windows().find((window) => window.url().endsWith('/pet.html'))!;
    await expect(pet.locator('[data-pet-avatar]')).toBeVisible();
    await pet.evaluate(() => {
      window.addEventListener('storage', (event) => {
        if (event.key !== 'abu-settings' || !event.newValue) return;
        const state = JSON.parse(event.newValue).state;
        document.body.dataset.permissionRevision = String(state.browserConfigRevisions.browserPermissionConfigV2);
      });
    });
    await send(page, 'keep this conversation on local', replies[0]);
    const first = await page.locator('[data-conversation-row]').first().getAttribute('data-conversation-row');
    expect(first).toBeTruthy();
    await newTask(page);
    await chooseModel(page, MODEL_A.label, FLASH.label);
    await send(page, 'keep this conversation on flash', replies[1]);
    const second = await page.locator('[data-conversation-row]').first().getAttribute('data-conversation-row');
    expect(second).toBeTruthy();
    await openConversation(page, first);
    await expectSettingsModel(page, MODEL_A, 'Local Provider');
    await openConversation(page, second);
    await expectSettingsModel(page, FLASH, 'Flash Provider');

    await openSettings(page);
    await page.getByRole('button', { name: '能力', exact: true }).click();
    await page.getByRole('button', { name: /^阿布内置浏览器 ·/ }).click();
    await page.getByRole('combobox', { name: '浏览网页', exact: true }).click();
    await page.getByRole('option', { name: '禁止', exact: true }).click();
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('abu-settings')!).state.browserPermissionConfigV2.defaults.browse)).toBe('deny');
    const revision = await page.evaluate(() => JSON.parse(localStorage.getItem('abu-settings')!).state.browserConfigRevisions.browserPermissionConfigV2);
    await expect(pet.locator('body')).toHaveAttribute('data-permission-revision', String(revision));
    await page.evaluate(() => navigator.locks.request('abu-browser-permission-config-v2', () => {}));
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('abu-settings')!).state.activeModel))
      .toEqual({ providerId: 'flash-provider', modelId: FLASH.id });
    await page.keyboard.press('Escape');
    await closeAbuElectron(app);
    app = undefined;

    app = (await launchAbuElectron(dataRoot)).app;
    page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(page);
    await newTask(page);
    await expect(modelButton(page, FLASH.label)).toBeVisible();
    await expectSettingsModel(page, FLASH, 'Flash Provider');
    await openConversation(page, first);
    await expect(modelButton(page, MODEL_A.label)).toBeVisible();
    await expectSettingsModel(page, MODEL_A, 'Local Provider');
    await send(page, 'continue the local conversation', replies[2]);
    await openConversation(page, second);
    await expect(modelButton(page, FLASH.label)).toBeVisible();
    await send(page, 'continue the flash conversation', replies[3]);
    expect(taskRequests(mock).map((request) => (request.body as { model: string }).model))
      .toEqual([MODEL_A.id, FLASH.id, MODEL_A.id, FLASH.id]);
  } finally {
    if (app) await closeAbuElectron(app);
    await mock.close();
    removeElectronDataRoot(dataRoot);
  }
});
