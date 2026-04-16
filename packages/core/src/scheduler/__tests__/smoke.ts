import assert from 'node:assert/strict';
import {
  FakeClockAdapter,
  MemoryLoggerAdapter,
  MemoryTriggerRepo,
} from '../../mocks';
import { TickLoop, DueTaskScheduler } from '../index';
import type { TriggerRule } from '../../ports/repos/trigger';

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

function cronRule(id: string, intervalSeconds: number, enabled = true): TriggerRule {
  return {
    id,
    name: id,
    enabled,
    source: { type: 'cron', intervalSeconds },
    prompt: 'do thing',
    createdAt: 0,
    updatedAt: 0,
  };
}

async function main() {
  console.log('TickLoop:');

  await test('runImmediately 立即触发一次', async () => {
    const clock = new FakeClockAdapter(0);
    const logger = new MemoryLoggerAdapter();
    let called = 0;
    const loop = new TickLoop({
      clock,
      logger,
      intervalMs: 60_000,
      runImmediately: true,
      onTick: () => {
        called++;
      },
    });
    loop.start();
    // microtask flush
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(called, 1);
    loop.stop();
  });

  await test('FakeClock 推进触发 interval', async () => {
    const clock = new FakeClockAdapter(0);
    const logger = new MemoryLoggerAdapter();
    let called = 0;
    const loop = new TickLoop({
      clock,
      logger,
      intervalMs: 60_000,
      onTick: () => {
        called++;
      },
    });
    loop.start();
    clock.advance(60_000);
    await Promise.resolve();
    clock.advance(60_000);
    await Promise.resolve();
    assert.equal(called, 2);
    loop.stop();
  });

  await test('onTick 抛错被 logger 吞掉', async () => {
    const clock = new FakeClockAdapter(0);
    const logger = new MemoryLoggerAdapter();
    const loop = new TickLoop({
      clock,
      logger,
      intervalMs: 1000,
      runImmediately: true,
      onTick: () => {
        throw new Error('boom');
      },
    });
    loop.start();
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(
      logger.entries.some(
        (e) =>
          e.level === 'error' &&
          JSON.stringify(e.data ?? '').includes('boom')
      )
    );
    loop.stop();
  });

  console.log('\nDueTaskScheduler:');

  await test('启动时首次 tick 将所有 cron rule 视为到期', async () => {
    const clock = new FakeClockAdapter(0);
    const logger = new MemoryLoggerAdapter();
    const triggers = new MemoryTriggerRepo();
    await triggers.upsertRule(cronRule('a', 60));
    await triggers.upsertRule(cronRule('b', 120));
    await triggers.upsertRule(cronRule('c', 60, false)); // disabled

    const executed: string[] = [];
    const sched = new DueTaskScheduler({
      triggers,
      clock,
      logger,
      executor: async (r) => {
        executed.push(r.id);
      },
    });

    const due = await sched.getDueRules();
    assert.deepEqual(due.map((r) => r.id).sort(), ['a', 'b']);
  });

  await test('runNow 立即执行单个 rule', async () => {
    const clock = new FakeClockAdapter(0);
    const logger = new MemoryLoggerAdapter();
    const triggers = new MemoryTriggerRepo();
    await triggers.upsertRule(cronRule('x', 60));
    const executed: string[] = [];
    const sched = new DueTaskScheduler({
      triggers,
      clock,
      logger,
      executor: async (r) => {
        executed.push(r.id);
      },
    });
    await sched.runNow('x');
    assert.deepEqual(executed, ['x']);
  });

  await test('间隔内不重复执行，超间隔后再次到期', async () => {
    const clock = new FakeClockAdapter(1000);
    const logger = new MemoryLoggerAdapter();
    const triggers = new MemoryTriggerRepo();
    await triggers.upsertRule(cronRule('r', 60));
    const executed: string[] = [];
    const sched = new DueTaskScheduler({
      triggers,
      clock,
      logger,
      executor: async (r) => {
        executed.push(r.id);
      },
    });
    await sched.runNow('r');
    assert.equal(executed.length, 1);

    // 30 秒后还没到
    clock.advance(30_000);
    let due = await sched.getDueRules();
    assert.equal(due.length, 0);

    // 到 60s 点：到期
    clock.advance(30_000);
    due = await sched.getDueRules();
    assert.equal(due.length, 1);
  });

  console.log(`\n结果：${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
