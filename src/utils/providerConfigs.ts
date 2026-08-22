/**
 * Static provider registry — plain object literal, not store-derived. Split
 * out of `src/stores/settingsStore.ts` (was defined at settingsStore.ts:82)
 * so it can be imported without dragging in that file's `zustand` `create()`
 * + `persist` module-load graph — same "pure/static value trapped in the
 * store's module" pattern as `settingsSelectors.ts` (see that file's doc
 * comment) and `scratchpadClassify.ts`.
 *
 * Lives in `src/utils/` rather than `src/stores/` for the same reason as
 * `settingsSelectors.ts`: the sidecar bundle's fail-fast guard
 * (`scripts/build-sidecar.mjs`'s `bundleGraphGuardPlugin`) fails the build on
 * ANY module physically located under `src/stores/**`, regardless of
 * content — a path-based check, not a content-aware one.
 *
 * `settingsStore.ts` imports + re-exports `PROVIDER_CONFIGS` unchanged so no
 * existing importer needs to change; this file is the source of truth going
 * forward. `src/core/capabilities.ts` (reachable from `agentLoop.ts`'s
 * import graph) is repointed here directly; other (UI) consumers stay on the
 * settingsStore re-export.
 */
import type { LLMProvider, ApiFormat, ProviderCapabilities } from '../types';

type ProviderPlan = {
  // 'openai' / 'anthropic' are custom's two "plans" — reusing this mechanism
  // to let a single "Custom API" entry pick its wire format via the same
  // 配置方式 dropdown as multi-endpoint builtins (design doc §7b), instead of
  // two separate custom entries differing only by a hardcoded format.
  id: 'paygo' | 'coding' | 'agent' | 'tokenplan' | 'openai' | 'anthropic';
  baseUrl: string;
  format: ApiFormat;
  models?: { id: string; label: string }[];
  capabilities?: ProviderCapabilities;
  /** Display name override — some vendors brand the tier differently (e.g.
   *  bailian's coding tier is "Token Plan"). Falls back to the generic
   *  billing label (Coding Plan / Agent Plan / Pay-as-you-go) when absent. */
  label?: string;
  /** Per-tier override of the provider-level flag — a vendor can serve the
   *  model-list endpoint on one billing tier and not another, since the tiers
   *  are separate hosts with separate credentials. Takes precedence over the
   *  provider-level value; absent falls back to it. */
  supportsModelList?: boolean;
};

type ProviderConfig = {
  name: string;
  baseUrl: string;
  format: ApiFormat;
  models: { id: string; label: string }[];
  capabilities?: ProviderCapabilities;
  plans?: ProviderPlan[];
  /** Set false when the vendor's OpenAI-compatible surface has no `/models`
   *  endpoint, so the settings UI hides 「获取模型列表」 instead of offering a
   *  button that can only ever fail. Absent means "assume it works" — a fetch
   *  degrades to a clear typed error either way. */
  supportsModelList?: boolean;
};

export const PROVIDER_CONFIGS = {
  volcengine: {
    name: '火山引擎',
    // Default = Agent Plan. All three tiers are OpenAI-compatible (/v3 endpoints)
    // and share one curated model list. Multi-config family — see plans[].
    baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
    format: 'openai-compatible',
    // Exactly what the Ark subscription console lists under 「配置 model-name」,
    // in its order — ids dotted with no date suffix, labels matching one to
    // one. This is the plan's actual entitlement list, so it is reproduced as
    // published rather than curated down or re-mapped: the Seed 2.0 pro/code
    // entries that used to sit here are retired and no longer served.
    models: [
      { id: 'doubao-seed-2.0-lite', label: 'Doubao Seed 2.0 Lite' },
      { id: 'doubao-seed-2.0-mini', label: 'Doubao Seed 2.0 Mini' },
      { id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code' },
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
      { id: 'minimax-m3', label: 'MiniMax M3' },
      { id: 'doubao-seed-evolving', label: 'Doubao Seed Evolving' },
      { id: 'kimi-k3', label: 'Kimi K3' },
      { id: 'doubao-seed-2.1-turbo', label: 'Doubao Seed 2.1 Turbo' },
      { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
      { id: 'glm-5.3', label: 'GLM-5.3' },
    ],
    // Model listing is declared per tier, because the three are separate hosts
    // with separate credentials and only one of them has been measured.
    // Verified with a live Agent Plan key: GET /api/plan/v3/models answers an
    // empty-bodied 404 (auth passed — a bad key returns 401 on every path,
    // including nonexistent ones, since the gateway authenticates before it
    // routes). Ark's model listing lives on its control-plane API instead
    // (ListFoundationModels, AK/SK-signed) — a different protocol.
    // Coding shares the subscription-host family, so it is assumed to match.
    // Pay-as-you-go is left enabled: it is a different host that has NOT been
    // measured, and a fetch that fails there now reports an accurate,
    // status-carrying message rather than a dead button.
    plans: [
      { id: 'agent', baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3', format: 'openai-compatible', supportsModelList: false },
      { id: 'coding', baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3', format: 'openai-compatible', supportsModelList: false },
      { id: 'paygo', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', format: 'openai-compatible' },
    ],
  },
  bailian: {
    name: '阿里百炼',
    // Default = Token Plan 团队版. Subscription and pay-as-you-go credentials
    // are isolated by endpoint, so each billing mode must be an explicit plan.
    baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    format: 'openai-compatible',
    models: [
      { id: 'qwen3.8-max', label: 'Qwen3.8 Max' },
      { id: 'qwen3.7-max', label: 'Qwen3.7 Max' },
      { id: 'qwen3.7-plus', label: 'Qwen3.7 Plus' },
      { id: 'qwen3.6-flash', label: 'Qwen3.6 Flash' },
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
      { id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code' },
    ],
    plans: [
      { id: 'tokenplan', baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', format: 'openai-compatible',
        models: [
          { id: 'qwen3.8-max', label: 'Qwen3.8 Max' },
          { id: 'qwen3.7-max', label: 'Qwen3.7 Max' },
          { id: 'qwen3.7-plus', label: 'Qwen3.7 Plus' },
          { id: 'qwen3.6-flash', label: 'Qwen3.6 Flash' },
          { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
          { id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code' },
        ] },
      { id: 'coding', baseUrl: 'https://coding.dashscope.aliyuncs.com/v1', format: 'openai-compatible',
        models: [
          { id: 'qwen3.7-plus', label: 'Qwen3.7 Plus' },
          { id: 'qwen3.6-plus', label: 'Qwen3.6 Plus' },
          { id: 'kimi-k2.5', label: 'Kimi K2.5' },
          { id: 'glm-5', label: 'GLM-5' },
          { id: 'MiniMax-M2.5', label: 'MiniMax M2.5' },
        ] },
      // China (Beijing) shared DashScope endpoint. Other regions and
      // workspace-dedicated domains remain available through Custom API.
      { id: 'paygo', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', format: 'openai-compatible',
        models: [
          { id: 'qwen3.8-max', label: 'Qwen3.8 Max' },
          { id: 'qwen3.7-max', label: 'Qwen3.7 Max' },
          { id: 'qwen3.7-plus', label: 'Qwen3.7 Plus' },
          { id: 'qwen3.6-flash', label: 'Qwen3.6 Flash' },
          { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
          { id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code' },
        ] },
    ],
  },
  anthropic: {
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    format: 'anthropic',
    models: [
      { id: 'claude-opus-5', label: 'Claude Opus 5' },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
      { id: 'claude-fable-5', label: 'Claude Fable 5' },
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
    ],
    capabilities: {
      webSearch: { type: 'tool', toolSpec: { type: 'web_search_20250305', name: 'web_search', max_uses: 5 } },
    },
  },
  openai: {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com',
    format: 'openai-compatible',
    models: [
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
      { id: 'gpt-5.5', label: 'GPT-5.5' },
    ],
    capabilities: {
      imageGen: true,
    },
  },
  deepseek: {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    format: 'openai-compatible',
    models: [
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
      { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
    ],
  },
  moonshot: {
    name: 'Kimi',
    baseUrl: 'https://api.moonshot.cn',
    format: 'openai-compatible',
    models: [
      { id: 'kimi-k3', label: 'Kimi K3' },
      { id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code' },
      { id: 'kimi-k2.7-code-highspeed', label: 'Kimi K2.7 Code Highspeed' },
      { id: 'kimi-k2.6', label: 'Kimi K2.6' },
    ],
    capabilities: {
      webSearch: { type: 'tool', toolSpec: { type: 'builtin_function', function: { name: '$web_search' } } },
    },
  },
  zhipu: {
    name: '智谱GLM',
    // Default = GLM Coding Plan. Both tiers OpenAI-compatible.
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    format: 'openai-compatible',
    models: [
      { id: 'glm-5.3', label: 'GLM-5.3' },
      { id: 'glm-5.2', label: 'GLM-5.2' },
      { id: 'glm-5-turbo', label: 'GLM-5-Turbo' },
      { id: 'glm-5v-turbo', label: 'GLM-5V-Turbo' },
    ],
    capabilities: {
      webSearch: { type: 'tool', toolSpec: { type: 'web_search', web_search: { enable: true, search_engine: 'search_pro' } } },
      imageGen: true,
    },
    plans: [
      { id: 'coding', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', format: 'openai-compatible' },
      { id: 'paygo', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', format: 'openai-compatible',
        capabilities: { webSearch: { type: 'tool', toolSpec: { type: 'web_search', web_search: { enable: true, search_engine: 'search_pro' } } }, imageGen: true } },
    ],
  },
  minimax: {
    name: 'MiniMax',
    baseUrl: 'https://api.minimaxi.com/v1',
    format: 'openai-compatible',
    models: [
      { id: 'MiniMax-M3', label: 'MiniMax M3' },
      { id: 'MiniMax-M2.7', label: 'MiniMax M2.7' },
      { id: 'MiniMax-M2.7-highspeed', label: 'MiniMax M2.7 Highspeed' },
    ],
  },
  siliconflow: {
    name: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn',
    format: 'openai-compatible',
    // No curated list — SiliconFlow is an aggregator with too many models to
    // maintain; the user fetches/adds their own (like a custom endpoint).
    models: [],
    capabilities: {
      imageGen: true,
    },
  },
  qiniu: {
    name: '七牛云',
    baseUrl: 'https://api.qnaigc.com/v1',
    format: 'openai-compatible',
    models: [
      { id: 'deepseek/deepseek-v3.2-251201', label: 'DeepSeek V3.2' },
      { id: 'deepseek-r1-0528', label: 'DeepSeek R1-0528' },
      { id: 'moonshotai/kimi-k2.5', label: 'Kimi K2.5' },
      { id: 'moonshotai/kimi-k2-thinking', label: 'Kimi K2 Thinking' },
      { id: 'minimax/minimax-m2.5', label: 'Minimax M2.5' },
      { id: 'minimax/minimax-m2.1', label: 'Minimax M2.1' },
      { id: 'z-ai/glm-5', label: 'GLM 5' },
      { id: 'qwen3-max', label: 'Qwen3 Max' },
      { id: 'doubao-seed-2.0-pro', label: 'Doubao Seed 2.0 Pro' },
      { id: 'doubao-seed-2.0-code', label: 'Doubao Seed 2.0 Code' },
      { id: 'openai/gpt-5.4', label: 'GPT-5.4' },
      { id: 'gemini-3.1-flash-lite-preview', label: 'Gemini 3.1 Flash Lite Preview' },
      { id: 'claude-4.6-sonnet', label: 'Claude 4.6 Sonnet' },
      { id: 'claude-4.6-opus', label: 'Claude 4.6 Opus' },
    ],
  },
  xiaomi: {
    name: '小米 MiMo',
    // Default = Token Plan. Both tiers share the same model list.
    baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
    format: 'openai-compatible',
    models: [
      { id: 'mimo-v2.5-pro', label: 'MiMo V2.5 Pro' },
      { id: 'mimo-v2.5', label: 'MiMo V2.5' },
    ],
    plans: [
      { id: 'tokenplan', baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1', format: 'openai-compatible' },
      { id: 'paygo', baseUrl: 'https://api.xiaomimimo.com/v1', format: 'openai-compatible' },
    ],
  },
  openrouter: {
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    format: 'openai-compatible',
    // No curated list — OpenRouter is an aggregator with hundreds of models;
    // the user fetches/adds their own (like a custom endpoint).
    models: [],
  },
  ollama: { name: 'Ollama', baseUrl: 'http://127.0.0.1:11434', format: 'openai-compatible', models: [] },
  lmstudio: { name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1', format: 'openai-compatible', models: [] },
  local: { name: '本地模型', baseUrl: '', format: 'openai-compatible', models: [] },
  custom: {
    name: '自定义 API',
    baseUrl: '',
    format: 'openai-compatible',
    models: [],
    // Two "plans" that are really just a format switch (design doc §7b): the
    // user always types their own baseUrl, so both plans leave it empty —
    // picking one only changes which wire format the request is sent as.
    plans: [
      { id: 'openai', baseUrl: '', format: 'openai-compatible', models: [] },
      { id: 'anthropic', baseUrl: '', format: 'anthropic', models: [] },
    ],
  },
} as Record<LLMProvider, ProviderConfig>;
