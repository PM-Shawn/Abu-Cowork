// @vitest-environment node

/**
 * 故障注入：写到一半进程被杀。
 *
 * 任务书：`docs/2026-09-15-usage-accounting-fix-brief.md`（期 1 第 2 步）。
 *
 * 账本没有 outbox、没有补存队列，"已经写进去的还在不在"全靠 SQLite 自己的
 * WAL + `synchronous = FULL`。这条保证不能只写在注释里——这里用真实的子进程写、
 * 真实的 SIGKILL 杀，再在父进程里把库重新打开清点。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
const usageDb = require_('./usageDb.cjs') as {
  USAGE_DB_FILENAME: string;
  _internal: {
    queryRange: (
      app: unknown,
      from: string,
      to: string,
    ) => { available: boolean; totals: { attempts: number; inputKnownSum: number } };
    queryConversation: (
      app: unknown,
      conversationId: string,
    ) => { available: boolean; totals: { attempts: number } };
    resetForTest: () => void;
  };
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const SCRATCH_ROOT = path.join(REPO_ROOT, '.scratch', 'usage-crash-test');
const WRITER = path.join(HERE, '__fixtures__', 'usageCrashWriter.cjs');

let appDataRoot = '';

function fakeApp() {
  return {
    isPackaged: false,
    getPath(name: string) {
      if (name === 'appData') return appDataRoot;
      throw new Error(`fakeApp.getPath: unexpected key "${name}"`);
    },
  };
}

function dbPath() {
  return path.join(appDataRoot, 'com.abu.app.electron-dev', usageDb.USAGE_DB_FILENAME);
}

afterEach(() => {
  usageDb._internal.resetForTest();
  fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
});

describe('写到一半进程被杀', () => {
  it('账本确认过的条目一条不少，库仍然能打开', async () => {
    usageDb._internal.resetForTest();
    appDataRoot = path.join(SCRATCH_ROOT, 'kill-mid-write');
    fs.rmSync(appDataRoot, { recursive: true, force: true });
    fs.mkdirSync(appDataRoot, { recursive: true });

    const child = spawn(process.execPath, [WRITER, appDataRoot], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const committed: number[] = [];
    // 由子进程的输出驱动：确认过的条目数到了就放行，等多久交给用例自己的超时。
    let reachedEnough: () => void = () => {};
    const enough = new Promise<void>((resolve) => {
      reachedEnough = resolve;
    });
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const parsed = JSON.parse(line) as { committed?: number; failed?: number; code?: string };
        if (parsed.failed !== undefined) {
          throw new Error(`子进程写入失败：#${parsed.failed} ${parsed.code}`);
        }
        if (parsed.committed !== undefined) {
          committed.push(parsed.committed);
          if (committed.length >= 30) reachedEnough();
        }
      }
    });

    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));

    await enough;
    expect(committed.length).toBeGreaterThanOrEqual(30);

    // 正写在中间的时候硬杀：没有清理、没有关闭、没有检查点。
    child.kill('SIGKILL');
    await exited;

    const confirmed = committed.length;
    expect(fs.existsSync(dbPath())).toBe(true);

    const result = usageDb._internal.queryRange(fakeApp(), '0000-01-01', '9999-12-31');
    expect(result.available).toBe(true);
    // 被杀之后可能还有几条已经写进 WAL 但没来得及报出来，所以是"不少于"。
    expect(result.totals.attempts).toBeGreaterThanOrEqual(confirmed);
    // 每条 100 输入，合计必须与条数对得上——半条记录或者脏数据会在这里露出来。
    expect(result.totals.inputKnownSum).toBe(result.totals.attempts * 100);

    const conversation = usageDb._internal.queryConversation(fakeApp(), 'conv-crash');
    expect(conversation.totals.attempts).toBe(result.totals.attempts);
  }, 30_000);

  it('杀掉之后重新打开，继续写不受影响', async () => {
    usageDb._internal.resetForTest();
    appDataRoot = path.join(SCRATCH_ROOT, 'resume-after-kill');
    fs.rmSync(appDataRoot, { recursive: true, force: true });
    fs.mkdirSync(appDataRoot, { recursive: true });

    const child = spawn(process.execPath, [WRITER, appDataRoot], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve) => {
      child.stdout.once('data', () => resolve());
    });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGKILL');
    await exited;

    const before = usageDb._internal.queryRange(fakeApp(), '0000-01-01', '9999-12-31');
    expect(before.available).toBe(true);
    const beforeAttempts = before.totals.attempts;

    const recordUsageAttempt = (
      require_('./usageDb.cjs') as {
        recordUsageAttempt: (app: unknown, raw: unknown) => { ok: boolean; code?: string };
      }
    ).recordUsageAttempt;
    const written = recordUsageAttempt(fakeApp(), {
      schemaVersion: 1,
      attemptId: 'att-after-crash',
      logicalCallId: 'call-after-crash',
      revision: 1,
      providerInstanceId: 'provider-anthropic-default',
      protocol: 'anthropic',
      requestedModel: 'claude-opus-5',
      servedModel: 'claude-opus-5',
      source: 'main',
      conversationId: 'conv-crash',
      skill: null,
      startedAtUtc: 1_789_000_000_000,
      localDate: '2026-09-15',
      tzId: 'Asia/Shanghai',
      offsetMinutes: 480,
      endedAtUtc: 1_789_000_002_000,
      outcome: 'succeeded',
      usage: {
        inputTotal: 100,
        uncachedInput: 100,
        cacheRead: 0,
        cacheWrite: 0,
        outputTotal: 10,
        reasoningOutput: null,
        evidence: 'final',
        invalidFields: [],
      },
    });
    expect(written).toEqual({ ok: true });

    const after = usageDb._internal.queryRange(fakeApp(), '0000-01-01', '9999-12-31');
    expect(after.totals.attempts).toBe(beforeAttempts + 1);
  }, 30_000);
});
