/**
 * 用量记账的口径本体（纯函数，无 I/O、无 store、无 adapter 依赖）。
 *
 * 任务书：`docs/2026-09-15-usage-accounting-fix-brief.md`（期 1 第 1 步「口径冻结」）。
 * 这一层只回答"provider 报上来的数字该怎么理解"，不回答"记在哪"和"谁来调"——
 * 存储是期 1 第 2 步，接入 adapter 是第 3 步。
 *
 * ## 为什么与 `TokenUsage` 并存
 *
 * `src/types/index.ts` 的 `TokenUsage` 被上下文预算、token 估算、计价和多处 UI 使用，
 * 而它的 `inputTokens` 语义跨 provider 不一致（Anthropic 的 `input_tokens` 不含缓存，
 * OpenAI 的 `prompt_tokens` 含缓存）。本轮不动它，以免顺带改变计价或上下文预算；
 * 代价与后续迁移见任务书「债务与后续」。
 *
 * ## 三条不变量
 *
 * 1. **null 是未知，0 是已知为零。** 任何"缺字段就补 0"的写法都会把未上报说成没消耗。
 * 2. **provider 的流内用量是累计快照，不是增量。** 同一次尝试的后续事件是修订，
 *    绝不相加；缺字段的后续事件不得覆盖已知字段。
 * 3. **矛盾字段既不钳位也不放行。** 实读 pi-ai 会把算出来的负数 clamp 到 0
 *    （于是 100/缓存200 得出"总计 250"），DSH 则让它变成 -100。两种都会把修剪或
 *    溢出后的数当成可信计数。这里一律判为未知并记下字段名。
 */

/** 一次尝试的来源。页面按三类展示：主对话（main）/ 子代理（subagent）/ 系统辅助（其余）。 */
export type UsageSource =
  | 'main'
  | 'subagent'
  | 'compaction'
  | 'memory'
  | 'skill'
  | 'diagnostic'
  | 'other';

/** 采集边界所在的线路协议——**不是**模型厂商。企业网关上的 Claude 走 openai-compatible。 */
export type UsageProtocol = 'anthropic' | 'openai-compatible';

/**
 * 用量证据强度。它描述的是"这组数字是不是最终结算值"，与请求成功/失败无关：
 * 成功、失败、取消本身都不是完整性证据。
 *
 * - `none`   provider 一个用量字段都没给
 * - `partial` 只拿到流内累计快照（例如只有 message_start，之后连接被切）
 * - `final`  拿到了该 provider 的最终结算事件
 */
export type UsageEvidence = 'none' | 'partial' | 'final';

/**
 * 归一化后的用量。六个计数字段一律 `number | null`。
 *
 * 语义固定为：
 * - `inputTotal` = 这次请求的输入总量（**含**缓存读与缓存写）
 * - `uncachedInput` + `cacheRead` + `cacheWrite` = `inputTotal`（各项已知时）
 * - `outputTotal` **含** `reasoningOutput`；推理是其中子项，展示时不得再加一次
 */
export interface AccountingUsage {
  inputTotal: number | null;
  uncachedInput: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  outputTotal: number | null;
  reasoningOutput: number | null;
  evidence: UsageEvidence;
  /**
   * 被判为不可信而丢弃的线路字段名（非有限、非整数、负数、超出安全整数，
   * 或与其它字段矛盾的推导结果）。
   *
   * 这不是任务书里砍掉的 per-field `validationState`（每个字段一个状态枚举）——
   * 那是把完整性重复存一遍。这里只是一串字段名，U03 的"非法字段进入不完整计数"
   * 需要它，诊断包要靠它说清是哪个网关在乱报。
   */
  invalidFields: string[];
}

export function emptyAccountingUsage(): AccountingUsage {
  return {
    inputTotal: null,
    uncachedInput: null,
    cacheRead: null,
    cacheWrite: null,
    outputTotal: null,
    reasoningOutput: null,
    evidence: 'none',
    invalidFields: [],
  };
}

/** 一次尝试的完整快照。`revision` 单调递增，同 `attemptId` 的后来者覆盖先来者。 */
export interface UsageAttempt {
  schemaVersion: 1;
  attemptId: string;
  /** 一次逻辑调用（含其重试）的 ID，用于把同一次调用的多次尝试归到一起。 */
  logicalCallId: string;
  revision: number;
  providerInstanceId: string;
  protocol: UsageProtocol;
  requestedModel: string;
  /** provider 实际服务的模型，未知为 null（不回填成 requestedModel）。 */
  servedModel: string | null;
  source: UsageSource;
  conversationId: string | null;
  skill: string | null;
  startedAtUtc: number;
  /** 请求开始时的**本地**日历日，`YYYY-MM-DD`。跨午夜完成仍归开始日。 */
  localDate: string;
  tzId: string;
  /** 见 `localCalendarParts`：IANA 习惯符号，UTC+8 为 +480。 */
  offsetMinutes: number;
  endedAtUtc: number | null;
  outcome: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  usage: AccountingUsage;
}

/**
 * 请求开始时的本地日历归属。
 *
 * **符号约定：IANA 习惯，UTC+8 → `+480`。** 注意这与 JS 的
 * `Date.prototype.getTimezoneOffset()` 正好相反（它对 UTC+8 返回 -480），所以这里显式取负。
 * 符号在协议层固定下来：`offsetMinutes` 只看名字无法判断方向，
 * 两套惯例混用会让跨端诊断和"负 offset"用例全部产生歧义。
 *
 * 本地日期取自真实日历字段（`getFullYear/getMonth/getDate`），不经 UTC 折算：
 * 北京时间凌晨的一次请求，UTC 日历上还是前一天。
 */
export function localCalendarParts(at: Date): {
  localDate: string;
  tzId: string;
  offsetMinutes: number;
} {
  return {
    localDate: localDateOf(at),
    tzId: resolveTimeZoneId(),
    offsetMinutes: -at.getTimezoneOffset(),
  };
}

/** 时区名取不到时的占位值。 */
export const UNKNOWN_TIME_ZONE = 'unknown';

/**
 * 本机的 IANA 时区名。
 *
 * 环境变量 `TZ` 写成运行时认不出的值时，`resolvedOptions().timeZone` 是 `undefined`。
 * 账本的入口校验要求 `tzId` 是非空字符串，缺了它每一条用量都会被拒绝。
 * 日历归属靠的是 `localDate` 与 `offsetMinutes`，这两项在这种环境里仍然可用，
 * 所以时区名用占位值顶上，用量照常入账。
 */
function resolveTimeZoneId(): string {
  const zone: unknown = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return typeof zone === 'string' && zone.length > 0 ? zone : UNKNOWN_TIME_ZONE;
}

/**
 * 本机时区的日历日，`YYYY-MM-DD`。
 *
 * 账本里的 `localDate`、用量页的热图格子和每日条形图都走这一个函数，
 * 三处的日期才对得上。
 */
export function localDateOf(at: Date): string {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, '0');
  const d = String(at.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 线路上的 usage 对象：任意形状，字段值可能是任何东西。 */
export type WireUsage = Record<string, unknown>;

/** 一条可信计数：安全的非负整数。其余（含 NaN/Infinity/小数/负数/字符串）都不可信。 */
function trustedCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * 读一个线路字段。存在但不可信时记入 `invalid`；不存在则静默返回 null（未上报 ≠ 乱报）。
 */
function readCount(wire: WireUsage, key: string, invalid: string[]): number | null {
  const raw = wire[key];
  if (raw === undefined || raw === null) return null;
  const ok = trustedCount(raw);
  if (ok === null) invalid.push(key);
  return ok;
}

function readNested(
  wire: WireUsage,
  parent: string,
  key: string,
  invalid: string[],
): number | null {
  const container = wire[parent];
  if (container === undefined || container === null) return null;
  if (typeof container !== 'object' || Array.isArray(container)) {
    invalid.push(parent);
    return null;
  }
  const raw = (container as Record<string, unknown>)[key];
  if (raw === undefined || raw === null) return null;
  const ok = trustedCount(raw);
  if (ok === null) invalid.push(`${parent}.${key}`);
  return ok;
}

/** 各项已知时求和；任一未知则总量未知。溢出出安全整数范围同样判未知。 */
function sumOrUnknown(parts: (number | null)[], label: string, invalid: string[]): number | null {
  if (parts.some((p) => p === null)) return null;
  const total = (parts as number[]).reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(total)) {
    invalid.push(label);
    return null;
  }
  return total;
}

/**
 * Anthropic Messages 协议的归一化。
 *
 * 关键语义：**`input_tokens` 不含缓存**，缓存读写是与它并列的两项，
 * 所以 `inputTotal` 由三项相加得出。
 * 缓存字段缺失时 `inputTotal` 为未知（页面显示"已知用量"），
 * **不补 0**——补 0 会把一次高缓存命中的请求说成只消耗了未缓存的那一小截。
 */
export function normalizeAnthropicUsage(wire: WireUsage, evidence: UsageEvidence): AccountingUsage {
  const invalid: string[] = [];
  const uncachedInput = readCount(wire, 'input_tokens', invalid);
  const cacheRead = readCount(wire, 'cache_read_input_tokens', invalid);
  const cacheWrite = readCount(wire, 'cache_creation_input_tokens', invalid);
  const outputTotal = readCount(wire, 'output_tokens', invalid);
  const reasoningOutput = readNested(wire, 'output_tokens_details', 'thinking_tokens', invalid);

  const reported = [uncachedInput, cacheRead, cacheWrite, outputTotal, reasoningOutput];
  const anyReported = reported.some((v) => v !== null) || invalid.length > 0;

  return {
    inputTotal: sumOrUnknown([uncachedInput, cacheRead, cacheWrite], 'inputTotal', invalid),
    uncachedInput,
    cacheRead,
    cacheWrite,
    outputTotal,
    reasoningOutput,
    evidence: anyReported ? evidence : 'none',
    invalidFields: invalid,
  };
}

/**
 * OpenAI 兼容协议的归一化。
 *
 * 关键语义：**`prompt_tokens` 已经含缓存读**，所以它直接就是 `inputTotal`，
 * 缓存读是它的子项；未缓存部分可由 `prompt_cache_miss_tokens` 直接得到，
 * 或在总量与缓存读都可信且不矛盾时相减得出。
 *
 * 缓存读的字段名各家不同，探测顺序与现有 `openai-compatible.ts` 的 `extractUsage` 一致：
 * `prompt_tokens_details.cached_tokens`（OpenAI 规范，豆包/百炼/GLM 跟随）→
 * `prompt_cache_hit_tokens`（DeepSeek）→ 顶层 `cached_tokens`（部分网关扁平化）。
 *
 * ## 待真实网关确认的一项（**不要猜**）
 *
 * 企业网关必然走本协议（`agentLoop.ts` 的 `isEnterpriseGatewayMode || apiFormat === 'openai-compatible'`），
 * 其上可以是 Claude。若响应同时带 `cache_creation_input_tokens`（Anthropic 特有的缓存写），
 * 就无法判断 `prompt_tokens` 是否已把缓存写计入：
 * 网关既可能按 OpenAI 语义合进总量，也可能把 Anthropic 的 `input_tokens` 原样映射成
 * `prompt_tokens`（那样它连缓存读都不含）。两种映射会让同一份数字差出一个缓存写。
 *
 * 因此这里**判 `inputTotal` 与 `uncachedInput` 为未知**，保留三个分项，
 * 等真实企业网关实测确认映射方式后再收紧（任务书 V03、期 1 发布闸门）。
 * 宁可显示"已知用量"，不可显示一个看似精确的错数。
 */
export function normalizeOpenAICompatibleUsage(
  wire: WireUsage,
  evidence: UsageEvidence,
): AccountingUsage {
  const invalid: string[] = [];
  const reportedTotal = readCount(wire, 'prompt_tokens', invalid);
  const outputTotal = readCount(wire, 'completion_tokens', invalid);
  const reasoningOutput = readNested(wire, 'completion_tokens_details', 'reasoning_tokens', invalid);

  let cacheRead = readNested(wire, 'prompt_tokens_details', 'cached_tokens', invalid);
  if (cacheRead === null && !invalid.includes('prompt_tokens_details.cached_tokens')) {
    cacheRead = readCount(wire, 'prompt_cache_hit_tokens', invalid);
  }
  if (cacheRead === null && !invalid.includes('prompt_cache_hit_tokens')) {
    cacheRead = readCount(wire, 'cached_tokens', invalid);
  }

  const cacheWrite = readCount(wire, 'cache_creation_input_tokens', invalid);
  const cacheWriteReported = cacheWrite !== null;

  // 报了缓存写 ⇒ 总量的构成不明（见上方注释），总量与未缓存部分都判未知。
  const inputTotal: number | null = cacheWriteReported ? null : reportedTotal;
  let uncachedInput: number | null = null;

  if (!cacheWriteReported) {
    const declaredMiss = readCount(wire, 'prompt_cache_miss_tokens', invalid);
    if (declaredMiss !== null) {
      uncachedInput = declaredMiss;
    } else if (reportedTotal !== null && cacheRead !== null) {
      // 矛盾就判未知：缓存读大于总量说明网关在乱报，既不钳到 0（pi-ai 的做法，
      // 会凭空造出一个"总计"），也不让它变成负数（DSH 的做法）。
      if (cacheRead > reportedTotal) {
        invalid.push('uncachedInput');
      } else {
        uncachedInput = reportedTotal - cacheRead;
      }
    }
    // 只报总量不报缓存时 uncachedInput 保持未知：总量仍可信，缺的是缓存细分。
  }

  const anyReported =
    [reportedTotal, outputTotal, reasoningOutput, cacheRead, cacheWrite].some((v) => v !== null) ||
    invalid.length > 0;

  return {
    inputTotal,
    uncachedInput,
    cacheRead,
    cacheWrite,
    outputTotal,
    reasoningOutput,
    evidence: anyReported ? evidence : 'none',
    invalidFields: invalid,
  };
}

export function normalizeWireUsage(
  protocol: UsageProtocol,
  wire: WireUsage,
  evidence: UsageEvidence,
): AccountingUsage {
  return protocol === 'anthropic'
    ? normalizeAnthropicUsage(wire, evidence)
    : normalizeOpenAICompatibleUsage(wire, evidence);
}

/**
 * 把一次尝试的后续快照并入已有快照。
 *
 * 累计快照语义（不变量 2）：出现的字段覆盖，未出现的字段保留原值，**任何字段都不相加**。
 * Anthropic 的结束事件只带输出总数，输入与缓存两项靠这条规则保留下来。
 *
 * `evidence` 只能单向变强（none → partial → final）：拿到过最终结算，
 * 之后再来一个流内快照不能把它降回 partial。
 */
const EVIDENCE_RANK: Record<UsageEvidence, number> = { none: 0, partial: 1, final: 2 };

export function mergeAccountingUsage(
  base: AccountingUsage,
  next: AccountingUsage,
): AccountingUsage {
  const pick = (a: number | null, b: number | null): number | null => (b !== null ? b : a);
  return {
    inputTotal: pick(base.inputTotal, next.inputTotal),
    uncachedInput: pick(base.uncachedInput, next.uncachedInput),
    cacheRead: pick(base.cacheRead, next.cacheRead),
    cacheWrite: pick(base.cacheWrite, next.cacheWrite),
    outputTotal: pick(base.outputTotal, next.outputTotal),
    reasoningOutput: pick(base.reasoningOutput, next.reasoningOutput),
    evidence:
      EVIDENCE_RANK[next.evidence] > EVIDENCE_RANK[base.evidence] ? next.evidence : base.evidence,
    invalidFields: Array.from(new Set([...base.invalidFields, ...next.invalidFields])),
  };
}

/**
 * 整段提示词的 token 数，给 token 估算器的校准用。
 *
 * 旧的 `TokenUsage.inputTokens` 在两种协议下含义不同：Anthropic 的不含缓存读写，
 * OpenAI 兼容协议的 `prompt_tokens` 已经含缓存读。校准要的是发给模型的整段输入，
 * 所以 Anthropic 要把三项加起来，OpenAI 兼容协议直接取 `inputTokens`。
 */
export function promptTokensOf(
  protocol: UsageProtocol,
  usage: { inputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number },
): number {
  if (protocol === 'openai-compatible') return usage.inputTokens;
  return (
    usage.inputTokens + (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0)
  );
}

/**
 * 总量是否完整。**只有拿到最终结算证据才算完整**——流内累计值即便输入输出都有数，
 * 也不能冒充最终值（`start-only` 之后连接被切就是这种情况）。
 */
export function totalsComplete(usage: AccountingUsage): boolean {
  return usage.evidence === 'final' && usage.inputTotal !== null && usage.outputTotal !== null;
}

/**
 * 缓存细分是否可得。与总量完整性**分开**判断：缺缓存不等于整次总量未知，
 * 所以缓存命中率的分母只能取这一类尝试，且页面要注明覆盖数。
 */
export function cacheBreakdownComplete(usage: AccountingUsage): boolean {
  return (
    usage.uncachedInput !== null &&
    usage.cacheRead !== null &&
    usage.cacheWrite !== null &&
    usage.inputTotal !== null
  );
}
