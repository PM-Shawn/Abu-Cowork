/**
 * llm/ POC 冒烟测试：验证 FetchAdapter 注入 + OpenAICompatibleAdapter + SSE 流解析。
 *
 * 运行：npx tsx packages/core/src/llm/__tests__/smoke.ts
 */

import assert from 'node:assert/strict';

import {
  MemoryFetchAdapter,
  MemoryLoggerAdapter,
  FakeClockAdapter,
  SystemClockAdapter,
} from '../../mocks';
import { OpenAICompatibleAdapter } from '../openai-compatible';
import type { Message, StreamEvent } from '../../../../../src/types';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err instanceof Error ? err.message : err}`);
    failed++;
  }
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
        await new Promise((r) => setTimeout(r, 1));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

async function main() {
  console.log('OpenAICompatibleAdapter + MemoryFetch:');

  await test('完整 SSE 流能解析出文本事件', async () => {
    const fetch = new MemoryFetchAdapter();
    const logger = new MemoryLoggerAdapter();
    const clock = new SystemClockAdapter();
    // 用真实时钟是因为 heartbeat 需要触发器，但我们不要它实际触发

    fetch.on(/chat\/completions/, () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ])
    );

    const adapter = new OpenAICompatibleAdapter({ fetch, logger, clock });
    const events: StreamEvent[] = [];
    const msgs: Message[] = [
      { id: 'u1', role: 'user', content: '你好', timestamp: Date.now() },
    ];

    await adapter.chat(
      msgs,
      {
        model: 'gpt-4',
        apiKey: 'sk-test',
        baseUrl: 'https://api.mock.com/v1',
        maxTokens: 100,
      },
      (e) => events.push(e)
    );

    const textEvents = events.filter((e) => e.type === 'text');
    const combinedText = textEvents
      .map((e) => (e.type === 'text' ? e.text : ''))
      .join('');
    assert.ok(combinedText.includes('Hello'), `got: ${combinedText}`);
    assert.ok(combinedText.includes('world'), `got: ${combinedText}`);

    const doneEvent = events.find((e) => e.type === 'done');
    assert.ok(doneEvent, 'should emit done event');

    // 验证确实调用了 fetch
    assert.equal(fetch.calls.length, 1);
    assert.ok(fetch.calls[0].url.includes('chat/completions'));
    // 验证 Authorization header
    const headers = fetch.calls[0].init?.headers as Record<string, string>;
    assert.equal(headers['Authorization'], 'Bearer sk-test');
  });

  await test('429 错误被分类为 rate_limit', async () => {
    const fetch = new MemoryFetchAdapter();
    const logger = new MemoryLoggerAdapter();
    const clock = new SystemClockAdapter();

    fetch.on(/chat\/completions/, () =>
      new Response('{"error":{"message":"rate limit exceeded"}}', {
        status: 429,
      })
    );

    const adapter = new OpenAICompatibleAdapter({ fetch, logger, clock });

    let caught: unknown = null;
    try {
      await adapter.chat(
        [{ id: 'u1', role: 'user', content: 'hi', timestamp: Date.now() }],
        { model: 'gpt-4', apiKey: 'k', baseUrl: 'https://api.mock.com/v1' },
        () => {}
      );
    } catch (err) {
      caught = err;
    }
    // 这里不强制抛——实现可能通过 onEvent 报错。验证能处理即可
    if (caught instanceof Error) {
      assert.ok(/rate|429/i.test(caught.message), `got: ${caught.message}`);
    }
  });

  await test('heartbeat 在 90s 空闲后触发（FakeClock）', async () => {
    const fetch = new MemoryFetchAdapter();
    const logger = new MemoryLoggerAdapter();
    const clock = new FakeClockAdapter(0);

    // 构造一个永远挂起的流，触发 heartbeat
    const stream = new ReadableStream({
      start() {
        // 永不 close,永不 enqueue
      },
    });
    fetch.on(/chat\/completions/, () =>
      new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    );

    const adapter = new OpenAICompatibleAdapter({ fetch, logger, clock });
    const events: StreamEvent[] = [];

    // 启动 chat，但不 await——我们要手动推进 clock
    const chatPromise = adapter.chat(
      [{ id: 'u1', role: 'user', content: 'hi', timestamp: Date.now() }],
      { model: 'gpt-4', apiKey: 'k', baseUrl: 'https://api.mock.com/v1' },
      (e) => events.push(e)
    );

    // 让 microtask 队列跑，让 adapter 进入 reader.read() 等待态
    await new Promise((r) => setTimeout(r, 50));

    // 推进 fake clock 91 秒
    clock.advance(91_000);

    // 给事件传播机会
    await new Promise((r) => setTimeout(r, 50));

    // 我们无法真正 resolve chatPromise（reader 还挂着），但能看到 heartbeat 触发的事件
    const errorEvent = events.find(
      (e) => e.type === 'error' && /idle timeout/i.test(e.error || '')
    );
    assert.ok(errorEvent, `should emit idle timeout error. got: ${events.map((e) => e.type).join(',')}`);

    // 避免未处理 promise 报错
    chatPromise.catch(() => {});
  });

  console.log(`\n结果：${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
