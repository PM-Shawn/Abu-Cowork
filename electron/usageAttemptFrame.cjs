/**
 * 用量尝试快照的线路表示：stdout 帧格式 + 边界校验。
 *
 * 任务书：`docs/2026-09-15-usage-accounting-fix-brief.md`（期 1 第 2 步）。
 * 类型本体在 `src/core/llm/usageAccounting.ts` 的 `UsageAttempt`，两端由
 * `electron/usageAttemptFrame.contract.test.ts` 读同一份样例表保持一致。
 *
 * ## 两个不可信来源，同一道校验
 *
 * 账本有两条入口：sidecar 的 stdout 帧（本文件的 `decodeUsageFrame`）和 renderer
 * 经 IPC 发来的 `usage_record`（`usageDb.cjs` 调 `validateUsageAttempt`）。两者都是
 * 跨进程输入，都要按同一套规则校验后才允许进库。
 *
 * ## 为什么校验失败不抛到进程外
 *
 * 用户已确认的产品约束：用量保存失败必须允许继续聊天，只提示统计可能不完整
 * （任务书 U05）。sidecar 与 renderer 是独立进程，它们送来的坏数据是**运行时输入**，
 * 在 main 里因为一条坏帧崩溃会直接打断用户正在进行的回答。所以这里返回
 * `{ ok: false, reason }`，由调用方累加健康计数并让页面显示一行提示。
 * 我方代码自身的用法错误（例如调用时少传参数）仍然按仓库惯例就地抛出。
 *
 * ## 白名单构造
 *
 * 校验通过后返回的是**逐字段重建**的新对象，线路上多出来的字段一律丢弃。
 * 这条是 U06 的隐私守卫：账本只存请求身份、路由、时间、用量与结果，
 * 提示词、回答、图片、key 不得经由"多带一个字段"的方式混进来。
 */
'use strict';

/**
 * 帧标记，帧的第一个顶层键。
 *
 * sidecar 的 stdout 同时承载 JSON-RPC，而 RPC 载荷里可以出现任意文本
 * （模型回答、工具结果），正文里含有这个串的普通行很常见。判据分两步：
 * 行以 `USAGE_FRAME_PREFIX` 开头，解析后标记确实是顶层键。任何一步不满足，
 * 这一行照常交给普通消息通道。
 */
const USAGE_FRAME_MARKER = '__abu_usage__';

/** 帧由 `JSON.stringify({ [标记]: 版本, attempt })` 生成，标记恒为第一个键。 */
const USAGE_FRAME_PREFIX = `{"${USAGE_FRAME_MARKER}":`;

/** 单帧上限。快照是一组定长标量字段，正常在 2KB 以内；超限直接拒绝，不解析。 */
const MAX_FRAME_CHARS = 16 * 1024;

/** 单个字符串字段上限，避免把超长串当身份写进账本。 */
const MAX_ID_CHARS = 200;
const MAX_TZ_CHARS = 100;
const MAX_INVALID_FIELDS = 32;
const MAX_INVALID_FIELD_CHARS = 100;

const PROTOCOLS = new Set(['anthropic', 'openai-compatible']);
const SOURCES = new Set(['main', 'subagent', 'compaction', 'memory', 'skill', 'diagnostic', 'other']);
const OUTCOMES = new Set(['running', 'succeeded', 'failed', 'cancelled', 'interrupted']);
const EVIDENCE = new Set(['none', 'partial', 'final']);

/** 六个计数字段，顺序与 `AccountingUsage` 一致。 */
const COUNT_FIELDS = [
  'inputTotal',
  'uncachedInput',
  'cacheRead',
  'cacheWrite',
  'outputTotal',
  'reasoningOutput',
];

const SCHEMA_VERSION = 1;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function reject(reason) {
  return { ok: false, reason };
}

/** 非空字符串且不超长。 */
function readId(value, max) {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > max) return null;
  return value;
}

/** 非空字符串或 `null`；`undefined` 一律视为 `null`。 */
function readNullableId(value, max) {
  if (value === null || value === undefined) return { ok: true, value: null };
  const id = readId(value, max);
  return id === null ? { ok: false } : { ok: true, value: id };
}

/** 安全非负整数。 */
function isCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * 计数字段：`null` 是未知，数字必须是安全非负整数。
 *
 * 归一化层（`usageAccounting.ts`）已经把不可信的线路值转成 `null` 并把字段名记进
 * `invalidFields`。这里再挡一道，是因为帧可能不是由那一层产生的——跨进程输入不能
 * 依赖"对端已经处理过"。
 */
function readCount(value) {
  if (value === null || value === undefined) return { ok: true, value: null };
  return isCount(value) ? { ok: true, value } : { ok: false };
}

const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 校验并逐字段重建一份用量尝试快照。
 *
 * @param {unknown} raw 跨进程送来的对象
 * @returns {{ ok: true, attempt: object } | { ok: false, reason: string }}
 *   `reason` 是稳定错误码（形如 `field:localDate`），只含字段名不含字段值——
 *   它会进健康计数与诊断包，不能把用户内容带出去。
 */
function validateUsageAttempt(raw) {
  if (!isRecord(raw)) return reject('not-an-object');
  if (raw.schemaVersion !== SCHEMA_VERSION) return reject('field:schemaVersion');

  const attemptId = readId(raw.attemptId, MAX_ID_CHARS);
  if (attemptId === null) return reject('field:attemptId');

  const logicalCallId = readId(raw.logicalCallId, MAX_ID_CHARS);
  if (logicalCallId === null) return reject('field:logicalCallId');

  if (!isCount(raw.revision)) return reject('field:revision');

  const providerInstanceId = readId(raw.providerInstanceId, MAX_ID_CHARS);
  if (providerInstanceId === null) return reject('field:providerInstanceId');

  if (typeof raw.protocol !== 'string' || !PROTOCOLS.has(raw.protocol)) return reject('field:protocol');

  const requestedModel = readId(raw.requestedModel, MAX_ID_CHARS);
  if (requestedModel === null) return reject('field:requestedModel');

  const servedModel = readNullableId(raw.servedModel, MAX_ID_CHARS);
  if (!servedModel.ok) return reject('field:servedModel');

  if (typeof raw.source !== 'string' || !SOURCES.has(raw.source)) return reject('field:source');

  const conversationId = readNullableId(raw.conversationId, MAX_ID_CHARS);
  if (!conversationId.ok) return reject('field:conversationId');

  const skill = readNullableId(raw.skill, MAX_ID_CHARS);
  if (!skill.ok) return reject('field:skill');

  if (!isCount(raw.startedAtUtc) || raw.startedAtUtc === 0) return reject('field:startedAtUtc');

  if (typeof raw.localDate !== 'string' || !LOCAL_DATE_RE.test(raw.localDate)) {
    return reject('field:localDate');
  }

  const tzId = readId(raw.tzId, MAX_TZ_CHARS);
  if (tzId === null) return reject('field:tzId');

  // IANA 习惯符号，UTC+8 为 +480（见 `localCalendarParts`）。现实区间是
  // [-720, +840]，这里放宽到整日以免为历史时区数据库的边角料误伤真实记录。
  if (!Number.isSafeInteger(raw.offsetMinutes) || Math.abs(raw.offsetMinutes) > 1440) {
    return reject('field:offsetMinutes');
  }

  let endedAtUtc = null;
  if (raw.endedAtUtc !== null && raw.endedAtUtc !== undefined) {
    if (!isCount(raw.endedAtUtc) || raw.endedAtUtc === 0) return reject('field:endedAtUtc');
    endedAtUtc = raw.endedAtUtc;
  }

  if (typeof raw.outcome !== 'string' || !OUTCOMES.has(raw.outcome)) return reject('field:outcome');

  if (!isRecord(raw.usage)) return reject('field:usage');
  const usage = {};
  for (const field of COUNT_FIELDS) {
    const read = readCount(raw.usage[field]);
    if (!read.ok) return reject(`field:usage.${field}`);
    usage[field] = read.value;
  }
  if (typeof raw.usage.evidence !== 'string' || !EVIDENCE.has(raw.usage.evidence)) {
    return reject('field:usage.evidence');
  }
  usage.evidence = raw.usage.evidence;

  const rawInvalid = raw.usage.invalidFields;
  if (rawInvalid !== undefined && !Array.isArray(rawInvalid)) return reject('field:usage.invalidFields');
  const invalidFields = [];
  for (const name of rawInvalid ?? []) {
    if (typeof name !== 'string' || name.length === 0 || name.length > MAX_INVALID_FIELD_CHARS) {
      return reject('field:usage.invalidFields');
    }
    invalidFields.push(name);
  }
  if (invalidFields.length > MAX_INVALID_FIELDS) return reject('field:usage.invalidFields');
  usage.invalidFields = invalidFields;

  return {
    ok: true,
    attempt: {
      schemaVersion: SCHEMA_VERSION,
      attemptId,
      logicalCallId,
      revision: raw.revision,
      providerInstanceId,
      protocol: raw.protocol,
      requestedModel,
      servedModel: servedModel.value,
      source: raw.source,
      conversationId: conversationId.value,
      skill: skill.value,
      startedAtUtc: raw.startedAtUtc,
      localDate: raw.localDate,
      tzId,
      offsetMinutes: raw.offsetMinutes,
      endedAtUtc,
      outcome: raw.outcome,
      usage,
    },
  };
}

/**
 * 把一份快照编成一行 stdout 帧（不含换行符）。
 *
 * 主进程一侧的测试用它造帧；生产端的编码器在 `sidecar/src/usageFrame.ts`，两者由
 * 契约测试保持一致。编码前不校验：送进来的形状错误是我方代码的用法错误，
 * 应当在调用的那一侧就地暴露。
 */
function encodeUsageFrame(attempt) {
  return JSON.stringify({ [USAGE_FRAME_MARKER]: SCHEMA_VERSION, attempt });
}

/**
 * 解析一行 stdout。
 *
 * @returns {{ kind: 'not-a-frame' } | { kind: 'frame', attempt: object } | { kind: 'rejected', reason: string }}
 *   - `not-a-frame`：这行不是用量帧，调用方必须照常把它投进普通消息通道。
 *     JSON-RPC 载荷里可以出现任意文本，含有标记串的普通行走的正是这一支。
 *   - `rejected`：确实是用量帧，但内容不合法。调用方吞掉该行并累加计数——
 *     已经声明自己是用量帧的行不应再冒充 RPC 消息发给 renderer。
 */
function decodeUsageFrame(line) {
  if (typeof line !== 'string') return { kind: 'not-a-frame' };
  // 先看长度、再看开头，两步都是常数时间。sidecar 的事件行可以有几 MB，
  // 对每一行做全文查找是白费的。
  if (line.length > MAX_FRAME_CHARS) return { kind: 'not-a-frame' };
  if (!line.startsWith(USAGE_FRAME_PREFIX)) return { kind: 'not-a-frame' };

  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { kind: 'not-a-frame' };
  }
  if (!isRecord(parsed)) return { kind: 'not-a-frame' };
  // 顶层键才算数：其余的行照常交给普通消息通道。
  if (!Object.prototype.hasOwnProperty.call(parsed, USAGE_FRAME_MARKER)) {
    return { kind: 'not-a-frame' };
  }
  if (parsed[USAGE_FRAME_MARKER] !== SCHEMA_VERSION) {
    return { kind: 'rejected', reason: 'frame-version' };
  }

  const validated = validateUsageAttempt(parsed.attempt);
  if (!validated.ok) return { kind: 'rejected', reason: validated.reason };
  return { kind: 'frame', attempt: validated.attempt };
}

module.exports = {
  USAGE_FRAME_MARKER,
  USAGE_FRAME_PREFIX,
  USAGE_ATTEMPT_SCHEMA_VERSION: SCHEMA_VERSION,
  MAX_FRAME_CHARS,
  validateUsageAttempt,
  encodeUsageFrame,
  decodeUsageFrame,
};
