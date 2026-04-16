/**
 * POC 冒烟测试：验证 context/ 模块可以在零平台依赖下通过 Mock Adapters 运行起来。
 *
 * 运行：
 *   npx tsx packages/core/src/context/__tests__/smoke.ts
 *
 * 这不是单元测试，是端到端连通性验证——证明 DI 设计能工作。
 */

import assert from 'node:assert/strict';

import {
  FakeClockAdapter,
  MemoryLoggerAdapter,
} from '../../mocks';
import {
  TokenEstimator,
  AutoCompactTracker,
  ContextManager,
  ContextCompressor,
  type CompressionLLM,
} from '../index';
import type { Message } from '../../../../../src/types';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => {
      console.log(`  ✓ ${name}`);
      passed++;
    })
    .catch((err) => {
      console.error(`  ✗ ${name}`);
      console.error(`    ${err instanceof Error ? err.message : err}`);
      failed++;
    });
}

function mkMsg(role: 'user' | 'assistant', text: string, ts: number): Message {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    role,
    content: text,
    timestamp: ts,
  };
}

async function main() {
  console.log('TokenEstimator:');

  await test('estimateTokens CJK 约 1.5 字/token', () => {
    const est = new TokenEstimator();
    const tokens = est.estimateTokens('中文测试文本一二三四五六七八');
    assert.ok(tokens >= 6 && tokens <= 15, `got ${tokens}`);
  });

  await test('estimateTokens 英文约 4 字/token', () => {
    const est = new TokenEstimator();
    const tokens = est.estimateTokens('a'.repeat(400));
    assert.ok(tokens >= 90 && tokens <= 110, `got ${tokens}`);
  });

  await test('多实例独立校准互不影响', () => {
    const a = new TokenEstimator();
    const b = new TokenEstimator();
    a.setActiveModel('m1');
    b.setActiveModel('m2');
    a.calibrateFromUsage(100, 150);
    assert.equal(b.getCalibrationRatio(), 1.0);
    assert.ok(a.getCalibrationRatio() > 1.0);
  });

  console.log('\nAutoCompactTracker (FakeClock 驱动冷却):');

  await test('3 次失败触发 5 分钟冷却', () => {
    const clock = new FakeClockAdapter(1_000_000);
    const tracker = new AutoCompactTracker(clock);
    tracker.recordFailure('invalid_request');
    tracker.recordFailure('invalid_request');
    assert.equal(tracker.isDisabled(), false, '2 次未触发');
    tracker.recordFailure('invalid_request');
    assert.equal(tracker.isDisabled(), true, '3 次应触发');
    clock.advance(4 * 60 * 1000);
    assert.equal(tracker.isDisabled(), true, '4 分钟内仍禁用');
    clock.advance(2 * 60 * 1000);
    assert.equal(tracker.isDisabled(), false, '超过 5 分钟应恢复');
  });

  await test('网络类错误不累计', () => {
    const clock = new FakeClockAdapter(1_000_000);
    const tracker = new AutoCompactTracker(clock);
    for (let i = 0; i < 10; i++) tracker.recordFailure('network_error');
    assert.equal(tracker.isDisabled(), false);
  });

  await test('认证错误立即禁用 30 分钟', () => {
    const clock = new FakeClockAdapter(1_000_000);
    const tracker = new AutoCompactTracker(clock);
    tracker.recordFailure('authentication');
    assert.equal(tracker.isDisabled(), true);
    clock.advance(29 * 60 * 1000);
    assert.equal(tracker.isDisabled(), true);
    clock.advance(2 * 60 * 1000);
    assert.equal(tracker.isDisabled(), false);
  });

  await test('shouldCompact 对 level 3 返 true', () => {
    const clock = new FakeClockAdapter(0);
    const tracker = new AutoCompactTracker(clock);
    assert.equal(tracker.shouldCompact(0), false);
    assert.equal(tracker.shouldCompact(1), false);
    assert.equal(tracker.shouldCompact(2), true);
    assert.equal(tracker.shouldCompact(3), true);
  });

  console.log('\nContextManager (Logger + Clock 注入):');

  await test('消息内合理返回原消息', () => {
    const clock = new FakeClockAdapter(Date.now());
    const logger = new MemoryLoggerAdapter();
    const estimator = new TokenEstimator();
    const mgr = new ContextManager({ estimator, logger, clock });

    const now = clock.now();
    const msgs: Message[] = [
      mkMsg('user', '你好', now),
      mkMsg('assistant', '你好，请问有什么可以帮你', now + 1),
    ];
    const result = mgr.prepareContextMessages(msgs, 'system', 10000, 1000);
    assert.equal(result.length, 2);
    assert.equal(logger.entries.length, 0, '无截断不应打日志');
  });

  await test('溢出时触发 hard truncation 并记日志', () => {
    const clock = new FakeClockAdapter(Date.now());
    const logger = new MemoryLoggerAdapter();
    const estimator = new TokenEstimator();
    const mgr = new ContextManager({ estimator, logger, clock });

    const now = clock.now();
    const bigText = 'a'.repeat(20000);
    const msgs: Message[] = [];
    for (let i = 0; i < 20; i++) {
      msgs.push(mkMsg('user', 'q' + i, now + i * 2));
      msgs.push(mkMsg('assistant', bigText, now + i * 2 + 1));
    }
    const result = mgr.prepareContextMessages(msgs, 'sys', 8000, 1000);
    assert.ok(result.length < msgs.length, '应该被截断');
    assert.ok(
      logger.entries.some((e) => e.message.includes('Hard truncation')),
      'logger 应收到截断日志'
    );
  });

  console.log('\nContextCompressor (Mock LLM 注入):');

  await test('压缩阈值未达时不调 LLM', async () => {
    const clock = new FakeClockAdapter(Date.now());
    const logger = new MemoryLoggerAdapter();
    const estimator = new TokenEstimator();
    const compressor = new ContextCompressor({ estimator, logger, clock });

    let llmCalled = false;
    const mockLLM: CompressionLLM = {
      async chat() {
        llmCalled = true;
      },
    };

    const msgs: Message[] = [mkMsg('user', '短消息', Date.now())];
    const result = await compressor.compressIfNeeded(msgs, 'sys', 10000, 1000, {
      adapter: mockLLM,
      model: 'm',
      apiKey: 'k',
    });
    assert.equal(result.compressed, false);
    assert.equal(llmCalled, false);
  });

  await test('超阈值时调 Mock LLM 产出摘要', async () => {
    const clock = new FakeClockAdapter(1_700_000_000_000);
    const logger = new MemoryLoggerAdapter();
    const estimator = new TokenEstimator();
    const compressor = new ContextCompressor({ estimator, logger, clock });

    const mockLLM: CompressionLLM = {
      async chat(_messages, _options, onEvent) {
        onEvent({ type: 'text', text: '这是压缩后的摘要文本。' });
      },
    };

    const now = clock.now();
    const bigText = '这是一段较长的中文对话内容，用来填充足够的 token。'.repeat(30);
    const msgs: Message[] = [];
    for (let i = 0; i < 12; i++) {
      msgs.push(mkMsg('user', `问题${i}: ${bigText}`, now + i * 2));
      msgs.push(mkMsg('assistant', `答案${i}: ${bigText}`, now + i * 2 + 1));
    }

    const result = await compressor.compressIfNeeded(msgs, 'sys', 4000, 500, {
      adapter: mockLLM,
      model: 'm',
      apiKey: 'k',
    });
    assert.equal(result.compressed, true, `应压缩: savedTokens=${result.savedTokens}`);
    assert.ok(result.savedTokens > 0);
    const summary = result.messages.find((m) =>
      typeof m.content === 'string' && m.content.includes('[对话历史摘要]')
    );
    assert.ok(summary, '应该包含摘要消息');
  });

  console.log(`\n结果：${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
