/**
 * Shared pure entry-model derivation — P1-3B-3B.
 *
 * `agentLoop.ts`'s entry sequence and `entryOrchestration.ts`'s
 * `precomputeOrchestration` each computed the SAME
 * `effectiveModelId`/`entryModelDeclared` formula independently (the latter
 * a deliberate, documented duplicate — see `entryOrchestration.ts`'s
 * "Reordering note"). P1-3B-3B's shell dispatcher (`agentLoopRunner.ts`'s
 * `buildAgentRunParams`) needs the SAME pair a third time (to resolve
 * `resolvedCreds`'s provider and the `capsSnapshot`'s (providerId, modelId)
 * key) — rather than adding a third hand-copy, this module is the single
 * pure source all three call sites use.
 *
 * Pure: no side effects (does NOT call `setActiveModel` — that stays the
 * loop's own genuine side effect, see `agentLoop.ts`'s call site immediately
 * after it calls this helper).
 */
import type { RouteResult } from './orchestrator';
import { getEffectiveModel, getActiveProvider, resolveAgentModel } from '../../utils/settingsSelectors';
import { resolveModelDeclared } from '../llm/resolveModelDeclared';
import type { SettingsState } from '@/stores/settingsStore';
import type { ProviderInstance } from '@/types/provider';
import type { DeclaredCapabilities } from '@/types/provider';

export interface ResolvedEntryModel {
  effectiveModelId: string;
  provider: ProviderInstance | undefined;
  entryModelDeclared: DeclaredCapabilities | undefined;
}

/**
 * `settings` / `settingsForModel` mirror `runAgentLoop`'s own locals — the
 * latter is the per-conversation-pinned-model overlay on top of the former.
 * `resolveAgentModel` deliberately reads the RAW `settings`, not
 * `settingsForModel` (mirrors the original call site exactly — see
 * `entryOrchestration.ts`'s doc for why).
 */
export function resolveEntryModel(
  route: Pick<RouteResult, 'type' | 'definition'>,
  settings: SettingsState,
  settingsForModel: SettingsState,
): ResolvedEntryModel {
  let effectiveModelId = getEffectiveModel(settingsForModel);
  if (route.type === 'agent' && route.definition?.model) {
    effectiveModelId = resolveAgentModel(route.definition.model, settings);
  }
  const provider = getActiveProvider(settingsForModel);
  const entryModelDeclared = resolveModelDeclared(provider, effectiveModelId);
  return { effectiveModelId, provider, entryModelDeclared };
}
