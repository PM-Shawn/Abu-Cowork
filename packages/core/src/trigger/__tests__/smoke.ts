import assert from 'node:assert/strict';
import {
  MemoryStorageAdapter,
  MemoryLoggerAdapter,
  FakeClockAdapter,
} from '../../mocks';
import { FileTriggerWatcher, matchesGlob } from '../index';
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

function fileRule(id: string, path: string, events: Array<'create' | 'modify' | 'delete'>, pattern?: string): TriggerRule {
  return {
    id,
    name: id,
    enabled: true,
    source: { type: 'file', path, events, pattern },
    prompt: '',
    createdAt: 0,
    updatedAt: 0,
  };
}

async function main() {
  console.log('fileMatcher:');

  await test('glob 基本', () => {
    assert.equal(matchesGlob('src/a.ts', '**/*.ts'), true);
    assert.equal(matchesGlob('src/a.ts', '*.ts'), false);
    assert.equal(matchesGlob('a.ts', '*.ts'), true);
    assert.equal(matchesGlob('logs/2026-04.log', '*.log'), false);
    assert.equal(matchesGlob('logs/2026-04.log', '**/*.log'), true);
  });

  console.log('\nFileTriggerWatcher:');

  await test('create 事件触发 executor', async () => {
    const storage = new MemoryStorageAdapter();
    const clock = new FakeClockAdapter(0);
    const logger = new MemoryLoggerAdapter();
    const calls: Array<{ path: string; ev: string }> = [];

    await storage.mkdir('/watched', { recursive: true });

    const watcher = new FileTriggerWatcher({
      storage,
      clock,
      logger,
      executor: async (_rule, path, ev) => {
        calls.push({ path, ev });
      },
    });

    watcher.register(fileRule('r1', '/watched', ['create']));
    await storage.writeTextFile('/watched/new.log', 'data');

    // Advance past debounce
    clock.advance(300);
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].ev, 'create');
    watcher.unregisterAll();
  });

  await test('events 过滤：只监听 modify', async () => {
    const storage = new MemoryStorageAdapter();
    const clock = new FakeClockAdapter(0);
    const logger = new MemoryLoggerAdapter();
    const calls: string[] = [];

    await storage.mkdir('/w', { recursive: true });

    const watcher = new FileTriggerWatcher({
      storage,
      clock,
      logger,
      executor: async (_r, _p, ev) => {
        calls.push(ev);
      },
    });

    watcher.register(fileRule('r1', '/w', ['modify']));
    await storage.writeTextFile('/w/a.txt', 'v1'); // create
    clock.advance(300);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(calls.length, 0, 'create should be filtered');

    await storage.writeTextFile('/w/a.txt', 'v2'); // modify
    clock.advance(300);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(calls.length, 1);
    assert.equal(calls[0], 'modify');
    watcher.unregisterAll();
  });

  await test('pattern 过滤', async () => {
    const storage = new MemoryStorageAdapter();
    const clock = new FakeClockAdapter(0);
    const logger = new MemoryLoggerAdapter();
    const seen: string[] = [];

    await storage.mkdir('/log', { recursive: true });

    const watcher = new FileTriggerWatcher({
      storage,
      clock,
      logger,
      executor: async (_r, path) => {
        seen.push(path);
      },
    });

    watcher.register(fileRule('r1', '/log', ['create'], '**/*.log'));
    await storage.writeTextFile('/log/a.log', 'x');
    await storage.writeTextFile('/log/b.txt', 'x');

    clock.advance(300);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(seen.length, 1, `expected only .log, got: ${seen.join(',')}`);
    assert.ok(seen[0].endsWith('a.log'));
    watcher.unregisterAll();
  });

  await test('多事件 debounce 合并', async () => {
    const storage = new MemoryStorageAdapter();
    const clock = new FakeClockAdapter(0);
    const logger = new MemoryLoggerAdapter();
    const calls: string[] = [];
    await storage.mkdir('/d', { recursive: true });

    const watcher = new FileTriggerWatcher({
      storage,
      clock,
      logger,
      executor: async (_r, _p, ev) => {
        calls.push(ev);
      },
    });

    watcher.register(fileRule('r', '/d', ['create', 'modify']));
    await storage.writeTextFile('/d/a.txt', '1');
    await storage.writeTextFile('/d/a.txt', '2');
    await storage.writeTextFile('/d/a.txt', '3');

    clock.advance(300);
    await new Promise((r) => setTimeout(r, 10));
    // 同一 path 被合并为最后一次事件 (modify)
    assert.equal(calls.length, 1);
    watcher.unregisterAll();
  });

  await test('unregister 停止监听', async () => {
    const storage = new MemoryStorageAdapter();
    const clock = new FakeClockAdapter(0);
    const logger = new MemoryLoggerAdapter();
    const calls: string[] = [];
    await storage.mkdir('/u', { recursive: true });

    const watcher = new FileTriggerWatcher({
      storage,
      clock,
      logger,
      executor: async (_r, path) => {
        calls.push(path);
      },
    });

    watcher.register(fileRule('r', '/u', ['create']));
    assert.equal(watcher.isRegistered('r'), true);
    watcher.unregister('r');
    assert.equal(watcher.isRegistered('r'), false);

    await storage.writeTextFile('/u/x', 'data');
    clock.advance(300);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(calls.length, 0);
  });

  console.log(`\n结果：${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
