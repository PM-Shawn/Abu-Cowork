/**
 * 用量尝试快照跨进程传输的共享样例（期 1 第 2 步）。
 *
 * 任务书：`docs/2026-09-15-usage-accounting-fix-brief.md`。
 *
 * ## 谁读这份样例
 *
 * - **现在**：`electron/usageAttemptFrame.contract.test.ts` 用真实的
 *   `validateUsageAttempt` / `decodeUsageFrame` 跑每一条，断言合法的原样进库、
 *   不合法的按稳定错误码拒绝、多余字段被丢弃。
 * - **期 1 第 3 步**：sidecar 侧的采集器接上之后，它的发送测试会用同一批快照
 *   编帧，断言 main 侧解出来逐字段相同。
 *
 * 两端读同一份表，所以任一端单方面改协议都会红。跨进程边界上"发的是什么"
 * 和"收的是什么"之间的这段距离，由这份表盯着。
 *
 * ## 为什么拒绝样例比通过样例多
 *
 * 账本有两个入口，sidecar 与 renderer，都是跨进程输入。能被写进用户账本的东西
 * 必须逐字段说得清，否则一个乱报的网关或者一次协议漂移就会把说不清的数字
 * 变成用户看到的统计。
 */

import type { UsageAttempt } from '../usageAccounting';

export interface ValidAttemptFixture {
  name: string;
  attempt: UsageAttempt;
  pins: string;
}

export interface RejectedAttemptFixture {
  name: string;
  raw: unknown;
  /** 稳定错误码，形如 `field:localDate`。只含字段名，不含字段值。 */
  reason: string;
  pins: string;
}

export interface StrippedAttemptFixture {
  name: string;
  raw: Record<string, unknown>;
  expected: UsageAttempt;
  pins: string;
}

/** 一份各字段都取到已知值的基准快照，供样例按需改写单个字段。 */
export function baseAttempt(): UsageAttempt {
  return {
    schemaVersion: 1,
    attemptId: 'att-0001',
    logicalCallId: 'call-0001',
    revision: 1,
    providerInstanceId: 'provider-anthropic-default',
    protocol: 'anthropic',
    requestedModel: 'claude-opus-5',
    servedModel: 'claude-opus-5',
    source: 'main',
    conversationId: 'conv-0001',
    skill: null,
    startedAtUtc: 1_789_000_000_000,
    localDate: '2026-09-15',
    tzId: 'Asia/Shanghai',
    offsetMinutes: 480,
    endedAtUtc: 1_789_000_002_000,
    outcome: 'succeeded',
    usage: {
      inputTotal: 2000,
      uncachedInput: 1000,
      cacheRead: 800,
      cacheWrite: 200,
      outputTotal: 500,
      reasoningOutput: null,
      evidence: 'final',
      invalidFields: [],
    },
  };
}

export const VALID_ATTEMPTS: ValidAttemptFixture[] = [
  {
    name: '主对话，Anthropic，各项齐备',
    attempt: baseAttempt(),
    pins: '最常见的一条。六个计数字段与身份字段原样穿过进程边界，不做任何补零与改写。',
  },
  {
    name: '进行中的尝试：还没有结束时间，用量全未知',
    attempt: {
      ...baseAttempt(),
      attemptId: 'att-0002',
      revision: 0,
      endedAtUtc: null,
      outcome: 'running',
      usage: {
        inputTotal: null,
        uncachedInput: null,
        cacheRead: null,
        cacheWrite: null,
        outputTotal: null,
        reasoningOutput: null,
        evidence: 'none',
        invalidFields: [],
      },
    },
    pins:
      '请求刚发出就写第一版快照，此时一个用量字段都还没有。' +
      'revision 从 0 开始，endedAtUtc 为 null——这两样都必须是合法值，' +
      '否则"发出即记账"这条路走不通，崩溃前的尝试就会完全无迹可寻。',
  },
  {
    name: '子代理，企业网关上的 Claude，缓存构成未知',
    attempt: {
      ...baseAttempt(),
      attemptId: 'att-0003',
      logicalCallId: 'call-0003',
      revision: 4,
      providerInstanceId: 'provider-enterprise-gateway',
      protocol: 'openai-compatible',
      requestedModel: 'claude-opus-5',
      servedModel: null,
      source: 'subagent',
      skill: 'code-review',
      usage: {
        inputTotal: null,
        uncachedInput: null,
        cacheRead: 800,
        cacheWrite: 200,
        outputTotal: 500,
        reasoningOutput: null,
        evidence: 'final',
        invalidFields: [],
      },
    },
    pins:
      '企业网关必然走 openai-compatible，其上可以是 Claude。总量判未知、分项照实保留的组合' +
      '必须能完整穿过传输层——否则边界上一次"顺手补个总数"就把说不清的数字变成了用户看到的统计。',
  },
  {
    name: '西半球负时区，跨年边界，含推理子项',
    attempt: {
      ...baseAttempt(),
      attemptId: 'att-0004',
      logicalCallId: 'call-0004',
      protocol: 'openai-compatible',
      providerInstanceId: 'provider-openai-default',
      requestedModel: 'gpt-6-astra',
      servedModel: 'gpt-6-astra',
      source: 'compaction',
      conversationId: null,
      localDate: '2025-12-31',
      tzId: 'America/New_York',
      offsetMinutes: -300,
      usage: {
        inputTotal: 1000,
        uncachedInput: 200,
        cacheRead: 800,
        cacheWrite: null,
        outputTotal: 500,
        reasoningOutput: 120,
        evidence: 'final',
        invalidFields: [],
      },
    },
    pins:
      '负 offset 必须原样保留。反馈里"北京时间凌晨被记到前一天"是 UTC 折算造成的，' +
      '修法是本地日历日随快照一起走，传输层不得按 UTC 重算。conversationId 为 null 是系统辅助调用的常态。',
  },
  {
    name: '被取消，只拿到流内累计快照，并记下乱报的字段名',
    attempt: {
      ...baseAttempt(),
      attemptId: 'att-0005',
      logicalCallId: 'call-0005',
      revision: 2,
      source: 'memory',
      outcome: 'cancelled',
      usage: {
        inputTotal: 1000,
        uncachedInput: 1000,
        cacheRead: 0,
        cacheWrite: 0,
        outputTotal: null,
        reasoningOutput: null,
        evidence: 'partial',
        invalidFields: ['completion_tokens'],
      },
    },
    pins:
      '取消本身不是完整性证据，evidence 仍是 partial。' +
      'cacheRead 的 0 是 provider 明确报的已知为零，与 outputTotal 的 null 是两回事，传输层不得混为一谈。' +
      'invalidFields 只带字段名，是诊断要用的线索。',
  },
];

export const REJECTED_ATTEMPTS: RejectedAttemptFixture[] = [
  {
    name: '根本不是对象',
    raw: 'att-0001',
    reason: 'not-an-object',
    pins: '跨进程来的东西可以是任何形状，第一道判断就得挡住非对象。',
  },
  {
    name: '版本号不认识',
    raw: { ...baseAttempt(), schemaVersion: 2 },
    reason: 'field:schemaVersion',
    pins: '用户装回旧版本时，新版 sidecar 的帧不能被旧版 main 按旧理解写进库。',
  },
  {
    name: '空的 attemptId',
    raw: { ...baseAttempt(), attemptId: '' },
    reason: 'field:attemptId',
    pins: 'attemptId 是主键，也是幂等重放的唯一依据。空串会把所有无名尝试挤成同一行。',
  },
  {
    name: '超长的 attemptId',
    raw: { ...baseAttempt(), attemptId: 'a'.repeat(201) },
    reason: 'field:attemptId',
    pins: '身份字段有长度上限，避免把超长串当身份写进账本。',
  },
  {
    name: 'revision 是负数',
    raw: { ...baseAttempt(), revision: -1 },
    reason: 'field:revision',
    pins: 'revision 单调递增是幂等写入那一句 SQL 的前提，负值会让比较失去意义。',
  },
  {
    name: 'revision 是小数',
    raw: { ...baseAttempt(), revision: 1.5 },
    reason: 'field:revision',
    pins: '小数会被 SQLite 存成浮点，比较结果依赖精度。',
  },
  {
    name: '协议不在已知集合里',
    raw: { ...baseAttempt(), protocol: 'gemini' },
    reason: 'field:protocol',
    pins: '协议决定缓存口径怎么读。不认识的协议意味着口径未知，不能先写进去再说。',
  },
  {
    name: '来源不在已知集合里',
    raw: { ...baseAttempt(), source: 'unknown-source' },
    reason: 'field:source',
    pins: '页面按来源分组展示，来源是枚举。写进一个页面认不出的值等于这条记录在界面上消失。',
  },
  {
    name: '本地日期是 UTC 时间戳格式',
    raw: { ...baseAttempt(), localDate: '2026-09-15T00:00:00.000Z' },
    reason: 'field:localDate',
    pins:
      'toISOString() 这类取法会把带时间的串送进来。' +
      '格式一旦不是 YYYY-MM-DD，按日期范围查询就会静默少算，没有任何报错。',
  },
  {
    name: '本地日期缺位补零',
    raw: { ...baseAttempt(), localDate: '2026-9-15' },
    reason: 'field:localDate',
    pins: '日期是字符串比较，位数不齐会让范围查询给出错误结果，且不会有任何报错。',
  },
  {
    name: 'offsetMinutes 超出一整天',
    raw: { ...baseAttempt(), offsetMinutes: 2000 },
    reason: 'field:offsetMinutes',
    pins: '真实时区区间是 -720 到 +840，放宽到整日仍要有上限。',
  },
  {
    name: '结束时间早于开始时间但形状合法',
    raw: { ...baseAttempt(), endedAtUtc: 0 },
    reason: 'field:endedAtUtc',
    pins: '0 既可能是"没结束"也可能是纪元零点。未结束一律用 null，0 直接拒绝。',
  },
  {
    name: '结果不在已知集合里',
    raw: { ...baseAttempt(), outcome: 'done' },
    reason: 'field:outcome',
    pins: '结果是枚举，页面据此区分正常结束、失败、取消与中断。认不出的值会让这四类在界面上并成一类。',
  },
  {
    name: '计数字段是负数',
    raw: { ...baseAttempt(), usage: { ...baseAttempt().usage, outputTotal: -5 } },
    reason: 'field:usage.outputTotal',
    pins:
      '实读 DSH 的归一化会让相减结果变成 -100 并照样给出总计。' +
      '负的 token 数没有含义，边界上就要挡住，不能让它进汇总。',
  },
  {
    name: '计数字段是字符串',
    raw: { ...baseAttempt(), usage: { ...baseAttempt().usage, inputTotal: '2000' } },
    reason: 'field:usage.inputTotal',
    pins: 'JSON 里数字与字符串是两回事，SQLite 会把字符串存进 INTEGER 列而不报错。',
  },
  {
    name: '计数字段超出安全整数',
    raw: {
      ...baseAttempt(),
      usage: { ...baseAttempt().usage, inputTotal: Number.MAX_SAFE_INTEGER + 2 },
    },
    reason: 'field:usage.inputTotal',
    pins: '超出安全整数之后加法不再精确，累加出来的总量会悄悄失真。',
  },
  {
    name: '证据强度不在已知集合里',
    raw: { ...baseAttempt(), usage: { ...baseAttempt().usage, evidence: 'complete' } },
    reason: 'field:usage.evidence',
    pins: '证据强度决定"这组数字算不算最终值"，认不出的值会让完整性判定失去依据。',
  },
  {
    name: 'invalidFields 里混进了对象',
    raw: {
      ...baseAttempt(),
      usage: { ...baseAttempt().usage, invalidFields: [{ field: 'prompt_tokens' }] },
    },
    reason: 'field:usage.invalidFields',
    pins: 'invalidFields 只能是字段名。放行对象等于给账本开了一个任意内容的口子。',
  },
  {
    name: 'usage 整个缺失',
    raw: (() => {
      const { usage: _usage, ...rest } = baseAttempt();
      return rest;
    })(),
    reason: 'field:usage',
    pins: '没有用量的尝试也要有一个全 null 的用量对象，缺失与全未知是两种形状。',
  },
];

export const STRIPPED_ATTEMPTS: StrippedAttemptFixture[] = [
  {
    name: '线路上多带的字段一律丢弃',
    raw: {
      ...baseAttempt(),
      promptText: '帮我把这封邮件改得客气一些',
      responseText: '好的，改写如下……',
      apiKey: 'sk-live-0123456789',
      requestHeaders: { authorization: 'Bearer sk-live-0123456789' },
      usage: { ...baseAttempt().usage, rawProviderPayload: { prompt: '……' } },
    },
    expected: baseAttempt(),
    pins:
      '账本只存请求身份、路由、时间、用量与结果（任务书 U06）。' +
      '校验通过后返回的是逐字段重建的新对象，所以提示词、回答、密钥、请求头' +
      '不可能靠"多带一个字段"混进库里，也不会出现在诊断包中。',
  },
  {
    name: '可空字段传 undefined 等同于 null',
    raw: (() => {
      const base = baseAttempt();
      return {
        ...base,
        servedModel: undefined,
        conversationId: undefined,
        skill: undefined,
        endedAtUtc: undefined,
      };
    })(),
    expected: {
      ...baseAttempt(),
      servedModel: null,
      conversationId: null,
      skill: null,
      endedAtUtc: null,
    },
    pins:
      'JSON 序列化会把 undefined 直接去掉，所以缺字段与显式 null 在边界上必须等价。' +
      '否则同一份快照走 stdout 帧与走 IPC 会得到两种结果。',
  },
];
