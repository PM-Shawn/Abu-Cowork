/**
 * 用量口径的共享契约样例（wire → AccountingUsage，逐字段期望值）。
 *
 * 任务书：`docs/2026-09-15-usage-accounting-fix-brief.md`（期 1 第 1 步「口径冻结」）。
 *
 * ## 谁读这份样例
 *
 * - **现在**：`src/core/llm/usageAccounting.contract.test.ts` 把每条 `events` 依次喂给真实的
 *   `normalizeWireUsage` + `mergeAccountingUsage`，断言最终结果**逐字段**等于 `expected`。
 * - **期 1 第 3 步**：适配器接入后，`claude.ts` / `openai-compatible.ts` 的流解析测试会把
 *   **同一批 wire 对象**塞进真实流事件里跑一遍，断言同样的 `expected`。
 *
 * 两端读同一份表，所以任一端单方面改动都会红：归一化函数改了语义、或者适配器
 * 在把 provider 字段交给归一化之前擅自补 0 / 钳位 / 丢字段，都躲不过。
 * "provider 报了什么"和"账本记了什么"之间的这段距离，由这份表盯着。
 *
 * ## 为什么是这 6 组
 *
 * 前两组盯 Anthropic 的累计快照语义（本次故障的第 4 条根因），第 3 组盯 OpenAI 的
 * 尾部结算与推理子项，第 4 组盯企业网关上的 Claude（口径待实测确认，见 `usageAccounting.ts`），
 * 第 5 组盯"全缺失不能变成 0"，第 6 组盯矛盾字段——它直接编码了调研探针的实测结论：
 * 同一份 `prompt_tokens: 100 / 缓存 200` 的矛盾输入，pi-ai 把未缓存部分钳到 0 并给出
 * "总计 250"，DSH 让它变成 -100 并给出"总计 150"，两者都把修剪后的数当成可信计数。
 * Abu 在这里必须两者都不做。
 */

import type { AccountingUsage, UsageEvidence, UsageProtocol, WireUsage } from '../usageAccounting';

export interface UsageFixtureEntry {
  name: string;
  protocol: UsageProtocol;
  /** 按到达顺序排列的用量事件。`evidence` 标明该事件是流内快照还是最终结算。 */
  events: { wire: WireUsage; evidence: UsageEvidence }[];
  expected: AccountingUsage;
  /** 这条样例盯的是什么——出现回归时先读这里，别直接改期望值。 */
  pins: string;
}

export const USAGE_FIXTURES: UsageFixtureEntry[] = [
  {
    name: 'anthropic: message_start 累计快照 + message_delta 最终结算',
    protocol: 'anthropic',
    events: [
      {
        wire: {
          input_tokens: 1000,
          cache_read_input_tokens: 800,
          cache_creation_input_tokens: 200,
          output_tokens: 1,
        },
        evidence: 'partial',
      },
      // 真实的 message_delta 只带 output_tokens，不重复输入与缓存。
      { wire: { output_tokens: 500 }, evidence: 'final' },
    ],
    expected: {
      // input_tokens 不含缓存，所以总量 = 1000 + 800 + 200。
      inputTotal: 2000,
      uncachedInput: 1000,
      cacheRead: 800,
      cacheWrite: 200,
      outputTotal: 500,
      reasoningOutput: null,
      evidence: 'final',
      invalidFields: [],
    },
    pins:
      '结束事件只报 output 时，message_start 的输入与缓存三项必须保留。' +
      '整体替换整个用量对象会让 Anthropic 的缓存读写每轮归零、缓存命中率恒为 0。',
  },
  {
    name: 'anthropic: 只有 message_start 就被切断',
    protocol: 'anthropic',
    events: [
      {
        wire: {
          input_tokens: 1000,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: 3,
        },
        evidence: 'partial',
      },
    ],
    expected: {
      inputTotal: 1000,
      uncachedInput: 1000,
      cacheRead: 0,
      cacheWrite: 0,
      outputTotal: 3,
      reasoningOutput: null,
      evidence: 'partial',
      invalidFields: [],
    },
    pins:
      '输入输出都有数，但没有最终结算证据，所以总量不算完整——累计值不能冒充最终值。' +
      '这里的 0 是 provider 明确报的"已知为零"，与未上报的 null 是两回事。',
  },
  {
    name: 'openai-compatible: 尾部 usage，含缓存读与推理子项',
    protocol: 'openai-compatible',
    events: [
      {
        wire: {
          prompt_tokens: 1000,
          completion_tokens: 500,
          prompt_tokens_details: { cached_tokens: 800 },
          completion_tokens_details: { reasoning_tokens: 120 },
        },
        evidence: 'final',
      },
    ],
    expected: {
      // prompt_tokens 已含缓存读，直接就是总量；未缓存部分由相减得出。
      inputTotal: 1000,
      uncachedInput: 200,
      cacheRead: 800,
      cacheWrite: null,
      outputTotal: 500,
      reasoningOutput: 120,
      evidence: 'final',
      invalidFields: [],
    },
    pins:
      'prompt_tokens 含缓存，不能再把缓存加一次（现有 UsageSection 的 cacheTotal 就是这么重复计的）。' +
      'reasoning 含在 completion_tokens 里，是子项不是另一笔；OpenAI 侧没有缓存写概念，保持未知而非 0。',
  },
  {
    name: 'openai-compatible: 企业网关上的 Claude（同时报缓存写）',
    protocol: 'openai-compatible',
    events: [
      {
        wire: {
          prompt_tokens: 1000,
          completion_tokens: 500,
          prompt_tokens_details: { cached_tokens: 800 },
          cache_creation_input_tokens: 200,
        },
        evidence: 'final',
      },
    ],
    expected: {
      // 无法判断 prompt_tokens 是否已含缓存写，因此总量与未缓存部分都判未知，
      // 三个分项照实保留。待真实企业网关实测确认映射后再收紧（V03）。
      inputTotal: null,
      uncachedInput: null,
      cacheRead: 800,
      cacheWrite: 200,
      outputTotal: 500,
      reasoningOutput: null,
      evidence: 'final',
      invalidFields: [],
    },
    pins:
      '企业网关必然走 openai-compatible 协议，其上可以是 Claude。现有 extractUsage 直接不取缓存写，' +
      '于是企业 Claude 路由的缓存写是黑的。这里保留分项但拒绝给出一个构成不明的总量。',
  },
  {
    name: '两协议共用：provider 一个用量字段都没给',
    protocol: 'openai-compatible',
    events: [{ wire: {}, evidence: 'final' }],
    expected: {
      inputTotal: null,
      uncachedInput: null,
      cacheRead: null,
      cacheWrite: null,
      outputTotal: null,
      reasoningOutput: null,
      evidence: 'none',
      invalidFields: [],
    },
    pins:
      '全缺失必须是 null + evidence none，不能变成一排 0。实读 pi-ai 对空 usage 返回全 0，' +
      'DSH 返回 NaN——前者把"没上报"说成"没消耗"，后者把脏值带进账本。',
  },
  {
    name: 'openai-compatible: 网关乱报（缓存读大于总量、输出为负、细分非数值）',
    protocol: 'openai-compatible',
    events: [
      {
        wire: {
          prompt_tokens: 100,
          prompt_tokens_details: { cached_tokens: 200 },
          completion_tokens: -5,
          completion_tokens_details: { reasoning_tokens: 'many' },
        },
        evidence: 'final',
      },
    ],
    expected: {
      // 总量与缓存读各自是可信的非负整数，照实保留；
      // 相减出来的未缓存部分矛盾，判未知——既不钳到 0，也不留负数。
      inputTotal: 100,
      uncachedInput: null,
      cacheRead: 200,
      cacheWrite: null,
      outputTotal: null,
      reasoningOutput: null,
      evidence: 'final',
      invalidFields: ['completion_tokens', 'completion_tokens_details.reasoning_tokens', 'uncachedInput'],
    },
    pins:
      '探针实测：同一输入 pi-ai 给出"未缓存 0、总计 250"，DSH 给出"未缓存 -100、总计 150"。' +
      'Abu 两者都不做——矛盾项判未知并记下字段名，合法项（总量、缓存读）仍作为已知部分保留。',
  },
];
