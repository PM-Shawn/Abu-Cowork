/**
 * Loopback mock of the two Ollama native routes Abu talks to: `GET /api/ps`
 * (the models Ollama has loaded, with the context length each one runs at) and
 * `POST /api/chat` (NDJSON stream). Listens on 127.0.0.1 only and never
 * receives a real credential or user content.
 */
import { createServer, type ServerResponse } from 'node:http';
import { classifyMockRequestPurpose, closeServer, type MockRequest } from './openAiMock';

export interface OllamaMockOptions {
  /**
   * `context_length` of the model in the /api/ps reply, i.e. the length Ollama
   * loaded it with. Omitted means the model is not loaded and /api/ps lists nothing.
   */
  loadedContextLength?: number;
  modelId: string;
  /** Replies to the task's /api/chat calls, in order. */
  replies: readonly string[];
}

export interface OllamaMock {
  baseUrl: string;
  close: () => Promise<void>;
  /** Every /api/chat request, including memory extraction and compression. */
  chatRequests: MockRequest[];
  /** How many times Abu asked GET /api/ps. */
  readonly psRequests: number;
}

function ndjsonLine(value: Record<string, unknown>): string {
  return `${JSON.stringify(value)}\n`;
}

export async function startOllamaMock(options: OllamaMockOptions): Promise<OllamaMock> {
  const chatRequests: MockRequest[] = [];
  const counters = { ps: 0 };
  let taskReplyCount = 0;
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
      // 原样保留，断言失败时能看到收到了什么
    }

    if (req.method === 'GET' && requestUrl.pathname === '/api/ps') {
      counters.ps += 1;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      // 字段按 Ollama api/types.go 的 ProcessModelResponse 写；名字带标签
      res.end(JSON.stringify({
        models: options.loadedContextLength === undefined ? [] : [{
          name: options.modelId,
          model: options.modelId,
          size: 1_000_000_000,
          digest: 'abu-e2e-digest',
          details: { family: 'qwen3', parameter_size: '0.6B', quantization_level: 'Q4_K_M' },
          expires_at: '2099-01-01T00:00:00Z',
          size_vram: 1_000_000_000,
          context_length: options.loadedContextLength,
        }],
      }));
      return;
    }

    if (req.method !== 'POST' || requestUrl.pathname !== '/api/chat') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unexpected local Ollama E2E mock route' }));
      return;
    }

    const purpose = classifyMockRequestPurpose(body);
    chatRequests.push({
      authorization: req.headers.authorization,
      body,
      pathname: requestUrl.pathname,
      purpose,
      responseAborted: false,
    });
    const reply = purpose === 'memory'
      ? '[]'
      : purpose === 'compression'
        ? 'Abu E2E compacted conversation summary.'
        : options.replies[taskReplyCount++];
    if (reply === undefined) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unexpected extra local Ollama E2E mock request' }));
      return;
    }

    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8' });
    // 分两段送出正文，再送结束帧，与真实 Ollama 的逐行流式一致
    const splitAt = Math.ceil(reply.length / 2);
    for (const part of [reply.slice(0, splitAt), reply.slice(splitAt)]) {
      res.write(ndjsonLine({
        model: options.modelId,
        message: { role: 'assistant', content: part },
        done: false,
      }));
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    res.end(ndjsonLine({
      model: options.modelId,
      message: { role: 'assistant', content: '' },
      done: true,
      done_reason: 'stop',
      prompt_eval_count: 1200,
      eval_count: 12,
    }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // 只监听本机回环地址
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server, activeResponses);
    throw new Error('The local Ollama mock did not receive a TCP port');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server, activeResponses),
    chatRequests,
    get psRequests() {
      return counters.ps;
    },
  };
}
