/**
 * Real-Electron acceptance for switching conversations: the message area goes
 * from the old transcript to the new one without a painted frame in between
 * that shows no message row, the new transcript stays where it first painted,
 * a running conversation does not replay the enter animation of its live turn,
 * a search hit in another conversation is the first position painted, and a
 * conversation whose chart is drawn after it first shows stays at its newest
 * message in every frame while it grows.
 *
 * Every frame is sampled twice inside the page: in requestAnimationFrame and in
 * a MessageChannel callback posted from it, which runs after the frame is
 * painted. The assertions read the painted samples.
 *
 * Deterministic per TESTING.md: a loopback mock answers by the marker in the
 * last user message; the running conversation's request is held open.
 */
import { expect, test } from '@playwright/test';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { ElectronApplication, Locator, Page } from 'playwright';
import {
  closeAbuElectron,
  configureLocalMockProvider,
  createElectronDataRoot,
  launchAbuElectron,
  removeElectronDataRoot,
  type ElectronDataRoot,
} from './electronHelpers';
import { CHAT_PLACEHOLDER, READY_TIMEOUT, answerTitleRequest, classifyMockRequestPurpose } from './openAiMock';

const LONG = 'SWITCH_LONG';
const SHORT = 'SWITCH_SHORT';
const RUNNING = 'SWITCH_RUNNING';
const CHART = 'SWITCH_CHART';
const SEARCH_WORD = 'SWITCHSEARCHTARGET';
const FRAMES = 40;

interface PaintedSample {
  /** A row of the transcript intersects the viewport. */
  rowsInView: number;
  /** Which list element was on the page (a new one after the switch). */
  listId: number;
  scrollTop: number;
  scrollHeight: number;
  distanceToBottom: number;
  /** Running `block-expand-enter` animations inside the scroller. */
  enterAnimations: number;
  /** The row holding the search target message intersects the viewport. */
  searchRowInView: boolean;
  /**
   * Where the element in the middle of the viewport when the new list first
   * painted is now, from the top of the viewport; null before that frame and
   * once the element has left the page (a box that stood in for a block still
   * loading leaves with the block in its place).
   */
  anchorTop: number | null;
  /** Where that element's row is now, from the top of the viewport; null before the first frame. */
  rowTop: number | null;
}

function sseDelta(delta: Record<string, string>, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-conversation-switch',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'abu-conversation-switch-e2e',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

/** The text of the last user message of a task request, or '' for memory and compression requests. */
function lastUserText(body: string): string {
  const parsed = JSON.parse(body) as { messages?: { role: string; content: unknown }[] };
  if (classifyMockRequestPurpose(parsed) !== 'task') return '';
  const user = [...(parsed.messages ?? [])].reverse().find((m) => m.role === 'user');
  return user ? JSON.stringify(user.content) : '';
}

function longReply(turn: string): string {
  const paragraph = (index: number) => `第 ${index + 1} 段：这一段用来把回复撑高，切换对话时消息区要直接显示最底部。`;
  return [...Array.from({ length: 24 }, (_, index) => paragraph(index)), `LONG_DONE_${turn}`].join('\n\n');
}

/** A tall reply whose last part is a chart: the chart is drawn after the reply is shown, and the reply grows. */
function chartReply(): string {
  const paragraph = (index: number) => `第 ${index + 1} 段：图表画好之前，这一轮先按占位的高度显示。`;
  const chart = [
    '```mermaid',
    'flowchart TD',
    ...Array.from({ length: 8 }, (_, index) => `  S${index}[第 ${index + 1} 步] --> S${index + 1}[第 ${index + 2} 步]`),
    '```',
  ].join('\n');
  return [...Array.from({ length: 12 }, (_, index) => paragraph(index)), chart, 'CHART_DONE'].join('\n\n');
}

async function startSwitchMock(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const activeResponses = new Set<ServerResponse>();
  const server = createServer(async (req, res) => {
    activeResponses.add(res);
    res.once('close', () => activeResponses.delete(res));
    let body = '';
    for await (const chunk of req) body += String(chunk);
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unexpected route' }));
      return;
    }
    // The title call that follows a first reply is not a task turn (src/core/session/titleGen.ts).
    if (answerTitleRequest(JSON.parse(body), res)) return;
    res.writeHead(200, {
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'content-type': 'text/event-stream; charset=utf-8',
    });
    const text = lastUserText(body);
    if (text.includes(RUNNING)) {
      // Thinking that never ends: the turn stays running with its step list open.
      res.write(sseDelta({ reasoning_content: '正在比较几种做法，先看第一种的取舍。' }));
      return;
    }
    const turn = /TURN_(\d+)/.exec(text)?.[1];
    const reply = text.includes(LONG)
      ? longReply(turn ?? '0')
      : text.includes(CHART) ? chartReply() : text.includes(SHORT) ? 'SHORT_DONE' : '[]';
    res.write(sseDelta({ content: reply }));
    res.write(sseDelta({}, 'stop'));
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('loopback mock did not bind a port');
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, close: () => closeServer(server, activeResponses) };
}

function closeServer(server: Server, activeResponses: ReadonlySet<ServerResponse>): Promise<void> {
  for (const response of activeResponses) response.destroy();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections?.();
  });
}

async function send(page: Page, text: string): Promise<void> {
  const input = page.getByPlaceholder(CHAT_PLACEHOLDER).first();
  await expect(input).toBeVisible({ timeout: READY_TIMEOUT });
  await input.fill(text);
  await page.keyboard.press('Enter');
}

async function showSidebar(page: Page): Promise<void> {
  const show = page.getByRole('button', { name: '显示侧栏', exact: true });
  if (await show.count()) await show.click();
}

async function activeConversationId(page: Page): Promise<string> {
  const row = page.locator('[data-conversation-row][aria-current="true"]');
  await expect(row).toHaveCount(1, { timeout: READY_TIMEOUT });
  return (await row.getAttribute('data-conversation-row')) ?? '';
}

async function startNewTask(page: Page, text: string): Promise<void> {
  await page.getByLabel('Main navigation').getByRole('button', { name: '新任务', exact: true }).click();
  await send(page, text);
}

/**
 * Press `target` and return the painted samples of the frames that follow,
 * from the first one that shows the list mounted after the press.
 */
async function recordSwitch(
  page: Page,
  target: Locator,
  frames = FRAMES,
): Promise<{ before: PaintedSample; after: PaintedSample[] }> {
  await page.evaluate(({ frames, searchWord }) => {
    const samples: PaintedSample[] = [];
    const store = window as Window & {
      __switchSamples?: PaintedSample[];
      __switchListIds?: { ids: WeakMap<Element, number>; next: number };
    };
    store.__switchSamples = samples;
    const listIds = store.__switchListIds ?? { ids: new WeakMap<Element, number>(), next: 1 };
    store.__switchListIds = listIds;
    const listBefore = document.querySelector('[data-testid="chat-message-list"]');
    let anchor: Element | null = null;
    let anchorRow: Element | null = null;
    const measure = (): PaintedSample => {
      const scroller = document.querySelector<HTMLElement>('[data-chat-scroll-content]')?.parentElement ?? null;
      const list = document.querySelector('[data-testid="chat-message-list"]');
      if (list && !listIds.ids.has(list)) listIds.ids.set(list, listIds.next++);
      const ids = listIds.ids;
      if (!scroller) {
        return { rowsInView: 0, listId: 0, scrollTop: 0, scrollHeight: 0, distanceToBottom: 0, enterAnimations: 0, searchRowInView: false, anchorTop: null, rowTop: null };
      }
      const view = scroller.getBoundingClientRect();
      if (list && list !== listBefore && !anchor) {
        // The element in the middle of the viewport; a transcript shorter than
        // the viewport has none there, and its last row stands in.
        const middle = document.elementFromPoint(view.left + view.width / 2, view.top + view.height / 2);
        anchor = middle && list.contains(middle) ? middle : [...list.querySelectorAll('[data-index]')].at(-1) ?? null;
        anchorRow = anchor?.closest('[data-index]') ?? null;
      }
      const intersects = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return rect.height > 0 && rect.bottom > view.top && rect.top < view.bottom;
      };
      const rowsInView = [...scroller.querySelectorAll('[data-index]')].filter(intersects).length;
      const enterAnimations = document.getAnimations().filter((animation) => (
        animation.playState === 'running'
        && (animation as CSSAnimation).animationName === 'block-expand-enter'
        && animation.effect instanceof KeyframeEffect
        && animation.effect.target instanceof Element
        && scroller.contains(animation.effect.target)
      )).length;
      const searchRow = [...scroller.querySelectorAll('[data-message-id]')]
        .find((element) => (element.textContent ?? '').includes(searchWord))
        ?.closest('[data-index]');
      return {
        rowsInView,
        listId: list ? ids.get(list) ?? 0 : 0,
        scrollTop: Math.round(scroller.scrollTop),
        scrollHeight: scroller.scrollHeight,
        distanceToBottom: Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight),
        enterAnimations,
        searchRowInView: searchRow ? intersects(searchRow) : false,
        anchorTop: anchor?.isConnected ? Math.round(anchor.getBoundingClientRect().top - view.top) : null,
        rowTop: anchorRow?.isConnected ? Math.round(anchorRow.getBoundingClientRect().top - view.top) : null,
      };
    };
    let count = 0;
    const frame = () => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => samples.push(measure());
      channel.port2.postMessage(0);
      count += 1;
      if (count < frames) requestAnimationFrame(frame);
    };
    // The first sample is the frame on screen before the press.
    samples.push(measure());
    document.addEventListener('click', () => requestAnimationFrame(frame), { capture: true, once: true });
  }, { frames, searchWord: SEARCH_WORD });
  await target.click();
  await expect.poll(() => page.evaluate(() => (window as Window & { __switchSamples?: unknown[] }).__switchSamples?.length ?? 0), {
    timeout: READY_TIMEOUT,
  }).toBeGreaterThanOrEqual(frames + 1);
  const samples = await page.evaluate(() => (window as Window & { __switchSamples?: PaintedSample[] }).__switchSamples ?? []);
  const [before, ...painted] = samples;
  const firstNew = painted.findIndex((sample) => sample.listId !== 0 && sample.listId !== before.listId);
  expect(firstNew, `the list was not remounted: ${JSON.stringify(painted.slice(0, 6))}`).toBeGreaterThanOrEqual(0);
  // Frames before the new list paints still show the old transcript.
  for (const sample of painted.slice(0, firstNew)) expect(sample.rowsInView, JSON.stringify(sample)).toBeGreaterThan(0);
  return { before, after: painted.slice(firstNew) };
}

function expectNoEmptyFrameAndNoJump(after: PaintedSample[]): void {
  for (const sample of after) expect(sample.rowsInView, JSON.stringify(after.slice(0, 8))).toBeGreaterThan(0);
  const landed = after[0].scrollTop;
  for (const sample of after) {
    expect(Math.abs(sample.scrollTop - landed), JSON.stringify(after.slice(0, 8))).toBeLessThanOrEqual(1);
  }
  expectContentInViewStays(after);
}

/**
 * What was in the middle of the viewport in the first painted frame stays
 * where it is: the element for as long as it is on the page, and its row
 * throughout.
 */
function expectContentInViewStays(after: PaintedSample[]): void {
  const trace = JSON.stringify(after.map(({ scrollTop, scrollHeight, anchorTop, rowTop }) => ({ scrollTop, scrollHeight, anchorTop, rowTop })));
  const landed = after[0].anchorTop;
  const landedRow = after[0].rowTop;
  expect(landed, trace).not.toBeNull();
  expect(landedRow, trace).not.toBeNull();
  for (const sample of after) {
    if (sample.anchorTop !== null) expect(Math.abs(sample.anchorTop - (landed ?? 0)), trace).toBeLessThanOrEqual(1);
    expect(Math.abs((sample.rowTop ?? 0) - (landedRow ?? 0)), trace).toBeLessThanOrEqual(1);
  }
}

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;
let mock: { baseUrl: string; close: () => Promise<void> } | undefined;

test.afterEach(async () => {
  if (app) await closeAbuElectron(app);
  app = undefined;
  if (dataRoot) removeElectronDataRoot(dataRoot);
  dataRoot = undefined;
  if (mock) await mock.close();
  mock = undefined;
});

test('switching conversations paints no empty message area and no jump; a running turn and a search hit land as they are', async () => {
  test.setTimeout(300_000);
  mock = await startSwitchMock();
  dataRoot = createElectronDataRoot();
  app = (await launchAbuElectron(dataRoot)).app;
  const page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER).first()).toBeVisible({ timeout: READY_TIMEOUT });
  await configureLocalMockProvider(page, mock.baseUrl, {
    contextWindowSize: 200_000,
    maxOutputTokens: 8_192,
    modelId: 'abu-conversation-switch-e2e',
    supportsReasoning: true,
  });

  // ---- A: four long turns, the first one holding the search word -------------
  await startNewTask(page, `${LONG} TURN_1 ${SEARCH_WORD}`);
  await expect(page.getByText('LONG_DONE_1')).toBeVisible({ timeout: READY_TIMEOUT });
  for (const turn of [2, 3, 4]) {
    await send(page, `${LONG} TURN_${turn}`);
    await expect(page.getByText(`LONG_DONE_${turn}`)).toBeVisible({ timeout: READY_TIMEOUT });
  }
  await showSidebar(page);
  const longId = await activeConversationId(page);

  // ---- B: one short turn ------------------------------------------------------
  await startNewTask(page, `${SHORT} TURN_1`);
  await expect(page.getByText('SHORT_DONE')).toBeVisible({ timeout: READY_TIMEOUT });
  await showSidebar(page);
  const shortId = await activeConversationId(page);

  // ---- C: running, its thinking step open -------------------------------------
  await startNewTask(page, `${RUNNING} TURN_1`);
  await expect(page.getByText('正在比较几种做法')).toBeVisible({ timeout: READY_TIMEOUT });
  await showSidebar(page);
  const runningId = await activeConversationId(page);

  const row = (id: string) => page.locator(`[data-conversation-row="${id}"]`);

  // ---- Switching lands at the newest message in one frame ---------------------
  const toLong = await recordSwitch(page, row(longId));
  expectNoEmptyFrameAndNoJump(toLong.after);
  expect(toLong.after[0].distanceToBottom, JSON.stringify(toLong.after.slice(0, 4))).toBeLessThanOrEqual(2);

  const toShort = await recordSwitch(page, row(shortId));
  expectNoEmptyFrameAndNoJump(toShort.after);

  const toLongAgain = await recordSwitch(page, row(longId));
  expectNoEmptyFrameAndNoJump(toLongAgain.after);
  expect(toLongAgain.after[0].distanceToBottom).toBeLessThanOrEqual(2);

  // ---- 「回到底部」 reaches the newest message, however the rows on the way measure ----
  const scroller = page.locator('[data-chat-scroll-content]').locator('xpath=..');
  const box = await scroller.boundingBox();
  if (!box) throw new Error('the message area has no box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 8; i += 1) await page.mouse.wheel(0, -500);
  const distanceToBottom = () => scroller.evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight));
  await expect.poll(distanceToBottom).toBeGreaterThan(1_000);
  await page.getByRole('button', { name: '回到底部', exact: true }).click();
  await expect.poll(distanceToBottom, { timeout: 5_000 }).toBeLessThanOrEqual(2);

  // ---- A running conversation shows its live turn without replaying it --------
  const toRunning = await recordSwitch(page, row(runningId));
  expectNoEmptyFrameAndNoJump(toRunning.after);
  for (const sample of toRunning.after) expect(sample.enterAnimations, JSON.stringify(sample)).toBe(0);

  // ---- A search hit in another conversation is the first painted position -----
  await recordSwitch(page, row(shortId));
  await page.locator('[data-window-control="search"]').click();
  const dialog = page.getByRole('dialog', { name: '搜索' });
  const field = dialog.getByPlaceholder('搜索对话...');
  const hit = dialog.getByRole('button').filter({ hasText: LONG });
  // The index is written after the turn ends, and the window asks it once per query.
  await expect(async () => {
    await field.fill('');
    await field.fill(SEARCH_WORD);
    await expect(hit.first()).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: READY_TIMEOUT });
  const toHit = await recordSwitch(page, hit.first());
  // The hit is in the first of four tall turns: the first painted frame is on
  // its row, nowhere near the newest message.
  expect(toHit.after[0].searchRowInView, JSON.stringify(toHit.after.slice(0, 4))).toBe(true);
  expect(toHit.after[0].distanceToBottom).toBeGreaterThan(1_000);
  expectNoEmptyFrameAndNoJump(toHit.after);
});

test('a conversation with a chart opens after a restart at its newest message, at its final height, and nothing in view moves', async () => {
  test.setTimeout(300_000);
  mock = await startSwitchMock();
  dataRoot = createElectronDataRoot();
  app = (await launchAbuElectron(dataRoot)).app;
  let page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER).first()).toBeVisible({ timeout: READY_TIMEOUT });
  await configureLocalMockProvider(page, mock.baseUrl, {
    contextWindowSize: 200_000,
    maxOutputTokens: 8_192,
    modelId: 'abu-conversation-switch-e2e',
    supportsReasoning: true,
  });

  await startNewTask(page, `${CHART} TURN_1`);
  await expect(page.getByText('CHART_DONE')).toBeVisible({ timeout: READY_TIMEOUT });
  // The chart is drawn in this run, so the height it is drawn at is known to the next.
  await expect(page.locator('[data-chat-scroll-content] svg[id^="mermaid-"]')).toBeVisible({ timeout: READY_TIMEOUT });
  await showSidebar(page);
  const chartId = await activeConversationId(page);
  await startNewTask(page, `${SHORT} TURN_1`);
  await expect(page.getByText('SHORT_DONE')).toBeVisible({ timeout: READY_TIMEOUT });
  await showSidebar(page);
  const shortId = await activeConversationId(page);

  // A new run draws the chart again; the height it was drawn at is remembered across runs.
  await closeAbuElectron(app);
  app = (await launchAbuElectron(dataRoot)).app;
  page = await app.firstWindow({ timeout: READY_TIMEOUT });
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER).first()).toBeVisible({ timeout: READY_TIMEOUT });
  await showSidebar(page);
  await page.locator(`[data-conversation-row="${shortId}"]`).click();
  await expect(page.getByText('SHORT_DONE')).toBeVisible({ timeout: READY_TIMEOUT });

  const toChart = await recordSwitch(page, page.locator(`[data-conversation-row="${chartId}"]`), 90);
  await expect(page.locator('[data-chat-scroll-content] svg[id^="mermaid-"]')).toBeVisible();
  const frames = JSON.stringify(toChart.after.map(({ rowsInView, scrollTop, scrollHeight, distanceToBottom, anchorTop }) => (
    { rowsInView, scrollTop, scrollHeight, distanceToBottom, anchorTop })));
  // The block held the chart's height while the chart was drawn again: the transcript never grew.
  const heights = toChart.after.map((sample) => sample.scrollHeight);
  expect(Math.max(...heights) - Math.min(...heights), frames).toBeLessThanOrEqual(2);
  for (const sample of toChart.after) {
    expect(sample.rowsInView, frames).toBeGreaterThan(0);
    expect(sample.distanceToBottom, frames).toBeLessThanOrEqual(2);
  }
  expectContentInViewStays(toChart.after);
});
