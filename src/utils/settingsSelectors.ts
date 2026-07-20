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
 * `settingsStore.ts` re-exports all three unchanged so no existing importer
 * needs to change; this file is the source of truth going forward.
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
