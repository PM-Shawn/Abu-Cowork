/**
 * Real-Electron regression for the active-turn scroll anchor. The mock stream
 * is advanced by the test one animation frame at a time, so failures identify
 * renderer geometry rather than timer or network scheduling noise.
 */
import { expect, test } from '@playwright/test';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { ElectronApplication, Page } from 'playwright';
import {
  closeAbuElectron,
  configureLocalMockProvider,
  createElectronDataRoot,
  launchAbuElectron,
  removeElectronDataRoot,
  type ElectronDataRoot,
} from './electronHelpers';

const READY_TIMEOUT = 45_000;
const CHAT_PLACEHOLDER = '想让阿布帮你做点什么？';
const PRELUDE_PROMPT = 'THINKING_SCROLL_PRELUDE_20260829';
const PRELUDE_MARKER = 'THINKING_SCROLL_PRELUDE_COMPLETE';
const WARMUP_PROMPT = 'THINKING_SCROLL_WARMUP_20260829';
const WARMUP_MARKER = 'THINKING_SCROLL_WARMUP_COMPLETE';
const PROBE_PROMPT = 'THINKING_SCROLL_PROBE_20260829';
const ANSWER_MARKER = 'THINKING_SCROLL_PROBE_COMPLETE';
const TRACE_EVENT = 'abu:chat-scroll-trace';

interface ProbeMock {
  baseUrl: string;
  close: () => Promise<void>;
  finishProbe: () => void;
  waitForProbe: () => Promise<void>;
  writeAnswer: (content: string) => void;
  writeReasoning: (content: string) => void;
}

interface ScrollTrace {
  distanceToBottom?: number;
  phase: string;
  source: string;
  scrollDelta?: number;
  spacerHeight?: number;
}

interface AnchorSample {
  anchorTop: number;
  distanceToBottom: number;
  spacerHeight: number;
  scrollTop: number;
}

function sseDelta(delta: Record<string, string>, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-thinking-scroll',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'abu-thinking-scroll-e2e',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function responseContains(body: string, marker: string): boolean {
  try {
    return JSON.stringify(JSON.parse(body)).includes(marker);
  } catch {
    return body.includes(marker);
  }
}

async function startProbeMock(): Promise<ProbeMock> {
  let probeResponse: ServerResponse | null = null;
  let resolveProbe: (() => void) | null = null;
  const probeReady = new Promise<void>((resolve) => {
    resolveProbe = resolve;
  });
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

    res.writeHead(200, {
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'content-type': 'text/event-stream; charset=utf-8',
    });

    if (responseContains(body, PROBE_PROMPT)) {
      probeResponse = res;
      resolveProbe?.();
      return;
    }

    if (responseContains(body, WARMUP_PROMPT)) {
      const lines = Array.from({ length: 35 }, (_, index) => `warmup line ${index + 1}`).join('\n');
      res.write(sseDelta({ content: `${lines}\n${WARMUP_MARKER}` }));
      res.write(sseDelta({}, 'stop'));
      res.end('data: [DONE]\n\n');
      return;
    }

    if (responseContains(body, PRELUDE_PROMPT)) {
      res.write(sseDelta({ content: `prelude answer\n${PRELUDE_MARKER}` }));
      res.write(sseDelta({}, 'stop'));
      res.end('data: [DONE]\n\n');
      return;
    }

    // Memory extraction and other background bookkeeping must not introduce a
    // real network dependency into this journey.
    res.write(sseDelta({ content: '[]' }));
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

  const requireProbeResponse = (): ServerResponse => {
    if (!probeResponse) throw new Error('probe response is not ready');
    return probeResponse;
  };

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    waitForProbe: () => probeReady,
    writeReasoning: (content) => requireProbeResponse().write(sseDelta({ reasoning_content: content })),
    writeAnswer: (content) => requireProbeResponse().write(sseDelta({ content })),
    finishProbe: () => {
      const response = requireProbeResponse();
      response.write(sseDelta({}, 'stop'));
      response.end('data: [DONE]\n\n');
    },
    close: () => closeServer(server, activeResponses),
  };
}

function closeServer(server: Server, activeResponses: ReadonlySet<ServerResponse>): Promise<void> {
  for (const response of activeResponses) response.destroy();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections?.();
  });
}

async function advanceFrames(page: Page, count: number): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function send(page: Page, text: string): Promise<void> {
  const input = page.getByPlaceholder(CHAT_PLACEHOLDER).first();
  await expect(input).toBeVisible({ timeout: READY_TIMEOUT });
  await input.fill(text);
  await page.keyboard.press('Enter');
}

async function waitForTurnCompletion(page: Page, marker: string): Promise<void> {
  await expect(page.getByText(marker, { exact: false })).toBeVisible({ timeout: READY_TIMEOUT });
  await expect(page.getByLabel(/^(停止|Stop)$/)).toBeHidden({ timeout: READY_TIMEOUT });
}

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;
let mock: ProbeMock | undefined;

test.describe.serial('Thinking scroll anchor — real Electron', () => {
  test.afterEach(async () => {
    if (app) {
      await closeAbuElectron(app);
      app = undefined;
    }
    if (dataRoot) {
      removeElectronDataRoot(dataRoot);
      dataRoot = undefined;
    }
    if (mock) {
      await mock.close();
      mock = undefined;
    }
  });

  test('keeps the active user anchor stable without a raw total-height correction', async ({ browserName: _browserName }, testInfo) => {
    mock = await startProbeMock();
    const launched = await launchAbuElectron(createElectronDataRoot());
    app = launched.app;
    dataRoot = launched;
    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await page.waitForLoadState('domcontentloaded');
    // Wait for Zustand persistence to finish hydrating before replacing its
    // provider state; configuring immediately after domcontentloaded can race
    // the initial empty-store write and leave the composer with no model.
    await expect(page.getByPlaceholder(CHAT_PLACEHOLDER).first()).toBeVisible({ timeout: READY_TIMEOUT });
    await configureLocalMockProvider(page, mock.baseUrl, {
      contextWindowSize: 200_000,
      maxOutputTokens: 8_192,
      modelId: 'abu-thinking-scroll-e2e',
      supportsReasoning: true,
    });

    await send(page, PRELUDE_PROMPT);
    await waitForTurnCompletion(page, PRELUDE_MARKER);
    await send(page, WARMUP_PROMPT);
    await waitForTurnCompletion(page, WARMUP_MARKER);

    await page.evaluate((eventName) => {
      const target = window as Window & {
        __ABU_CHAT_SCROLL_TRACE__?: boolean;
        __abuAnchorSamples?: AnchorSample[];
        __abuCollectAnchorSamples?: boolean;
        __abuScrollTraces?: ScrollTrace[];
      };
      target.__ABU_CHAT_SCROLL_TRACE__ = true;
      target.__abuScrollTraces = [];
      window.addEventListener(eventName, (event) => {
        target.__abuScrollTraces?.push((event as CustomEvent<ScrollTrace>).detail);
      });
    }, TRACE_EVENT);

    await send(page, PROBE_PROMPT);
    await mock.waitForProbe();
    const anchor = page.locator(`[data-message-id]`, { hasText: PROBE_PROMPT }).last();
    await expect(anchor).toBeVisible({ timeout: READY_TIMEOUT });
    await advanceFrames(page, 4);
    mock.writeReasoning('rail geometry seed keeps the measured active tail live\n');
    await advanceFrames(page, 6);
    const railEvidence = await page.evaluate((probe) => {
      const scroller = document.querySelector<HTMLElement>('.overlay-scroll');
      const currentTick = document.querySelector<HTMLButtonElement>('nav button[aria-current="true"]');
      const spacer = document.querySelector<HTMLElement>('[data-turn-bottom-spacer]');
      const anchorElement = Array.from(document.querySelectorAll<HTMLElement>('[data-message-id]'))
        .find((element) => element.textContent?.includes(probe));
      const messageRow = anchorElement?.closest<HTMLElement>('[data-index]');
      if (!scroller || !currentTick || !messageRow || !spacer) {
        throw new Error('chapter rail or active-turn geometry was not available');
      }
      return {
        currentLabel: currentTick.getAttribute('aria-label'),
        distanceToBottom: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
        spacerHeight: spacer?.getBoundingClientRect().height ?? 0,
        tickCount: document.querySelectorAll('nav button[aria-current]').length,
        isProbeChapter: currentTick.getAttribute('aria-label')?.includes(probe.slice(0, 20)) ?? false,
        initialTailHeight: spacer.getBoundingClientRect().top - messageRow.getBoundingClientRect().top,
      };
    }, PROBE_PROMPT);
    expect(railEvidence.tickCount).toBe(3);
    expect(railEvidence.spacerHeight).toBeGreaterThan(0);
    expect(railEvidence.isProbeChapter, railEvidence.currentLabel ?? 'missing label').toBe(true);
    await page.evaluate((probe) => {
      const target = window as Window & {
        __abuAnchorSamples?: AnchorSample[];
        __abuCollectAnchorSamples?: boolean;
      };
      const anchorElement = Array.from(document.querySelectorAll<HTMLElement>('[data-message-id]'))
        .find((element) => element.textContent?.includes(probe));
      const scroller = document.querySelector<HTMLElement>('.overlay-scroll');
      if (!anchorElement || !scroller) throw new Error('active user anchor or chat scroller not found');
      target.__abuAnchorSamples = [];
      target.__abuCollectAnchorSamples = true;
      const sample = () => {
        if (!target.__abuCollectAnchorSamples) return;
        target.__abuAnchorSamples?.push({
          anchorTop: anchorElement.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
          distanceToBottom: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
          spacerHeight: document.querySelector<HTMLElement>('[data-turn-bottom-spacer]')
            ?.getBoundingClientRect().height ?? 0,
          scrollTop: scroller.scrollTop,
        });
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, PROBE_PROMPT);

    for (let index = 0; index < 22; index += 1) {
      mock.writeReasoning(`reasoning line ${String(index + 1).padStart(2, '0')} keeps growing the active task pane\n`);
      await advanceFrames(page, 3);
    }
    mock.writeAnswer(`${ANSWER_MARKER} first answer line.\n`);
    await advanceFrames(page, 4);
    // Deliberately exceed the initial spacer. The previous regression sampled
    // only spacer>0 frames and used a short reply, so it never observed the
    // delayed +96px correction after exhaustion.
    for (let chunk = 0; chunk < 14; chunk += 1) {
      const lines = Array.from(
        { length: 8 },
        (_, index) => `long answer ${String((chunk * 8) + index + 1).padStart(3, '0')} keeps growing after spacer exhaustion`,
      ).join('\n');
      mock.writeAnswer(`${lines}\n`);
      await advanceFrames(page, 3);
    }
    mock.writeAnswer('Final answer line settles the completion fold.');
    mock.finishProbe();
    await expect(page.getByText(ANSWER_MARKER, { exact: false })).toBeVisible({ timeout: READY_TIMEOUT });
    await advanceFrames(page, 24);

    const evidence = await page.evaluate((probe) => {
      const target = window as Window & {
        __abuAnchorSamples?: AnchorSample[];
        __abuCollectAnchorSamples?: boolean;
        __abuScrollTraces?: ScrollTrace[];
      };
      target.__abuCollectAnchorSamples = false;
      const anchorElement = Array.from(document.querySelectorAll<HTMLElement>('[data-message-id]'))
        .find((element) => element.textContent?.includes(probe)) ?? null;
      const messageRow = anchorElement?.closest<HTMLElement>('[data-index]');
      const spacer = document.querySelector<HTMLElement>('[data-turn-bottom-spacer]');
      const scroller = document.querySelector<HTMLElement>('.overlay-scroll');
      return {
        samples: target.__abuAnchorSamples ?? [],
        traces: target.__abuScrollTraces ?? [],
        finalDistanceToBottom: scroller
          ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
          : Number.POSITIVE_INFINITY,
        finalTailHeight: messageRow && spacer
          ? spacer.getBoundingClientRect().top - messageRow.getBoundingClientRect().top
          : 0,
      };
    }, PROBE_PROMPT);
    const armedSamples = evidence.samples.filter((sample) => sample.spacerHeight > 0);
    const anchorTops = armedSamples.map((sample) => sample.anchorTop);
    const anchorDrift = Math.max(...anchorTops) - Math.min(...anchorTops);
    const firstExhaustedIndex = evidence.samples.findIndex((sample) => sample.spacerHeight === 0);
    const postExhaustionSamples = firstExhaustedIndex >= 0
      ? evidence.samples.slice(firstExhaustedIndex + 1)
      : [];
    const maxArmedBottomGap = Math.max(
      0,
      ...armedSamples.map((sample) => Math.abs(sample.distanceToBottom)),
    );
    const anchorStart = evidence.traces.findIndex((trace) => trace.source === 'turn-anchor');
    const anchorHandoff = evidence.traces.findIndex((trace, index) => (
      index >= anchorStart
      && trace.source === 'turn-anchor'
      && trace.phase === 'applied'
      && trace.spacerHeight === 0
    ));
    // The sampler and the scroll correction are both rAF callbacks. Depending
    // on callback registration order, a sample can observe the intermediate
    // layout before the correction later in the same frame. Applied traces are
    // emitted after scrollTop is written, so they are the authoritative
    // same-layout-pass handoff evidence.
    const handoffAppliedTraces = anchorHandoff >= 0
      ? evidence.traces
          .slice(anchorHandoff)
          .filter((trace) => trace.source === 'turn-anchor' && trace.phase === 'applied')
          .slice(0, 4)
      : [];
    const maxHandoffGap = Math.max(
      0,
      ...handoffAppliedTraces.map((trace) => Math.abs(
        trace.distanceToBottom ?? Number.POSITIVE_INFINITY,
      )),
    );
    const finalBottomGap = Math.abs(evidence.finalDistanceToBottom);
    const tailGrowth = evidence.finalTailHeight - railEvidence.initialTailHeight;
    const anchoredTraces = anchorStart >= 0
      ? evidence.traces.slice(anchorStart, anchorHandoff >= 0 ? anchorHandoff + 1 : undefined)
      : evidence.traces;
    const rawHeightCorrection = anchoredTraces.find((trace) =>
      trace.source === 'total-list-height'
      && trace.phase === 'applied'
      && Math.abs(trace.scrollDelta ?? 0) > 2,
    );
    await testInfo.attach('scroll-anchor-evidence.json', {
      body: Buffer.from(JSON.stringify({
        anchorDrift,
        anchorHandoff,
        anchoredTraces,
        firstExhaustedIndex,
        finalBottomGap,
        maxArmedBottomGap,
        maxHandoffGap,
        handoffAppliedTraces,
        railEvidence,
        tailGrowth,
        ...evidence,
      }, null, 2)),
      contentType: 'application/json',
    });

    expect(
      rawHeightCorrection,
      `total-list-height performed a raw correction: ${JSON.stringify(evidence.traces)}`,
    ).toBeUndefined();
    expect(anchorHandoff, 'no synchronous spacer-exhaustion handoff was traced').toBeGreaterThan(anchorStart);
    expect(
      anchorDrift,
      `active user anchor drifted across ${armedSamples.length} armed frames: ${JSON.stringify(evidence)}`,
    ).toBeLessThanOrEqual(2);
    expect(tailGrowth).toBeGreaterThan(railEvidence.spacerHeight);
    expect(firstExhaustedIndex, 'the long answer never exhausted the initial spacer').toBeGreaterThanOrEqual(0);
    expect(postExhaustionSamples.length, 'no frames were sampled after spacer exhaustion').toBeGreaterThan(0);
    expect(
      maxArmedBottomGap,
      `armed frames exposed a physical bottom blind spot: ${JSON.stringify(armedSamples)}`,
    ).toBeLessThanOrEqual(2);
    expect(
      maxHandoffGap,
      `spacer exhaustion left a delayed handoff gap: ${JSON.stringify(handoffAppliedTraces)}`,
    ).toBeLessThanOrEqual(8);
    expect(handoffAppliedTraces).toHaveLength(4);
    // "Settled at bottom" cannot be asserted to 0: scrollHeight/clientHeight
    // are rounded ints and scrollTop is quantized to the device pixel grid, so
    // a scroller resting on its bottom asymptote still measures a small
    // constant gap — up to 3px on integer-dpr displays (hosted CI runners),
    // sub-pixel fractions on Retina. 4px keeps real regressions (tens to
    // hundreds of px) detectable; the product's own at-bottom semantic is
    // VIRTUOSO_AT_BOTTOM_THRESHOLD_PX = 100.
    expect(
      finalBottomGap,
      `long reply did not settle at bottom: ${JSON.stringify(postExhaustionSamples.slice(-8))}`,
    ).toBeLessThanOrEqual(4);
  });
});
