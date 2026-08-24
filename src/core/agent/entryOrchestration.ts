/**
 * Shared entry-orchestration precompute — P1-3B-3A item 1.
 *
 * Extracted from `runAgentLoop`'s entry sequence (`agentLoop.ts`, originally
 * the block spanning the old `:772-832` — route → skill-content refresh →
 * entryModelDeclared/capability-prompt derivation → `buildSystemPromptSections`)
 * so the 3b-3B shell dispatch layer can precompute EXACTLY the same
 * `{route, systemPromptSections}` pair the in-process loop computes, from a
 * single source, instead of a second hand-copied implementation that could
 * drift. `AgentLoopOptions.orchestration` (added P1-3b-1) is the injection
 * seam both paths funnel through.
 *
 * ── Import-graph note (design doc §2 "雷 1") ────────────────────────────
 * This module imports from `./orchestrator` (`routeInput`/
 * `buildSystemPromptSections`), which drags the heaviest DRAGGER cluster in
 * the app (registry/mcpManager/settingsStore/defaultWorkspace stores/skill
 * loader — see the design doc's §2 "雷 1"). `agentLoop.ts` must NEVER take a
 * STATIC import of this module — that would re-drag the whole orchestrator
 * graph into the sidecar bundle that hosts `runAgentLoop`. Its only
 * reference is a DYNAMIC `await import('./entryOrchestration')` inside the
 * `options?.orchestration ?? ...` fallback branch in `runAgentLoop` itself,
 * which is provably dead code on the sidecar path — `agentLoopHost.ts`
 * ALWAYS supplies `options.orchestration`, precomputed shell-side by the
 * 3b-3B dispatcher using this SAME `precomputeOrchestration` function. The
 * sidecar build additionally carries a THROWING bundle-graph-only shim for
 * this module (`sidecar/src/shims/entryOrchestrationRun.ts`) so if that
 * fallback branch is EVER actually reached sidecar-side (a wiring bug), it
 * fails loudly instead of quietly pulling in the whole orchestrator graph or
 * silently running against wrong state.
 *
 * ── Reordering note (documented per the card's "keep every side effect in
 * exactly the same order... anything you cannot cleanly extract without
 * reordering: leave it in the loop" instruction) ─────────────────────────
 * `entryModelDeclared` is recomputed HERE (pure — `getEffectiveModel`/
 * `resolveAgentModel`/`resolveModelDeclared`, no side effects) purely to
 * derive the capability prompt's `supportsTools` flag for
 * `buildSystemPromptSections`. The LOOP recomputes an equivalent
 * `effectiveModelId`/`entryModelDeclared` pair AGAIN, right after this call,
 * to (a) call `setActiveModel` — a genuine side effect on `tokenEstimator`'s
 * module-global calibration state, which stays uniquely in the loop, never
 * duplicated here — and (b) derive `toolContext.supportsVision`. This is a
 * small (~6-line) DUPLICATE of a pure formula, not the drifting
 * orchestration-call duplicate the card warns against.
 *
 * The one true reordering this extraction causes: `setActiveModel`'s
 * assignment now happens AFTER `buildSystemPromptSections`'s `await`
 * resolves, instead of before (the original code computed
 * effectiveModelId/setActiveModel/entryModelDeclared BETWEEN the old
 * route-computation position and the old systemPromptSections-computation
 * position; merging both into one earlier atomic precompute call moves the
 * await earlier). Verified this is behaviorally inert for a single loop's
 * own execution: `orchestrator.ts` has ZERO reference to
 * `tokenEstimator`/`activeModel` (grepped — no hits), so
 * `buildSystemPromptSections` never reads the value `setActiveModel` sets.
 * The only theoretical effect is a few-microtasks-wider window during which
 * a DIFFERENT, concurrently-running conversation's own token-estimation call
 * could observe THIS conversation's not-yet-updated `activeModelId` on the
 * shared module global — a benign, PRE-EXISTING race (tokenEstimator
 * calibration is a soft heuristic, not correctness-critical; any two
 * concurrent `runAgentLoop` calls already race on this same global at their
 * own respective `setActiveModel` calls today, regardless of this
 * extraction) that is not newly introduced, only very slightly widened for
 * this one call site. No existing test depends on it — full suite verified
 * green after this change (see P1-3B-3A-REPORT.md).
 */
import type { ToolExecutionContext } from '../../types';
import type { RouteResult, IMContext } from './orchestrator';
import { routeInput, buildSystemPromptSections } from './orchestrator';
import type { PromptSection } from '../llm/promptSections';
import { skillLoader } from '../skill/loader';
import { resolveEntryModel } from './resolveEntryModel';
import { getCapabilityPrompt } from './prompts/capabilityPrompt';
import type { SettingsState } from '@/stores/settingsStore';

export interface PrecomputedOrchestration {
  route: RouteResult;
  systemPromptSections: PromptSection[];
}

/**
 * `entry.settingsForModel` is the loop's OWN already-resolved
 * per-conversation-pinned-model overlay. Accepting it as a param (rather than
 * re-deriving it from a fresh
 * conversation read) avoids duplicating the model-pin derivation logic
 * (`pinnedConv?.model ?? indexEntry?.model ?? settings.activeModel`) a
 * second time — "keep the signature small and derive internally what you
 * can" from the card, applied by NOT re-deriving what the caller already
 * computed one statement earlier.
 */
export async function precomputeOrchestration(
  conversationId: string,
  userMessage: string,
  imContext: IMContext | undefined,
  entry: { settingsForModel: SettingsState },
  abortSignal?: AbortSignal,
  toolContext?: ToolExecutionContext,
): Promise<PrecomputedOrchestration> {
  const route = routeInput(userMessage);

  // Refresh skill content from disk to ensure latest version.
  if (route.type === 'skill' && route.skill?.filePath) {
    const fresh = await skillLoader.refreshSkill(route.skill.name);
    if (fresh) {
      route.skill = fresh;
      route.skillContent = fresh.content;
    }
  }

  // Pure duplicate of the loop's own effectiveModelId/entryModelDeclared
  // derivation — see this module's "Reordering note" above for why this
  // duplication is deliberate and bounded (setActiveModel itself is never
  // called here). P1-3B-3B: both this call site and the loop's own now go
  // through the SAME `resolveEntryModel` pure helper (single source for the
  // formula itself — only the `setActiveModel` side effect stays
  // uniquely in the loop), and the shell dispatcher's `buildAgentRunParams`
  // is a third caller of the same helper — see resolveEntryModel.ts's doc.
  const { entryModelDeclared } = resolveEntryModel(route, entry.settingsForModel);

  const systemPromptSections = await buildSystemPromptSections(
    route,
    getCapabilityPrompt({ supportsTools: entryModelDeclared?.supportsTools !== false }),
    conversationId,
    imContext,
    0,
    { ...toolContext, abortSignal },
  );

  return { route, systemPromptSections };
}
