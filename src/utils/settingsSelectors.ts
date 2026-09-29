/**
 * Pure settingsStore selectors — split out of `src/stores/settingsStore.ts`
 * so they can be imported without dragging in that file's `zustand`
 * `create()` + `persist` module-load graph (secrets bootstrap, i18n
 * `setLanguage`/`initLanguage` side-effecting imports, etc.).
 *
 * Lives in `src/utils/` rather than `src/stores/` DELIBERATELY: the sidecar
 * bundle's fail-fast guard (`scripts/build-sidecar.mjs`'s
 * `bundleGraphGuardPlugin`, P1-3a design doc §2 item 9) fails the build on
 * ANY module physically located under `src/stores/**`, regardless of that
 * module's own content — a blunt, path-based check by design, not a
 * content-aware one. Living outside that directory is what lets this
 * genuinely pure module actually reach the sidecar bundle.
 *
 * Why this exists at all: `src/core/agent/subagentLoop.ts` calls
 * `getActiveApiKey`/`getActiveProvider`/`resolveAgentModel` **mid-loop**
 * (once per turn, to pick up a runtime-discovered capability or a settings
 * change) — not just once at entry — so they can't be resolved shell-side
 * and passed through as a frozen snapshot the way the sidecar migration
 * (`docs/2026-07-19-phase1-p3-loop-migration-staging.md` §2 "正式步 3a")
 * pre-resolves e.g. LLM creds. They must stay directly importable from BOTH
 * the webview and the sidecar bundle. All three were already pure functions
 * of a passed-in `SettingsState` (verified by reading — no closures over
 * store/Tauri state), so this is a zero-behavior relocation, same pattern as
 * `loopGuards.ts`'s `escalateMaxOutputTokens`/`shouldContinueTruncatedToolCalls`
 * move (see P1-3a-pre-REPORT.md §1).
 *
 * `settingsStore.ts` re-exports all five (see below) unchanged so no
 * existing importer needs to change; this file is the source of truth going
 * forward.
 *
 * `getEffectiveModel`/`providerRequiresApiKey` (P1-3b-1, added alongside the
 * original three — same purity verification, same relocation pattern) were
 * previously at settingsStore.ts:492-500 (pre-relocation line numbers).
 */
import type { SettingsState } from '../stores/settingsStore';
import type { ProviderInstance } from '../types/provider';

/** Get the active provider instance */
export function getActiveProvider(state: SettingsState): ProviderInstance | undefined {
  return state.providers.find(p => p.id === state.activeModel.providerId);
}

/** Returns the active API key for the current provider (backward-compatible) */
export function getActiveApiKey(state: SettingsState): string {
  const p = state.providers.find(p => p.id === state.activeModel.providerId);
  return p?.apiKey ?? '';
}

export type ModelUnavailableReason = 'provider-removed' | 'provider-disabled' | 'model-removed';
export interface ModelRef { providerId: string; modelId: string }

/**
 * Whether a conversation's pinned model can still be used. Mirrors the
 * settings page's own visibility rule (AIServicesSection `visibleProviders`):
 * a builtin the user trashed stays in the array but is hidden, so it reads as
 * removed, not merely switched off.
 *
 * A managed provider's model list is pulled at runtime. An empty list that no
 * pull has confirmed (`status !== 'verified'`) says nothing about what the
 * owning system allows, so a model missing from it is not reported as removed;
 * the request itself settles the question. A list on hand came from a
 * successful pull and stands while the next one is in flight or has failed.
 */
export function getModelUnavailableReason(
  state: Pick<SettingsState, 'providers'>,
  ref: ModelRef,
): ModelUnavailableReason | null {
  const p = state.providers.find((x) => x.id === ref.providerId);
  const visible = !!p && (p.userAdded || p.enabled || p.apiKey.trim().length > 0);
  if (!p || !visible) return 'provider-removed';
  if (!p.enabled) return 'provider-disabled';
  if (p.source === 'managed' && p.status !== 'verified' && p.models.length === 0) return null;
  if (!p.models.some((m) => m.id === ref.modelId)) return 'model-removed';
  return null;
}

export function hasAnyEnabledProvider(state: Pick<SettingsState, 'providers'>): boolean {
  return state.providers.some((p) => p.enabled);
}

/**
 * A model of the user's own to fall back on while a managed provider cannot be
 * reached: the one in use before that provider took over the default, if it
 * can still be used, else the first model of the first enabled provider the
 * user owns. Null when the user has none.
 */
export function findPersonalFallbackModel(
  state: Pick<SettingsState, 'providers'>,
  preferred: ModelRef | null,
): ModelRef | null {
  if (preferred) {
    const p = state.providers.find((x) => x.id === preferred.providerId);
    if (p && p.source !== 'managed' && getModelUnavailableReason(state, preferred) === null) return preferred;
  }
  const own = state.providers.find((p) => p.source !== 'managed' && p.enabled && p.models.length > 0);
  return own ? { providerId: own.id, modelId: own.models[0].id } : null;
}

export function getModelDisplayLabel(state: Pick<SettingsState, 'providers'>, ref: ModelRef): string {
  const p = state.providers.find((x) => x.id === ref.providerId);
  return p?.models.find((m) => m.id === ref.modelId)?.label || ref.modelId;
}

/** Resolve an agent's model field into the actual model ID */
export function resolveAgentModel(agentModel: string | undefined, state: SettingsState): string {
  const globalModel = state.activeModel.modelId;
  if (!agentModel || agentModel === 'inherit') return globalModel;

  // A model id cannot be detached from the provider whose base URL/API key
  // will execute it. Accepting an override merely because another enabled
  // provider exposes the same id creates an invalid mixed pair such as
  // DeepSeek credentials + a GLM model. Agent definitions currently carry
  // only a model id (no provider id), so the only unambiguous override is one
  // offered by the active provider itself.
  const activeProvider = getActiveProvider(state);
  if (
    activeProvider?.enabled
    && activeProvider.models.some((model) => model.id === agentModel)
  ) {
    return agentModel;
  }

  // Incompatible with the active provider -> inherit its selected model.
  return globalModel;
}

function isLoopbackUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const host = new URL(value).hostname;
  return host === 'localhost' || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host);
}

/**
 * 调用这个服务商是否必须有 API key。Ollama、LM Studio 不需要；用户自定义的
 * OpenAI 兼容服务地址指向本机时也不需要。Anthropic SDK 在 key 为空时直接拒绝发请求，
 * 所以 Anthropic 格式的自定义服务始终需要 key。
 */
export function providerNeedsApiKey(
  provider: Pick<ProviderInstance, 'id' | 'source' | 'apiFormat' | 'baseUrl'>,
): boolean {
  if (provider.id === 'ollama' || provider.id === 'lmstudio') return false;
  return !(provider.source === 'custom' && provider.apiFormat === 'openai-compatible' && isLoopbackUrl(provider.baseUrl));
}

/** 服务商已经具备调用所需的凭据：有 key，或本来就不需要 key。 */
export function providerHasCredentials(
  provider: Pick<ProviderInstance, 'id' | 'source' | 'apiFormat' | 'baseUrl' | 'apiKey'>,
): boolean {
  return provider.apiKey.trim().length > 0 || !providerNeedsApiKey(provider);
}

/** Whether the current provider requires an API key (backward-compatible) */
export function providerRequiresApiKey(state: SettingsState): boolean {
  const provider = getActiveProvider(state);
  return provider ? providerNeedsApiKey(provider) : true;
}

/** Returns the effective model ID (backward-compatible) */
export function getEffectiveModel(state: SettingsState): string {
  return state.activeModel.modelId;
}
