import { expect, test } from '@playwright/test';
import type { ElectronApplication, Locator, Page } from 'playwright';
import {
  closeAbuElectron, configureLocalMockProvider, createElectronDataRoot, dismissFirstRunOverlays,
  launchAbuElectron, removeElectronDataRoot, type ElectronDataRoot,
} from './electronHelpers';
import { CHAT_PLACEHOLDER, READY_TIMEOUT, startOpenAiMock, waitForApp, type OpenAiMock } from './openAiMock';

let app: ElectronApplication;
let dataRoot: ElectronDataRoot;
let model: OpenAiMock | undefined;

test.beforeEach(async () => {
  dataRoot = createElectronDataRoot();
  app = (await launchAbuElectron(dataRoot)).app;
});

test.afterEach(async () => {
  await closeAbuElectron(app);
  await model?.close();
  model = undefined;
  removeElectronDataRoot(dataRoot);
});

async function resize(width: number, height: number) {
  await app.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes('index.html'));
    if (!window) throw new Error('Main window is unavailable');
    window.setContentSize(size.width, size.height);
  }, { width, height });
}

async function box(locator: Locator) {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error('Expected a rendered element');
  return bounds;
}

async function settled(locator: Locator) {
  await expect.poll(() => locator.evaluate((element) => element.getAnimations().filter((animation) => animation.playState === 'running').length)).toBe(0);
}

async function openSettings(page: Page) {
  await page.getByRole('button', { name: '我', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  const settings = page.locator('[data-abu-settings-dialog]');
  await expect(settings).toBeVisible();
  await settled(settings);
  return settings;
}

async function scrollPopoverToEnd(page: Page, list: Locator) {
  const dimensions = await list.evaluate((element) => ({ height: element.clientHeight, total: element.scrollHeight }));
  expect(dimensions.total).toBeGreaterThan(dimensions.height);
  await list.hover();
  await page.mouse.wheel(0, dimensions.total);
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect.poll(() => list.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1);
}

for (const size of [{ width: 1200, height: 800 }, { width: 900, height: 700 }]) {
  test(`scrolls the provider list to its last choice at ${size.width}x${size.height}`, async () => {
    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(page);
    await dismissFirstRunOverlays(page);
    await resize(size.width, size.height);
    const settings = await openSettings(page);
    await settings.getByRole('button', { name: '模型', exact: true }).click();
    await settings.locator('[data-settings-header]').getByRole('button', { name: '添加', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '添加 AI 服务', exact: true });
    await dialog.getByRole('button', { name: '选择供应商', exact: true }).click();
    const popover = page.locator('[data-ds-popover]');
    await scrollPopoverToEnd(page, popover.locator('.max-h-64'));
    await expect(popover.getByRole('button', { name: '自定义 API', exact: true })).toBeInViewport();
    await popover.getByRole('button', { name: '自定义 API', exact: true }).click();
    await expect(popover).toHaveCount(0);
    await expect(dialog.getByLabel('服务名称', { exact: true })).toHaveValue('自定义 API');
  });
}

test('scrolls a provider model list and returns focus after closing it', async () => {
  const page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(page);
  await dismissFirstRunOverlays(page);
  await resize(1200, 800);
  const settings = await openSettings(page);
  await settings.getByRole('button', { name: '模型', exact: true }).click();
  await settings.locator('[data-settings-header]').getByRole('button', { name: '添加', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加 AI 服务', exact: true });
  await dialog.getByRole('button', { name: '选择供应商', exact: true }).click();
  const popover = page.locator('[data-ds-popover]');
  await popover.getByPlaceholder('搜索供应商...').fill('七牛');
  await popover.getByRole('button', { name: '七牛云', exact: true }).click();
  await expect(popover).toHaveCount(0);
  const trigger = dialog.getByRole('button', { name: '选择模型', exact: true });
  await trigger.click();
  await scrollPopoverToEnd(page, popover.locator('.max-h-64'));
  const last = popover.getByRole('checkbox', { name: 'Claude 4.6 Opus', exact: true });
  await expect(last).toBeInViewport();
  await last.click();
  await expect(last).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Claude 4.6 Opus', exact: true })).toBeFocused();
  await expect(dialog).toBeVisible();
});

test('renders every diagram when one reply contains concurrent Mermaid renders', async () => {
  const count = 8;
  model = await startOpenAiMock([{ kind: 'complete', responseText: Array.from({ length: count }, (_, index) => [
    '```mermaid',
    'flowchart LR',
    `A[Diagram ${index + 1}] --> B[Ready ${index + 1}]`,
    '```',
  ].join('\n')).join('\n\n') }]);
  const page = await app.firstWindow({ timeout: READY_TIMEOUT });
  const errors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await waitForApp(page);
  await configureLocalMockProvider(page, model.baseUrl);
  const input = page.getByPlaceholder(CHAT_PLACEHOLDER);
  await input.fill('Show all eight diagrams');
  await input.press('Enter');
  const diagrams = page.locator('[data-renderable-code="mermaid"]');
  try {
    await expect(diagrams).toHaveCount(count, { timeout: READY_TIMEOUT });
    for (let index = 0; index < count; index++) {
      await expect(diagrams.nth(index).locator('svg[id^="mermaid-"]')).toBeVisible({ timeout: READY_TIMEOUT });
      await expect(diagrams.nth(index).getByRole('button', { name: '展开查看', exact: true })).toBeAttached();
    }
  } finally {
    await test.info().attach('diagram-errors', { body: errors.join('\n'), contentType: 'text/plain' });
    await test.info().attach('diagram-text', { body: (await diagrams.allTextContents()).join('\n'), contentType: 'text/plain' });
  }
});

test('renders readable diagrams in a bounded viewer, with fit, anchored zoom, scrolling and focus return', async () => {
  model = await startOpenAiMock([{ kind: 'complete', responseText: [
    '```mermaid',
    'flowchart LR',
    'A[Conversation model] --> D{First available}',
    'B[Session model] --> D',
    'C[Global model] --> D',
    'D --> E[Selected model]',
    '```',
    '```mermaid',
    'flowchart TD',
    ...Array.from({ length: 16 }, (_, index) => `S${index}[Step ${index + 1}] --> S${index + 1}[Step ${index + 2}]`),
    '```',
  ].join('\n') }]);
  const page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(page);
  await configureLocalMockProvider(page, model.baseUrl);
  await resize(1200, 800);
  const input = page.getByPlaceholder(CHAT_PLACEHOLDER);
  await input.fill('Show the two diagrams');
  await input.press('Enter');
  const diagrams = page.locator('[data-renderable-code="mermaid"]');
  await expect(diagrams).toHaveCount(2, { timeout: READY_TIMEOUT });
  const ordinary = diagrams.first();
  await expect(ordinary.locator('svg[id^="mermaid-"]')).toBeVisible({ timeout: READY_TIMEOUT });
  const natural = await ordinary.locator('svg[id^="mermaid-"]').evaluate((element) => {
    const svg = element as SVGSVGElement;
    return { width: svg.viewBox.baseVal.width, height: svg.viewBox.baseVal.height };
  });
  const inlineWidth = (await box(ordinary.locator('svg[id^="mermaid-"]'))).width;
  await ordinary.hover();
  const opener = ordinary.getByRole('button', { name: '展开查看', exact: true });
  await opener.click();
  const viewer = page.getByRole('dialog', { name: '展开查看', exact: true });
  await expect(viewer).toBeVisible();
  await settled(viewer);
  const bounds = await box(viewer);
  expect(bounds.width).toBeLessThanOrEqual(1000);
  expect(bounds.height).toBeLessThanOrEqual(720);
  expect(bounds.y).toBeGreaterThanOrEqual(56);
  expect(bounds.x).toBeGreaterThanOrEqual(32);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(776);
  const frame = viewer.locator('iframe');
  await expect(frame).toHaveAttribute('sandbox', '');
  await expect.poll(async () => (await box(frame)).width).toBeGreaterThan(inlineWidth);
  const svg = viewer.frameLocator('iframe').locator('svg');
  await expect(svg).toBeVisible();
  expect((await box(svg)).width).toBeCloseTo((await box(frame)).width, 0);

  const actual = viewer.getByRole('button', { name: '原始大小', exact: true });
  await actual.click();
  await expect(actual).toHaveText('100%');
  expect((await box(frame)).width).toBeCloseTo(natural.width, 0);
  await viewer.getByRole('button', { name: '放大', exact: true }).click();
  await expect(actual).toHaveText('125%');
  expect((await box(frame)).width).toBeCloseTo(natural.width * 1.25, 0);
  await resize(900, 700);
  await expect(actual).toHaveText('125%');
  await viewer.getByRole('button', { name: '适合窗口', exact: true }).click();
  await resize(1200, 800);
  await expect.poll(async () => (await box(frame)).width).toBeGreaterThan(900);
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  await expect(opener).toBeFocused();

  const tall = diagrams.last();
  await tall.hover();
  await tall.getByRole('button', { name: '展开查看', exact: true }).click();
  await settled(viewer);
  await expect(actual).toHaveText('100%');
  const viewport = viewer.locator('[data-diagram-viewport]');
  const close = viewer.getByRole('button', { name: '关闭', exact: true });
  const closeBefore = await box(close);
  await viewport.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  expect(await viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
  expect((await box(close)).y).toBe(closeBefore.y);
  await viewer.getByRole('button', { name: '适合窗口', exact: true }).click();
  await expect.poll(async () => (await box(frame)).height).toBeLessThanOrEqual((await box(viewport)).height - 47);
  const fitWidth = (await box(frame)).width;
  const center = await box(viewport);
  await viewport.dispatchEvent('wheel', { ctrlKey: true, deltaY: -100, clientX: center.x + center.width / 2, clientY: center.y + center.height / 2 });
  await expect.poll(async () => (await box(frame)).width).toBeGreaterThan(fitWidth);
  await close.click();
  await expect(viewer).toHaveCount(0);
  await tall.hover();
  await tall.getByRole('button', { name: '展开查看', exact: true }).click();
  await expect(actual).toHaveText('100%');
  await close.click();
});

test('keeps profile editing on the identity row and settings actions above scrolling content', async () => {
  const page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await waitForApp(page);
  await dismissFirstRunOverlays(page);
  await resize(1200, 800);
  const trigger = page.getByRole('button', { name: '我', exact: true });
  await trigger.click();
  const identity = page.locator('[data-account-identity]');
  const edit = identity.getByRole('menuitem', { name: '编辑资料', exact: true });
  const name = identity.getByText('我', { exact: true });
  await page.getByRole('menuitem', { name: '设置', exact: true }).hover();
  await expect(edit).toHaveCSS('opacity', '0');
  const nameBefore = await box(name);
  await identity.hover();
  await expect(edit).toHaveCSS('opacity', '1');
  expect(await box(name)).toEqual(nameBefore);
  expect((await box(edit)).x).toBeGreaterThan(nameBefore.x + nameBefore.width);
  await edit.click();
  const profile = page.getByRole('dialog', { name: '编辑资料', exact: true });
  await expect(profile).toBeVisible();
  await profile.getByRole('button', { name: '取消', exact: true }).click();
  await expect(profile).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.press('Enter');
  await expect(edit).toBeFocused();
  await expect(edit).toHaveCSS('opacity', '1');
  await page.keyboard.press('Enter');
  await expect(profile).toBeVisible();
  await profile.getByRole('button', { name: '取消', exact: true }).click();
  await expect(profile).toHaveCount(0);

  await page.evaluate(async () => {
    await navigator.locks.request('abu-browser-permission-config-v2', () => {
      const raw = localStorage.getItem('abu-settings');
      if (!raw) throw new Error('Settings have not initialized');
      const persisted = JSON.parse(raw);
      persisted.state.providers = persisted.state.providers.map((provider: Record<string, unknown>) => ({ ...provider, userAdded: true, enabled: false }));
      persisted.state.auxiliaryServices.webSearch = { provider: 'searxng', baseUrl: 'http://127.0.0.1:43120' };
      persisted.state.imageGeneration = {
        defaultId: 'layout-image-1',
        backends: [1, 2].map((index) => ({ id: `layout-image-${index}`, name: `Image service ${index}`, vendor: 'custom', baseUrl: 'http://127.0.0.1:43120', apiKey: '', model: 'image-model' })),
      };
      localStorage.setItem('abu-settings', JSON.stringify(persisted));
    });
  });
  await page.reload();
  await waitForApp(page);
  const settings = await openSettings(page);
  await settings.getByRole('button', { name: '模型', exact: true }).click();
  const header = settings.locator('[data-settings-header]');
  await expect(header.getByRole('heading', { name: '模型', exact: true })).toBeVisible();
  await expect(header.getByRole('button', { name: '添加', exact: true })).toBeVisible();
  const close = settings.locator('[data-abu-settings-close]');
  const initialClose = await box(close);
  const scroller = settings.locator('[data-radix-scroll-area-viewport]');
  await scroller.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  expect(await scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect((await box(close)).y).toBe(initialClose.y);
  expect(initialClose.y + initialClose.height).toBeLessThanOrEqual((await box(scroller)).y);
  await expect(header.getByRole('heading', { name: '模型', exact: true })).toBeVisible();
  const imageRow = settings.getByRole('group', { name: '图片生成', exact: true });
  const searchRow = settings.getByRole('group', { name: '联网搜索', exact: true });
  const add = imageRow.getByRole('button', { name: '添加', exact: true });
  const imageStatus = imageRow.getByRole('button', { name: /已配置 2 个后端/ });
  const searchStatus = searchRow.getByRole('button', { name: '已配置', exact: true });
  const labelBox = await box(imageRow.getByText('图片生成', { exact: true }));
  const addBox = await box(add);
  expect(addBox.x - labelBox.x - labelBox.width).toBeCloseTo(8, 0);
  const statusBox = await box(imageStatus);
  const searchBox = await box(searchStatus);
  expect(statusBox.x + statusBox.width).toBeCloseTo(searchBox.x + searchBox.width, 0);
  await add.click();
  const backend = page.getByRole('dialog', { name: '添加后端', exact: true });
  await expect(backend).toBeVisible();
  await backend.getByRole('button', { name: '取消', exact: true }).click();
  await expect(backend).toHaveCount(0);
  await expect(add).toBeFocused();
  await resize(900, 700);
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes('index.html'));
    if (!window) throw new Error('Main window is unavailable');
    window.webContents.setZoomFactor(1.25);
  });
  await expect.poll(async () => (await box(imageRow)).width).toBeLessThan(480);
  await imageStatus.scrollIntoViewIfNeeded();
  await expect.poll(async () => {
    const action = await box(add);
    return (await box(imageStatus)).y - action.y - action.height;
  }).toBeGreaterThan(0);
  const narrowStatus = await box(imageStatus);
  const rowBox = await box(imageRow);
  expect(narrowStatus.x + narrowStatus.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 1);
  await close.click();
  await expect(settings).toHaveCount(0);
});
