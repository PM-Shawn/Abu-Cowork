// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { LOCAL_FIRST_RESPONSE_TIMEOUT_MS } from '../src/core/llm/heartbeat';

// httpHost.cjs 由 Node 自己的 require 加载，vi.mock 管不到它；按 mediaSignature.test.cjs 的做法
// 先加载真实的 undici，再把 require 缓存里的导出换成记录调用的替身
const require = createRequire(import.meta.url);
const undiciPath = require.resolve('undici');
const httpHostPath = require.resolve('./httpHost.cjs');

const agents: Array<{ options: unknown }> = [];
class FakeAgent {
  options: unknown;
  constructor(options: unknown) {
    this.options = options;
    agents.push(this);
  }
}
const undiciFetch = vi.fn();
const globalFetch = vi.fn();

let httpDispatch: (cmd: string, args: Record<string, unknown>) => unknown;
let originalUndiciExports: unknown;

beforeAll(() => {
  require(undiciPath);
  originalUndiciExports = require.cache[undiciPath]!.exports;
  require.cache[undiciPath]!.exports = { Agent: FakeAgent, fetch: undiciFetch };
  delete require.cache[httpHostPath];
  ({ httpDispatch } = require('./httpHost.cjs'));
  vi.stubGlobal('fetch', globalFetch);
});

afterAll(() => {
  require.cache[undiciPath]!.exports = originalUndiciExports;
  delete require.cache[httpHostPath];
  vi.unstubAllGlobals();
});

async function send(clientConfig: Record<string, unknown>) {
  const rid = await httpDispatch('plugin:http|fetch', { clientConfig });
  return httpDispatch('plugin:http|fetch_send', { rid });
}

describe('httpHost plugin:http|fetch_send', () => {
  beforeEach(() => {
    undiciFetch.mockReset();
    globalFetch.mockReset();
    undiciFetch.mockImplementation(async () => new Response('{"done":true}\n'));
    globalFetch.mockImplementation(async () => new Response('ok'));
  });

  it('sends a local model server request with header and body limits past the adapters\' 10 minute wait', async () => {
    const meta = await send({
      method: 'POST',
      url: 'http://192.168.1.20:11434/api/chat',
      headers: [['content-type', 'application/json']],
      data: [123, 125],
      localServer: true,
    });

    expect(meta).toMatchObject({ status: 200 });
    expect(globalFetch).not.toHaveBeenCalled();
    expect(undiciFetch).toHaveBeenCalledTimes(1);
    const [url, init] = undiciFetch.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe('http://192.168.1.20:11434/api/chat');
    expect(init).toMatchObject({ method: 'POST', headers: [['content-type', 'application/json']], redirect: 'follow' });
    expect(Buffer.from(init.body as Buffer).toString()).toBe('{}');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.dispatcher).toBeInstanceOf(FakeAgent);
    // undici 默认 300 秒没收到响应头、或两段内容之间空闲 300 秒就断开；本地服务的等待由适配器计时，
    // 传输层上限放在适配器 10 分钟之后 10 秒，只作兜底
    expect((init.dispatcher as FakeAgent).options).toEqual({
      headersTimeout: LOCAL_FIRST_RESPONSE_TIMEOUT_MS + 10_000,
      bodyTimeout: LOCAL_FIRST_RESPONSE_TIMEOUT_MS + 10_000,
    });
  });

  it('reuses one connection pool for every local model server request', async () => {
    await send({ method: 'POST', url: 'http://127.0.0.1:11434/api/chat', headers: [], data: [1], localServer: true });
    await send({ method: 'POST', url: 'http://127.0.0.1:1234/v1/chat/completions', headers: [], data: [1], localServer: true });

    const dispatchers = undiciFetch.mock.calls.map((call) => (call[1] as { dispatcher?: unknown }).dispatcher);
    expect(dispatchers[0]).toBe(dispatchers[1]);
    expect(agents).toHaveLength(1);
  });

  it('keeps ordinary requests on the built-in fetch', async () => {
    await send({ method: 'GET', url: 'http://127.0.0.1:11434/api/tags', headers: [], data: null });

    expect(undiciFetch).not.toHaveBeenCalled();
    expect(globalFetch).toHaveBeenCalledTimes(1);
    expect((globalFetch.mock.calls[0] as [string, Record<string, unknown>])[1].dispatcher).toBeUndefined();
  });
});
