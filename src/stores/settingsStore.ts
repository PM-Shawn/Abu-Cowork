import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { LLMProvider, ApiFormat, ProviderCapabilities, CustomService } from '../types';
import type { ProviderInstance, ActiveModel, AuxiliaryServices, ModelInfo } from '../types/provider';
import { deriveUiCaps } from '../core/llm/modelCapabilities';
import type { PermissionMode } from '../core/permissions/permissionMode';
import type { WebSearchProviderType } from '../core/search/providers';
import { setLanguage, initLanguage, type LanguageSetting } from '@/i18n';
import type { UpdateInfo } from '@/core/updates/checker';
import {
  SECRET_KEYS,
  getSecret,
  setSecret,
  writeSecretOrDelete,
  deleteSecret,
  listFailedSecrets,
  clearAllSecrets,
} from '@/utils/secretStore';

/**
 * Fire-and-forget helper for secret-store side effects. Swallowing failures
 * here is intentional: the in-memory state is authoritative for the session,
 * and if the encrypted store is unavailable `persistApiKeyPlaintextFallback`
 * stays true so localStorage keeps the plaintext as a safety net.
 */
function fafSecret(promise: Promise<void>, label: string): void {
  promise.catch((err) => {
    console.warn(`[secrets] ${label} failed:`, err);
  });
}

/**
 * Module-level gate controlling whether `partialize` strips apiKey fields
 * before writing to localStorage. Starts `true` (safe default: persist
 * plaintext as Phase 2 did) and flips to `false` only after
 * `bootstrapSecrets` has fully confirmed that every in-memory apiKey is
 * also present in the encrypted store — either because we read it from
 * there, or because we just backfilled it.
 *
 * This means: a user with a broken secret store (Tauri IPC down, macOS
 * file corruption, etc.) will keep seeing plaintext in localStorage and
 * will not lose their keys. Once the store is healthy again on a later
 * launch, the flag flips and subsequent saves strip the plaintext.
 */
let persistApiKeyPlaintextFallback = true;

// ============================================================
// Static Provider Registry (used for defaults, guides, initialization)
// ============================================================

type ProviderConfig = {
  name: string;
  baseUrl: string;
  format: ApiFormat;
  models: { id: string; label: string }[];
  capabilities?: ProviderCapabilities;
};

export const PROVIDER_CONFIGS = {
  volcengine: {
    name: '火山引擎 (Volcengine)',
    // Coding Plan aggregator endpoint — multi-vendor, strict OpenAI tool schema only.
    // No private extensions like Ark's `web_search`, so no webSearch capability here.
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    format: 'openai-compatible',
    models: [
      { id: 'doubao-seed-2.0-code', label: 'Doubao Seed 2.0 Code' },
      { id: 'doubao-seed-2.0-pro', label: 'Doubao Seed 2.0 Pro' },
      { id: 'doubao-seed-2.0-lite', label: 'Doubao Seed 2.0 Lite' },
      { id: 'doubao-seed-code', label: 'Doubao Seed Code' },
      { id: 'minimax-m2.5', label: 'MiniMax M2.5' },
      { id: 'glm-4.7', label: 'GLM-4.7' },
      { id: 'deepseek-v3.2', label: 'DeepSeek V3.2' },
      { id: 'kimi-k2.5', label: 'Kimi K2.5' },
    ],
  },
  bailian: {
    name: '阿里百炼 (Bailian)',
    baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
    format: 'openai-compatible',
    models: [
      { id: 'qwen3.5-plus', label: 'Qwen3.5 Plus' },
      { id: 'qwen3-max', label: 'Qwen3 Max' },
      { id: 'qwen3.5-flash', label: 'Qwen3.5 Flash' },
      { id: 'glm-5', label: 'GLM-5' },
      { id: 'kimi-k2.5', label: 'Kimi K2.5' },
      { id: 'minimax-m2.5', label: 'MiniMax M2.5' },
      { id: 'gpt-5.4', label: 'GPT-5.4' },
      { id: 'gpt-5', label: 'GPT-5' },
      { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview' },
      { id: 'gemini-3.1-flash-lite-preview', label: 'Gemini 3.1 Flash Lite Preview' },
      { id: 'claude-4.6-sonnet', label: 'Claude 4.6 Sonnet' },
      { id: 'claude-4.6-opus', label: 'Claude 4.6 Opus' },
    ],
    capabilities: {
      webSearch: { type: 'parameter', paramName: 'enable_search', paramValue: true },
      imageGen: true,
    },
  },
  anthropic: {
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    format: 'anthropic',
    models: [
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
      { id: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
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
      { id: 'gpt-4.1', label: 'GPT-4.1' },
      { id: 'gpt-4.1-mini', label: 'GPT-4.1 Mini' },
      { id: 'gpt-4o', label: 'GPT-4o' },
      { id: 'gpt-4o-mini', label: 'GPT-4o Mini' },
    ],
    capabilities: {
      imageGen: true,
    },
  },
  deepseek: {
    name: '深度求索 (DeepSeek)',
    baseUrl: 'https://api.deepseek.com',
    format: 'openai-compatible',
    models: [
      { id: 'deepseek-chat', label: 'DeepSeek V3.2' },
      { id: 'deepseek-reasoner', label: 'DeepSeek R1' },
    ],
  },
  moonshot: {
    name: '月之暗面 (Moonshot)',
    baseUrl: 'https://api.moonshot.cn',
    format: 'openai-compatible',
    models: [
      { id: 'moonshot-v1-8k', label: 'Moonshot v1 8K' },
      { id: 'moonshot-v1-32k', label: 'Moonshot v1 32K' },
      { id: 'moonshot-v1-128k', label: 'Moonshot v1 128K' },
    ],
    capabilities: {
      webSearch: { type: 'tool', toolSpec: { type: 'builtin_function', function: { name: '$web_search' } } },
    },
  },
  zhipu: {
    name: '智谱 AI (Zhipu)',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    format: 'openai-compatible',
    models: [
      { id: 'glm-5', label: 'GLM-5' },
      { id: 'glm-4.7', label: 'GLM-4.7' },
      { id: 'glm-4.7-flash', label: 'GLM-4.7 Flash (免费)' },
      { id: 'glm-4.6v', label: 'GLM-4.6V' },
    ],
    capabilities: {
      webSearch: { type: 'tool', toolSpec: { type: 'web_search', web_search: { enable: true, search_engine: 'search_pro' } } },
      imageGen: true,
    },
  },
  minimax: {
    name: 'MiniMax',
    baseUrl: 'https://api.minimaxi.com/v1',
    format: 'openai-compatible',
    models: [
      { id: 'MiniMax-M2.7', label: 'MiniMax M2.7' },
      { id: 'MiniMax-M2.7-highspeed', label: 'MiniMax M2.7 Highspeed' },
      { id: 'MiniMax-M2.5', label: 'MiniMax M2.5' },
      { id: 'MiniMax-M2.5-highspeed', label: 'MiniMax M2.5 Highspeed' },
    ],
  },
  siliconflow: {
    name: '硅基流动 (SiliconFlow)',
    baseUrl: 'https://api.siliconflow.cn',
    format: 'openai-compatible',
    models: [
      { id: 'deepseek-ai/DeepSeek-V3.2', label: 'DeepSeek V3.2' },
      { id: 'Qwen/Qwen2.5-72B-Instruct', label: 'Qwen 2.5 72B' },
      { id: 'meta-llama/Llama-3.3-70B-Instruct', label: 'Llama 3.3 70B' },
    ],
    capabilities: {
      imageGen: true,
    },
  },
  qiniu: {
    name: '七牛云 (Qiniu)',
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
  openrouter: {
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    format: 'openai-compatible',
    models: [
      { id: 'anthropic/claude-opus-4.6', label: 'Claude Opus 4.6' },
      { id: 'anthropic/claude-sonnet-4.6', label: 'Claude Sonnet 4.6' },
      { id: 'openai/gpt-5.4', label: 'GPT-5.4' },
      { id: 'openai/gpt-5.4-pro', label: 'GPT-5.4 Pro' },
      { id: 'google/gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview' },
      { id: 'google/gemini-3.1-flash-lite-preview', label: 'Gemini 3.1 Flash Lite Preview' },
      { id: 'deepseek/deepseek-v3.2', label: 'DeepSeek V3.2' },
      { id: 'deepseek/deepseek-r1', label: 'DeepSeek R1' },
      { id: 'mistralai/mistral-large-2512', label: 'Mistral Large' },
      { id: 'qwen/qwen3.5-plus-02-15', label: 'Qwen 3.5 Plus' },
      { id: 'moonshotai/kimi-k2.5', label: 'Kimi K2.5' },
      { id: 'stepfun/step-3.5-flash:free', label: 'Step 3.5 Flash (Free)' },
    ],
  },
  ollama: { name: 'Ollama', baseUrl: 'http://localhost:11434', format: 'openai-compatible', models: [] },
  local: { name: '本地模型 (Local)', baseUrl: '', format: 'openai-compatible', models: [] },
  custom: { name: '自定义 API', baseUrl: '', format: 'openai-compatible', models: [] },
} as Record<LLMProvider, ProviderConfig>;

/** Returns the list of builtin provider IDs */
export function getAvailableProviders(): LLMProvider[] {
  return Object.keys(PROVIDER_CONFIGS) as LLMProvider[];
}

/** Derive available models for a provider ID (from static config) */
export const AVAILABLE_MODELS = Object.fromEntries(
  Object.entries(PROVIDER_CONFIGS).map(([k, v]) => [k, v.models])
) as Record<LLMProvider, { id: string; label: string }[]>;

// ============================================================
// Default providers from static config
// ============================================================

function createDefaultProviders(): ProviderInstance[] {
  // Exclude 'local' and 'custom' — they are only created via AddProviderModal
  const builtinIds = Object.keys(PROVIDER_CONFIGS).filter(
    id => id !== 'local' && id !== 'custom'
  ) as LLMProvider[];

  return builtinIds.map((id, index) => ({
    id,
    source: 'builtin' as const,
    name: PROVIDER_CONFIGS[id].name,
    enabled: id === 'qiniu', // default: only qiniu enabled
    apiFormat: PROVIDER_CONFIGS[id].format,
    baseUrl: PROVIDER_CONFIGS[id].baseUrl,
    apiKey: '',
    models: PROVIDER_CONFIGS[id].models.map(m => ({ id: m.id, label: m.label, capabilities: deriveUiCaps(m.id) })),
    capabilities: PROVIDER_CONFIGS[id].capabilities,
    status: 'unchecked' as const,
    sortOrder: index,
  }));
}

// ============================================================
// View mode types
// ============================================================

export type ViewMode = 'chat' | 'automation' | 'toolbox' | 'settings';
export type AutomationTab = 'schedule' | 'trigger';
export type SystemSettingsTab = 'general' | 'ai-services' | 'sandbox' | 'im-channels' | 'personal-memory' | 'soul' | 'diagnostic' | 'usage' | 'about' | 'feedback' | 'sponsor';
export type ToolboxTab = 'skills' | 'agents' | 'mcp';

// ============================================================
// State & Actions interfaces
// ============================================================

interface SettingsState {
  // ── Provider & Model (V2) ──
  providers: ProviderInstance[];
  activeModel: ActiveModel;
  recentModels: ActiveModel[];
  favoriteModels: ActiveModel[];
  auxiliaryServices: AuxiliaryServices;

  // ── General settings (unchanged) ──
  theme: 'dark' | 'light';
  showSettings: boolean;
  sidebarCollapsed: boolean;
  rightPanelCollapsed: boolean;
  agentMaxTurns?: number; // undefined = 不限制
  maxOutputTokens: number;
  contextWindowSize: number;
  language: LanguageSetting;
  activeSystemTab: SystemSettingsTab;
  activeAutomationTab: AutomationTab;
  activeToolboxTab: ToolboxTab;
  toolboxSearchQuery: string;
  installingItem: string | null;
  viewMode: ViewMode;
  disabledSkills: string[];
  disabledAgents: string[];
  sandboxEnabled: boolean;
  networkIsolationEnabled: boolean;
  networkWhitelist: string[];
  allowPrivateNetworks: boolean;
  closeAction: 'ask' | 'minimize' | 'quit';
  updateInfo: UpdateInfo | null;
  updateChecking: boolean;
  lastUpdateCheck: number;
  updateDownloadProgress: { downloaded: number; total: number } | null;
  updateInstalling: boolean;
  userNickname: string;
  userAvatar: string;
  guideShown: boolean;
  behaviorSensorEnabled: boolean;
  computerUseEnabled: boolean;
  allowSkillCommands: boolean;
  soulInitialized: boolean;
  skillRegistry: string;
  permissionMode: PermissionMode;

  /**
   * Soul (persona) settings. Currently holds `proactivity` which controls
   * how aggressively the agent consumes/creates skills (see
   * `src/core/agent/prompts/skillsGuidance.ts`). No UI yet — defaults to
   * 'companion'; power users edit settings JSON directly until Module H's
   * Preset UI ships.
   */
  soul: {
    proactivity: 'shy' | 'companion' | 'butler';
    /**
     * True once the user has seen the first-time drafts onboarding flow and
     * picked a proactivity preset. Flips false → true on first confirm.
     */
    draftsOnboardingShown: boolean;
  };

  /**
   * Content safety scanner settings (see `src/core/safety/contentGuard.ts`).
   *
   * Intentionally **no Settings UI** — these are an escape hatch for power
   * users debugging false positives. Edit via `~/Library/Application
   * Support/com.abu.app/abu-settings` directly.
   */
  safety: {
    /** Kill switch — off skips scan entirely (default: true). */
    enableContentGuard: boolean;
    /**
     * Pattern IDs to skip during scan. Useful when a legitimate skill
     * content trips a false positive. Empty by default.
     */
    bypass: string[];
  };

  /**
   * Secret-store keys (e.g. `provider:claude`, `aux:webSearch`) that failed
   * to decrypt at app start. Ephemeral — never persisted — repopulated each
   * launch by `bootstrapSecrets`. The AI-services UI reads this to show a
   * "please re-enter" hint on affected provider cards.
   */
  failedSecretKeys: string[];

  /**
   * One-shot flag for the v0.15 sensitive-memory audit. Set to true after the
   * onboarding dialog runs once (whether the user marked memories private,
   * skipped, or had no flagged memories). Persisted so the dialog never shows
   * again. New v0.15+ users start with `true` (no legacy data to audit).
   */
  hasRunSensitiveAudit_v015: boolean;
  /** Ephemeral — not persisted. Set by the memory settings panel to kick off the audit.
   *  Do NOT add to partialize. */
  shouldRunMemoryAudit: boolean;
}

interface SettingsActions {
  // ── Provider management (V2) ──
  addProvider: (config: Omit<ProviderInstance, 'id' | 'status' | 'sortOrder'>) => string;
  updateProvider: (id: string, patch: Partial<ProviderInstance>) => void;
  removeProvider: (id: string) => void;
  toggleProvider: (id: string) => void;
  reorderProviders: (ids: string[]) => void;
  setProviderStatus: (id: string, status: ProviderInstance['status'], message?: string, latency?: number) => void;

  // ── Model selection (V2) ──
  selectModel: (providerId: string, modelId: string) => void;
  toggleFavorite: (providerId: string, modelId: string) => void;

  // ── Provider model management ──
  addModelToProvider: (providerId: string, model: ModelInfo) => void;
  removeModelFromProvider: (providerId: string, modelId: string) => void;
  setProviderModels: (providerId: string, models: ModelInfo[]) => void;

  // ── Auxiliary services ──
  setAuxiliaryWebSearch: (config: AuxiliaryServices['webSearch']) => void;
  setAuxiliaryImageGen: (config: AuxiliaryServices['imageGen']) => void;

  // ── General settings actions (unchanged) ──
  setTheme: (theme: 'dark' | 'light') => void;
  toggleSettings: () => void;
  toggleSidebar: () => void;
  toggleRightPanel: () => void;
  setRightPanelCollapsed: (collapsed: boolean) => void;
  setAgentMaxTurns: (n: number | undefined) => void;
  setMaxOutputTokens: (tokens: number) => void;
  setContextWindowSize: (size: number) => void;
  setLanguage: (lang: LanguageSetting) => void;
  openSystemSettings: (tab?: SystemSettingsTab) => void;
  closeSystemSettings: () => void;
  setActiveSystemTab: (tab: SystemSettingsTab) => void;
  openAutomation: (tab?: AutomationTab) => void;
  closeAutomation: () => void;
  setActiveAutomationTab: (tab: AutomationTab) => void;
  openToolbox: (tab?: ToolboxTab) => void;
  closeToolbox: () => void;
  setActiveToolboxTab: (tab: ToolboxTab) => void;
  setToolboxSearchQuery: (query: string) => void;
  setInstallingItem: (itemId: string | null) => void;
  setViewMode: (mode: ViewMode) => void;
  toggleSkillEnabled: (skillName: string) => void;
  autoDisableProjectSkills: (skillNames: string[]) => void;
  toggleAgentEnabled: (agentName: string) => void;
  setSandboxEnabled: (enabled: boolean) => void;
  setNetworkIsolationEnabled: (enabled: boolean) => void;
  setNetworkWhitelist: (whitelist: string[]) => void;
  setAllowPrivateNetworks: (allow: boolean) => void;
  setCloseAction: (action: 'ask' | 'minimize' | 'quit') => void;
  setUpdateInfo: (info: UpdateInfo | null) => void;
  setUpdateChecking: (checking: boolean) => void;
  setLastUpdateCheck: (time: number) => void;
  setUpdateDownloadProgress: (progress: { downloaded: number; total: number } | null) => void;
  setUpdateInstalling: (installing: boolean) => void;
  setUserNickname: (nickname: string) => void;
  setUserAvatar: (avatar: string) => void;
  setGuideShown: (shown: boolean) => void;
  setBehaviorSensorEnabled: (enabled: boolean) => void;
  setComputerUseEnabled: (enabled: boolean) => void;
  setSoulInitialized: (initialized: boolean) => void;
  setProactivity: (level: 'shy' | 'companion' | 'butler') => void;
  setDraftsOnboardingShown: (shown: boolean) => void;
  setHasRunSensitiveAudit_v015: (done: boolean) => void;
  setShouldRunMemoryAudit: (run: boolean) => void;
  /**
   * Toggle the contentGuard safety scanner globally. When off, agent-
   * initiated writes (memory + skill drafts) skip the 120-pattern scan.
   * Intended as an escape hatch for power users debugging false positives.
   */
  setContentGuardEnabled: (enabled: boolean) => void;
  setPermissionMode: (mode: PermissionMode) => void;

  /**
   * Wipe every stored API key — both in the encrypted store and in memory.
   * Meant as a hard reset escape hatch; also used automatically by the
   * "clear all data" flow if one is ever added. The settings snapshot is
   * otherwise preserved (provider entries, models, preferences).
   */
  clearAllStoredKeys: () => Promise<void>;
}

// ============================================================
// Helper functions (backward-compatible signatures, V2 internals)
// ============================================================

/** Get the active provider instance */
export function getActiveProvider(state: SettingsState): ProviderInstance | undefined {
  return state.providers.find(p => p.id === state.activeModel.providerId);
}

/**
 * Reconcile activeModel after rehydration so that downstream code
 * (getActiveProvider, ChatInput, agentLoop) always sees a consistent state.
 *
 * Mutates `state` in place. Exported for unit testing — also called from
 * `onRehydrateStorage` below.
 *
 * Rules:
 * 1. Active provider missing  → switch to a usable enabled provider, falling
 *    back to any enabled provider.
 * 2. Active provider disabled but has key (or is ollama) → silently re-enable.
 * 3. Active provider disabled and unusable → switch to a usable fallback;
 *    only force-enable as a last resort so getActiveProvider() keeps resolving.
 */
export function reconcileActiveProvider(
  state: Pick<SettingsState, 'providers' | 'activeModel'>
): void {
  const activeProvider = state.providers.find(
    p => p.id === state.activeModel.providerId
  );
  if (!activeProvider) {
    const fallback =
      state.providers.find(
        p => p.enabled && (p.apiKey.trim().length > 0 || p.id === 'ollama')
      ) ?? state.providers.find(p => p.enabled);
    if (fallback) {
      state.activeModel = {
        providerId: fallback.id,
        modelId: fallback.models[0]?.id ?? '',
      };
    }
    return;
  }
  if (activeProvider.enabled) return;

  const isUsable =
    activeProvider.apiKey.trim().length > 0 || activeProvider.id === 'ollama';
  if (isUsable) {
    activeProvider.enabled = true;
    return;
  }

  const fallback = state.providers.find(
    p =>
      p.id !== activeProvider.id &&
      p.enabled &&
      (p.apiKey.trim().length > 0 || p.id === 'ollama')
  );
  if (fallback) {
    state.activeModel = {
      providerId: fallback.id,
      modelId: fallback.models[0]?.id ?? '',
    };
    // Leave activeProvider disabled — user's intent is preserved.
  } else {
    // No usable alternative; degrade to original behavior so that
    // getActiveProvider() and the send-time guard still work.
    activeProvider.enabled = true;
  }
}

/** Get the active provider + model in one call */
export function getActiveProviderAndModel(state: SettingsState): {
  provider: ProviderInstance;
  modelId: string;
} | null {
  const p = state.providers.find(p => p.id === state.activeModel.providerId && p.enabled);
  if (!p) return null;
  return { provider: p, modelId: state.activeModel.modelId };
}

/** Returns the active API key for the current provider (backward-compatible) */
export function getActiveApiKey(state: SettingsState): string {
  const p = state.providers.find(p => p.id === state.activeModel.providerId);
  return p?.apiKey ?? '';
}

/** Whether the current provider requires an API key (backward-compatible) */
export function providerRequiresApiKey(state: SettingsState): boolean {
  return state.activeModel.providerId !== 'ollama';
}

/** Returns the effective model ID (backward-compatible) */
export function getEffectiveModel(state: SettingsState): string {
  return state.activeModel.modelId;
}

/** Resolve an agent's model field into the actual model ID */
export function resolveAgentModel(agentModel: string | undefined, state: SettingsState): string {
  const globalModel = state.activeModel.modelId;
  if (!agentModel || agentModel === 'inherit') return globalModel;
  // Search across enabled providers
  for (const p of state.providers) {
    if (p.enabled && p.models.some(m => m.id === agentModel)) return agentModel;
  }
  // Incompatible → fall back to global
  return globalModel;
}

/** Get all models from all enabled providers (for model selector) */
export function getAllEnabledModels(state: SettingsState): Array<{
  provider: ProviderInstance;
  model: ModelInfo;
}> {
  return state.providers
    .filter(p => p.enabled)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .flatMap(p => p.models.map(m => ({ provider: p, model: m })));
}

// ============================================================
// Store
// ============================================================

export type SettingsStore = SettingsState & SettingsActions;

const defaultProviders = createDefaultProviders();

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      // ── Provider & Model defaults ──
      providers: defaultProviders,
      activeModel: { providerId: 'qiniu', modelId: 'deepseek/deepseek-v3.2-251201' },
      recentModels: [],
      favoriteModels: [],
      auxiliaryServices: {},

      // ── General settings defaults ──
      theme: 'dark',
      showSettings: false,
      sidebarCollapsed: false,
      rightPanelCollapsed: false,
      maxOutputTokens: 32768,
      contextWindowSize: 200000,
      language: 'system' as LanguageSetting,
      activeSystemTab: 'usage' as SystemSettingsTab,
      activeAutomationTab: 'schedule' as AutomationTab,
      activeToolboxTab: 'skills' as ToolboxTab,
      toolboxSearchQuery: '',
      installingItem: null,
      viewMode: 'chat' as ViewMode,
      disabledSkills: [
        'alert-sop', 'algorithmic-art', 'brand-guidelines', 'canvas-design',
        'claude-api', 'create-agent', 'doc-coauthoring', 'docx',
        'frontend-design', 'infographic', 'internal-comms', 'pdf',
        'pptx', 'slack-gif-creator', 'theme-factory', 'web-artifacts-builder',
        'webapp-testing', 'xlsx',
      ],
      disabledAgents: [],
      sandboxEnabled: true,
      networkIsolationEnabled: false,
      networkWhitelist: [],
      allowPrivateNetworks: true,
      closeAction: 'ask' as 'ask' | 'minimize' | 'quit',
      updateInfo: null,
      updateChecking: false,
      lastUpdateCheck: 0,
      updateDownloadProgress: null,
      updateInstalling: false,
      userNickname: '',
      userAvatar: '',
      guideShown: false,
      behaviorSensorEnabled: false,
      computerUseEnabled: false,
      allowSkillCommands: true,
      soulInitialized: false,
      skillRegistry: '',
      permissionMode: 'default' as PermissionMode,
      soul: {
        proactivity: 'companion',
        draftsOnboardingShown: false,
      },
      safety: {
        enableContentGuard: true,
        bypass: [],
      },
      failedSecretKeys: [],
      // Defaults to false so existing users get the audit on first v0.15 launch.
      // The migration below sets `false` explicitly for upgraders; new installs
      // start with this default (also false).
      hasRunSensitiveAudit_v015: false,
      shouldRunMemoryAudit: false,

      // ════════════════════════════════════════════════
      // Provider management actions (V2)
      // ════════════════════════════════════════════════

      addProvider: (config) => {
        const id = Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
        // Trim whitespace that users may have accidentally pasted — otherwise
        // a trailing space in baseUrl produces /%20/v1/... when the URL is
        // appended with path segments. See urlUtils.normalizeBaseUrl.
        const cleanBaseUrl = (config.baseUrl ?? '').trim();
        const cleanApiKey = (config.apiKey ?? '').trim();
        set((s) => {
          const newProvider: ProviderInstance = {
            ...config,
            baseUrl: cleanBaseUrl,
            apiKey: cleanApiKey,
            id,
            status: 'unchecked',
            sortOrder: s.providers.length,
          };
          const providers = [...s.providers, newProvider];
          // If this is the first enabled provider, auto-select its first model
          const hasEnabledBefore = s.providers.some(p => p.enabled);
          const update: Partial<SettingsState> = { providers };
          if (!hasEnabledBefore && config.enabled && config.models.length > 0) {
            update.activeModel = { providerId: id, modelId: config.models[0].id };
          }
          return update;
        });
        // Mirror apiKey to encrypted secret store.
        fafSecret(writeSecretOrDelete(SECRET_KEYS.provider(id), cleanApiKey), `addProvider(${id})`);
        return id;
      },

      updateProvider: (id, patch) => {
        // Trim whitespace at the store boundary — same rationale as addProvider.
        const cleanPatch: Partial<ProviderInstance> = { ...patch };
        if (patch.baseUrl !== undefined) cleanPatch.baseUrl = patch.baseUrl.trim();
        if (patch.apiKey !== undefined) cleanPatch.apiKey = patch.apiKey.trim();
        set((s) => ({
          providers: s.providers.map(p => p.id === id ? { ...p, ...cleanPatch } : p),
        }));
        // Only touch the secret store when apiKey is actually being updated;
        // other patches (enabled flag, status, model list) must not clobber it.
        if (Object.prototype.hasOwnProperty.call(patch, 'apiKey')) {
          fafSecret(
            writeSecretOrDelete(SECRET_KEYS.provider(id), cleanPatch.apiKey ?? ''),
            `updateProvider(${id})`,
          );
        }
      },

      removeProvider: (id) => {
        set((s) => {
          const providers = s.providers.filter(p => p.id !== id);
          const update: Partial<SettingsState> = { providers };
          // If we removed the active provider, switch to first enabled
          if (s.activeModel.providerId === id) {
            const fallback = providers.find(p => p.enabled);
            if (fallback) {
              update.activeModel = {
                providerId: fallback.id,
                modelId: fallback.models[0]?.id ?? '',
              };
            }
          }
          return update;
        });
        fafSecret(deleteSecret(SECRET_KEYS.provider(id)), `removeProvider(${id})`);
      },

      toggleProvider: (id) => set((s) => ({
        providers: s.providers.map(p =>
          p.id === id ? { ...p, enabled: !p.enabled } : p
        ),
      })),

      reorderProviders: (ids) => set((s) => ({
        providers: s.providers.map(p => ({
          ...p,
          sortOrder: ids.indexOf(p.id),
        })),
      })),

      setProviderStatus: (id, status, message, latency) => set((s) => ({
        providers: s.providers.map(p =>
          p.id === id ? {
            ...p,
            status,
            statusMessage: message,
            statusLatency: latency,
            lastChecked: Date.now(),
          } : p
        ),
      })),

      // ── Model selection ──

      selectModel: (providerId, modelId) => set((s) => {
        const newActive = { providerId, modelId };
        // Update recent models
        const recent = [
          newActive,
          ...s.recentModels.filter(
            r => !(r.providerId === providerId && r.modelId === modelId)
          ),
        ].slice(0, 5);
        return { activeModel: newActive, recentModels: recent };
      }),

      toggleFavorite: (providerId, modelId) => set((s) => {
        const exists = s.favoriteModels.some(
          f => f.providerId === providerId && f.modelId === modelId
        );
        return {
          favoriteModels: exists
            ? s.favoriteModels.filter(f => !(f.providerId === providerId && f.modelId === modelId))
            : [...s.favoriteModels, { providerId, modelId }],
        };
      }),

      // ── Provider model management ──

      addModelToProvider: (providerId, model) => set((s) => ({
        providers: s.providers.map(p =>
          p.id === providerId
            ? { ...p, models: [...p.models, model] }
            : p
        ),
      })),

      removeModelFromProvider: (providerId, modelId) => set((s) => ({
        providers: s.providers.map(p =>
          p.id === providerId
            ? { ...p, models: p.models.filter(m => m.id !== modelId) }
            : p
        ),
      })),

      setProviderModels: (providerId, models) => set((s) => ({
        providers: s.providers.map(p =>
          p.id === providerId ? { ...p, models } : p
        ),
      })),

      // ── Auxiliary services ──

      setAuxiliaryWebSearch: (config) => {
        // Trim whitespace at the store boundary (same rationale as addProvider).
        const cleaned = config
          ? { ...config, apiKey: config.apiKey?.trim() ?? '', baseUrl: config.baseUrl?.trim() ?? '' }
          : config;
        set((s) => ({
          auxiliaryServices: { ...s.auxiliaryServices, webSearch: cleaned },
        }));
        fafSecret(
          writeSecretOrDelete(SECRET_KEYS.auxWebSearch, cleaned?.apiKey ?? ''),
          'setAuxiliaryWebSearch',
        );
      },

      setAuxiliaryImageGen: (config) => {
        // Trim whitespace at the store boundary (same rationale as addProvider).
        const cleaned = config
          ? { ...config, apiKey: config.apiKey?.trim() ?? '', baseUrl: config.baseUrl?.trim() ?? '' }
          : config;
        set((s) => ({
          auxiliaryServices: { ...s.auxiliaryServices, imageGen: cleaned },
        }));
        fafSecret(
          writeSecretOrDelete(SECRET_KEYS.auxImageGen, cleaned?.apiKey ?? ''),
          'setAuxiliaryImageGen',
        );
      },

      // ════════════════════════════════════════════════
      // General settings actions (unchanged)
      // ════════════════════════════════════════════════

      setTheme: (theme) => set({ theme }),
      toggleSettings: () => set((s) => ({ showSettings: !s.showSettings })),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      toggleRightPanel: () => set((s) => ({ rightPanelCollapsed: !s.rightPanelCollapsed })),
      setRightPanelCollapsed: (collapsed) => set({ rightPanelCollapsed: collapsed }),
      setAgentMaxTurns: (agentMaxTurns) => set({ agentMaxTurns }),
      setMaxOutputTokens: (maxOutputTokens) => set({ maxOutputTokens }),
      setContextWindowSize: (contextWindowSize) => set({ contextWindowSize }),
      setLanguage: (lang) => {
        setLanguage(lang);
        set({ language: lang });
      },
      openSystemSettings: (tab) =>
        set((s) => ({
          viewMode: 'settings' as ViewMode,
          activeSystemTab: tab ?? s.activeSystemTab,
        })),
      closeSystemSettings: () =>
        set({ viewMode: 'chat' as ViewMode }),
      setActiveSystemTab: (tab) => set({ activeSystemTab: tab }),
      openAutomation: (tab) =>
        set({
          viewMode: 'automation' as ViewMode,
          activeAutomationTab: tab ?? 'schedule',
        }),
      closeAutomation: () =>
        set({ viewMode: 'chat' as ViewMode }),
      setActiveAutomationTab: (tab) => set({ activeAutomationTab: tab }),
      openToolbox: (tab) =>
        set(() => ({
          viewMode: 'toolbox' as ViewMode,
          activeToolboxTab: tab ?? 'skills',
          toolboxSearchQuery: '',
        })),
      closeToolbox: () =>
        set({
          viewMode: 'chat' as ViewMode,
          installingItem: null,
          toolboxSearchQuery: '',
        }),
      setActiveToolboxTab: (tab) => set({ activeToolboxTab: tab, toolboxSearchQuery: '' }),
      setToolboxSearchQuery: (query) => set({ toolboxSearchQuery: query }),
      setInstallingItem: (itemId) => set({ installingItem: itemId }),
      setViewMode: (viewMode) => set({ viewMode }),
      toggleSkillEnabled: (skillName) => set((s) => ({
        disabledSkills: s.disabledSkills.includes(skillName)
          ? s.disabledSkills.filter((n) => n !== skillName)
          : [...s.disabledSkills, skillName],
      })),
      autoDisableProjectSkills: (skillNames) => set((s) => {
        const newNames = skillNames.filter((n) => !s.disabledSkills.includes(n));
        if (newNames.length === 0) return s;
        return { disabledSkills: [...s.disabledSkills, ...newNames] };
      }),
      toggleAgentEnabled: (agentName) => set((s) => ({
        disabledAgents: s.disabledAgents.includes(agentName)
          ? s.disabledAgents.filter((n) => n !== agentName)
          : [...s.disabledAgents, agentName],
      })),
      setSandboxEnabled: (sandboxEnabled) => set({ sandboxEnabled }),
      setNetworkIsolationEnabled: (networkIsolationEnabled) => set({ networkIsolationEnabled }),
      setNetworkWhitelist: (networkWhitelist) => set({ networkWhitelist }),
      setAllowPrivateNetworks: (allowPrivateNetworks) => set({ allowPrivateNetworks }),
      setCloseAction: (closeAction) => set({ closeAction }),
      setUpdateInfo: (updateInfo) => set({ updateInfo }),
      setUpdateChecking: (updateChecking) => set({ updateChecking }),
      setLastUpdateCheck: (lastUpdateCheck) => set({ lastUpdateCheck }),
      setUpdateDownloadProgress: (updateDownloadProgress) => set({ updateDownloadProgress }),
      setUpdateInstalling: (updateInstalling) => set({ updateInstalling }),
      setUserNickname: (userNickname) => set({ userNickname }),
      setUserAvatar: (userAvatar) => set({ userAvatar }),
      setGuideShown: (guideShown) => set({ guideShown }),
      setBehaviorSensorEnabled: (behaviorSensorEnabled) => set({ behaviorSensorEnabled }),
      setComputerUseEnabled: (computerUseEnabled) => set({ computerUseEnabled }),
      setSoulInitialized: (soulInitialized) => set({ soulInitialized }),
      setProactivity: (level) =>
        set((s) => ({ soul: { ...s.soul, proactivity: level } })),
      setDraftsOnboardingShown: (shown) =>
        set((s) => ({ soul: { ...s.soul, draftsOnboardingShown: shown } })),
      setHasRunSensitiveAudit_v015: (done) => set({ hasRunSensitiveAudit_v015: done }),
      setShouldRunMemoryAudit: (run) => set({ shouldRunMemoryAudit: run }),
      setContentGuardEnabled: (enabled) =>
        set((s) => ({ safety: { ...s.safety, enableContentGuard: enabled } })),
      setPermissionMode: (mode) => set({ permissionMode: mode }),

      clearAllStoredKeys: async () => {
        const s = useSettingsStore.getState();
        // Collect the full set of known secret keys so the Windows/Linux
        // keyring path (no enumeration API) has something to iterate.
        const knownKeys = [
          ...s.providers.map((p) => SECRET_KEYS.provider(p.id)),
          SECRET_KEYS.auxWebSearch,
          SECRET_KEYS.auxImageGen,
        ];
        try {
          await clearAllSecrets(knownKeys);
        } catch (err) {
          console.warn('[secrets] clearAll backend failed:', err);
          // Continue anyway — at minimum blank the in-memory keys so the
          // user sees immediate effect. Next bootstrap will re-report any
          // orphaned entries the backend couldn't remove.
        }
        set((state) => ({
          providers: state.providers.map((p) => ({ ...p, apiKey: '' })),
          auxiliaryServices: {
            ...(state.auxiliaryServices.webSearch && {
              webSearch: { ...state.auxiliaryServices.webSearch, apiKey: '' },
            }),
            ...(state.auxiliaryServices.imageGen && {
              imageGen: { ...state.auxiliaryServices.imageGen, apiKey: '' },
            }),
          },
          failedSecretKeys: [],
        }));
      },
    }),
    {
      name: 'abu-settings',
      version: 26,
      migrate: (persisted: unknown, version: number) => {
        const state = persisted as Record<string, unknown>;

        // ════════════════════════════════════════════════
        // V26: Add hasRunSensitiveAudit_v015 flag. Existing upgraders get
        // false → onboarding dialog runs once on next launch and detects any
        // pre-v0.15 memories that look sensitive (id cards, bank cards, etc.)
        // so they can be marked private before Phase 2 auto-injection starts
        // surfacing them to the LLM each turn.
        // ════════════════════════════════════════════════
        if (version < 26) {
          const s = state as Record<string, unknown>;
          if (typeof s.hasRunSensitiveAudit_v015 !== 'boolean') {
            s.hasRunSensitiveAudit_v015 = false;
          }
        }


        // Each version branch is wrapped so a failure in one step doesn't
        // wipe the user's entire settings snapshot. Zustand's default
        // behavior on migrate throw is to fall back to the initial state —
        // catastrophic for a store this large. Inner try/catch keeps
        // downstream branches running (they're all additive-with-defaults,
        // so partial migration is strictly safer than full reset).
        const step = (label: string, fn: () => void) => {
          try {
            fn();
          } catch (err) {
            console.error(
              `[settingsStore] migration step "${label}" failed; preserving pre-step state:`,
              err,
            );
          }
        };

        // ════════════════════════════════════════════════
        // V25: Backfill `userAdded` for providers the user already configured.
        // Before this field existed, AIServicesSection used
        // `enabled || apiKey != ''` as a proxy for "user added this", which
        // made Ollama / decrypt-failed / cleared-key providers vanish from
        // the list when toggled off. Mark every provider that is currently
        // enabled or has a stored apiKey as userAdded so they survive the
        // toggle, and treat all custom providers as added by definition.
        // ════════════════════════════════════════════════
        if (version < 25) step('V25 backfill provider.userAdded', () => {
          if (!Array.isArray(state.providers)) return;
          state.providers = (state.providers as Array<Record<string, unknown>>).map((p) => {
            if (p.userAdded === true) return p;
            const enabled = p.enabled === true;
            const apiKey = typeof p.apiKey === 'string' ? p.apiKey.trim() : '';
            const isCustom = p.source === 'custom';
            if (isCustom || enabled || apiKey.length > 0) {
              return { ...p, userAdded: true };
            }
            return p;
          });
        });

        // ════════════════════════════════════════════════
        // V24: Remove temperature / enableThinking / thinkingBudget from persisted state.
        // These are now internal constants — users no longer configure them.
        if (version < 24) step('V24 drop user-configurable inference params', () => {
          delete (state as Record<string, unknown>).temperature;
          delete (state as Record<string, unknown>).enableThinking;
          delete (state as Record<string, unknown>).thinkingBudget;
        });

        // V23: Backfill model capabilities for existing users.
        // Before this version, models fetched from provider APIs or created from
        // the static PROVIDER_CONFIGS list had an empty capabilities array, so
        // thinking/vision badges never appeared in ModelSelector. This one-shot
        // pass runs deriveUiCaps on every stored model that has no capabilities.
        // ════════════════════════════════════════════════
        if (version < 23) step('V23 backfill model capabilities', () => {
          if (!Array.isArray(state.providers)) return;
          state.providers = (state.providers as Array<Record<string, unknown>>).map((p) => {
            const models = p.models as Array<Record<string, unknown>> | undefined;
            if (!Array.isArray(models)) return p;
            return {
              ...p,
              models: models.map((m) => {
                if (Array.isArray(m.capabilities) && m.capabilities.length > 0) return m;
                const id = typeof m.id === 'string' ? m.id : '';
                return { ...m, capabilities: deriveUiCaps(id) };
              }),
            };
          });
        });

        // ════════════════════════════════════════════════
        // V22: Strip stale `capabilities.webSearch` from persisted Volcengine
        // provider. Volcengine's Coding Plan endpoint (/api/coding/v3) is a
        // multi-vendor aggregator that only accepts strict OpenAI function-form
        // tools; the previously-declared `{type:'web_search', web_search:{...}}`
        // toolSpec was unconditionally injected into body.tools and made every
        // request crash with "missing tools.function parameter". The capability
        // was removed from PROVIDER_CONFIGS; this one-shot cleanup makes UI
        // badges (ProviderCard, ModelSelector, AIServicesSection) agree with
        // the actual endpoint behavior for users who upgraded.
        // ════════════════════════════════════════════════
        if (version < 22) step('V22 strip volcengine webSearch', () => {
          if (!Array.isArray(state.providers)) return;
          state.providers = (state.providers as Array<Record<string, unknown>>).map((p) => {
            if (p.id !== 'volcengine') return p;
            const caps = p.capabilities as Record<string, unknown> | undefined;
            if (!caps || !('webSearch' in caps)) return p;
            const { webSearch: _webSearch, ...rest } = caps;
            void _webSearch;
            return { ...p, capabilities: Object.keys(rest).length > 0 ? rest : undefined };
          });
        });

        // ════════════════════════════════════════════════
        // V21: One-shot trim pass on stored baseUrl/apiKey for providers and
        // auxiliary services. Existing users who accidentally pasted URLs with
        // trailing whitespace would otherwise keep hitting 404s — fetch encodes
        // the space to %20 and corrupts the path (e.g. /%20/v1/chat/completions).
        // Silent backfill: addProvider/updateProvider/setAuxiliary* now trim on
        // write, so this branch only cleans up data stored before the fix.
        // ════════════════════════════════════════════════
        if (version < 21) step('V21 baseUrl/apiKey trim', () => {
          if (Array.isArray(state.providers)) {
            state.providers = (state.providers as Array<Record<string, unknown>>).map((p) => ({
              ...p,
              baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl.trim() : p.baseUrl,
              apiKey: typeof p.apiKey === 'string' ? p.apiKey.trim() : p.apiKey,
            }));
          }
          const aux = state.auxiliaryServices as Record<string, Record<string, unknown> | undefined> | undefined;
          if (aux?.webSearch) {
            aux.webSearch = {
              ...aux.webSearch,
              baseUrl: typeof aux.webSearch.baseUrl === 'string' ? aux.webSearch.baseUrl.trim() : aux.webSearch.baseUrl,
              apiKey: typeof aux.webSearch.apiKey === 'string' ? aux.webSearch.apiKey.trim() : aux.webSearch.apiKey,
            };
          }
          if (aux?.imageGen) {
            aux.imageGen = {
              ...aux.imageGen,
              baseUrl: typeof aux.imageGen.baseUrl === 'string' ? aux.imageGen.baseUrl.trim() : aux.imageGen.baseUrl,
              apiKey: typeof aux.imageGen.apiKey === 'string' ? aux.imageGen.apiKey.trim() : aux.imageGen.apiKey,
            };
          }
        });

        // ════════════════════════════════════════════════
        // V20: Drafts onboarding flag — add draftsOnboardingShown to soul
        // (defaults to false so existing users also see the onboarding once
        // when their first draft appears).
        // ════════════════════════════════════════════════
        if (version < 20) step('V20 draftsOnboardingShown', () => {
          const soul = (state.soul as Record<string, unknown> | undefined) ?? {
            proactivity: 'companion',
          };
          if (soul.draftsOnboardingShown === undefined) {
            soul.draftsOnboardingShown = false;
          }
          state.soul = soul;
        });

        // ════════════════════════════════════════════════
        // V19: Soul personality — add proactivity preset
        // (shy / companion / butler). Default 'companion' for existing users
        // so the companion guidance prompt governs self-evolution behavior.
        // Additive — no data transform needed.
        // ════════════════════════════════════════════════
        if (version < 19) step('V19 soul default', () => {
          if (state.soul === undefined) {
            state.soul = { proactivity: 'companion', draftsOnboardingShown: false };
          }
        });

        // ════════════════════════════════════════════════
        // V18: Content safety settings (scanner feature flag + bypass list).
        // Additive — defaults installed if missing.
        // ════════════════════════════════════════════════
        if (version < 18) step('V18 safety defaults', () => {
          if (state.safety === undefined) {
            state.safety = { enableContentGuard: true, bypass: [] };
          }
        });

        // ════════════════════════════════════════════════
        // V17: API keys moved to the encrypted secret store.
        // Actual data move happens asynchronously in bootstrapSecrets
        // (migrate can't await Tauri IPC); this branch only bumps the
        // version marker so the next persist-save will strip the
        // plaintext via the new partialize.
        // ════════════════════════════════════════════════
        if (version < 17) step('V17 secret store marker', () => {
          void state;
        });

        // ════════════════════════════════════════════════
        // V16: Agent max turns — added optional agentMaxTurns
        // (undefined = unlimited; replaces hardcoded default of 20)
        // ════════════════════════════════════════════════
        if (version < 16) step('V16 agentMaxTurns', () => {
          // Optional additive field; no data transform needed.
          // Old users get undefined → unlimited (looser than previous 20).
          void state;
        });

        // ════════════════════════════════════════════════
        // V15: Soul personality — add soulInitialized flag
        // ════════════════════════════════════════════════
        if (version < 15) step('V15 soulInitialized', () => {
          if (state.soulInitialized === undefined) {
            state.soulInitialized = false;
          }
        });

        // ════════════════════════════════════════════════
        // V14: Provider V2 migration
        // ════════════════════════════════════════════════
        if (version < 14) step('V14 provider V2', () => {
          const oldApiKeys = (state.apiKeys as Record<string, string>) ?? {};
          const oldCustomServices = (state.customServices as CustomService[]) ?? [];
          const oldProvider = (state.provider as string) ?? 'qiniu';
          const oldModel = (state.model as string) ?? '';
          const oldCustomModel = (state.customModel as string) ?? '';
          const oldBaseUrl = (state.baseUrl as string) ?? '';
          const oldApiFormat = (state.apiFormat as string) ?? 'openai-compatible';

          // Build providers[] from PROVIDER_CONFIGS + old state
          const builtinIds = Object.keys(PROVIDER_CONFIGS).filter(
            id => id !== 'local' && id !== 'custom'
          ) as LLMProvider[];

          const providers: ProviderInstance[] = builtinIds.map((id, index) => {
            const config = PROVIDER_CONFIGS[id];
            const hasKey = !!oldApiKeys[id];
            const isActive = id === oldProvider;
            return {
              id,
              source: 'builtin' as const,
              name: config.name,
              // Enable if: has API key, or is the currently active provider
              enabled: hasKey || isActive,
              apiFormat: config.format,
              // If this is the active provider and user had a custom baseUrl, use it
              baseUrl: (isActive && oldBaseUrl) ? oldBaseUrl : config.baseUrl,
              apiKey: oldApiKeys[id] ?? '',
              models: config.models.map(m => ({ id: m.id, label: m.label })),
              capabilities: config.capabilities,
              status: 'unchecked' as const,
              sortOrder: index,
            };
          });

          // Migrate custom services to custom providers
          for (const svc of oldCustomServices) {
            providers.push({
              id: svc.id,
              source: 'custom' as const,
              name: svc.name,
              enabled: state.activeCustomServiceId === svc.id,
              apiFormat: svc.apiFormat,
              baseUrl: svc.baseUrl,
              apiKey: svc.apiKey,
              models: [{ id: svc.model, label: svc.model }],
              status: 'unchecked' as const,
              sortOrder: providers.length,
            });
          }

          // If old provider was 'custom' but not a saved custom service, create one
          if (oldProvider === 'custom' && !state.activeCustomServiceId && oldBaseUrl) {
            const customId = 'migrated_custom';
            providers.push({
              id: customId,
              source: 'custom' as const,
              name: '自定义 API (迁移)',
              enabled: true,
              apiFormat: oldApiFormat as ApiFormat,
              baseUrl: oldBaseUrl,
              apiKey: oldApiKeys.custom ?? '',
              models: oldCustomModel ? [{ id: oldCustomModel, label: oldCustomModel }] : [],
              status: 'unchecked' as const,
              sortOrder: providers.length,
            });
          }

          // If old provider was 'local', create a custom provider for it
          if (oldProvider === 'local' && oldBaseUrl) {
            const localId = 'migrated_local';
            providers.push({
              id: localId,
              source: 'custom' as const,
              name: '本地模型 (迁移)',
              enabled: true,
              apiFormat: oldApiFormat as ApiFormat,
              baseUrl: oldBaseUrl,
              apiKey: oldApiKeys.local ?? '',
              models: oldCustomModel ? [{ id: oldCustomModel, label: oldCustomModel }] : [],
              status: 'unchecked' as const,
              sortOrder: providers.length,
            });
          }

          state.providers = providers;

          // Build activeModel
          let activeProviderId = oldProvider;
          let activeModelId = oldModel;

          // Handle custom service activation
          if (state.activeCustomServiceId) {
            activeProviderId = state.activeCustomServiceId as string;
            const svc = oldCustomServices.find(cs => cs.id === activeProviderId);
            activeModelId = svc?.model ?? oldCustomModel ?? oldModel;
          } else if (oldProvider === 'custom' && !state.activeCustomServiceId && oldBaseUrl) {
            activeProviderId = 'migrated_custom';
            activeModelId = oldCustomModel || oldModel;
          } else if (oldProvider === 'local') {
            activeProviderId = 'migrated_local';
            activeModelId = oldCustomModel || oldModel;
          } else if (oldModel === '__custom__' || oldProvider === 'ollama') {
            activeModelId = oldCustomModel || '';
          }

          state.activeModel = { providerId: activeProviderId, modelId: activeModelId };
          state.recentModels = [];
          state.favoriteModels = [];

          // Build auxiliaryServices
          const auxWebSearch = state.webSearchApiKey ? {
            provider: (state.webSearchProvider ?? 'brave') as WebSearchProviderType,
            apiKey: (state.webSearchApiKey ?? '') as string,
            baseUrl: (state.webSearchBaseUrl ?? '') as string,
          } : undefined;

          const auxImageGen = state.imageGenApiKey ? {
            baseUrl: (state.imageGenBaseUrl ?? '') as string,
            apiKey: (state.imageGenApiKey ?? '') as string,
            model: (state.imageGenModel ?? 'dall-e-3') as string,
          } : undefined;

          state.auxiliaryServices = {
            ...(auxWebSearch ? { webSearch: auxWebSearch } : {}),
            ...(auxImageGen ? { imageGen: auxImageGen } : {}),
          };

          // Clean up old fields
          delete state.provider;
          delete state.apiFormat;
          delete state.model;
          delete state.customModel;
          delete state.apiKeys;
          delete state.baseUrl;
          delete state.customServices;
          delete state.activeCustomServiceId;
          delete state.imageGenApiKey;
          delete state.imageGenBaseUrl;
          delete state.imageGenModel;
          delete state.useBuiltinWebSearch;
          delete state.webSearchProvider;
          delete state.webSearchApiKey;
          delete state.webSearchBaseUrl;
        });

        // ════════════════════════════════════════════════
        // Pre-V14 migrations (keep for upgrade chains)
        // ════════════════════════════════════════════════
        if (version < 13) step('V13 ollama model', () => {
          if (state.provider === 'ollama' && state.model !== '__custom__') {
            state.model = '__custom__';
          }
        });
        if (version < 12) step('V12 permissionMode default', () => {
          if (state.permissionMode === undefined) state.permissionMode = 'default';
        });
        if (version < 11) step('V11 maxOutputTokens bump', () => {
          if (state.maxOutputTokens === 8192) {
            state.maxOutputTokens = 32768;
          }
        });
        if (version < 10) step('V10 apiKeys map', () => {
          const oldKey = state.apiKey as string | undefined;
          const currentProvider = (state.provider as string) || 'qiniu';
          if (oldKey) {
            state.apiKeys = { [currentProvider]: oldKey };
          } else {
            state.apiKeys = {};
          }
          delete state.apiKey;
        });
        if (version < 9) step('V9 customServices', () => {
          if (state.customServices === undefined) state.customServices = [];
          if (state.activeCustomServiceId === undefined) state.activeCustomServiceId = null;
        });
        if (version < 8) step('V8 skillRegistry', () => {
          if (state.skillRegistry === undefined) state.skillRegistry = '';
        });
        if (version < 7) step('V7 disabledSkills defaults', () => {
          state.disabledSkills = [
            'alert-sop', 'algorithmic-art', 'brand-guidelines', 'canvas-design',
            'claude-api', 'create-agent', 'doc-coauthoring', 'docx',
            'frontend-design', 'infographic', 'internal-comms', 'pdf',
            'pptx', 'slack-gif-creator', 'theme-factory', 'web-artifacts-builder',
            'webapp-testing', 'xlsx',
          ];
        });
        if (version < 6) step('V6 allowSkillCommands', () => {
          if (state.allowSkillCommands === undefined) state.allowSkillCommands = true;
        });
        if (version < 5) step('V5 computerUseEnabled', () => {
          if (state.computerUseEnabled === undefined) state.computerUseEnabled = false;
        });
        if (version < 4) step('V4 behaviorSensorEnabled', () => {
          if (state.behaviorSensorEnabled === undefined) state.behaviorSensorEnabled = false;
        });
        if (version < 3) step('V3 network isolation', () => {
          if (state.networkIsolationEnabled === undefined) state.networkIsolationEnabled = false;
          if (state.networkWhitelist === undefined) state.networkWhitelist = [];
          if (state.allowPrivateNetworks === undefined) state.allowPrivateNetworks = true;
        });
        if (version < 2) step('V2 user profile', () => {
          if (state.userNickname === undefined) state.userNickname = '';
          if (state.userAvatar === undefined) state.userAvatar = '';
          if (state.guideShown === undefined) state.guideShown = false;
        });
        if (version === 0) step('V0 mcp migration + zhipu fix', () => {
          // Cross-store migration: mcpServers → abu-mcp-store
          const mcpServers = state.mcpServers as
            | { name: string; command?: string; args?: string[]; url?: string;
                enabled?: boolean; transport?: string; env?: Record<string, string>;
                headers?: Record<string, string>; timeout?: number }[]
            | undefined;
          if (Array.isArray(mcpServers) && mcpServers.length > 0) {
            try {
              const mcpRaw = localStorage.getItem('abu-mcp-store');
              const mcpParsed = mcpRaw ? JSON.parse(mcpRaw) : { state: { servers: {} } };
              const existingServers = mcpParsed?.state?.servers ?? {};
              for (const srv of mcpServers) {
                if (srv.name && !existingServers[srv.name]) {
                  existingServers[srv.name] = {
                    config: { ...srv, enabled: srv.enabled ?? true },
                    status: 'disconnected',
                    tools: [],
                  };
                }
              }
              mcpParsed.state = { ...mcpParsed.state, servers: existingServers };
              localStorage.setItem('abu-mcp-store', JSON.stringify(mcpParsed));
            } catch { /* ignore */ }
          }
          delete state.mcpServers;

          if (state.provider === 'zhipu' && state.baseUrl === 'https://open.bigmodel.cn/api/paas') {
            state.baseUrl = 'https://open.bigmodel.cn/api/paas/v4';
          }

          if (state.disabledSkills === undefined) state.disabledSkills = [];
          if (state.disabledAgents === undefined) state.disabledAgents = [];
          if (state.sandboxEnabled === undefined) state.sandboxEnabled = true;
          if (state.closeAction === undefined) state.closeAction = 'ask';
          if (state.lastUpdateCheck === undefined) state.lastUpdateCheck = 0;
        });
        return state;
      },
      partialize: (state) => ({
        // V2 provider fields — apiKey is stripped once bootstrapSecrets has
        // confirmed the encrypted store is healthy. Until then we fall back
        // to Phase 2 behavior (plaintext in localStorage) so a broken secret
        // backend can't cause silent data loss on save.
        providers: persistApiKeyPlaintextFallback
          ? state.providers
          : state.providers.map((p) => ({ ...p, apiKey: '' })),
        activeModel: state.activeModel,
        recentModels: state.recentModels,
        favoriteModels: state.favoriteModels,
        auxiliaryServices: persistApiKeyPlaintextFallback
          ? state.auxiliaryServices
          : {
              ...(state.auxiliaryServices.webSearch && {
                webSearch: { ...state.auxiliaryServices.webSearch, apiKey: '' },
              }),
              ...(state.auxiliaryServices.imageGen && {
                imageGen: { ...state.auxiliaryServices.imageGen, apiKey: '' },
              }),
            },
        // General settings
        theme: state.theme,
        language: state.language,
        agentMaxTurns: state.agentMaxTurns,
        maxOutputTokens: state.maxOutputTokens,
        contextWindowSize: state.contextWindowSize,
        sidebarCollapsed: state.sidebarCollapsed,
        rightPanelCollapsed: state.rightPanelCollapsed,
        disabledSkills: state.disabledSkills,
        disabledAgents: state.disabledAgents,
        sandboxEnabled: state.sandboxEnabled,
        networkIsolationEnabled: state.networkIsolationEnabled,
        networkWhitelist: state.networkWhitelist,
        allowPrivateNetworks: state.allowPrivateNetworks,
        closeAction: state.closeAction,
        lastUpdateCheck: state.lastUpdateCheck,
        userNickname: state.userNickname,
        userAvatar: state.userAvatar,
        guideShown: state.guideShown,
        behaviorSensorEnabled: state.behaviorSensorEnabled,
        computerUseEnabled: state.computerUseEnabled,
        allowSkillCommands: state.allowSkillCommands,
        soulInitialized: state.soulInitialized,
        skillRegistry: state.skillRegistry,
        permissionMode: state.permissionMode,
        soul: state.soul,
        safety: state.safety,
        hasRunSensitiveAudit_v015: state.hasRunSensitiveAudit_v015,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        // Initialize i18n module with persisted language setting
        if (state.language) {
          initLanguage(state.language);
        }
        // Validate active model points to a usable provider
        reconcileActiveProvider(state);
        // Force reset ephemeral UI state
        state.showSettings = false;
        state.activeSystemTab = 'usage';
        state.activeAutomationTab = 'schedule';
        state.activeToolboxTab = 'skills';
        state.toolboxSearchQuery = '';
        state.installingItem = null;
        state.viewMode = 'chat';
        state.updateDownloadProgress = null;
        state.updateInstalling = false;
      },
    }
  )
);

/**
 * Hydrate API keys from the encrypted secret store into the in-memory settings
 * state, and backfill any plaintext legacy keys (still present in state from
 * localStorage rehydration) into the secret store. Called once after Zustand
 * rehydration completes, typically from `App.tsx`.
 *
 * Flow on each launch:
 *   1. Read every known key from the encrypted store in parallel.
 *   2. For any provider / aux service where the in-memory state carries a
 *      non-empty apiKey but the store does not, write it to the store
 *      (this is the legacy-to-encrypted migration path; happens exactly
 *      once per user on upgrade from 0.11 / Phase 2).
 *   3. For every key the store returned, overwrite the in-memory apiKey
 *      so the store is the source of truth.
 *   4. If steps 1-3 all succeeded, flip
 *      `persistApiKeyPlaintextFallback` to false so subsequent persist
 *      saves strip apiKey from localStorage.
 *
 * Any failure (Tauri IPC down, secrets file corrupted, etc.) leaves the
 * fallback flag at true, so localStorage keeps plaintext and no data is
 * lost. The next healthy launch retries the migration and eventually
 * strips the plaintext.
 */
export async function bootstrapSecrets(): Promise<void> {
  const state = useSettingsStore.getState();

  type Fetch =
    | { kind: 'provider'; providerId: string; value: string | null }
    | { kind: 'webSearch'; value: string | null }
    | { kind: 'imageGen'; value: string | null };

  const tasks: Promise<Fetch>[] = [];

  for (const p of state.providers) {
    tasks.push(
      getSecret(SECRET_KEYS.provider(p.id)).then(
        (value) => ({ kind: 'provider', providerId: p.id, value } as Fetch),
      ),
    );
  }
  tasks.push(
    getSecret(SECRET_KEYS.auxWebSearch).then(
      (value) => ({ kind: 'webSearch', value } as Fetch),
    ),
  );
  tasks.push(
    getSecret(SECRET_KEYS.auxImageGen).then(
      (value) => ({ kind: 'imageGen', value } as Fetch),
    ),
  );

  let results: Fetch[];
  try {
    results = await Promise.all(tasks);
  } catch (err) {
    console.warn('[secrets] bootstrap read failed, staying in plaintext-fallback mode:', err);
    return;
  }

  const providerUpdates = new Map<string, string>();
  let webSearchSecret: string | null = null;
  let imageGenSecret: string | null = null;
  for (const r of results) {
    if (r.kind === 'provider' && r.value) providerUpdates.set(r.providerId, r.value);
    else if (r.kind === 'webSearch') webSearchSecret = r.value;
    else if (r.kind === 'imageGen') imageGenSecret = r.value;
  }

  // Backfill: state has plaintext key but encrypted store doesn't.
  // Happens on first 0.12 launch for users whose keys came from 0.11 or
  // Phase 2 if some provider was never edited (write-through never fired).
  const backfills: Promise<void>[] = [];
  for (const p of state.providers) {
    const plain = p.apiKey?.trim() ?? '';
    if (plain.length > 0 && !providerUpdates.has(p.id)) {
      backfills.push(setSecret(SECRET_KEYS.provider(p.id), plain));
    }
  }
  if (!webSearchSecret) {
    const plain = state.auxiliaryServices.webSearch?.apiKey?.trim() ?? '';
    if (plain.length > 0) backfills.push(setSecret(SECRET_KEYS.auxWebSearch, plain));
  }
  if (!imageGenSecret) {
    const plain = state.auxiliaryServices.imageGen?.apiKey?.trim() ?? '';
    if (plain.length > 0) backfills.push(setSecret(SECRET_KEYS.auxImageGen, plain));
  }

  let backfillOk = true;
  if (backfills.length > 0) {
    try {
      await Promise.all(backfills);
      console.log(`[secrets] migrated ${backfills.length} legacy plaintext key(s) to encrypted store`);
    } catch (err) {
      backfillOk = false;
      console.warn('[secrets] backfill failed, staying in plaintext-fallback mode:', err);
    }
  }

  // Query the set of keys the backend couldn't decrypt (macOS hardware
  // change scenario). Failure here is non-fatal; we just end up with an
  // empty list and the UI skips the "please re-enter" hints.
  let failedSecretKeys: string[] = [];
  try {
    failedSecretKeys = await listFailedSecrets();
    if (failedSecretKeys.length > 0) {
      console.warn('[secrets] decrypt failed for keys:', failedSecretKeys);
    }
  } catch (err) {
    console.warn('[secrets] listFailedSecrets failed:', err);
  }

  // Apply hydration — overwrite in-memory apiKey only when we fetched a
  // non-null value from the store (backfilled keys already match in-memory).
  useSettingsStore.setState((s) => {
    const providers = s.providers.map((p) => {
      const fetched = providerUpdates.get(p.id);
      return fetched ? { ...p, apiKey: fetched } : p;
    });

    const auxiliaryServices = { ...s.auxiliaryServices };
    if (webSearchSecret && auxiliaryServices.webSearch) {
      auxiliaryServices.webSearch = { ...auxiliaryServices.webSearch, apiKey: webSearchSecret };
    }
    if (imageGenSecret && auxiliaryServices.imageGen) {
      auxiliaryServices.imageGen = { ...auxiliaryServices.imageGen, apiKey: imageGenSecret };
    }

    return { providers, auxiliaryServices, failedSecretKeys };
  });

  // Flip the gate only if everything round-tripped cleanly. Subsequent
  // persist saves will now strip apiKey from localStorage.
  if (backfillOk) {
    persistApiKeyPlaintextFallback = false;
  }
}
