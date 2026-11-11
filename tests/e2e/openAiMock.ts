/**
 * Loopback OpenAI-compatible mock plus the chat-shell constants the Electron
 * journeys share. Extracted from tests/e2e/task-lifecycle.spec.ts so more than
 * one spec can drive a deterministic model endpoint; the behaviour is
 * unchanged. The server listens on 127.0.0.1 only and never receives a real
 * credential or user content.
 */
import { expect } from '@playwright/test';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { Page } from 'playwright';

export const READY_TIMEOUT = 45_000;
export const CHAT_PLACEHOLDER = '想让阿布帮你做点什么？';
export const TEST_API_KEY = 'abu-e2e-test-key-not-a-real-secret';
export const TEST_MODEL_ID = 'abu-e2e-local-model';

export interface MockRequest {
  authorization: string | undefined;
  body: unknown;
  pathname: string;
  purpose: 'compression' | 'memory' | 'task' | 'title';
  responseAborted: boolean;
}

export type MockReplyPlan =
  /** `chunks`: how many streamed deltas carry the text (default 2). */
  | { kind: 'complete'; responseText: string; chunks?: number }
  | {
      arguments: Record<string, unknown>;
      kind: 'tool-call';
      toolCallId: string;
      toolName: string;
    }
  | { kind: 'hold-open'; partialText: string }
  | { kind: 'http-error'; status: number; body: unknown };

export interface OpenAiMock {
  baseUrl: string;
  close: () => Promise<void>;
  requests: MockRequest[];
  /** Pathnames of the answered `getRoutes` requests, in order. */
  getRequests: string[];
}

function sseChunk(content: string, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-abu-e2e',
    object: 'chat.completion.chunk',
    created: 0,
    model: TEST_MODEL_ID,
    choices: [{
      index: 0,
      delta: content ? { content } : {},
      finish_reason: finishReason,
    }],
  })}\n\n`;
}

export interface OpenAiMockOptions {
  /**
   * Extra read-only routes a local model server offers besides chat, keyed by
   * pathname (e.g. LM Studio's `/api/v0/models`). Each answers GET with the
   * given JSON; any other route still answers 404.
   */
  getRoutes?: Readonly<Record<string, unknown>>;
  /** The text every compression request is answered with. */
  compressionResponseText?: string;
  /** Controls the compression response for cancellation and failure journeys. */
  compressionReply?: MockReplyPlan;
  /** The title every title request is answered with (default: the first message's opening words). */
  titleResponseText?: string;
}

/** Which kind of model call a request body is: memory extraction, compression, or the task itself. */
export function classifyMockRequestPurpose(body: unknown): MockRequest['purpose'] {
  return isTitleRequest(body)
    ? 'title'
    : isMemoryExtractionRequest(body)
      ? 'memory'
      : isCompressionRequest(body)
        ? 'compression'
        : 'task';
}

/**
 * The side call that names a new conversation once its first reply has ended
 * (src/core/session/titleGen.ts). It is not a task turn: scripted mocks answer
 * it on their own and never spend a scripted reply on it.
 */
export function isTitleRequest(body: unknown): boolean {
  if (!body || typeof body !== 'object' || !('messages' in body)) return false;
  const messages = (body as { messages?: unknown }).messages;
  return Array.isArray(messages) && messages.some((message) => {
    if (!message || typeof message !== 'object') return false;
    const candidate = message as { content?: unknown; role?: unknown };
    return candidate.role === 'system' &&
      typeof candidate.content === 'string' &&
      candidate.content.startsWith('You name chat conversations.');
  });
}

/**
 * The title a mock answers a title request with: the opening words of the first
 * message, which is what the conversation was already called, so a journey that
 * reads the sidebar sees the same text as before titles were model-written.
 * A journey that tests the title itself passes its own text.
 */
export function mockTitleFor(body: unknown, override?: string): string {
  if (override !== undefined) return override;
  const messages = (body as { messages?: { role?: string; content?: unknown }[] }).messages ?? [];
  const user = messages.find((message) => message.role === 'user');
  const content = typeof user?.content === 'string' ? user.content : '';
  const first = /<first_message>\n([\s\S]*?)\n<\/first_message>/.exec(content)?.[1] ?? '';
  return first.slice(0, 30) || 'E2E title';
}

/**
 * Answers a title request on `res` and returns true; returns false for any other
 * request so a spec-private mock can call it first and carry on. Both the
 * streamed and the plain-JSON shape are served, like a real endpoint.
 */
export function answerTitleRequest(body: unknown, res: ServerResponse, override?: string): boolean {
  if (!isTitleRequest(body)) return false;
  const text = mockTitleFor(body, override);
  const streamed = !(typeof body === 'object' && body && (body as { stream?: unknown }).stream === false);
  if (!streamed) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      id: 'chatcmpl-abu-e2e-title',
      object: 'chat.completion',
      created: 0,
      model: TEST_MODEL_ID,
      choices: [{ index: 0, message: { content: text, role: 'assistant' }, finish_reason: 'stop' }],
    }));
    return true;
  }
  res.writeHead(200, {
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'content-type': 'text/event-stream; charset=utf-8',
  });
  res.write(sseChunk(text, null));
  res.write(sseChunk('', 'stop'));
  res.end('data: [DONE]\n\n');
  return true;
}

export async function startOpenAiMock(
  replyPlans: readonly (MockReplyPlan | ((request: MockRequest) => MockReplyPlan))[],
  options: OpenAiMockOptions = {},
): Promise<OpenAiMock> {
  const requests: MockRequest[] = [];
  const getRequests: string[] = [];
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
      // Keep malformed input available in the assertion output if this ever regresses.
    }
    const purpose = classifyMockRequestPurpose(body);
    const mockRequest: MockRequest = {
      authorization: req.headers.authorization,
      body,
      pathname: requestUrl.pathname,
      purpose,
      responseAborted: false,
    };
    const getRoute = options.getRoutes?.[requestUrl.pathname];
    if (req.method === 'GET' && getRoute !== undefined) {
      getRequests.push(requestUrl.pathname);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(getRoute));
      return;
    }
    if (req.method !== 'POST' || requestUrl.pathname !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unexpected local E2E mock route' }));
      return;
    }

    requests.push(mockRequest);
    if (purpose === 'title') {
      answerTitleRequest(body, res, options.titleResponseText);
      return;
    }
    const replySource =
      purpose === 'memory'
        ? { kind: 'complete' as const, responseText: '[]' }
        : purpose === 'compression'
          ? options.compressionReply ?? {
              kind: 'complete' as const,
              responseText: options.compressionResponseText ?? 'Abu E2E compacted conversation summary.',
            }
        : replyPlans[taskRequestCount++];
    const replyPlan = typeof replySource === 'function' ? replySource(mockRequest) : replySource;
    if (!replyPlan) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unexpected extra local E2E mock request' }));
      return;
    }

    if (replyPlan.kind === 'http-error') {
      res.writeHead(replyPlan.status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(replyPlan.body));
      return;
    }

    const usesStreaming = !body
      || typeof body !== 'object'
      || !('stream' in body)
      || (body as { stream?: unknown }).stream !== false;
    if (!usesStreaming) {
      res.writeHead(200, {
        'cache-control': 'no-cache',
        'content-type': 'application/json; charset=utf-8',
      });
      if (replyPlan.kind === 'hold-open') {
        // Tool-enabled requests are non-streaming, so there is no partial
        // text to send: hold the response until the client aborts it.
        res.once('close', () => {
          mockRequest.responseAborted = !res.writableEnded;
        });
        return;
      }
      const message = replyPlan.kind === 'tool-call'
        ? {
            content: null,
            role: 'assistant',
            tool_calls: [{
              id: replyPlan.toolCallId,
              type: 'function',
              function: {
                name: replyPlan.toolName,
                arguments: JSON.stringify(replyPlan.arguments),
              },
            }],
          }
        : { content: replyPlan.responseText, role: 'assistant' };
      res.end(JSON.stringify({
        id: 'chatcmpl-abu-e2e',
        object: 'chat.completion',
        created: 0,
        model: TEST_MODEL_ID,
        choices: [{
          index: 0,
          message,
          finish_reason: replyPlan.kind === 'tool-call' ? 'tool_calls' : 'stop',
        }],
      }));
      return;
    }

    res.writeHead(200, {
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'content-type': 'text/event-stream; charset=utf-8',
    });
    if (replyPlan.kind === 'hold-open') {
      res.once('close', () => {
        // A deliberate stop aborts the browser's response stream. This stays
        // false for normal completed replies, which call res.end() below.
        mockRequest.responseAborted = !res.writableEnded;
      });
      res.write(sseChunk(replyPlan.partialText, null));
      return;
    }

    if (replyPlan.kind === 'tool-call') {
      res.write(sseToolCall(replyPlan));
      res.end('data: [DONE]\n\n');
      return;
    }

    const { responseText, chunks = 2 } = replyPlan;
    const chunkLength = Math.ceil(responseText.length / chunks);
    // Normal streaming providers deliver several deltas before their terminal
    // frame; preserve that ordering across the renderer's RAF token buffer.
    for (let start = 0; start < responseText.length; start += chunkLength) {
      res.write(sseChunk(responseText.slice(start, start + chunkLength), null));
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    res.write(sseChunk('', 'stop'));
    res.end('data: [DONE]\n\n');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Loopback only: this test must never expose a local mock on the network.
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
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => closeServer(server, activeResponses),
    requests,
    getRequests,
  };
}

function sseToolCall(plan: Extract<MockReplyPlan, { kind: 'tool-call' }>): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-abu-e2e',
    object: 'chat.completion.chunk',
    created: 0,
    model: TEST_MODEL_ID,
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          id: plan.toolCallId,
          type: 'function',
          function: {
            name: plan.toolName,
            arguments: JSON.stringify(plan.arguments),
          },
        }],
      },
      finish_reason: null,
    }],
  })}\n\n${sseChunk('', 'tool_calls')}`;
}

function isMemoryExtractionRequest(body: unknown): boolean {
  if (!body || typeof body !== 'object' || !('messages' in body)) return false;
  const messages = (body as { messages?: unknown }).messages;
  return Array.isArray(messages) && messages.some((message) => {
    if (!message || typeof message !== 'object') return false;
    const candidate = message as { content?: unknown; role?: unknown };
    return candidate.role === 'system' &&
      typeof candidate.content === 'string' &&
      candidate.content.includes('你是一个记忆提取助手');
  });
}

/** A compaction's summary request ends with the summary instruction (contextCompressor.ts). */
function isCompressionRequest(body: unknown): boolean {
  if (!body || typeof body !== 'object' || !('messages' in body)) return false;
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const last = messages[messages.length - 1] as { role?: unknown; content?: unknown } | null;
  if (!last || last.role !== 'user') return false;
  const text = typeof last.content === 'string'
    ? last.content
    : Array.isArray(last.content)
      ? last.content.map((part) => (part && typeof part === 'object' && 'text' in part ? String(part.text) : '')).join('')
      : '';
  return text.startsWith('Stop working on the task for a moment.');
}

export function taskRequests(mock: OpenAiMock): MockRequest[] {
  return mock.requests.filter((request) => request.purpose === 'task');
}

export function titleRequests(mock: OpenAiMock): MockRequest[] {
  return mock.requests.filter((request) => request.purpose === 'title');
}

export function compressionRequests(mock: OpenAiMock): MockRequest[] {
  return mock.requests.filter((request) => request.purpose === 'compression');
}

export function closeServer(server: Server, activeResponses: ReadonlySet<ServerResponse>): Promise<void> {
  // A failed assertion can leave a hold-open SSE response active. Destroy it
  // before close() so afterEach cannot wait forever on that client connection.
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

/** Wait until the renderer has painted the chat composer. */
export async function waitForApp(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByPlaceholder(CHAT_PLACEHOLDER)).toBeVisible({ timeout: READY_TIMEOUT });
}
