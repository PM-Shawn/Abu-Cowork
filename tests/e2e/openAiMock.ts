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
  purpose: 'compression' | 'memory' | 'task';
  responseAborted: boolean;
}

export type MockReplyPlan =
  | { kind: 'complete'; responseText: string }
  | {
      arguments: Record<string, unknown>;
      kind: 'tool-call';
      toolCallId: string;
      toolName: string;
    }
  | { kind: 'hold-open'; partialText: string };

export interface OpenAiMock {
  baseUrl: string;
  close: () => Promise<void>;
  requests: MockRequest[];
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

export async function startOpenAiMock(replyPlans: readonly MockReplyPlan[]): Promise<OpenAiMock> {
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
      // Keep malformed input available in the assertion output if this ever regresses.
    }
    const purpose = isMemoryExtractionRequest(body)
      ? 'memory'
      : isCompressionRequest(body)
        ? 'compression'
        : 'task';
    const mockRequest: MockRequest = {
      authorization: req.headers.authorization,
      body,
      pathname: requestUrl.pathname,
      purpose,
      responseAborted: false,
    };
    if (req.method !== 'POST' || requestUrl.pathname !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unexpected local E2E mock route' }));
      return;
    }

    requests.push(mockRequest);
    const replyPlan =
      purpose === 'memory'
        ? { kind: 'complete' as const, responseText: '[]' }
        : purpose === 'compression'
          ? { kind: 'complete' as const, responseText: 'Abu E2E compacted conversation summary.' }
        : replyPlans[taskRequestCount++];
    if (!replyPlan) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unexpected extra local E2E mock request' }));
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
        res.end(JSON.stringify({ error: 'hold-open replies require a streaming request' }));
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

    const { responseText } = replyPlan;
    const splitAt = Math.ceil(responseText.length / 2);
    res.write(sseChunk(responseText.slice(0, splitAt), null));
    // Normal streaming providers deliver several deltas before their terminal
    // frame; preserve that ordering across the renderer's RAF token buffer.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    res.write(sseChunk(responseText.slice(splitAt), null));
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
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

function isCompressionRequest(body: unknown): boolean {
  if (!body || typeof body !== 'object' || !('messages' in body)) return false;
  const messages = (body as { messages?: unknown }).messages;
  return Array.isArray(messages) && messages.some((message) => {
    if (!message || typeof message !== 'object') return false;
    const content = (message as { content?: unknown }).content;
    return typeof content === 'string'
      && content.includes('请将以下对话内容压缩为一段简洁的摘要');
  });
}

export function taskRequests(mock: OpenAiMock): MockRequest[] {
  return mock.requests.filter((request) => request.purpose === 'task');
}

export function compressionRequests(mock: OpenAiMock): MockRequest[] {
  return mock.requests.filter((request) => request.purpose === 'compression');
}

function closeServer(server: Server, activeResponses: ReadonlySet<ServerResponse>): Promise<void> {
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
