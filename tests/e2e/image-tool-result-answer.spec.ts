/**
 * Real Electron + sidecar coverage for the answer that follows an
 * image-bearing tool result: the model reads a PNG through `read_file`, then
 * replies with a short text, and that text must render exactly once.
 *
 * The provider is a loopback-only OpenAI-compatible SSE server: no real
 * credential or network endpoint is involved. The PNG is produced by the app
 * window's own canvas encoder and is large enough (>1 MB) that the sidecar's
 * media transport is still in flight when the answer turn starts — the
 * window in which the answer frames queue behind it.
 */
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
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
const TEST_API_KEY = 'abu-e2e-image-answer-not-a-real-secret';
const TEST_MODEL_ID = 'abu-e2e-image-answer-model';
const PROVIDER_ID = 'abu-e2e-image-answer-provider';
const LOCAL_MOCK_PROVIDER_OPTIONS = {
  apiKey: TEST_API_KEY,
  modelId: TEST_MODEL_ID,
  modelLabel: 'Abu E2E deterministic image model',
  permissionMode: 'standard',
  providerId: PROVIDER_ID,
  providerName: 'Abu E2E loopback image provider',
  supportsReasoning: null,
  supportsTools: true,
} as const;
/** Below this the transport finishes before the answer turn starts and the race never opens. */
const MIN_IMAGE_BYTES = 1_000_000;

interface MockRequest {
  authorization: string | undefined;
  body: unknown;
  pathname: string;
  purpose: 'compression' | 'memory' | 'task';
}

type MockReplyPlan =
  | { kind: 'tool-call'; arguments: Record<string, unknown>; toolCallId: string; toolName: string }
  | { kind: 'complete'; responseText: string };

interface OpenAiMock {
  baseUrl: string;
  close: () => Promise<void>;
  requests: MockRequest[];
}

function sseChunk(delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-abu-e2e-image-answer',
    object: 'chat.completion.chunk',
    created: 0,
    model: TEST_MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function requestMessages(body: unknown): Array<{ role?: unknown; content?: unknown }> {
  if (!body || typeof body !== 'object' || !('messages' in body)) return [];
  const messages = (body as { messages?: unknown }).messages;
  return Array.isArray(messages) ? messages : [];
}

/** Memory extraction and context compression run after a turn on their own requests; keep them off the task plan. */
function classifyRequest(body: unknown): MockRequest['purpose'] {
  for (const message of requestMessages(body)) {
    if (typeof message.content !== 'string') continue;
    if (message.role === 'system' && message.content.includes('你是一个记忆提取助手')) return 'memory';
    if (message.content.includes('请将以下对话内容压缩为一段简洁的摘要')) return 'compression';
  }
  return 'task';
}

async function startOpenAiMock(replyPlans: readonly MockReplyPlan[]): Promise<OpenAiMock> {
  const requests: MockRequest[] = [];
  let taskRequestCount = 0;
  const activeResponses = new Set<ServerResponse>();
  const server = createServer(async (req, res) => {
    activeResponses.add(res);
    res.once('close', () => activeResponses.delete(res));

    const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    let rawBody = '';
    for await (const chunk of req) rawBody += String(chunk);
    let body: unknown = rawBody;
    try {
      body = JSON.parse(rawBody);
    } catch {
      // Preserve malformed input for diagnostics without accepting it as valid.
    }

    if (req.method !== 'POST' || requestUrl.pathname !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unexpected local E2E mock route' }));
      return;
    }

    const purpose = classifyRequest(body);
    requests.push({ authorization: req.headers.authorization, body, pathname: requestUrl.pathname, purpose });
    const replyPlan: MockReplyPlan | undefined = purpose === 'memory'
      ? { kind: 'complete', responseText: '[]' }
      : purpose === 'compression'
        ? { kind: 'complete', responseText: 'Abu E2E compacted summary.' }
        : replyPlans[taskRequestCount++];
    if (!replyPlan) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unexpected extra local E2E mock request' }));
      return;
    }

    res.writeHead(200, {
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'content-type': 'text/event-stream; charset=utf-8',
    });
    if (replyPlan.kind === 'tool-call') {
      res.write(sseChunk({
        tool_calls: [{
          index: 0,
          id: replyPlan.toolCallId,
          type: 'function',
          function: { name: replyPlan.toolName, arguments: JSON.stringify(replyPlan.arguments) },
        }],
      }, null));
      res.write(sseChunk({}, 'tool_calls'));
      res.end('data: [DONE]\n\n');
      return;
    }
    // Two content chunks, like a real stream: the answer arrives as two
    // appendText frames rather than one.
    const { responseText } = replyPlan;
    const splitAt = Math.ceil(responseText.length / 2);
    res.write(sseChunk({ content: responseText.slice(0, splitAt) }, null));
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    res.write(sseChunk({ content: responseText.slice(splitAt) }, null));
    res.write(sseChunk({}, 'stop'));
    res.end('data: [DONE]\n\n');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Loopback only: the mock must never listen on an externally reachable interface.
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server, activeResponses);
    throw new Error('The local OpenAI-compatible mock did not receive a TCP port');
  }

  return {
    // 2130706433 is the numeric IPv4 spelling of 127.0.0.1. The server still
    // listens only on loopback, but this avoids the adapter's literal-loopback
    // => Ollama heuristic so the real SSE/tools path is used.
    baseUrl: `http://2130706433:${address.port}/v1`,
    close: () => closeServer(server, activeResponses),
    requests,
  };
}

function closeServer(server: Server, activeResponses: ReadonlySet<ServerResponse>): Promise<void> {
  for (const response of activeResponses) response.destroy();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.closeAllConnections?.();
      reject(new Error('Timed out closing local OpenAI E2E mock'));
    }, 5_000);
    server.close((error) => {
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    });
    server.closeAllConnections?.();
  });
}

/**
 * A 1280x720 PNG whose upper rows are random noise, encoded by the app
 * window's canvas. Noise defeats PNG compression, so the file lands well
 * above MIN_IMAGE_BYTES; the rest is a gradient so the file stays a
 * realistic picture rather than pure static.
 */
async function writeProbeImage(page: Page, target: string): Promise<number> {
  const dataUrl = await page.evaluate(() => {
    const width = 1280;
    const height = 720;
    const noiseRows = 365;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('canvas 2d context unavailable');
    const image = context.createImageData(width, height);
    const noiseBytes = width * noiseRows * 4;
    // crypto.getRandomValues caps one call at 65536 bytes.
    for (let offset = 0; offset < noiseBytes; offset += 65_536) {
      crypto.getRandomValues(image.data.subarray(offset, Math.min(offset + 65_536, noiseBytes)));
    }
    for (let y = noiseRows; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 4;
        image.data[index] = Math.floor((x / width) * 255);
        image.data[index + 1] = Math.floor((y / height) * 255);
        image.data[index + 2] = 128;
        image.data[index + 3] = 255;
      }
    }
    for (let offset = 3; offset < noiseBytes; offset += 4) image.data[offset] = 255;
    context.putImageData(image, 0, 0);
    return canvas.toDataURL('image/png');
  });
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  fs.writeFileSync(target, Buffer.from(base64, 'base64'));
  return fs.statSync(target).size;
}

async function waitForApp(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
}

/** Runtime event names the main process currently holds for this launch. */
async function runtimeEventNames(page: Page): Promise<string[]> {
  const diagnostics = await page.evaluate(async () => {
    const shell = (window as unknown as {
      __ABU_SHELL__: { getRuntimeDiagnostics: () => Promise<{ recentEventLines: string[] }> };
    }).__ABU_SHELL__;
    return shell.getRuntimeDiagnostics();
  });
  return diagnostics.recentEventLines.flatMap((line) => {
    try {
      const event = JSON.parse(line) as { event?: unknown };
      return typeof event.event === 'string' ? [event.event] : [];
    } catch {
      return [];
    }
  });
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

let app: ElectronApplication | undefined;
let dataRoot: ElectronDataRoot | undefined;
let mock: OpenAiMock | undefined;

test.describe.serial('Electron answer after an image tool result', () => {
  test.afterEach(async () => {
    if (app) {
      await closeAbuElectron(app);
      app = undefined;
    }
    if (mock) {
      await mock.close();
      mock = undefined;
    }
    if (dataRoot) {
      removeElectronDataRoot(dataRoot);
      dataRoot = undefined;
    }
  });

  test('renders the answer text exactly once after read_file returns a large image', async () => {
    test.setTimeout(180_000);
    const answer = `abu-e2e-image-answer-${randomUUID().slice(0, 8)}`;
    dataRoot = createElectronDataRoot();
    const imagePath = path.join(dataRoot.rootDir, `probe-${randomUUID().slice(0, 8)}.png`);
    mock = await startOpenAiMock([
      {
        kind: 'tool-call',
        arguments: { path: imagePath },
        toolCallId: `call-image-${randomUUID()}`,
        toolName: 'read_file',
      },
      { kind: 'complete', responseText: answer },
    ]);

    const launched = await launchAbuElectron(dataRoot);
    app = launched.app;
    const page = await app.firstWindow({ timeout: READY_TIMEOUT });
    await waitForApp(page);
    const imageBytes = await writeProbeImage(page, imagePath);
    expect(imageBytes).toBeGreaterThan(MIN_IMAGE_BYTES);
    await configureLocalMockProvider(page, mock.baseUrl, LOCAL_MOCK_PROVIDER_OPTIONS);

    const input = page.getByPlaceholder(CHAT_PLACEHOLDER);
    await input.fill(`abu-e2e-read-the-image-${randomUUID().slice(0, 8)}`);
    await input.press('Enter');

    // The PNG sits under the temp data root, which read_file may access
    // without an authorization prompt, so the run proceeds unattended.
    await expect.poll(
      () => mock!.requests.filter((request) => request.purpose === 'task').length,
      { timeout: READY_TIMEOUT },
    ).toBe(2);
    await expect.poll(
      async () => (await runtimeEventNames(page)).includes('renderer.agent_run_completed'),
      { timeout: READY_TIMEOUT },
    ).toBe(true);
    // Substring match on purpose: a doubled answer must reach the count below
    // instead of timing out on an exact-text locator.
    await expect(page.getByText(answer, { exact: false }).first()).toBeVisible({ timeout: READY_TIMEOUT });

    const mainText = await page.locator('main').innerText();
    expect(countOccurrences(mainText, answer)).toBe(1);
  });
});
