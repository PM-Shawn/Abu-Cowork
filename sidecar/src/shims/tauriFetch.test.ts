// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const undici = vi.hoisted(() => {
  const agents: Array<{ options: unknown }> = [];
  class Agent {
    options: unknown;
    constructor(options: unknown) {
      this.options = options;
      agents.push(this);
    }
  }
  return { agents, Agent, fetch: vi.fn() };
});
vi.mock('undici', () => ({ Agent: undici.Agent, fetch: undici.fetch }));

import { getTauriFetch } from './tauriFetch';
import { LOCAL_FIRST_RESPONSE_TIMEOUT_MS } from '@/core/llm/heartbeat';

describe('sidecar getTauriFetch', () => {
  beforeEach(() => {
    undici.fetch.mockReset();
  });

  it('returns the global fetch for ordinary requests', async () => {
    expect(await getTauriFetch()).toBe(globalThis.fetch);
    expect(await getTauriFetch({ localServer: false })).toBe(globalThis.fetch);
  });

  it('sends local model server requests with header and body limits past the adapters\' 10 minute wait', async () => {
    const response = new Response('{"done":true}\n');
    undici.fetch.mockResolvedValue(response);
    const controller = new AbortController();
    const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: controller.signal };

    const fetchFn = await getTauriFetch({ localServer: true });
    expect(fetchFn).not.toBe(globalThis.fetch);
    await expect(fetchFn('http://192.168.1.20:11434/api/chat', init)).resolves.toBe(response);

    expect(undici.fetch).toHaveBeenCalledTimes(1);
    const [url, sentInit] = undici.fetch.mock.calls[0] as [string, RequestInit & { dispatcher?: unknown }];
    expect(url).toBe('http://192.168.1.20:11434/api/chat');
    expect(sentInit).toMatchObject(init);
    expect(sentInit.signal).toBe(controller.signal);
    expect(sentInit.dispatcher).toBeInstanceOf(undici.Agent);
    // undici 默认 300 秒没收到响应头、或两段内容之间空闲 300 秒就断开；本地服务的等待由适配器计时，
    // 传输层上限放在适配器 10 分钟之后 10 秒，只作兜底
    expect((sentInit.dispatcher as InstanceType<typeof undici.Agent>).options).toEqual({
      headersTimeout: LOCAL_FIRST_RESPONSE_TIMEOUT_MS + 10_000,
      bodyTimeout: LOCAL_FIRST_RESPONSE_TIMEOUT_MS + 10_000,
    });
    expect(LOCAL_FIRST_RESPONSE_TIMEOUT_MS + 10_000).toBe(610_000);
  });

  it('reuses one connection pool for every local model server request', async () => {
    undici.fetch.mockImplementation(async () => new Response(''));
    const fetchFn = await getTauriFetch({ localServer: true });
    await fetchFn('http://127.0.0.1:11434/api/chat', { method: 'POST' });
    await (await getTauriFetch({ localServer: true }))('http://127.0.0.1:1234/v1/chat/completions', { method: 'POST' });

    const dispatchers = undici.fetch.mock.calls.map((call) => (call[1] as { dispatcher?: unknown }).dispatcher);
    expect(dispatchers[0]).toBe(dispatchers[1]);
    expect(undici.agents).toHaveLength(1);
  });
});
