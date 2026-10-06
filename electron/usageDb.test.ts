// @vitest-environment node

/**
 * 用量账本的行为测试（期 1 第 2 步）。
 *
 * 任务书：`docs/2026-09-15-usage-accounting-fix-brief.md`。
 * 这里盯三件事：那一句幂等写入是否真的给出了它承诺的四个性质；查询给出的
 * 「已知合计 + 未知尝试数」是否与 U03 一致；库出问题时是否只停在"记不上"，
 * 错误不进入正在进行的对话。
 *
 * 临时目录放仓库根目录下的 `.scratch/`，不用系统临时目录。
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseAttempt } from '../src/core/llm/__contractFixtures__/usageAttemptFixtures';
import type { UsageAttempt } from '../src/core/llm/usageAccounting';

const require_ = createRequire(import.meta.url);
const usageDb = require_('./usageDb.cjs') as {
  usageDispatch: (app: unknown, cmd: string, args?: unknown) => unknown;
  USAGE_MISS: symbol;
  USAGE_DB_FILENAME: string;
  USAGE_SCHEMA_VERSION: number;
  recordUsageAttempt: (app: unknown, raw: unknown) => { ok: boolean; code?: string };
  getUsageHealth: () => {
    writeFailures: number;
    rejectedFrames: number;
    firstFailureAtUtc: number | null;
    lastFailureAtUtc: number | null;
    lastErrorCode: string | null;
    degradedCode: string | null;
  };
  purgeUsageLedger: (app: unknown) => { removed: string[] };
  _internal: {
    queryRange: (app: unknown, from: string, to: string) => RangeResult;
    queryConversation: (app: unknown, conversationId: string) => ConversationResult;
    resetForTest: () => void;
  };
};

interface Aggregate {
  attempts: number;
  inputKnownSum: number;
  inputUnknownAttempts: number;
  outputKnownSum: number;
  outputUnknownAttempts: number;
  cacheReadKnownSum: number;
  cacheWriteKnownSum: number;
  reasoningKnownSum: number;
  cacheComparableAttempts: number;
  incompleteAttempts: number;
}

interface RangeResult {
  available: boolean;
  byDay: ({ localDate: string } & Aggregate)[];
  bySource: ({ source: string } & Aggregate)[];
  totals: Aggregate;
  statsOriginLocalDate: string | null;
  health: { writeFailures: number; lastErrorCode: string | null; degradedCode: string | null };
}

interface ConversationResult {
  available: boolean;
  totals: Aggregate;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH_ROOT = path.join(REPO_ROOT, '.scratch', 'usage-db-tests');

let caseIndex = 0;
let appDataRoot = '';

/** 假的 Electron `app`——`abuAppDataDir` 只用到 `getPath('appData')`。 */
function fakeApp() {
  return {
    getPath(name: string) {
      if (name === 'appData') return appDataRoot;
      throw new Error(`fakeApp.getPath: unexpected key "${name}"`);
    },
  };
}

/** 账本文件的真实路径（`abuAppDataDir` 在非打包态用 `com.abu.app.electron-dev`）。 */
function dbPath() {
  return path.join(appDataRoot, 'com.abu.app.electron-dev', usageDb.USAGE_DB_FILENAME);
}

function attempt(overrides: Partial<UsageAttempt> = {}): UsageAttempt {
  return { ...baseAttempt(), ...overrides };
}

function usageOf(overrides: Partial<UsageAttempt['usage']>): UsageAttempt['usage'] {
  return { ...baseAttempt().usage, ...overrides };
}

beforeEach(() => {
  usageDb._internal.resetForTest();
  caseIndex += 1;
  appDataRoot = path.join(SCRATCH_ROOT, `case-${caseIndex}`);
  fs.rmSync(appDataRoot, { recursive: true, force: true });
  fs.mkdirSync(appDataRoot, { recursive: true });
});

afterAll(() => {
  usageDb._internal.resetForTest();
  fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
});

const FULL_RANGE = ['0000-01-01', '9999-12-31'] as const;

function range(): RangeResult {
  return usageDb._internal.queryRange(fakeApp(), FULL_RANGE[0], FULL_RANGE[1]);
}

describe('幂等写入', () => {
  it('同一条重放 100 次，请求尝试数仍然是 1', () => {
    const one = attempt();
    for (let i = 0; i < 100; i += 1) {
      expect(usageDb.recordUsageAttempt(fakeApp(), one)).toEqual({ ok: true });
    }
    const result = range();
    expect(result.totals.attempts).toBe(1);
    expect(result.totals.inputKnownSum).toBe(2000);
    expect(usageDb.getUsageHealth().writeFailures).toBe(0);
  });

  it('更高的 revision 覆盖，更低的不覆盖', () => {
    usageDb.recordUsageAttempt(
      fakeApp(),
      attempt({ revision: 1, usage: usageOf({ outputTotal: 10 }) }),
    );
    usageDb.recordUsageAttempt(
      fakeApp(),
      attempt({ revision: 2, usage: usageOf({ outputTotal: 500 }) }),
    );
    expect(range().totals.outputKnownSum).toBe(500);

    // 迟到的旧快照：写入返回成功（这一句本来就允许什么都不改），但数字不退回。
    const late = usageDb.recordUsageAttempt(
      fakeApp(),
      attempt({ revision: 1, usage: usageOf({ outputTotal: 10 }) }),
    );
    expect(late).toEqual({ ok: true });
    expect(range().totals.outputKnownSum).toBe(500);
  });

  it('相同 revision 不覆盖已有内容', () => {
    usageDb.recordUsageAttempt(
      fakeApp(),
      attempt({ revision: 3, usage: usageOf({ outputTotal: 500 }) }),
    );
    usageDb.recordUsageAttempt(
      fakeApp(),
      attempt({ revision: 3, usage: usageOf({ outputTotal: 1 }) }),
    );
    expect(range().totals.outputKnownSum).toBe(500);
  });

  it('乱序到达：先收到最终结算，再收到流内快照，结果仍是最终结算', () => {
    const final = attempt({ revision: 5, outcome: 'succeeded', usage: usageOf({ outputTotal: 500 }) });
    const early = attempt({
      revision: 0,
      outcome: 'running',
      usage: usageOf({ outputTotal: null, evidence: 'none' }),
    });
    usageDb.recordUsageAttempt(fakeApp(), final);
    usageDb.recordUsageAttempt(fakeApp(), early);

    const result = range();
    expect(result.totals.attempts).toBe(1);
    expect(result.totals.outputKnownSum).toBe(500);
    expect(result.totals.incompleteAttempts).toBe(0);
  });

  it('不同 attemptId 各占一行', () => {
    usageDb.recordUsageAttempt(fakeApp(), attempt({ attemptId: 'a' }));
    usageDb.recordUsageAttempt(fakeApp(), attempt({ attemptId: 'b' }));
    expect(range().totals.attempts).toBe(2);
  });
});

describe('汇总口径', () => {
  beforeEach(() => {
    // 三条：一条各项齐备，一条输入未知，一条只有流内累计快照。
    usageDb.recordUsageAttempt(
      fakeApp(),
      attempt({ attemptId: 'a', localDate: '2026-09-15', source: 'main' }),
    );
    usageDb.recordUsageAttempt(
      fakeApp(),
      attempt({
        attemptId: 'b',
        localDate: '2026-09-15',
        source: 'subagent',
        usage: usageOf({ inputTotal: null, uncachedInput: null, outputTotal: 300 }),
      }),
    );
    usageDb.recordUsageAttempt(
      fakeApp(),
      attempt({
        attemptId: 'c',
        localDate: '2026-09-16',
        source: 'main',
        usage: usageOf({
          inputTotal: 100,
          cacheRead: null,
          cacheWrite: null,
          outputTotal: null,
          evidence: 'partial',
        }),
      }),
    );
  });

  it('已知合计只累加已知值，未知单独计数', () => {
    const totals = range().totals;
    expect(totals.attempts).toBe(3);
    // 2000 + 100，b 的输入未知不参与求和。
    expect(totals.inputKnownSum).toBe(2100);
    expect(totals.inputUnknownAttempts).toBe(1);
    expect(totals.outputKnownSum).toBe(800);
    expect(totals.outputUnknownAttempts).toBe(1);
  });

  it('缓存命中率的可比尝试数只数缓存读与输入总量都已知的那些', () => {
    // a 两样都有；b 输入总量未知；c 缓存读未知。
    expect(range().totals.cacheComparableAttempts).toBe(1);
  });

  it('未拿到最终结算的尝试单独计数', () => {
    expect(range().totals.incompleteAttempts).toBe(1);
  });

  it('推理 token 只累加已知值，输出合计不因它再加一次', () => {
    const before = range().totals;
    usageDb.recordUsageAttempt(
      fakeApp(),
      attempt({
        attemptId: 'd',
        localDate: '2026-09-16',
        usage: usageOf({ outputTotal: 500, reasoningOutput: 120 }),
      }),
    );

    const after = range().totals;

    // 其余几条没有上报推理，不参与求和。
    expect(before.reasoningKnownSum).toBe(0);
    expect(after.reasoningKnownSum).toBe(120);
    // 推理是输出的子项：输出合计只增加这一条的 500。
    expect(after.outputKnownSum).toBe(before.outputKnownSum + 500);
  });

  it('按本地日历日分组，日期就是快照里的 localDate', () => {
    const byDay = range().byDay;
    expect(byDay.map((d) => d.localDate)).toEqual(['2026-09-15', '2026-09-16']);
    expect(byDay[0].attempts).toBe(2);
    expect(byDay[1].attempts).toBe(1);
  });

  it('按来源分组', () => {
    const bySource = range().bySource;
    expect(bySource.map((s) => s.source)).toEqual(['main', 'subagent']);
    expect(bySource[0].attempts).toBe(2);
    expect(bySource[1].attempts).toBe(1);
  });

  it('日期范围之外的记录不参与合计，统计起点仍取全表最小日期', () => {
    const result = usageDb._internal.queryRange(fakeApp(), '2026-09-16', '2026-09-16');
    expect(result.totals.attempts).toBe(1);
    // 起点回答的是"这份统计从哪天开始"，与当前筛选范围无关（任务书 U01）。
    expect(result.statsOriginLocalDate).toBe('2026-09-15');
  });

  it('会话合计只数该会话', () => {
    usageDb.recordUsageAttempt(
      fakeApp(),
      attempt({ attemptId: 'd', conversationId: 'conv-other' }),
    );
    const mine = usageDb._internal.queryConversation(fakeApp(), 'conv-0001');
    expect(mine.available).toBe(true);
    expect(mine.totals.attempts).toBe(3);
  });

  it('空库查出来是零，不报错', () => {
    usageDb._internal.resetForTest();
    appDataRoot = path.join(SCRATCH_ROOT, 'empty-case');
    fs.rmSync(appDataRoot, { recursive: true, force: true });
    fs.mkdirSync(appDataRoot, { recursive: true });

    const result = range();
    expect(result.available).toBe(true);
    expect(result.totals.attempts).toBe(0);
    expect(result.statsOriginLocalDate).toBeNull();
    expect(result.byDay).toEqual([]);
  });
});

describe('只存该存的', () => {
  it('写进库里的 JSON 只有协议里的那些字段', () => {
    usageDb.recordUsageAttempt(fakeApp(), {
      ...attempt(),
      promptText: '帮我把这封邮件改得客气一些',
      apiKey: 'sk-live-0123456789',
    });

    // WAL 模式下新写的行先写在 `-wal` 边文件里，检查点之前主库文件里看不到它，
    // 所以两个文件一起读。期 4 的 purge 也因此必须覆盖 db / -wal / -shm 三个文件。
    // 按字节比对：文本解码会把无效字节变成替换字符，反而让断言变松。
    const raw = Buffer.concat(
      ['', '-wal']
        .map((suffix) => `${dbPath()}${suffix}`)
        .filter((p) => fs.existsSync(p))
        .map((p) => fs.readFileSync(p)),
    );
    expect(raw.includes('promptText')).toBe(false);
    expect(raw.includes('sk-live-0123456789')).toBe(false);
    expect(raw.includes('帮我把这封邮件')).toBe(false);
    // 该存的确实存了，避免这条断言因为"什么都没写进去"而假绿。
    expect(raw.includes('att-0001')).toBe(true);
  });

  it('不合法的快照不进库，只累加被拒计数', () => {
    const result = usageDb.recordUsageAttempt(fakeApp(), attempt({ localDate: '2026-9-15' }));
    expect(result.ok).toBe(false);
    expect(result.code).toBe('invalid-attempt:field:localDate');

    const health = usageDb.getUsageHealth();
    expect(health.rejectedFrames).toBe(1);
    // 被拒与写失败是两件事，原因不同，分开计数。
    expect(health.writeFailures).toBe(0);
    expect(range().totals.attempts).toBe(0);
  });
});

describe('库出问题时', () => {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  it('损坏的库：停止写入并上报，聊天路径拿到的是返回值不是异常', () => {
    const dir = path.dirname(dbPath());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dbPath(), 'this is not a sqlite database at all');

    const result = usageDb.recordUsageAttempt(fakeApp(), attempt());
    expect(result.ok).toBe(false);
    expect(result.code).toBe('corrupt');

    const health = usageDb.getUsageHealth();
    expect(health.writeFailures).toBe(1);
    expect(health.degradedCode).toBe('corrupt');
    expect(health.firstFailureAtUtc).not.toBeNull();

    // 不删库重建：损坏的字节原样留着，交给用户和诊断包。
    expect(fs.readFileSync(dbPath(), 'utf8')).toBe('this is not a sqlite database at all');
  });

  it('损坏的库：查询给出不可用，页面据此保留上一份快照', () => {
    const dir = path.dirname(dbPath());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dbPath(), 'this is not a sqlite database at all');

    const result = range();
    expect(result.available).toBe(false);
    expect(result.health.degradedCode).toBe('corrupt');
  });

  it('更高版本写过的库：停止写入，不删库重建', () => {
    const { DatabaseSync } = require_('node:sqlite') as {
      DatabaseSync: new (p: string) => { exec: (s: string) => void; close: () => void };
    };
    const dir = path.dirname(dbPath());
    fs.mkdirSync(dir, { recursive: true });
    const seed = new DatabaseSync(dbPath());
    seed.exec('CREATE TABLE usage_attempts_v99 (x TEXT)');
    seed.exec(`PRAGMA user_version = ${usageDb.USAGE_SCHEMA_VERSION + 1}`);
    seed.close();
    const before = fs.readFileSync(dbPath());

    const result = usageDb.recordUsageAttempt(fakeApp(), attempt());
    expect(result.ok).toBe(false);
    expect(result.code).toBe('schema-too-new');
    expect(usageDb.getUsageHealth().degradedCode).toBe('schema-too-new');
    expect(fs.readFileSync(dbPath())).toEqual(before);
  });

  it.skipIf(isRoot)('只读的库文件：写失败可见，且不抛出', () => {
    usageDb.recordUsageAttempt(fakeApp(), attempt());
    usageDb._internal.resetForTest();
    // WAL 与 shm 边文件也要一起只读，否则 SQLite 会直接改写它们，写入就不报错了。
    for (const suffix of ['', '-wal', '-shm']) {
      const p = `${dbPath()}${suffix}`;
      if (fs.existsSync(p)) fs.chmodSync(p, 0o444);
    }
    fs.chmodSync(path.dirname(dbPath()), 0o555);

    let thrown: unknown = null;
    let result: { ok: boolean; code?: string } = { ok: true };
    try {
      result = usageDb.recordUsageAttempt(fakeApp(), attempt({ attemptId: 'att-readonly' }));
    } catch (err) {
      thrown = err;
    }

    fs.chmodSync(path.dirname(dbPath()), 0o755);
    for (const suffix of ['', '-wal', '-shm']) {
      const p = `${dbPath()}${suffix}`;
      if (fs.existsSync(p)) fs.chmodSync(p, 0o644);
    }

    expect(thrown).toBeNull();
    expect(result.ok).toBe(false);
    expect(['readonly', 'cant-open']).toContain(result.code);
    expect(usageDb.getUsageHealth().writeFailures).toBe(1);
  });

  it.skipIf(isRoot)('上一版建的库文件是只读的：覆盖索引建不出来，历史数字照常读得到', () => {
    usageDb.recordUsageAttempt(fakeApp(), attempt({ attemptId: 'a', source: 'main' }));
    usageDb.recordUsageAttempt(fakeApp(), attempt({ attemptId: 'b', source: 'subagent', skill: 'docx' }));
    const before = range();
    usageDb._internal.resetForTest();

    const { DatabaseSync } = require_('node:sqlite') as {
      DatabaseSync: new (p: string) => {
        exec: (s: string) => void;
        prepare: (s: string) => { all: () => { name: string }[] };
        close: () => void;
      };
    };
    // 删掉覆盖索引，得到加这个索引之前的版本留下的库；再把库文件改成只读，目录保持可写。
    const older = new DatabaseSync(dbPath());
    older.exec('DROP INDEX idx_usage_range_cover');
    older.close();
    fs.chmodSync(dbPath(), 0o444);

    let after: RangeResult;
    let indexNames: string[];
    try {
      after = range();
      usageDb._internal.resetForTest();
      const probe = new DatabaseSync(dbPath());
      indexNames = probe.prepare('PRAGMA index_list(usage_attempts)').all().map((row) => row.name);
      probe.close();
    } finally {
      fs.chmodSync(dbPath(), 0o644);
    }

    // 索引确实没建成；少了这一条，下面的断言就可能是在有索引的库上通过的。
    expect(indexNames).not.toContain('idx_usage_range_cover');
    expect(after.available).toBe(true);
    expect(after.health.degradedCode).toBeNull();
    expect(after.totals).toEqual(before.totals);
    expect(after.bySource).toEqual(before.bySource);
    expect(after.byDay).toEqual(before.byDay);
  });

  it('库一时打不开：恢复之后自己接着记，不必重启', () => {
    // 在库文件的位置放一个目录，SQLite 打不开它。这个阻塞方式在 macOS 与 Windows
    // 上是同一种失败，不依赖目录权限位的语义。
    fs.mkdirSync(dbPath(), { recursive: true });

    const blocked = usageDb.recordUsageAttempt(fakeApp(), attempt({ attemptId: 'att-blocked' }));
    expect(blocked.ok).toBe(false);
    expect(usageDb.getUsageHealth().degradedCode).not.toBeNull();

    fs.rmSync(dbPath(), { recursive: true });

    // 没有重启、没有重置：下一次写入自己重新打开库。
    const recovered = usageDb.recordUsageAttempt(fakeApp(), attempt({ attemptId: 'att-after' }));
    expect(recovered).toEqual({ ok: true });
    // 停写提示跟着消失，页面上不会留下一行已经不成立的警告。
    expect(usageDb.getUsageHealth().degradedCode).toBeNull();
    expect(range().totals.attempts).toBe(1);
    // 挡住的那一条确实丢了，计数如实留着。
    expect(usageDb.getUsageHealth().writeFailures).toBe(1);
  });

  it('损坏的库不反复重试：认定之后一直停写', () => {
    const dir = path.dirname(dbPath());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dbPath(), 'not a database');

    usageDb.recordUsageAttempt(fakeApp(), attempt({ attemptId: 'a' }));
    // 把坏文件删掉也不改变本次运行的判定——损坏要由用户介入处理，
    // 不能靠"下一次写入碰巧建了个新库"把问题盖过去。
    fs.rmSync(dbPath());
    const second = usageDb.recordUsageAttempt(fakeApp(), attempt({ attemptId: 'b' }));
    expect(second.ok).toBe(false);
    expect(second.code).toBe('corrupt');
    expect(fs.existsSync(dbPath())).toBe(false);
  });

  it('连续失败累加计数，首次失败时间不被后来的覆盖', () => {
    const dir = path.dirname(dbPath());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dbPath(), 'not a database');

    usageDb.recordUsageAttempt(fakeApp(), attempt({ attemptId: 'x' }));
    const first = usageDb.getUsageHealth().firstFailureAtUtc;
    usageDb.recordUsageAttempt(fakeApp(), attempt({ attemptId: 'y' }));
    usageDb.recordUsageAttempt(fakeApp(), attempt({ attemptId: 'z' }));

    const health = usageDb.getUsageHealth();
    expect(health.writeFailures).toBe(3);
    expect(health.firstFailureAtUtc).toBe(first);
    expect(health.lastFailureAtUtc).not.toBeNull();
  });
});

describe('库结构往前走', () => {
  it('旧库缺查询列时打开就补上，已有的记录照样查得出来', () => {
    // 一个只有三列基础字段的库：相当于查询列清单变长之前建出来的库。
    const { DatabaseSync } = require_('node:sqlite') as {
      DatabaseSync: new (p: string) => {
        exec: (s: string) => void;
        prepare: (s: string) => { run: (...args: unknown[]) => void };
        close: () => void;
      };
    };
    const dir = path.dirname(dbPath());
    fs.mkdirSync(dir, { recursive: true });
    const seed = new DatabaseSync(dbPath());
    seed.exec(`
      CREATE TABLE usage_attempts (
        attempt_id TEXT PRIMARY KEY,
        revision   INTEGER NOT NULL,
        snapshot   TEXT NOT NULL
      );
      PRAGMA user_version = ${usageDb.USAGE_SCHEMA_VERSION};
    `);
    const old = attempt({ attemptId: 'att-old', skill: 'code-review' });
    seed
      .prepare('INSERT INTO usage_attempts (attempt_id, revision, snapshot) VALUES (?, ?, ?)')
      .run(old.attemptId, old.revision, JSON.stringify(old));
    seed.close();

    const result = range() as RangeResult & {
      byModel: { requestedModel: string }[];
      bySkill: { skill: string }[];
    };
    expect(result.available).toBe(true);
    expect(result.totals.attempts).toBe(1);
    expect(result.totals.inputKnownSum).toBe(2000);
    expect(result.byModel.map((m) => m.requestedModel)).toEqual(['claude-opus-5']);
    expect(result.bySkill.map((s) => s.skill)).toEqual(['code-review']);

    // 补完列之后照常写。
    expect(usageDb.recordUsageAttempt(fakeApp(), attempt({ attemptId: 'att-new' }))).toEqual({ ok: true });
    expect(range().totals.attempts).toBe(2);
  });

  it('上一版建的库没有范围查询的覆盖索引，打开时补上，汇总不变', () => {
    usageDb.recordUsageAttempt(fakeApp(), attempt({ attemptId: 'a', source: 'main' }));
    usageDb.recordUsageAttempt(fakeApp(), attempt({ attemptId: 'b', source: 'subagent', skill: 'docx' }));
    const before = range();
    usageDb._internal.resetForTest();

    const { DatabaseSync } = require_('node:sqlite') as {
      DatabaseSync: new (p: string) => {
        exec: (s: string) => void;
        prepare: (s: string) => { all: () => { name: string }[] };
        close: () => void;
      };
    };
    const indexNames = (): string[] => {
      const db = new DatabaseSync(dbPath());
      const names = db.prepare('PRAGMA index_list(usage_attempts)').all().map((row) => row.name);
      db.close();
      return names;
    };
    // 把索引删掉，得到的就是加这个索引之前的版本留下的库。
    const older = new DatabaseSync(dbPath());
    older.exec('DROP INDEX idx_usage_range_cover');
    older.close();
    expect(indexNames()).not.toContain('idx_usage_range_cover');

    const after = range();
    usageDb._internal.resetForTest();

    expect(after.available).toBe(true);
    expect(after.totals).toEqual(before.totals);
    expect(after.bySource).toEqual(before.bySource);
    expect(after.byDay).toEqual(before.byDay);
    expect(indexNames()).toContain('idx_usage_range_cover');
  });
});

describe('清除账本', () => {
  const SUFFIXES = ['', '-wal', '-shm'];

  function existingFiles(): string[] {
    return SUFFIXES.filter((suffix) => fs.existsSync(`${dbPath()}${suffix}`));
  }

  it('主库与两个边文件都删掉，磁盘上不留任何记录', () => {
    usageDb.recordUsageAttempt(fakeApp(), attempt());
    // 库还开着的时候三个文件都在；少了这一条，下面的「都删掉了」就可能是空转。
    expect(existingFiles()).toEqual(SUFFIXES);

    const result = usageDb.purgeUsageLedger(fakeApp());

    expect(result.removed).toContain(usageDb.USAGE_DB_FILENAME);
    expect(existingFiles()).toEqual([]);
  });

  it('进程异常退出后留在磁盘上的边文件也一起删掉', () => {
    usageDb.recordUsageAttempt(fakeApp(), attempt());
    // 库开着时把三个文件原样复制出来，得到的就是进程被终止那一刻磁盘上的样子：
    // 最近的记录还在 `-wal` 里，没有任何句柄会去收拾它。
    const crashedRoot = `${appDataRoot}-crashed`;
    const crashedDir = path.join(crashedRoot, path.basename(path.dirname(dbPath())));
    fs.rmSync(crashedRoot, { recursive: true, force: true });
    fs.mkdirSync(crashedDir, { recursive: true });
    for (const suffix of SUFFIXES) {
      fs.copyFileSync(`${dbPath()}${suffix}`, path.join(crashedDir, `${usageDb.USAGE_DB_FILENAME}${suffix}`));
    }
    usageDb._internal.resetForTest();
    appDataRoot = crashedRoot;
    expect(existingFiles()).toEqual(SUFFIXES);

    const result = usageDb.purgeUsageLedger(fakeApp());

    expect(result.removed.sort()).toEqual(SUFFIXES.map((s) => `${usageDb.USAGE_DB_FILENAME}${s}`).sort());
    expect(existingFiles()).toEqual([]);
  });

  it('清除之后查询是空的，统计起点也没有了', () => {
    usageDb.recordUsageAttempt(fakeApp(), attempt());
    usageDb.purgeUsageLedger(fakeApp());

    const result = range();

    expect(result.available).toBe(true);
    expect(result.totals.attempts).toBe(0);
    expect(result.statsOriginLocalDate).toBeNull();
  });

  it('清除之后照常能记，同一个 attemptId 重新算一条', () => {
    usageDb.recordUsageAttempt(fakeApp(), attempt({ revision: 9 }));
    usageDb.purgeUsageLedger(fakeApp());

    expect(usageDb.recordUsageAttempt(fakeApp(), attempt({ revision: 1 }))).toEqual({ ok: true });
    expect(range().totals.attempts).toBe(1);
  });

  it('没有账本文件时什么都不做', () => {
    expect(usageDb.purgeUsageLedger(fakeApp())).toEqual({ removed: [] });
    expect(existingFiles()).toEqual([]);
  });

  it('损坏的库也能清掉，停写状态随之解除', () => {
    fs.mkdirSync(path.dirname(dbPath()), { recursive: true });
    fs.writeFileSync(dbPath(), 'this is not a sqlite database at all');
    expect(usageDb.recordUsageAttempt(fakeApp(), attempt()).ok).toBe(false);
    expect(usageDb.getUsageHealth().degradedCode).toBe('corrupt');

    usageDb.purgeUsageLedger(fakeApp());

    expect(existingFiles()).toEqual([]);
    expect(usageDb.getUsageHealth().degradedCode).toBeNull();
    expect(usageDb.recordUsageAttempt(fakeApp(), attempt())).toEqual({ ok: true });
  });

  it('删到一半失败：抛出错误，停写状态不留在已经不存在的损坏文件上', () => {
    fs.mkdirSync(path.dirname(dbPath()), { recursive: true });
    fs.writeFileSync(dbPath(), 'this is not a sqlite database at all');
    expect(usageDb.recordUsageAttempt(fakeApp(), attempt()).ok).toBe(false);
    expect(usageDb.getUsageHealth().degradedCode).toBe('corrupt');
    // 在 `-wal` 的位置放一个非空目录：删文件的调用删不掉它，两个平台都会报错。
    fs.mkdirSync(`${dbPath()}-wal`);
    fs.writeFileSync(path.join(`${dbPath()}-wal`, 'blocker'), 'x');

    expect(() => usageDb.purgeUsageLedger(fakeApp())).toThrow();

    // 主库排在前面，已经删掉了。
    expect(fs.existsSync(dbPath())).toBe(false);
    expect(usageDb.getUsageHealth().degradedCode).toBeNull();
  });

  it('本次运行的健康计数不因清除而改变', () => {
    usageDb.recordUsageAttempt(fakeApp(), { nonsense: true });
    usageDb.purgeUsageLedger(fakeApp());

    expect(usageDb.getUsageHealth().rejectedFrames).toBe(1);
  });

  it('不是一条可以派发的命令', () => {
    usageDb.recordUsageAttempt(fakeApp(), attempt());

    for (const cmd of ['usage_purge', 'usage_purge_ledger', 'purgeUsageLedger']) {
      expect(usageDb.usageDispatch(fakeApp(), cmd, {})).toBe(usageDb.USAGE_MISS);
    }
    expect(range().totals.attempts).toBe(1);
  });

  it('除了账本模块自己，没有任何源码调用它', () => {
    const SOURCE_DIRS = ['electron', 'src', 'sidecar/src', 'scripts'];
    const SOURCE_EXTENSIONS = ['.cjs', '.mjs', '.js', '.ts', '.tsx'];
    const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'build', 'target', 'out']);

    function sourceFiles(dir: string): string[] {
      const found: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) found.push(...sourceFiles(full));
        else if (SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) found.push(full);
      }
      return found;
    }

    const mentioning = SOURCE_DIRS.flatMap((dir) => sourceFiles(path.join(REPO_ROOT, dir)))
      .filter((file) => fs.readFileSync(file, 'utf8').includes('purgeUsageLedger'))
      .map((file) => path.relative(REPO_ROOT, file).split(path.sep).join('/'))
      .sort();

    expect(mentioning).toEqual(['electron/usageDb.cjs', 'electron/usageDb.test.ts']);
  });
});

describe('命令派发', () => {
  it('不认识的命令返回哨兵，让派发链继续往下走', () => {
    expect(usageDb.usageDispatch(fakeApp(), 'notice_audit_insert', {})).toBe(usageDb.USAGE_MISS);
  });

  it('usage_record 与 usage_query_range 走同一份库', () => {
    expect(usageDb.usageDispatch(fakeApp(), 'usage_record', { attempt: attempt() })).toEqual({
      ok: true,
    });
    const result = usageDb.usageDispatch(fakeApp(), 'usage_query_range', {
      fromLocalDate: FULL_RANGE[0],
      toLocalDate: FULL_RANGE[1],
    }) as RangeResult;
    expect(result.totals.attempts).toBe(1);
  });

  it('usage_health 报得出被拒计数', () => {
    usageDb.usageDispatch(fakeApp(), 'usage_record', { attempt: { nonsense: true } });
    const health = usageDb.usageDispatch(fakeApp(), 'usage_health', {}) as {
      rejectedFrames: number;
    };
    expect(health.rejectedFrames).toBe(1);
  });
});
