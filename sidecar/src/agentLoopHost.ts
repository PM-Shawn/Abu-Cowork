/**
 * Main agent-loop host — sidecar-side handler for the `agent.run` /
 * `agent.abort` protocol extension (P1-3B-3A, see
 * docs/2026-07-20-phase1-p3b-loop-entry-design.md §4). Mirrors
 * `subagentHost.ts`'s shape (per-run isolation, param validation, active-run
 * tracking, shutdown draining) generalized from the subagent mini-loop to
 * the full `runAgentLoop`.
 *
 * Per-run isolation: each `agent.run` gets its OWN port-frame coalescer
 * (`agent.delta` notification stream), conversation read-mirror, local
 * execution/abort-controller maps, and `AsyncLocalStorage` context
 * (`agentRunContext.ts`) — two concurrent main-loop runs never share
 * mutable state, matching `subagentHost.ts`'s discipline (P1-3a) generalized
 * to the 8 bare-module-getter ports the main loop reads (design doc §1
 * fact + P1-3B-3A-REPORT.md's inventory).
 *
 * `AgentRunParams` — the contract 3b-3B's shell dispatcher must build (see
 * P1-3B-3A-REPORT.md for the full field-by-field rationale):
 *   { runId, conversationId, userMessage,
 *     options: { images?, blockedTools?, imContext? },
 *     orchestration: { route, systemPromptSections } — precomputed via
 *       entryOrchestration.ts's precomputeOrchestration, SHELL-side (the
 *       function that stays out of the sidecar bundle),
 *     conversationSnapshot, indexEntrySnapshot?,
 *     settingsSnapshot, capsSnapshot?: { providerId, modelId, caps },
 *     resolvedCreds, toolList, planMode?, locale }
 */
import type {
  ImageAttachment,
  ToolDefinition,
  ToolResult,
  ToolExecutionContext,
  Conversation,
} from '@/types';
import type { PlannedStep, TaskExecution } from '@/types/execution';
import type { RouteResult, IMContext } from '@/core/agent/orchestrator';
import type { PromptSection } from '@/core/llm/promptSections';
import type { ConversationMeta } from '@/core/session/conversationStorage';
import type { SettingsState } from '@/stores/settingsStore';
import type { ExecutionPort } from '@/core/agent/ports/executionPort';
import type { AbortRegistry } from '@/core/agent/ports/abortRegistry';
import type { WorkspaceReader } from '@/core/agent/ports/workspaceReader';
import type { ToolInvoker } from '@/core/agent/ports/toolInvoker';
import type { CapsPort } from '@/core/agent/ports/capsPort';
import type { PlanModeState } from '@/core/agent/planMode';
import { runAgentLoop, type AgentLoopOptions, type AgentLoopResult } from '@/core/agent/agentLoop';
import { enqueueUserInputWithId } from '@/core/agent/userInputQueue';
import { applyPlanModeState } from '@/core/agent/planMode';
import { TOOL_NAMES } from '@/core/tools/toolNames';
import { toolResultToString } from '@/core/tools/toolResultToString';
import { RpcError } from './protocol';
import { sendRequest, sendNotification, setPreRequestFlush } from './rpcClient';
import { agentRunContext, type AgentRunContext } from './agentRunContext';
import { createPortFrameCoalescer, type PortFrame } from './portFrameCoalescer';
import { createFrameChatDelta, createFrameExecutionPort, createFrameScratchpadPort } from './portFrameSenders';
import { createConversationRunMirror, type ConversationPatch } from './conversationRunMirror';
import { seedSettingsMirrorIfEmpty, getSettingsMirrorReader, applySettingsSnapshot } from './settingsMirror';

/** Sidecar-local declaration — never imported from shell-side code (same "src/ never runtime-imports sidecar/, and vice versa across this boundary" discipline `frameApplier.ts`/`subagentHost.ts` already document). */
interface SerializableToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolDefinition['inputSchema'];
}

interface CapsSnapshotEntry {
  providerId: string;
  modelId: string;
  maxOutputTokens?: number;
  contextWindow?: number;
  isReasoningModel?: boolean;
}

export interface AgentRunParams {
  runId: string;
  conversationId: string;
  userMessage: string;
  options: {
    images?: ImageAttachment[];
    blockedTools?: string[];
    imContext?: IMContext;
  };
  orchestration: { route: RouteResult; systemPromptSections: PromptSection[] };
  conversationSnapshot: Conversation;
  indexEntrySnapshot?: ConversationMeta;
  settingsSnapshot: SettingsState;
  capsSnapshot?: CapsSnapshotEntry;
  resolvedCreds: { apiKey: string; baseUrl: string | undefined; forceOpenAiCompatible: boolean };
  toolList: SerializableToolDefinition[];
  planMode?: PlanModeState;
  locale: string;
  /**
   * P1-3B-4 — a snapshot of the shell's `userInputQueue` for this
   * conversation, taken at dispatch time (`agentLoopRunner.ts`'s
   * `buildAgentRunParams`). Seeded into the sidecar's OWN (real, but
   * previously-disconnected) `userInputQueue` instance at `agent.run` start
   * (below), id-preserved via `enqueueUserInputWithId`, so a message already
   * staged in the shell queue BEFORE this run was dispatched is picked up by
   * `agentLoop.ts`'s turn-1 `drainQueuedInputs` (agentLoop.ts:990) — the
   * same "leftover flushes on the next run" semantics the in-process path
   * already has, just bridged across the process boundary.
   */
  queuedInputs?: { id: string; text: string; isSystem?: boolean }[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseAgentRunParams(params: unknown): AgentRunParams {
  if (!isRecord(params)) throw new RpcError(-32602, 'Invalid params: expected object');
  const { runId, conversationId, userMessage, options, orchestration, conversationSnapshot, settingsSnapshot, resolvedCreds, toolList, locale } = params;
  if (typeof runId !== 'string' || !runId) throw new RpcError(-32602, 'Invalid params: runId must be a non-empty string');
  if (typeof conversationId !== 'string' || !conversationId) throw new RpcError(-32602, 'Invalid params: conversationId must be a non-empty string');
  if (typeof userMessage !== 'string') throw new RpcError(-32602, 'Invalid params: userMessage must be a string');
  if (!isRecord(options)) throw new RpcError(-32602, 'Invalid params: options must be an object');
  if (!isRecord(orchestration) || !isRecord((orchestration as { route?: unknown }).route)) {
    throw new RpcError(-32602, 'Invalid params: orchestration.route must be an object');
  }
  if (!Array.isArray((orchestration as { systemPromptSections?: unknown }).systemPromptSections)) {
    throw new RpcError(-32602, 'Invalid params: orchestration.systemPromptSections must be an array');
  }
  if (!isRecord(conversationSnapshot) || typeof (conversationSnapshot as { id?: unknown }).id !== 'string') {
    throw new RpcError(-32602, 'Invalid params: conversationSnapshot must be a Conversation');
  }
  if (!isRecord(settingsSnapshot)) throw new RpcError(-32602, 'Invalid params: settingsSnapshot must be an object');
  if (!isRecord(resolvedCreds)) throw new RpcError(-32602, 'Invalid params: resolvedCreds must be an object');
  if (!Array.isArray(toolList)) throw new RpcError(-32602, 'Invalid params: toolList must be an array');
  if (typeof locale !== 'string') throw new RpcError(-32602, 'Invalid params: locale must be a string');
  return params as unknown as AgentRunParams;
}

function parseAbortParams(params: unknown): { runId: string } {
  if (!isRecord(params) || typeof params.runId !== 'string') {
    throw new RpcError(-32602, 'Invalid params: runId must be a string');
  }
  return { runId: params.runId };
}

/**
 * Reverse `ToolInvoker` — same shape as `subagentHost.ts`'s
 * `createReverseToolInvoker`, generalized: `getAllTools()` reads a live
 * mutable cache (seeded from `agent.run` params, refreshed — see below), and
 * `toolResultToString` is the RELOCATED real implementation (P1-3B-3A item
 * 2 — closes the P1-3a duplication debt), not a re-hand-copy.
 *
 * ── `getAllTools()` sync-vs-async gap (ESCALATED, per the card's
 * instruction — see P1-3B-3A-REPORT.md) ──────────────────────────────────
 * `agentLoop.ts`'s `resolveTools` (called synchronously, per-turn) calls
 * `toolInvoker.getAllTools()` synchronously — but `tool.list` is an async
 * reverse RPC. This implementation ships the STATIC snapshot (from
 * `agent.run` params) as the steady-state read, with an EVENTUALLY
 * CONSISTENT background refresh: after any `executeAnyTool` call for
 * `manage_mcp_server` (design doc §1 fact 7's mcpChanged trigger) resolves,
 * a background (fire-and-forget, not awaited by the caller) `tool.list`
 * request updates the cache for the NEXT `getAllTools()` read — NOT
 * strictly-before-the-very-next-read (that would require an awaited refresh
 * inserted into `agentLoop.ts`'s `resolveTools` call site, out of this
 * batch's surgical scope — see the report's option sketch). Common-path
 * correctness (tool list resolved once at run start) is unaffected; the
 * mcpChanged mid-run refresh path has a narrow eventually-consistent window
 * (one extra turn, typically) instead of being synchronously guaranteed.
 */
function createReverseToolInvoker(runId: string, initialTools: SerializableToolDefinition[]): ToolInvoker {
  let cache: SerializableToolDefinition[] = initialTools;

  function toFullTools(list: SerializableToolDefinition[]): ToolDefinition[] {
    return list.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      execute: async () => {
        throw new Error(
          `[sidecar] ToolDefinition.execute() called directly for "${t.name}" — this should never happen; agentLoop.ts/toolExecutor.ts only call invoker.executeAnyTool(), which reverses to the shell via tool.invoke.`,
        );
      },
    }));
  }

  function refreshInBackground(): void {
    sendRequest('tool.list', { runId })
      .then((result) => {
        if (Array.isArray(result)) cache = result as SerializableToolDefinition[];
      })
      .catch(() => {
        // Best-effort — a failed background refresh just means the NEXT
        // getAllTools() read stays on the stale cache one more round; the
        // run itself never fails because of this.
      });
  }

  return {
    getAllTools: () => toFullTools(cache),
    executeAnyTool: async (name, input, _onConfirm, _onFilePerm, context) => {
      const result = (await sendRequest('tool.invoke', {
        runId,
        toolName: name,
        input,
        context: context as ToolExecutionContext | undefined,
      })) as ToolResult;
      if (name === TOOL_NAMES.MANAGE_MCP_SERVER) refreshInBackground();
      return result;
    },
    toolResultToString,
  };
}

interface ActiveRun {
  conversationId: string;
  controllers: Map<string, AbortController>;
  coalescer: ReturnType<typeof createPortFrameCoalescer>;
  applyConvPatch: (patch: ConversationPatch) => void;
  applyExecPatch: (conversationId: string, plannedSteps: PlannedStep[]) => void;
}

const activeRuns = new Map<string, ActiveRun>();

/**
 * Flushes EVERY active run's coalescer, not just the one issuing the
 * outbound request — `rpcClient.ts`'s `setPreRequestFlush` hook is
 * process-global (one hook, fires before EVERY `sendRequest`, regardless of
 * which run's code triggered it). Order between DIFFERENT runs' flushes
 * doesn't matter (different `agent.delta` frame batches, disambiguated by
 * `runId`); order WITHIN a run is already preserved by that run's own
 * coalescer FIFO.
 */
function flushAllCoalescers(): void {
  for (const run of activeRuns.values()) run.coalescer.flush();
}
setPreRequestFlush(flushAllCoalescers);

export async function handleAgentRun(rawParams: unknown): Promise<unknown> {
  const params = parseAgentRunParams(rawParams);
  const { runId, conversationId } = params;

  if (activeRuns.has(runId)) {
    throw new RpcError(-32602, `Invalid params: runId "${runId}" is already active`);
  }

  seedSettingsMirrorIfEmpty(params.settingsSnapshot);

  const coalescer = createPortFrameCoalescer((frames) => {
    sendNotification('agent.delta', { runId, frames });
  });
  const push = (frame: PortFrame): void => coalescer.push(frame);

  const mirror = createConversationRunMirror(conversationId, {
    conversation: params.conversationSnapshot,
    indexEntry: params.indexEntrySnapshot,
  });

  const chatDelta = createFrameChatDelta(push, mirror.applyChatDeltaWrite);
  const scratchpadPort = createFrameScratchpadPort(push);

  // ── ExecutionPort + plannedSteps patch mirror (item 6 — see design gap
  // escalated in P1-3B-2-REPORT.md §2b / this batch's report §6) ──────────
  const innerExecPort = createFrameExecutionPort(push);
  const executionsByConv = new Map<string, TaskExecution>();
  const executionPort: ExecutionPort = {
    ...innerExecPort,
    createExecution: (convId, loopId) => {
      const exec = innerExecPort.createExecution(convId, loopId);
      executionsByConv.set(convId, exec);
      return exec;
    },
  };
  function applyExecPatch(convId: string, plannedSteps: PlannedStep[]): void {
    const exec = executionsByConv.get(convId);
    if (exec) exec.plannedSteps = plannedSteps;
  }

  // ── AbortRegistry — sidecar-local Map, lazily-created controllers, same
  // contract as the in-process store (design doc §3 "abortRegistry" row) ──
  const controllers = new Map<string, AbortController>();
  const abortRegistry: AbortRegistry = {
    hasAbortController: (convId) => controllers.has(convId),
    getAbortController: (convId) => {
      let c = controllers.get(convId);
      if (!c) {
        c = new AbortController();
        controllers.set(convId, c);
      }
      return c;
    },
    clearAbortController: (convId) => {
      controllers.delete(convId);
    },
  };

  // ── CapsPort — entry-pair snapshot + caps.record forwarding + local echo
  // (design doc §3 "capsPort" row: "入口快照 + caps.record 通知 + 本地回声") ──
  let capsSnapshot = params.capsSnapshot;
  function matchesSnapshot(providerId: string, modelId: string): boolean {
    return !!capsSnapshot && capsSnapshot.providerId === providerId && capsSnapshot.modelId === modelId;
  }
  const capsPort: CapsPort = {
    get: (providerId, modelId) => {
      // Only the entry (provider,model) pair is ever queried — verified by
      // grepping agentLoop.ts's capsPort.get call site (always
      // (activeProvider.id, effectiveModelId), a pair fixed at loop entry
      // and never reassigned — see P1-3B-3A-REPORT.md). A pair mismatch
      // (which should never happen in practice) serves undefined, matching
      // the "no discovered override yet" fallback — documented, not a
      // silent wrong-answer risk.
      if (!matchesSnapshot(providerId, modelId)) return undefined;
      const { maxOutputTokens, contextWindow, isReasoningModel } = capsSnapshot!;
      if (maxOutputTokens === undefined && contextWindow === undefined && isReasoningModel === undefined) return undefined;
      return { maxOutputTokens, contextWindow, isReasoningModel, source: 'error-derived' as const, updatedAt: Date.now() };
    },
    recordMaxOutputTokens: (providerId, modelId, limit) => {
      sendNotification('caps.record', { providerId, modelId, field: 'maxOutputTokens', value: limit });
      capsSnapshot = { providerId, modelId, ...capsSnapshot, maxOutputTokens: limit };
    },
    recordContextWindow: (providerId, modelId, window) => {
      sendNotification('caps.record', { providerId, modelId, field: 'contextWindow', value: window });
      capsSnapshot = { providerId, modelId, ...capsSnapshot, contextWindow: window };
    },
    recordReasoningObserved: (providerId, modelId) => {
      sendNotification('caps.record', { providerId, modelId, field: 'reasoningObserved', value: true });
      capsSnapshot = { providerId, modelId, ...capsSnapshot, isReasoningModel: true };
    },
  };

  // ── WorkspaceReader — reads live off the SAME conversation mirror
  // state.convPatch keeps current (design doc §3 "workspaceReader" row) ──
  const workspaceReader: WorkspaceReader = { getCurrentPath: () => mirror.getWorkspacePathSnapshot() };

  // ── ToolInvoker — reverse tool.invoke + live-with-background-refresh list
  const toolInvoker = createReverseToolInvoker(runId, params.toolList);

  const runCtx: AgentRunContext = {
    runId,
    conversationId,
    chatDelta,
    conversationReader: mirror.reader,
    executionPort,
    abortRegistry,
    scratchpadPort,
    capsPort,
    workspaceReader,
    toolInvoker,
    resolvedCreds: params.resolvedCreds,
    locale: params.locale,
    pushFrame: push,
  };

  if (params.planMode) applyPlanModeState(conversationId, params.planMode);

  // P1-3B-4 — seed the sidecar's OWN userInputQueue instance from the
  // shell's dispatch-time snapshot (id-preserved) BEFORE the loop starts, so
  // a message already staged in the shell queue at dispatch time is picked
  // up by agentLoop.ts's turn-1 drainQueuedInputs. See AgentRunParams.
  // queuedInputs's doc above.
  if (Array.isArray(params.queuedInputs)) {
    for (const qi of params.queuedInputs) {
      if (qi && typeof qi.id === 'string' && typeof qi.text === 'string') {
        enqueueUserInputWithId(conversationId, qi.id, qi.text, qi.isSystem);
      }
    }
  }

  activeRuns.set(runId, {
    conversationId,
    controllers,
    coalescer,
    applyConvPatch: mirror.applyConvPatch,
    applyExecPatch,
  });

  try {
    const options: AgentLoopOptions = {
      images: params.options.images,
      blockedTools: params.options.blockedTools,
      imContext: params.options.imContext,
      settingsReader: getSettingsMirrorReader(),
      orchestration: params.orchestration,
      // P1-3B-3B: use the shell-known runId as the loop's internal loopId
      // (same "keyed by a shell-known id" trick as createExecutionWithId's
      // id===loopId convention, P1-3B-2-REPORT.md §2b) — the shell's
      // RunSession/LoopContext are registered under `runId` BEFORE this
      // `agent.run` is even sent, so `delegate_to_agent`'s shell-side
      // `getLoopContext(toolExecContext.loopId)` lookup (toolExecContext
      // travels over the wire via tool.invoke's `context` field) resolves
      // correctly without threading a second id back across the wire.
      loopId: runId,
    };
    const result: AgentLoopResult = await agentRunContext.run(runCtx, () =>
      runAgentLoop(conversationId, params.userMessage, options),
    );
    return result;
  } finally {
    coalescer.flush();
    activeRuns.delete(runId);
  }
}

/**
 * `{ runId, message | userMessage, queueId?, isSystem? }` — P1-3B-3B: the
 * sidecar-side half of the cross-process concurrency guard, EXTENDED by
 * P1-3B-4 to id-preserve mid-run adds forwarded from the shell's
 * `userInputQueue` (the chip strip's source of truth). `runAgentLoop`'s own
 * in-process concurrency guard (agentLoop.ts's entry `hasAbortController`/
 * `enqueueUserInput` block) can't protect a SECOND `agent.run` dispatch for
 * the same conversationId — this handler's `activeRuns` is keyed by `runId`,
 * a NEW random id per dispatch, so a second dispatch never collides with the
 * first at that check. Two distinct shell-side callers reach this
 * notification, in two distinct shapes:
 *
 *   1. `runAgentLoopDispatched`'s own concurrency guard (a non-ChatInput
 *      caller re-dispatching into an already-running conversation) — sends
 *      the ORIGINAL `{ runId, userMessage }` shape, no `queueId` (this
 *      message never touched the shell's `userInputQueue`, so there's no
 *      chip/id to preserve — deliberately left unchanged from P1-3B-3B, see
 *      P1-3B-4-QUEUEINPUT-FIX-REPORT.md for why: an existing test pins this
 *      exact call shape). Falls back to a locally-minted id below.
 *   2. `agentLoopRunner.ts`'s NEW queued-input forwarder (the ChatInput
 *      chip-strip bridge this batch fixes) — sends `{ runId, message,
 *      queueId, isSystem? }`, id-preserved so the shell's `input.consumed`
 *      handler can `removeQueuedInput` the EXACT shell-queue entry (hence
 *      chip) once this run's loop actually consumes it.
 *
 * Either way, staged into the SAME `userInputQueue.ts` module `agentLoop.ts`
 * already drains each turn (real module, sidecar-resident, now id-preserving
 * — see `enqueueUserInputWithId`). Unknown runId (run already finished, or a
 * stray/duplicate message) → silent drop, same discipline as
 * `agent.abort`/`agent.delta`.
 */
let fallbackQueueIdCounter = 0;
function generateFallbackQueueId(): string {
  fallbackQueueIdCounter += 1;
  return `sc-eq-${Date.now().toString(36)}-${fallbackQueueIdCounter.toString(36)}`;
}

export function handleAgentEnqueueInput(rawParams: unknown): void {
  if (!isRecord(rawParams) || typeof rawParams.runId !== 'string') return;
  const message =
    typeof rawParams.message === 'string'
      ? rawParams.message
      : typeof rawParams.userMessage === 'string'
        ? rawParams.userMessage
        : undefined;
  if (message === undefined) return;
  const run = activeRuns.get(rawParams.runId);
  if (!run) return;
  const isSystem = typeof rawParams.isSystem === 'boolean' ? rawParams.isSystem : undefined;
  if (typeof rawParams.queueId === 'string') {
    enqueueUserInputWithId(run.conversationId, rawParams.queueId, message, isSystem);
  } else {
    // Backward-compat path (caller 1 above) — no shell-side chip to
    // correlate, so an auto-generated id is fine; enqueueUserInput would
    // also mint its own, but using enqueueUserInputWithId + a locally-minted
    // id keeps this one code path for both branches.
    enqueueUserInputWithId(run.conversationId, generateFallbackQueueId(), message, isSystem);
  }
}

/** `{ runId }` — abort THIS run's conversation-scoped AbortController. Idempotent, unknown runId silent no-op (3a discipline). */
export function handleAgentAbort(rawParams: unknown): void {
  const { runId } = parseAbortParams(rawParams);
  const run = activeRuns.get(runId);
  if (!run) return;
  run.controllers.get(run.conversationId)?.abort();
}

/** `{ runId, patch }` — apply a `state.convPatch` scalar-field patch to the run's conversation mirror. Unknown runId silent drop. */
export function handleStateConvPatch(rawParams: unknown): void {
  if (!isRecord(rawParams) || typeof rawParams.runId !== 'string' || !isRecord(rawParams.patch)) return;
  const run = activeRuns.get(rawParams.runId);
  if (!run) return;
  run.applyConvPatch(rawParams.patch as ConversationPatch);
}

/**
 * `{ runId, plannedSteps }` — item 6: `report_plan` (shell-side
 * `memoryTools.ts`) writes `plannedSteps` DIRECTLY onto the real
 * `taskExecutionStore`, bypassing `ExecutionPort` entirely (P1-3B-2-REPORT.md
 * §2b's escalation #1). The sidecar's local execution mirror can't observe
 * that write via frames, so `plannedStepsPrompt.ts`'s sidecar-side read
 * (`getExecutionByConversationId(...).plannedSteps`) would stay `[]` for
 * the run's whole lifetime without this. 3b-3B is expected to add the
 * shell-side emitter (watching `taskExecutionStore`'s `plannedSteps`
 * writes, keyed by conversationId, sending this notification) — the
 * contract from this side: `{ runId: string; plannedSteps: PlannedStep[] }`,
 * applied to the mirror's execution-by-conversationId record. Unknown runId
 * silent drop, same discipline as `agent.delta`.
 */
export function handleStateExecPatch(rawParams: unknown): void {
  if (!isRecord(rawParams) || typeof rawParams.runId !== 'string' || !Array.isArray(rawParams.plannedSteps)) return;
  const run = activeRuns.get(rawParams.runId);
  if (!run) return;
  run.applyExecPatch(run.conversationId, rawParams.plannedSteps as PlannedStep[]);
}

/** `{ settings }` — sidecar-GLOBAL settings mirror push, see `settingsMirror.ts`. Not per-run, so not routed through `activeRuns`. */
export function handleStateSettings(rawParams: unknown): void {
  if (!isRecord(rawParams) || !isRecord(rawParams.settings)) return;
  applySettingsSnapshot(rawParams.settings as unknown as SettingsState);
}

/** `{ conversationId, mode }` — mirror-apply (no re-notify — `planMode.ts`'s `applyPlanModeState` doesn't fire `onPlanModeChange`, per P1-3b-2's design). */
export function handleStatePlanMode(rawParams: unknown): void {
  if (!isRecord(rawParams) || typeof rawParams.conversationId !== 'string') return;
  const mode = rawParams.mode;
  if (mode !== null && mode !== 'off' && mode !== 'planning' && mode !== 'approved') return;
  applyPlanModeState(rawParams.conversationId, mode);
}

/** Abort every in-flight `agent.run` — used by the `shutdown` notification handler before exit (mirrors `subagentHost.ts`'s `shutdownAllSubagentRuns`). */
export function shutdownAllAgentRuns(): void {
  for (const run of activeRuns.values()) {
    for (const controller of run.controllers.values()) controller.abort();
  }
}

/** Test-only accessor. */
export function __getActiveAgentRunCount(): number {
  return activeRuns.size;
}
