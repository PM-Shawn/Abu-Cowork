/**
 * 用量账本的性能基准（任务书 V09）。
 *
 * 运行一次、记录数据，不是门禁，也不在 `npm run verify` 里。结果写到
 * `.scratch/usage-ledger-benchmark/results.json`，同时打印到终端。
 * 用法：`npm run bench:usage-ledger`
 *
 * 账本的读写都在主进程的主线程上同步执行，所以这里量的每一个耗时，
 * 就是那次操作让主线程停住的时间。三组数据：
 *   1. 十万行之上的日期范围查询（全部、近 30 天、单日）与单个会话的查询；
 *   2. 五十个请求同时进行时的写入（每个请求四份快照，交错到达）；
 *   3. 异常输入：十万份不合法的快照、一份超长的快照、一行超长的 stdout。
 *
 * 数据由下标推算，不含随机数，两次运行写入的内容相同。
 * 磁盘刷新的行为随平台不同，macOS 上量到的写入耗时不能直接当作 Windows 的。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const usageDb = require('../electron/usageDb.cjs');
const { decodeUsageFrame, encodeUsageFrame, validateUsageAttempt } = require('../electron/usageAttemptFrame.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const BENCH_ROOT = path.join(REPO_ROOT, '.scratch', 'usage-ledger-benchmark');

const ROWS = 100_000;
const DAYS = 365;
const CONCURRENT_REQUESTS = 50;
const SNAPSHOTS_PER_REQUEST = 4;
const QUERY_RUNS = 20;
const INVALID_FRAMES = 100_000;

const SOURCES = ['main', 'subagent', 'compaction', 'memory', 'skill', 'diagnostic', 'other'];
const MODELS = ['claude-opus-5', 'claude-sonnet-5', 'gpt-5.6-sol', 'deepseek-chat', 'qwen-max'];
const SKILLS = [null, null, null, 'docx', 'pptx'];
const FIRST_DAY_UTC = Date.UTC(2026, 0, 1);
const DAY_MS = 86_400_000;

const fakeApp = {
  getPath(name) {
    if (name === 'appData') return BENCH_ROOT;
    throw new Error(`benchmark app: unexpected getPath("${name}")`);
  },
};

function localDateOfDay(dayIndex) {
  return new Date(FIRST_DAY_UTC + dayIndex * DAY_MS).toISOString().slice(0, 10);
}

function attempt(index, revision = 1) {
  const dayIndex = index % DAYS;
  const startedAtUtc = FIRST_DAY_UTC + dayIndex * DAY_MS + (index % 86_400) * 1000;
  const inputUnknown = index % 50 === 0;
  return {
    schemaVersion: 1,
    attemptId: `bench-${index}`,
    logicalCallId: `call-${index}`,
    revision,
    providerInstanceId: 'provider-benchmark',
    protocol: index % 2 === 0 ? 'anthropic' : 'openai-compatible',
    requestedModel: MODELS[index % MODELS.length],
    servedModel: MODELS[index % MODELS.length],
    source: SOURCES[index % SOURCES.length],
    conversationId: `conv-${index % 2000}`,
    skill: SKILLS[index % SKILLS.length],
    startedAtUtc,
    localDate: localDateOfDay(dayIndex),
    tzId: 'Asia/Shanghai',
    offsetMinutes: 480,
    endedAtUtc: startedAtUtc + 2000,
    outcome: 'succeeded',
    usage: {
      inputTotal: inputUnknown ? null : 1000 + (index % 9000),
      uncachedInput: inputUnknown ? null : 400 + (index % 600),
      cacheRead: index % 3 === 0 ? null : index % 700,
      cacheWrite: index % 3 === 0 ? null : index % 90,
      outputTotal: 100 + (index % 900),
      reasoningOutput: index % 5 === 0 ? index % 300 : null,
      evidence: index % 97 === 0 ? 'partial' : 'final',
      invalidFields: [],
    },
  };
}

function round(ms) {
  return Math.round(ms * 1000) / 1000;
}

function time(fn) {
  const startedAt = performance.now();
  const value = fn();
  return { ms: performance.now() - startedAt, value };
}

/** 重复执行并给出中位数与最大值，单位毫秒。 */
function sample(runs, fn) {
  const durations = [];
  let last;
  for (let i = 0; i < runs; i += 1) {
    const { ms, value } = time(fn);
    durations.push(ms);
    last = value;
  }
  durations.sort((a, b) => a - b);
  return { medianMs: round(durations[Math.floor(runs / 2)]), maxMs: round(durations[runs - 1]), last };
}

function requireOk(result, what) {
  if (!result || result.ok !== true) {
    throw new Error(`benchmark: ${what} failed: ${JSON.stringify(result)}`);
  }
}

function run() {
  fs.rmSync(BENCH_ROOT, { recursive: true, force: true });
  fs.mkdirSync(BENCH_ROOT, { recursive: true });
  usageDb._internal.resetForTest();

  // ── 写入十万行 ──────────────────────────────────────────────────────
  const fill = time(() => {
    for (let i = 0; i < ROWS; i += 1) requireOk(usageDb.recordUsageAttempt(fakeApp, attempt(i)), `write ${i}`);
  });

  // ── 查询 ────────────────────────────────────────────────────────────
  const lastDay = localDateOfDay(DAYS - 1);
  const queryAll = sample(QUERY_RUNS, () => usageDb._internal.queryRange(fakeApp, '0000-01-01', '9999-12-31'));
  const query30 = sample(QUERY_RUNS, () => usageDb._internal.queryRange(fakeApp, localDateOfDay(DAYS - 30), lastDay));
  const queryDay = sample(QUERY_RUNS, () => usageDb._internal.queryRange(fakeApp, lastDay, lastDay));
  const queryConversation = sample(QUERY_RUNS, () => usageDb._internal.queryConversation(fakeApp, 'conv-7'));
  if (queryAll.last.totals.attempts !== ROWS) {
    throw new Error(`benchmark: expected ${ROWS} attempts, the ledger has ${queryAll.last.totals.attempts}`);
  }

  // ── 五十个请求同时进行 ──────────────────────────────────────────────
  // 每个请求先后写四份快照，五十个请求的同一版快照交错到达；最后把第一版再送一遍，
  // 模拟迟到的旧快照。
  const writeDurations = [];
  const concurrent = time(() => {
    for (let revision = 0; revision < SNAPSHOTS_PER_REQUEST; revision += 1) {
      for (let request = 0; request < CONCURRENT_REQUESTS; request += 1) {
        const snapshot = attempt(ROWS + request, revision);
        const { ms, value } = time(() => usageDb.recordUsageAttempt(fakeApp, snapshot));
        requireOk(value, `concurrent write ${request}/${revision}`);
        writeDurations.push(ms);
      }
    }
    for (let request = 0; request < CONCURRENT_REQUESTS; request += 1) {
      requireOk(usageDb.recordUsageAttempt(fakeApp, attempt(ROWS + request, 0)), `late replay ${request}`);
    }
  });
  writeDurations.sort((a, b) => a - b);
  const afterConcurrent = usageDb._internal.queryRange(fakeApp, '0000-01-01', '9999-12-31');
  if (afterConcurrent.totals.attempts !== ROWS + CONCURRENT_REQUESTS) {
    throw new Error(`benchmark: concurrent writes produced ${afterConcurrent.totals.attempts} attempts`);
  }

  // ── 异常输入 ────────────────────────────────────────────────────────
  const healthBefore = usageDb.getUsageHealth();
  const invalid = time(() => {
    for (let i = 0; i < INVALID_FRAMES; i += 1) {
      usageDb.recordUsageAttempt(fakeApp, { ...attempt(i), localDate: `2026-9-${i % 28}` });
    }
  });
  const healthAfter = usageDb.getUsageHealth();
  if (healthAfter.rejectedFrames - healthBefore.rejectedFrames !== INVALID_FRAMES) {
    throw new Error('benchmark: not every invalid snapshot was rejected');
  }
  const oversizedId = 'x'.repeat(1024 * 1024);
  const oversizedAttempt = sample(QUERY_RUNS, () => validateUsageAttempt({ ...attempt(1), attemptId: oversizedId }));
  const oversizedLine = encodeUsageFrame({ ...attempt(1), attemptId: 'y'.repeat(5 * 1024 * 1024) });
  const oversizedFrame = sample(QUERY_RUNS, () => decodeUsageFrame(oversizedLine));

  const dbPath = path.join(BENCH_ROOT, 'com.abu.app.electron-dev', usageDb.USAGE_DB_FILENAME);
  usageDb._internal.resetForTest();
  const dbBytes = fs.statSync(dbPath).size;

  const results = {
    environment: {
      platform: `${os.platform()} ${os.arch()}`,
      osRelease: os.release(),
      cpu: os.cpus()[0]?.model ?? 'unknown',
      node: process.version,
      loadAverage1m: round(os.loadavg()[0]),
    },
    ledger: { rows: ROWS, days: DAYS, dbBytes },
    fill: { totalMs: round(fill.ms), perWriteMs: round(fill.ms / ROWS) },
    queries: {
      allRange: { medianMs: queryAll.medianMs, maxMs: queryAll.maxMs },
      last30Days: { medianMs: query30.medianMs, maxMs: query30.maxMs },
      singleDay: { medianMs: queryDay.medianMs, maxMs: queryDay.maxMs },
      conversation: { medianMs: queryConversation.medianMs, maxMs: queryConversation.maxMs },
    },
    concurrentRequests: {
      requests: CONCURRENT_REQUESTS,
      writes: writeDurations.length + CONCURRENT_REQUESTS,
      totalMs: round(concurrent.ms),
      medianWriteMs: round(writeDurations[Math.floor(writeDurations.length / 2)]),
      maxWriteMs: round(writeDurations[writeDurations.length - 1]),
    },
    invalidInput: {
      rejectedSnapshots: INVALID_FRAMES,
      totalMs: round(invalid.ms),
      perSnapshotMs: round(invalid.ms / INVALID_FRAMES),
      oversizedIdValidationMedianMs: oversizedAttempt.medianMs,
      oversizedStdoutLineMedianMs: oversizedFrame.medianMs,
      oversizedStdoutLineResult: oversizedFrame.last.kind,
    },
  };

  fs.writeFileSync(path.join(BENCH_ROOT, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  console.log(JSON.stringify(results, null, 2));
}

run();
