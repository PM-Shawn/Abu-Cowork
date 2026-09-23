/**
 * 用量账本：main 进程独占的 `usage.sqlite`。
 *
 * 任务书：`docs/2026-09-15-usage-accounting-fix-brief.md`（期 1 第 2 步）。
 * 沿用 `catalogDb.cjs` / `noticeDb.cjs` 已在用的 `node:sqlite`（`DatabaseSync`），
 * 不引入新的 native 依赖。
 *
 * ## 一条 SQL 顶掉整套确认协议
 *
 * 写入只有一句 `INSERT ... ON CONFLICT ... WHERE excluded.revision > revision`。
 * 这一句同时给出四件事：同一条重放多少次都只有一行、`revision` 单调、旧快照不会
 * 覆盖新快照、乱序到达安全。因为这四件事由 SQL 自身保证，**生产者不需要知道写没写成**，
 * 重发无害——所以没有 outbox、没有内存补存队列、没有确认往返，也没有
 * 「内存中 / 生产者待存 / 主进程已存」这样的状态机。
 *
 * ## 写失败就是写失败
 *
 * 失败时累加计数、记下首末时间与稳定错误码，随查询结果返回，页面显示一行
 * （任务书 U05）。不承诺补存、不承诺跨重启找回。健康计数只描述本次运行：
 * 写不进去的时候，"写不进去"这件事同样写不进账本，这是这个设计诚实的代价。
 *
 * ## 账本是权威数据
 *
 * 与 `catalogDb.cjs:11` 明确声明可丢弃的 catalog 投影不同，本库是独立事实源。
 * 遇到更高的 schema 版本或损坏时**停止写入并上报**，绝不删库重建。
 *
 * ## 生成列
 *
 * 快照整体以 JSON 存在 `snapshot` 列，查询要用的字段由 SQLite 的 VIRTUAL 生成列
 * （`GENERATED ALWAYS AS (json_extract(...)) VIRTUAL`）派生并建索引。写入语句因此
 * 保持三个占位符不变，日期范围查询与各种分组又能走索引，不必逐行解析 JSON。
 *
 * 选 VIRTUAL 是为了库结构能往前走：SQLite 允许用 `ALTER TABLE ADD COLUMN` 增加
 * VIRTUAL 生成列，STORED 的不允许。以后要多查一个字段，往 `QUERY_COLUMNS` 里加一行，
 * 打开库时缺哪一列就补哪一列，快照本身一个字节都不用改写。
 *
 * ## 耐久级别
 *
 * WAL 加 `synchronous = NORMAL`，与同进程的 `noticeDb.cjs`、`catalogDb.cjs` 一致。
 * 已提交的事务在进程崩溃后仍然在；只有操作系统崩溃或断电可能丢掉最后几次提交。
 * 这与上面「不承诺找回」的容忍度相称，也让每次写入不必在主线程上等一次设备刷盘——
 * 写入发生在排空 sidecar stdout 的同一个处理函数里，它慢了，回答就跟着卡。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { abuAppDataDir } = require('./appEnv.cjs');
const { validateUsageAttempt } = require('./usageAttemptFrame.cjs');

/** 非用量命令的哨兵，与 `NOTICE_MISS` / `CATALOG_MISS` 同款。 */
const USAGE_MISS = Symbol('usage-dispatch-miss');

/** 库结构版本，存在 `PRAGMA user_version`。 */
const SCHEMA_VERSION = 1;

const DB_FILENAME = 'usage.sqlite';

/**
 * 稳定错误码：进健康计数、进诊断包、由 renderer 映射成用户看得懂的一句话。
 * 只含分类，不含路径与用户内容。
 */
const ERROR_CODES = {
  readonly: 'readonly',
  corrupt: 'corrupt',
  cantOpen: 'cant-open',
  io: 'io',
  diskFull: 'disk-full',
  busy: 'busy',
  schemaTooNew: 'schema-too-new',
  invalidAttempt: 'invalid-attempt',
};

/** SQLite 主结果码 → 稳定错误码。扩展码取低 8 位即为主码。 */
function errorCodeOf(err) {
  const primary = typeof err?.errcode === 'number' ? err.errcode & 0xff : null;
  switch (primary) {
    case 5:
      return ERROR_CODES.busy;
    case 8:
      return ERROR_CODES.readonly;
    case 10:
      return ERROR_CODES.io;
    case 11:
    case 26:
      return ERROR_CODES.corrupt;
    case 13:
      return ERROR_CODES.diskFull;
    case 14:
      return ERROR_CODES.cantOpen;
    default:
      return primary === null ? 'unknown' : `sqlite-${primary}`;
  }
}

// ── 进程内状态 ──────────────────────────────────────────────────────────

/**
 * @type {{
 *   db: import('node:sqlite').DatabaseSync,
 *   dbPath: string,
 *   upsert: import('node:sqlite').StatementSync,
 * } | null}
 */
let dbHandle = null;

/**
 * 打不开或版本不符时的停写原因，正常为 `null`。
 * @type {string | null}
 */
let degradedCode = null;

/**
 * 这两种在本次运行里不会自行好转：库损坏需要用户介入，版本过高要等用户装回新版本。
 * 认定之后不再重试打开。
 *
 * 其余原因（磁盘满、临时的 IO 错误、目录一时不可写）是会过去的，每次写入都重新试一次：
 * 试一次就是一个文件系统调用，而一次开机时的短暂故障不应该让这一整次运行都记不上账。
 */
const LATCHING_CODES = new Set([ERROR_CODES.corrupt, ERROR_CODES.schemaTooNew]);

const health = {
  writeFailures: 0,
  rejectedFrames: 0,
  firstFailureAtUtc: null,
  lastFailureAtUtc: null,
  lastErrorCode: null,
};

function noteFailure(code, nowUtc) {
  health.writeFailures += 1;
  health.lastErrorCode = code;
  health.lastFailureAtUtc = nowUtc;
  if (health.firstFailureAtUtc === null) health.firstFailureAtUtc = nowUtc;
}

/** 帧被拒：内容不合法，没进库。与写失败分开计数，两者原因不同。 */
function noteRejectedFrame(reason, nowUtc = Date.now()) {
  health.rejectedFrames += 1;
  health.lastErrorCode = `${ERROR_CODES.invalidAttempt}:${reason}`;
  health.lastFailureAtUtc = nowUtc;
  if (health.firstFailureAtUtc === null) health.firstFailureAtUtc = nowUtc;
}

function getUsageHealth() {
  return {
    writeFailures: health.writeFailures,
    rejectedFrames: health.rejectedFrames,
    firstFailureAtUtc: health.firstFailureAtUtc,
    lastFailureAtUtc: health.lastFailureAtUtc,
    lastErrorCode: health.lastErrorCode,
    degradedCode,
  };
}

// ── 库结构 ──────────────────────────────────────────────────────────────

/**
 * 生成列全部取自 `snapshot`。`json_extract` 对 JSON null 返回 SQL NULL，
 * 于是"未知"在 SQL 里天然还是 NULL，`SUM()` 跳过它、`x IS NULL` 数得出它——
 * 这正是 U03 要的「已知用量 + 受影响尝试数」两个数字。
 */
const QUERY_COLUMNS = [
  { name: 'local_date', type: 'TEXT', path: '$.localDate' },
  { name: 'source', type: 'TEXT', path: '$.source' },
  { name: 'conversation_id', type: 'TEXT', path: '$.conversationId' },
  { name: 'requested_model', type: 'TEXT', path: '$.requestedModel' },
  { name: 'skill', type: 'TEXT', path: '$.skill' },
  { name: 'evidence', type: 'TEXT', path: '$.usage.evidence' },
  { name: 'input_total', type: 'INTEGER', path: '$.usage.inputTotal' },
  { name: 'uncached_input', type: 'INTEGER', path: '$.usage.uncachedInput' },
  { name: 'cache_read', type: 'INTEGER', path: '$.usage.cacheRead' },
  { name: 'cache_write', type: 'INTEGER', path: '$.usage.cacheWrite' },
  { name: 'output_total', type: 'INTEGER', path: '$.usage.outputTotal' },
  { name: 'reasoning_output', type: 'INTEGER', path: '$.usage.reasoningOutput' },
];

function initSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS usage_attempts (
        attempt_id TEXT PRIMARY KEY,
        revision   INTEGER NOT NULL,
        snapshot   TEXT NOT NULL
    );
  `);

  // 缺哪一列补哪一列。`table_xinfo` 才列得出生成列，`table_info` 会把它们藏起来。
  const present = new Set(
    db.prepare('PRAGMA table_xinfo(usage_attempts)').all().map((row) => row.name),
  );
  for (const column of QUERY_COLUMNS) {
    if (present.has(column.name)) continue;
    db.exec(
      `ALTER TABLE usage_attempts ADD COLUMN ${column.name} ${column.type} `
      + `GENERATED ALWAYS AS (json_extract(snapshot, '${column.path}')) VIRTUAL`,
    );
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_usage_local_date   ON usage_attempts(local_date);
    CREATE INDEX IF NOT EXISTS idx_usage_conversation ON usage_attempts(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_usage_source_date  ON usage_attempts(source, local_date);
    CREATE INDEX IF NOT EXISTS idx_usage_model_date   ON usage_attempts(requested_model, local_date);
    CREATE INDEX IF NOT EXISTS idx_usage_skill_date   ON usage_attempts(skill, local_date);
  `);
}

function readUserVersion(db) {
  const row = db.prepare('PRAGMA user_version').get();
  return Number(row?.user_version ?? 0);
}

/**
 * 打开账本。失败或版本不符时进入停写状态并返回 `null`，调用方据此累加计数。
 * @param {import('electron').App} app
 */
function getDb(app) {
  if (dbHandle) return dbHandle.db;
  if (degradedCode && LATCHING_CODES.has(degradedCode)) return null;

  let db;
  try {
    const dir = abuAppDataDir(app);
    fs.mkdirSync(dir, { recursive: true });
    const dbPath = path.join(dir, DB_FILENAME);
    db = new DatabaseSync(dbPath);

    const found = readUserVersion(db);
    if (found > SCHEMA_VERSION) {
      // 用户装回了旧版本。新版本写的结构可能与这里的理解不同，继续写会产出
      // 说不清的数字，继续读会给出看似正常其实错位的汇总——两样都不做。
      db.close();
      degradedCode = ERROR_CODES.schemaTooNew;
      return null;
    }

    initSchema(db);
    if (found !== SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);

    // 写入语句只编译一次：每次模型请求要写三四份快照，逐次重新编译是白费的。
    dbHandle = { db, dbPath, upsert: db.prepare(UPSERT_SQL) };
    // 打开成功就清掉上一次的停写原因：短暂故障过去之后，页面上的那行提示
    // 也应该跟着消失，不必等用户重启。
    degradedCode = null;
    return db;
  } catch (err) {
    try {
      db?.close();
    } catch {
      /* 打开阶段就失败的句柄，关闭再失败没有额外信息 */
    }
    degradedCode = errorCodeOf(err);
    return null;
  }
}

// ── 写入 ────────────────────────────────────────────────────────────────

/**
 * 幂等写入。`revision` 不比已有的高就什么都不做——乱序到达、重放、旧快照迟到
 * 全部由这一句消解。
 */
const UPSERT_SQL = `
  INSERT INTO usage_attempts (attempt_id, revision, snapshot)
  VALUES (?, ?, ?)
  ON CONFLICT(attempt_id) DO UPDATE SET
    revision = excluded.revision,
    snapshot = excluded.snapshot
  WHERE excluded.revision > usage_attempts.revision
`;

/**
 * 写入一份**已经过校验**的快照。
 *
 * @returns {{ ok: true } | { ok: false, code: string }}
 *   绝不抛出：调用它的是模型请求路径，用量写失败不得打断正在进行的回答，
 *   也不得额外触发任何模型重试（任务书 U05）。
 */
function recordValidatedAttempt(app, attempt, nowUtc = Date.now()) {
  const db = getDb(app);
  if (!db) {
    const code = degradedCode ?? 'unknown';
    noteFailure(code, nowUtc);
    return { ok: false, code };
  }
  try {
    dbHandle.upsert.run(attempt.attemptId, attempt.revision, JSON.stringify(attempt));
    return { ok: true };
  } catch (err) {
    const code = errorCodeOf(err);
    noteFailure(code, nowUtc);
    return { ok: false, code };
  }
}

/** 校验后写入。跨进程入口（renderer IPC、sidecar 帧）都走这一支。 */
function recordUsageAttempt(app, raw, nowUtc = Date.now()) {
  const validated = validateUsageAttempt(raw);
  if (!validated.ok) {
    noteRejectedFrame(validated.reason, nowUtc);
    return { ok: false, code: `${ERROR_CODES.invalidAttempt}:${validated.reason}` };
  }
  return recordValidatedAttempt(app, validated.attempt, nowUtc);
}

// ── 查询 ────────────────────────────────────────────────────────────────

/**
 * 汇总表达式。三组数字对应 U03 的三件事：
 *  - `*_known_sum`：只累加已知值，未知不参与
 *  - `*_unknown_attempts`：有多少次尝试在这个字段上是未知的
 *  - `cache_comparable_attempts`：缓存命中率只能在缓存读与输入总量都已知时计算
 *
 * 命中率的分子分母都只取可比的那些尝试（`*_comparable_sum`）。拿全量的缓存读
 * 除以全量的输入总量，会把"没上报缓存的那些请求"算进分母，命中率被系统性压低。
 */
const AGGREGATE_COLUMNS = `
  COUNT(*)                                                   AS attempts,
  SUM(input_total)                                           AS input_known_sum,
  SUM(input_total IS NULL)                                   AS input_unknown_attempts,
  SUM(output_total)                                          AS output_known_sum,
  SUM(output_total IS NULL)                                  AS output_unknown_attempts,
  SUM(cache_read)                                            AS cache_read_known_sum,
  SUM(cache_write)                                           AS cache_write_known_sum,
  SUM(reasoning_output)                                      AS reasoning_known_sum,
  SUM(cache_read IS NOT NULL AND input_total IS NOT NULL)    AS cache_comparable_attempts,
  SUM(CASE WHEN cache_read IS NOT NULL AND input_total IS NOT NULL THEN cache_read END)
                                                             AS cache_read_comparable_sum,
  SUM(CASE WHEN cache_read IS NOT NULL AND input_total IS NOT NULL THEN input_total END)
                                                             AS input_comparable_sum,
  SUM(evidence <> 'final')                                   AS incomplete_attempts
`;

function mapAggregateRow(r) {
  return {
    attempts: r.attempts ?? 0,
    inputKnownSum: r.input_known_sum ?? 0,
    inputUnknownAttempts: r.input_unknown_attempts ?? 0,
    outputKnownSum: r.output_known_sum ?? 0,
    outputUnknownAttempts: r.output_unknown_attempts ?? 0,
    cacheReadKnownSum: r.cache_read_known_sum ?? 0,
    cacheWriteKnownSum: r.cache_write_known_sum ?? 0,
    reasoningKnownSum: r.reasoning_known_sum ?? 0,
    cacheComparableAttempts: r.cache_comparable_attempts ?? 0,
    cacheReadComparableSum: r.cache_read_comparable_sum ?? 0,
    inputComparableSum: r.input_comparable_sum ?? 0,
    incompleteAttempts: r.incomplete_attempts ?? 0,
  };
}

/** 空汇总：停写状态下页面仍要能渲染，不能因为没有库就抛错。 */
function emptyAggregate() {
  return mapAggregateRow({});
}

/**
 * 一次调用给出页面需要的全部数字：逐日、按来源、范围合计、统计起点、健康计数。
 * 分多次取会让页面出现"总数已更新、分日还没更新"的中间态。
 */
function queryRange(app, fromLocalDate, toLocalDate) {
  const db = getDb(app);
  if (!db) {
    return {
      available: false,
      byDay: [],
      bySource: [],
      byModel: [],
      bySkill: [],
      totals: emptyAggregate(),
      statsOriginLocalDate: null,
      health: getUsageHealth(),
    };
  }
  try {
    const byDay = db
      .prepare(
        `SELECT local_date, ${AGGREGATE_COLUMNS}
         FROM usage_attempts
         WHERE local_date >= ? AND local_date <= ?
         GROUP BY local_date
         ORDER BY local_date`,
      )
      .all(fromLocalDate, toLocalDate)
      .map((r) => ({ localDate: r.local_date, ...mapAggregateRow(r) }));

    const bySource = db
      .prepare(
        `SELECT source, ${AGGREGATE_COLUMNS}
         FROM usage_attempts
         WHERE local_date >= ? AND local_date <= ?
         GROUP BY source
         ORDER BY source`,
      )
      .all(fromLocalDate, toLocalDate)
      .map((r) => ({ source: r.source, ...mapAggregateRow(r) }));

    const byModel = db
      .prepare(
        `SELECT requested_model, ${AGGREGATE_COLUMNS}
         FROM usage_attempts
         WHERE local_date >= ? AND local_date <= ?
         GROUP BY requested_model
         ORDER BY requested_model`,
      )
      .all(fromLocalDate, toLocalDate)
      .map((r) => ({ requestedModel: r.requested_model, ...mapAggregateRow(r) }));

    // 技能为 null 的尝试不属于任何技能，不进这一组。
    const bySkill = db
      .prepare(
        `SELECT skill, ${AGGREGATE_COLUMNS}
         FROM usage_attempts
         WHERE local_date >= ? AND local_date <= ? AND skill IS NOT NULL
         GROUP BY skill
         ORDER BY skill`,
      )
      .all(fromLocalDate, toLocalDate)
      .map((r) => ({ skill: r.skill, ...mapAggregateRow(r) }));

    const totalsRow = db
      .prepare(
        `SELECT ${AGGREGATE_COLUMNS}
         FROM usage_attempts
         WHERE local_date >= ? AND local_date <= ?`,
      )
      .get(fromLocalDate, toLocalDate);

    // 统计起点取全表最小日期，与查询范围无关：页面要说明的是
    // "这份统计从哪天开始"（任务书 U01）。
    const originRow = db.prepare('SELECT MIN(local_date) AS origin FROM usage_attempts').get();

    return {
      available: true,
      byDay,
      bySource,
      byModel,
      bySkill,
      totals: mapAggregateRow(totalsRow ?? {}),
      statsOriginLocalDate: originRow?.origin ?? null,
      health: getUsageHealth(),
    };
  } catch (err) {
    const code = errorCodeOf(err);
    // 查询失败不清零：页面保留上一份快照并标注暂未更新（任务书 U05）。
    return {
      available: false,
      byDay: [],
      bySource: [],
      byModel: [],
      bySkill: [],
      totals: emptyAggregate(),
      statsOriginLocalDate: null,
      health: { ...getUsageHealth(), lastErrorCode: code },
    };
  }
}

/** 会话小标签用：单个会话的合计。 */
function queryConversation(app, conversationId) {
  const db = getDb(app);
  if (!db) return { available: false, totals: emptyAggregate() };
  try {
    const row = db
      .prepare(`SELECT ${AGGREGATE_COLUMNS} FROM usage_attempts WHERE conversation_id = ?`)
      .get(conversationId);
    return { available: true, totals: mapAggregateRow(row ?? {}) };
  } catch {
    return { available: false, totals: emptyAggregate() };
  }
}

// ── 派发 ────────────────────────────────────────────────────────────────

/**
 * renderer 一侧的通道。sidecar 在跑时用量走 stdout 帧（见 `mcpBridge.cjs`）；
 * renderer 自己发起的请求和用量页的读取走这里。
 */
function usageDispatch(app, cmd, args) {
  const a = args || {};
  switch (cmd) {
    case 'usage_record':
      return recordUsageAttempt(app, a.attempt);

    case 'usage_query_range':
      return queryRange(app, a.fromLocalDate, a.toLocalDate);

    case 'usage_query_conversation':
      return queryConversation(app, a.conversationId);

    case 'usage_health':
      return getUsageHealth();

    default:
      return USAGE_MISS;
  }
}

/** 仅供测试：关闭句柄并清空进程内状态。 */
function resetForTest() {
  if (dbHandle) {
    try {
      dbHandle.db.close();
    } catch {
      /* 已经关掉或库已损坏时无须再处理 */
    }
  }
  dbHandle = null;
  degradedCode = null;
  health.writeFailures = 0;
  health.rejectedFrames = 0;
  health.firstFailureAtUtc = null;
  health.lastFailureAtUtc = null;
  health.lastErrorCode = null;
}

module.exports = {
  usageDispatch,
  USAGE_MISS,
  USAGE_DB_FILENAME: DB_FILENAME,
  USAGE_SCHEMA_VERSION: SCHEMA_VERSION,
  ERROR_CODES,
  recordUsageAttempt,
  recordValidatedAttempt,
  noteRejectedFrame,
  getUsageHealth,
  _internal: {
    getDb,
    queryRange,
    queryConversation,
    errorCodeOf,
    resetForTest,
  },
};
