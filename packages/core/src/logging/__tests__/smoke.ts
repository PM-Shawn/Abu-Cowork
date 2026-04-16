/**
 * logging/ POC 冒烟测试。
 * 运行：npx tsx packages/core/src/logging/__tests__/smoke.ts
 */

import assert from 'node:assert/strict';

import { FakeClockAdapter } from '../../mocks';
import {
  RingBufferLoggerAdapter,
  ConsoleLoggerAdapter,
  scopedLogger,
  installAmbientLogger,
  getAmbientLogger,
  resetAmbientLogger,
} from '../index';
import type { LogEntry } from '../../ports/adapters/logger';

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

async function main() {
  console.log('RingBufferLoggerAdapter:');

  await test('环形缓冲按时序返回', () => {
    const clock = new FakeClockAdapter(1000);
    const logger = new RingBufferLoggerAdapter(clock, { capacity: 3 });
    logger.log('info', 'mod', 'a');
    clock.advance(10);
    logger.log('info', 'mod', 'b');
    clock.advance(10);
    logger.log('info', 'mod', 'c');
    const entries = logger.getRecent();
    assert.deepEqual(entries.map((e) => e.message), ['a', 'b', 'c']);
    assert.equal(entries[0].ts, 1000);
    assert.equal(entries[2].ts, 1020);
  });

  await test('超容量覆盖老记录', () => {
    const clock = new FakeClockAdapter(0);
    const logger = new RingBufferLoggerAdapter(clock, { capacity: 3 });
    logger.log('info', 'm', '1');
    logger.log('info', 'm', '2');
    logger.log('info', 'm', '3');
    logger.log('info', 'm', '4');
    logger.log('info', 'm', '5');
    const entries = logger.getRecent();
    assert.deepEqual(entries.map((e) => e.message), ['3', '4', '5']);
  });

  await test('warn/error 转发到 sink，info 不转发', () => {
    const clock = new FakeClockAdapter(0);
    const sinkCapture: LogEntry[] = [];
    const logger = new RingBufferLoggerAdapter(clock, {
      sink: (e) => sinkCapture.push(e),
    });
    logger.log('debug', 'm', 'd');
    logger.log('info', 'm', 'i');
    logger.log('warn', 'm', 'w');
    logger.log('error', 'm', 'e');
    assert.equal(sinkCapture.length, 2);
    assert.equal(sinkCapture[0].level, 'warn');
    assert.equal(sinkCapture[1].level, 'error');
  });

  await test('sink 抛错不影响 log 主流程', () => {
    const clock = new FakeClockAdapter(0);
    const logger = new RingBufferLoggerAdapter(clock, {
      sink: () => {
        throw new Error('disk full');
      },
    });
    logger.log('error', 'm', 'boom');
    assert.equal(logger.getRecent().length, 1);
  });

  console.log('\nscopedLogger 语法糖:');

  await test('scoped 四个级别映射到 adapter.log', () => {
    const clock = new FakeClockAdapter(0);
    const adapter = new RingBufferLoggerAdapter(clock);
    const log = scopedLogger(adapter, 'agentLoop');
    log.debug('d', { x: 1 });
    log.info('i');
    log.warn('w');
    log.error('e');
    const entries = adapter.getRecent();
    assert.deepEqual(entries.map((e) => e.level), ['debug', 'info', 'warn', 'error']);
    assert.equal(entries.every((e) => e.module === 'agentLoop'), true);
    assert.deepEqual(entries[0].data, { x: 1 });
  });

  console.log('\nambient logger:');

  await test('默认 ambient 是 silent（不抛、不打 console）', () => {
    resetAmbientLogger();
    const ambient = getAmbientLogger();
    ambient.log('info', 'm', 'silent test');
    assert.deepEqual(ambient.getRecent(), []);
  });

  await test('install 后 ambient 切换为实际实现', () => {
    const clock = new FakeClockAdapter(500);
    const real = new RingBufferLoggerAdapter(clock);
    installAmbientLogger(real);
    getAmbientLogger().log('warn', 'mod', 'installed');
    assert.equal(real.getRecent().length, 1);
    assert.equal(real.getRecent()[0].message, 'installed');
    resetAmbientLogger();
  });

  console.log('\nConsoleLoggerAdapter:');

  await test('basic call 不报错', () => {
    const clock = new FakeClockAdapter(1700000000000);
    const logger = new ConsoleLoggerAdapter(clock);
    // 短暂接管 console 避免污染输出
    const origInfo = console.info;
    const captured: unknown[][] = [];
    console.info = (...args: unknown[]) => captured.push(args);
    try {
      logger.log('info', 'mod', 'hello', { x: 1 });
    } finally {
      console.info = origInfo;
    }
    assert.equal(captured.length, 1);
    const [prefix, msg, data] = captured[0];
    assert.ok((prefix as string).includes('INFO'));
    assert.equal(msg, 'hello');
    assert.deepEqual(data, { x: 1 });
  });

  console.log(`\n结果：${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
