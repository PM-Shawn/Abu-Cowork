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
 *     options: { images?, blockedTools?, allowedTools?, imContext? },
 *     orchestration: { route, systemPromptSections } — precomputed via
 *       entryOrchestration.ts's precomputeOrchestration, SHELL-side (the
 *       function that stays out of the sidecar bundle),
 *     conversationSnapshot, indexEntrySnapshot?,
 *     settingsSnapshot, capsSnapshot?: { providerId, modelId, caps },
 *     resolvedCreds, toolList, planMode?, locale }
 */
import type {
  SubagentStopReason,
  ToolExecutionMetadata,
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
import type { ChatDelta } from '@/core/agent/ports/chatDelta';
import type { AbortRegistry } from '@/core/agent/ports/abortRegistry';
import type { WorkspaceReader } from '@/core/agent/ports/workspaceReader';
import type { ToolInvoker } from '@/core/agent/ports/toolInvoker';
import type { CapsPort } from '@/core/agent/ports/capsPort';
import type { PlanModeState } from '@/core/agent/planMode';
import { runAgentLoop, type AgentLoopOptions, type AgentLoopResult } from '@/core/agent/agentLoop';
import { isRunPermissionCeiling } from '@/core/permissions/runPermissionCeiling';
import {
  createAgentRunTerminal,
  type AgentRunTerminal,
} from '@/core/agent/agentRunTerminal';
import { normalizeBatchTerminalSummary } from '@/core/agent/batchTerminalSummary';
import { enqueueUserInputWithId } from '@/core/agent/userInputQueue';
import { applyPlanModeState } from '@/core/agent/planMode';
import { TOOL_NAMES } from '@/core/tools/toolNames';
import { toolResultToString } from '@/core/tools/toolResultToString';
import { setSettingsReader } from '@/core/agent/ports/settingsReader';
import { RpcError } from './protocol';
import { sendRequest, sendNotification, setPreRequestFlush } from './rpcClient';
import { agentRunContext, type AgentRunContext } from './agentRunContext';
import { createPortFrameCoalescer, type PortFrame } from './portFrameCoalescer';
import { createFrameChatDelta, createFrameExecutionPort, createFrameScratchpadPort, type FrameChatDelta } from './portFrameSenders';
import { createConversationRunMirror, type ConversationPatch } from './conversationRunMirror';
import { seedSettingsMirrorIfEmpty, getSettingsMirrorReader, applySettingsSnapshot } from './settingsMirror';
import { hasLocalTool, isLocalToolReadOnly, executeLocalTool } from './localTools';
import { LOCAL_PATH_BOUND_TOOLS } from './localPathBoundTools';
import { sidecarRuntimeErrorType, traceSidecarRuntimeEvent } from './runtimeTrace';
import {
  materializeSidecarMediaRefsForShell,
  sidecarValueHasOpaqueMediaRefs,
} from '@/core/subagent/delegatedUserTurnMaterializer';
import { formatLlmTerminalError, LLMError, normalizeUpstreamErrorDetails } from '@/core/llm/adapter';

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

const REVERSE_TOOL_MEDIA_DISPLAY_ERROR = 'Error: Could not prepare sidecar tool media for display.';

export interface AgentRunParams {
  runId: string;
  clientMessageId?: string;
  payloadDigest?: string;
  conversationId: string;
  userMessage: string;
  options: {
    blockedTools?: string[];
    allowedTools?: string[];
    authorizationScopeId?: string;
    runPermissionCeiling?: import('@/core/permissions/runPermissionCeiling').RunPermissionCeiling;
    workspacePathSnapshot?: string | null;
    imContext?: IMContext;
    /** Who started the run (`'user'` | `'automation'`); see RunInitiator. */
    initiatedBy?: import('@/core/agent/runInteractionMode').RunInitiator;
    prePersistedUserMessageId?: string;
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
  if (params.clientMessageId !== undefined && (typeof params.clientMessageId !== 'string' || !params.clientMessageId)) {
    throw new RpcError(-32602, 'Invalid params: clientMessageId must be a non-empty string');
  }
  if (params.payloadDigest !== undefined && (typeof params.payloadDigest !== 'string' || !params.payloadDigest)) {
    throw new RpcError(-32602, 'Invalid params: payloadDigest must be a non-empty string');
  }
  if (typeof conversationId !== 'string' || !conversationId) throw new RpcError(-32602, 'Invalid params: conversationId must be a non-empty string');
  if (typeof userMessage !== 'string') throw new RpcError(-32602, 'Invalid params: userMessage must be a string');
  if (!isRecord(options)) throw new RpcError(-32602, 'Invalid params: options must be an object');
  for (const field of ['blockedTools', 'allowedTools'] as const) {
    const value = options[field];
    if (value !== undefined && (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))) {
      throw new RpcError(-32602, `Invalid params: options.${field} must be a string array`);
    }
  }
  if (options.prePersistedUserMessageId !== undefined && (
    typeof options.prePersistedUserMessageId !== 'string' || !options.prePersistedUserMessageId
  )) {
    throw new RpcError(-32602, 'Invalid params: options.prePersistedUserMessageId must be a non-empty string');
  }
  if (options.authorizationScopeId !== undefined && (typeof options.authorizationScopeId !== 'string' || !options.authorizationScopeId)) {
    throw new RpcError(-32602, 'Invalid params: options.authorizationScopeId must be a non-empty string');
  }
  if (
    options.runPermissionCeiling !== undefined
    && !isRunPermissionCeiling(options.runPermissionCeiling)
  ) {
    throw new RpcError(-32602, 'Invalid params: options.runPermissionCeiling must be a valid run permission ceiling');
  }
  if (options.workspacePathSnapshot !== undefined && options.workspacePathSnapshot !== null && typeof options.workspacePathSnapshot !== 'string') {
    throw new RpcError(-32602, 'Invalid params: options.workspacePathSnapshot must be a string or null');
  }
  if (options.initiatedBy !== undefined && options.initiatedBy !== 'user' && options.initiatedBy !== 'automation') {
    throw new RpcError(-32602, "Invalid params: options.initiatedBy must be 'user' or 'automation'");
  }
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

function digestRunPayload(value: string): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ code, 0x85ebca6b);
  }
  return `rrp1-${value.length.toString(16)}-${(left >>> 0).toString(16).padStart(8, '0')}${(right >>> 0).toString(16).padStart(8, '0')}`;
}

function canonicalizeForRunDigest(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeForRunDigest);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (key === 'payloadDigest' || record[key] === undefined) continue;
      out[key] = canonicalizeForRunDigest(record[key]);
    }
    return out;
  }
  return value;
}

export function buildAgentRunPayloadDigest(params: unknown): string {
  return digestRunPayload(JSON.stringify(canonicalizeForRunDigest(params)));
}

function assertAgentRunDigest(params: AgentRunParams): void {
  if (!params.clientMessageId || !params.payloadDigest) {
    throw new RpcError(-32602, 'Invalid params: agent.run requires clientMessageId and payloadDigest');
  }
  if (buildAgentRunPayloadDigest(params) !== params.payloadDigest) {
    throw new RpcError(-32602, 'Invalid params: payloadDigest does not match agent.run params');
  }
}

function toWireToolContext(context: ToolExecutionContext | undefined): ToolExecutionContext | undefined {
  if (!context) return undefined;
  const {
    abortSignal: _abortSignal,
    reportMetadata: _reportMetadata,
    ...wireContext
  } = context;
  return wireContext;
}

function isSubagentStopReason(value: unknown): value is SubagentStopReason {
  return value === 'completed' || value === 'aborted' || value === 'error' || value === 'max_turns';
}

function parseToolExecutionMetadata(
  value: unknown,
  expectedBatchIdentity?: { conversationId?: string; batchToolCallId?: string },
): ToolExecutionMetadata | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new RpcError(-32603, 'Invalid tool.invoke metadata envelope');
  const metadata: ToolExecutionMetadata = {};
  if (value.subagentStopReason !== undefined) {
    if (!isSubagentStopReason(value.subagentStopReason)) {
      throw new RpcError(-32603, 'Invalid tool.invoke subagent metadata envelope');
    }
    metadata.subagentStopReason = value.subagentStopReason;
  }
  if (value.batchTerminalSummary !== undefined) {
    const summary = normalizeBatchTerminalSummary(value.batchTerminalSummary, expectedBatchIdentity);
    if (!summary) {
      throw new RpcError(-32603, 'Invalid tool.invoke batch summary envelope');
    }
    metadata.batchTerminalSummary = summary;
  }
  if (value.sandboxRecovery !== undefined) {
    if (!isRecord(value.sandboxRecovery) || value.sandboxRecovery.kind !== 'app-automation') {
      throw new RpcError(-32603, 'Invalid tool.invoke sandbox recovery envelope');
    }
    metadata.sandboxRecovery = typeof value.sandboxRecovery.targetApp === 'string'
      ? { kind: 'app-automation', targetApp: value.sandboxRecovery.targetApp }
      : { kind: 'app-automation' };
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function unwrapToolInvokeResult(response: unknown, context: ToolExecutionContext | undefined): ToolResult {
  if (!isRecord(response)) return response as ToolResult;
  if (!('result' in response)) {
    throw new RpcError(-32603, 'Invalid tool.invoke metadata envelope');
  }
  const result = response.result;
  if (typeof result !== 'string' && !Array.isArray(result)) {
    throw new RpcError(-32603, 'Invalid tool.invoke result in subagent metadata envelope');
  }
  const metadata = parseToolExecutionMetadata(
    response.metadata ?? (
      response.subagentStopReason !== undefined
        ? { subagentStopReason: response.subagentStopReason }
        : undefined
    ),
    {
      conversationId: context?.conversationId,
      batchToolCallId: context?.toolCallId,
    },
  );
  if (metadata) context?.reportMetadata?.(metadata);
  return result as ToolResult;
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
/**
 * Result of {@link checkLocalToolApproval} — deliberately a 3-way outcome,
 * NOT a 2-way allow/deny bool (that was P1-3d-1/early-3d-3's shape and is
 * what caused the double-popup bug this type fixes — see P1-3d-4's report).
 * The two "not allow" cases are NOT interchangeable:
 *
 *   - `'deny'` — the shell gave a CLEAR, explicit answer: no. Its approval
 *     chain (`checkToolApproval`, registry.ts) already ran to completion —
 *     including any confirm/file-permission UI callback, which the user
 *     already answered. Falling back to the reverse `tool.invoke` path here
 *     would re-run that SAME chain a second time, popping the SAME
 *     confirmation dialog again for a call the user (or a hard block) just
 *     rejected. So a `'deny'` is terminal: return `reason` as the
 *     `ToolResult` directly, exactly like the reverse path's own
 *     `executeAnyTool` does on a deny (registry.ts) — never execute, never
 *     retry.
 *   - `'unavailable'` — the shell did NOT give a clear answer: a transport
 *     failure (rejected/thrown RPC) or a response that isn't a recognizable
 *     `{decision:'allow'|'deny'}` shape. This is "couldn't determine the
 *     answer", which must never be conflated with "the answer is no" — an
 *     `'unavailable'` result has NOT consumed any confirm/permission UI (the
 *     shell-side chain never got far enough to know), so falling back to the
 *     reverse `tool.invoke` path (which independently re-derives its own
 *     approval decision, including any UI) is the correct, safe, exactly-
 *     once-UI behavior — same fail-closed discipline as before, just no
 *     longer bucketed together with an explicit deny.
 */
type LocalApprovalOutcome =
  | { decision: 'allow'; executionPath?: string }
  | { decision: 'deny'; reason: string }
  | { decision: 'unavailable' };

/**
 * P1-3d-3 (docs/2026-07-21-phase1-p3d-tool-migration-design.md §3) — asks
 * the shell "would this local tool call be approved?" via the `approval.check`
 * reverse RPC (shell handler: `agentLoopRunner.ts`'s `handleApprovalCheck`,
 * which calls the SAME `checkToolApproval` — registry.ts — the reverse
 * `tool.invoke` path runs transitively; single source of truth, see that
 * function's doc). This closes the P1-3d-1 "Known gap" flagged in
 * `localTools/index.ts`'s module doc: locally-executed tools now go through
 * the shell's enterprise-policy pre-check (and command/path checks, for any
 * future non-Tier-A local tool) exactly like the reverse path does.
 *
 * 🔴 SECURITY-CRITICAL fail-closed contract: returns `{decision:'allow'}`
 * ONLY when the shell responds with a clean `{decision:'allow'}`. An
 * explicit `{decision:'deny', reason}` returns that exact shape (see
 * {@link LocalApprovalOutcome}'s doc for why the caller must treat it as
 * terminal, not retry it). EVERYTHING else — a malformed/unexpected
 * response shape, a thrown RPC error, a transport failure, a
 * timeout-via-rejection — returns `{decision:'unavailable'}`, never
 * `'allow'`. The caller (`createReverseToolInvoker`'s `executeAnyTool`)
 * NEVER runs `executeLocalTool` on anything but a clean `'allow'`. "Can't
 * determine the answer" must never be treated as "yes" — see the design
 * doc §3's safety-smoke rule this implements.
 */
async function checkLocalToolApproval(
  runId: string,
  toolName: string,
  input: Record<string, unknown>,
  context: ToolExecutionContext | undefined,
): Promise<LocalApprovalOutcome> {
  let result: unknown;
  try {
    result = await sendRequest('approval.check', { runId, toolName, input, context });
  } catch {
    // Transport error, timeout-via-rejection, or an RPC error response —
    // fail-closed: the shell never answered, treat as unavailable (fall
    // back to the reverse path's own independent approval chain below),
    // never as an allow.
    return { decision: 'unavailable' };
  }
  if (isRecord(result) && result.decision === 'allow') {
    const executionPath = typeof result.executionPath === 'string' && result.executionPath.length > 0
      ? result.executionPath
      : undefined;
    // File tools execute in this process, after shell-side path validation.
    // Without the canonical path from that ACK, executing the original
    // lexical path would reopen the symlink-retarget race. Treat the ACK as
    // unusable and let the reverse path perform a fresh approval+execution.
    if (LOCAL_PATH_BOUND_TOOLS.has(toolName) && !executionPath) {
      return { decision: 'unavailable' };
    }
    return executionPath ? { decision: 'allow', executionPath } : { decision: 'allow' };
  }
  if (isRecord(result) && result.decision === 'deny') {
    // Mirror registry.ts's executeAnyTool default exactly (`approval.reason
    // ?? \`Error: tool "${name}" was denied\``) so a deny surfaces the same
    // ToolResult text regardless of which path (local or reverse) hit it.
    const reason = typeof result.reason === 'string' ? result.reason : `Error: tool "${toolName}" was denied`;
    return { decision: 'deny', reason };
  }
  // Anything else — result isn't a record, or `decision` isn't a recognized
  // 'allow'/'deny' value — is a malformed response, NOT an explicit deny.
  // The shell answered SOMETHING, but not in a shape we can act on; treat it
  // the same as "no answer" (unavailable), never default to allow.
  return { decision: 'unavailable' };
}

async function materializeReverseToolResultForSidecarProvider(
  result: ToolResult,
  conversationId: string,
  signal: AbortSignal | undefined,
): Promise<ToolResult> {
  let hasOpaqueMediaRefs: boolean;
  try {
    hasOpaqueMediaRefs = sidecarValueHasOpaqueMediaRefs(result);
  } catch {
    return REVERSE_TOOL_MEDIA_DISPLAY_ERROR;
  }
  if (!hasOpaqueMediaRefs) return result;
  try {
    return await materializeSidecarMediaRefsForShell(result, conversationId, signal) as ToolResult;
  } catch {
    return REVERSE_TOOL_MEDIA_DISPLAY_ERROR;
  }
}

function createReverseToolInvoker(
  runId: string,
  initialTools: SerializableToolDefinition[],
  mediaOriginConversationId: string,
): ToolInvoker {
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
    executeAnyTool: async (name, input, _onConfirm, _onFilePerm, context, contextUsagePercent) => {
      // P1-3d-1 (docs/2026-07-21-phase1-p3d-tool-migration-design.md §1) —
      // local dispatch: a hit in the sidecar's local tool registry runs
      // execute() in-process, skipping the tool.invoke round-trip entirely.
      // See localTools/index.ts's module doc for exactly which tools are
      // registered, why each is bundle-safe, and the readOnly/fallback
      // discipline this branch relies on.
      //
      // P1-3d-3/3d-4: before running it locally, ask the shell via
      // `approval.check` — this is what closes the P1-3d-1 enterprise-policy
      // gap (see checkLocalToolApproval's doc). Only a clean `'allow'`
      // proceeds to local execution.
      //
      // 🔴 P1-3d-4 fix — a plain `deny` MUST NOT fall back to `tool.invoke`.
      // The shell's `approval.check` already ran the FULL approval chain
      // (`checkToolApproval`, registry.ts) to a conclusion, including any
      // confirm/file-permission UI callback the user already answered.
      // Falling back to `tool.invoke` here would re-run that SAME chain a
      // second time — popping the SAME confirmation dialog twice for one
      // tool call (the P1-3d-3 double-popup bug this fixes). So a `'deny'`
      // is terminal: return its `reason` directly as the `ToolResult`,
      // exactly like the reverse path's own `executeAnyTool` does on a deny
      // (registry.ts: `return approval.reason ?? ...`) — never execute,
      // never retry. Only `'unavailable'` (transport failure, or a
      // malformed/unrecognized response — see `LocalApprovalOutcome`'s doc
      // for why that's NOT the same as an explicit deny) falls through to
      // the reverse `tool.invoke` path, which re-derives its own approval
      // decision (and any UI) independently and exactly once.
      if (hasLocalTool(name)) {
        const approval = await checkLocalToolApproval(runId, name, input, toWireToolContext(context as ToolExecutionContext | undefined));
        if (approval.decision === 'deny') {
          return approval.reason;
        }
        if (approval.decision === 'allow') {
          // Stop can win in the microtask gap after the shell's allow ACK is
          // received but before this local execute() begins. The shell's
          // post-approval barrier protects ACK creation; this second,
          // sidecar-local barrier protects ACK consumption.
          if (context?.abortSignal?.aborted) {
            const error = new Error('Tool execution aborted');
            error.name = 'AbortError';
            throw error;
          }
          try {
            const approvedInput = approval.executionPath
              ? { ...input, path: approval.executionPath }
              : input;
            return await executeLocalTool(
              name,
              approvedInput,
              context as ToolExecutionContext | undefined,
              contextUsagePercent,
            );
          } catch (err) {
            // A throw here means executeLocalTool's OWN dispatch layer failed
            // (NOT a normal tool-level error — those are already caught
            // inside executeLocalTool and returned as an error-string
            // ToolResult, matching registry.ts's ToolRegistry.execute
            // contract exactly). Only fall through to the reverse
            // tool.invoke path below when this tool is registered
            // readOnly:true (isLocalToolReadOnly(name)) — a safe, idempotent
            // retry, NOT a double-execution risk. A side-effecting local
            // tool MUST be registered with readOnly:false so this rethrows
            // instead (see localTools/index.ts's module doc) —
            // "committed once started", same discipline as
            // agentLoopRunner.ts's RunSession.committed.
            if (!isLocalToolReadOnly(name)) throw err;
          }
        }
        // approval.decision === 'unavailable' (transport failure or a
        // malformed/unrecognized approval.check response) — local execute()
        // was NEVER invoked, so falling through to the reverse tool.invoke
        // path below is always safe (nothing to double-execute, and no UI
        // has fired yet for this call).
      }
      const response = await sendRequest('tool.invoke', {
        runId,
        toolName: name,
        input,
        context: toWireToolContext(context as ToolExecutionContext | undefined),
      });
      const result = unwrapToolInvokeResult(response, context as ToolExecutionContext | undefined);
      if (name === TOOL_NAMES.MANAGE_MCP_SERVER) refreshInBackground();
      return await materializeReverseToolResultForSidecarProvider(
        result,
        mediaOriginConversationId,
        (context as ToolExecutionContext | undefined)?.abortSignal,
      );
    },
    toolResultToString,
  };
}

interface ActiveRun {
  conversationId: string;
  /** The loop's internal loopId — identical to the runId by the P1-3B-3B
   *  convention (see handleAgentRun's `loopId: runId` option). Stored so
   *  cross-surface writers (subagentHost's image persistence) can target
   *  the loop's message without re-deriving the convention. */
  loopId: string;
  /** This run's frame-sender ChatDelta — writes through it reach the run's
   *  conversation mirror AND the shell, in frame order, so they survive the
   *  ledger checkpoint (a shell-only write would be clobbered by it). */
  chatDelta: FrameChatDelta;
  controllers: Map<string, AbortController>;
  coalescer: ReturnType<typeof createPortFrameCoalescer>;
  applyConvPatch: (patch: ConversationPatch) => void;
  applyExecPatch: (conversationId: string, plannedSteps: PlannedStep[]) => void;
}

const activeRuns = new Map<string, ActiveRun>();

/**
 * Find the ACTIVE main-loop run for a conversation, exposing just the pieces
 * a cross-surface writer needs: its frame ChatDelta and loopId.
 *
 * Consumer: subagentHost's image persistence. A delegate's subagent runs via
 * its OWN subagent.run RPC while the parent loop runs here — for the
 * subagent's image-bearing tool call to survive the parent run's ledger
 * checkpoint, the `appendMessageToolCall` write must originate on THIS side
 * (mirror + frame), not shell-only. The one-live-run-per-conversation
 * invariant (agentLoopRunner's concurrency guard) makes the first match the
 * only match. Returns undefined when the parent loop is not sidecar-run —
 * the shell-side append is authoritative there.
 */
export function findActiveRunDeltaForConversation(
  conversationId: string,
): { chatDelta: ChatDelta; loopId: string } | undefined {
  for (const run of activeRuns.values()) {
    if (run.conversationId === conversationId) {
      return { chatDelta: run.chatDelta, loopId: run.loopId };
    }
  }
  return undefined;
}

export interface AgentStartAck {
  version: 1;
  runId: string;
  clientMessageId: string;
  acceptedAt: number;
  state: 'accepted' | 'running' | 'terminal';
  replay: boolean;
  terminal?: AgentRunTerminal;
}

export interface AgentRunStateResult {
  version: 1;
  runId: string;
  state: 'not_found' | 'accepted' | 'running' | 'terminal';
  clientMessageId?: string;
  acceptedAt?: number;
  terminal?: AgentRunTerminal;
}

interface RunRegistryEntry {
  params: AgentRunParams;
  payloadDigest: string;
  clientMessageId: string;
  acceptedAt: number;
  state: 'accepted' | 'running' | 'terminal';
  cancelRequested: boolean;
  terminal?: AgentRunTerminal;
  terminalAt?: number;
}

const RUN_REGISTRY_MAX_ENTRIES = 128;
const RUN_REGISTRY_TERMINAL_TTL_MS = 60 * 60 * 1_000;
const runRegistry = new Map<string, RunRegistryEntry>();

function pruneRunRegistry(now = Date.now()): void {
  for (const [runId, entry] of runRegistry) {
    if (
      entry.state === 'terminal'
      && now - (entry.terminalAt ?? entry.acceptedAt) > RUN_REGISTRY_TERMINAL_TTL_MS
    ) {
      runRegistry.delete(runId);
    }
  }
  if (runRegistry.size <= RUN_REGISTRY_MAX_ENTRIES) return;
  const terminalEntries = [...runRegistry.entries()]
    .filter(([, entry]) => entry.state === 'terminal')
    .sort((a, b) => (a[1].terminalAt ?? 0) - (b[1].terminalAt ?? 0));
  for (const [runId] of terminalEntries) {
    if (runRegistry.size <= RUN_REGISTRY_MAX_ENTRIES) break;
    runRegistry.delete(runId);
  }
}

function toStartAck(entry: RunRegistryEntry, replay: boolean): AgentStartAck {
  return {
    version: 1,
    runId: entry.params.runId,
    clientMessageId: entry.clientMessageId,
    acceptedAt: entry.acceptedAt,
    state: entry.state,
    replay,
    ...(entry.terminal ? { terminal: entry.terminal } : {}),
  };
}

function rememberTerminal(runId: string, terminal: AgentRunTerminal): void {
  const entry = runRegistry.get(runId);
  if (!entry || entry.terminal) return;
  entry.state = 'terminal';
  entry.terminal = terminal;
  entry.terminalAt = Date.now();
  pruneRunRegistry(entry.terminalAt);
}

/**
 * Reliable Run Protocol V1 phase 1: acknowledge ownership immediately, then
 * execute independently from the request that carried the start command.
 * Replaying the same ids/digest returns the existing fact and never starts a
 * second loop; conflicting reuse of a runId fails closed.
 */
export function handleAgentStart(rawParams: unknown): AgentStartAck {
  const params = parseAgentRunParams(rawParams);
  if (!params.clientMessageId || !params.payloadDigest) {
    throw new RpcError(-32602, 'Invalid params: agent.start requires clientMessageId and payloadDigest');
  }
  assertAgentRunDigest(params);
  pruneRunRegistry();
  const existing = runRegistry.get(params.runId);
  if (existing) {
    if (
      existing.payloadDigest !== params.payloadDigest
      || existing.clientMessageId !== params.clientMessageId
    ) {
      throw new RpcError(-32602, `Conflicting replay for runId "${params.runId}"`);
    }
    traceSidecarRuntimeEvent('sidecar.agent_start_replayed', {
      runId: params.runId,
      method: 'agent.start',
      stage: existing.state,
    });
    return toStartAck(existing, true);
  }

  const entry: RunRegistryEntry = {
    params,
    payloadDigest: params.payloadDigest,
    clientMessageId: params.clientMessageId,
    acceptedAt: Date.now(),
    state: 'accepted',
    cancelRequested: false,
  };
  runRegistry.set(params.runId, entry);
  traceSidecarRuntimeEvent('sidecar.agent_start_accepted', {
    runId: params.runId,
    method: 'agent.start',
    stage: 'accepted',
  });

  return toStartAck(entry, false);
}

export function handleAgentGetState(rawParams: unknown): AgentRunStateResult {
  if (!isRecord(rawParams) || typeof rawParams.runId !== 'string' || !rawParams.runId) {
    throw new RpcError(-32602, 'Invalid params: runId must be a non-empty string');
  }
  pruneRunRegistry();
  const entry = runRegistry.get(rawParams.runId);
  if (!entry) return { version: 1, runId: rawParams.runId, state: 'not_found' };
  return {
    version: 1,
    runId: rawParams.runId,
    state: entry.state,
    clientMessageId: entry.clientMessageId,
    acceptedAt: entry.acceptedAt,
    ...(entry.terminal ? { terminal: entry.terminal } : {}),
  };
}

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
  const rawParsedParams = parseAgentRunParams(rawParams);
  assertAgentRunDigest(rawParsedParams);
  const { runId } = rawParsedParams;
  const startedAt = Date.now();
  const registryEntry = runRegistry.get(runId);
  if (!registryEntry) {
    throw new RpcError(-32602, `Invalid params: agent.run requires prior agent.start for runId "${runId}"`);
  }
  if (
    registryEntry.payloadDigest !== rawParsedParams.payloadDigest
    || registryEntry.clientMessageId !== rawParsedParams.clientMessageId
  ) {
    throw new RpcError(-32602, `Conflicting agent.run for runId "${runId}"`);
  }
  const params = registryEntry.params;
  const { conversationId } = params;
  if (registryEntry?.state === 'terminal' && registryEntry.terminal) {
    return registryEntry.terminal.result;
  }
  if (registryEntry?.cancelRequested) {
    const result: AgentLoopResult = { reason: 'aborted' };
    const terminal = createAgentRunTerminal(runId, result);
    rememberTerminal(runId, terminal);
    sendNotification('agent.terminal', terminal);
    return terminal.result;
  }
  if (registryEntry) registryEntry.state = 'running';
  traceSidecarRuntimeEvent('sidecar.agent_run_received', {
    runId,
    method: 'agent.run',
    stage: 'params_parsed',
  });

  if (activeRuns.has(runId)) {
    throw new RpcError(-32602, `Invalid params: runId "${runId}" is already active`);
  }

  seedSettingsMirrorIfEmpty(params.settingsSnapshot);
  // P1-3d-1 — wire the bare settingsReader port getter (used directly by
  // locally-executed Tier A tools, e.g. web_search — see
  // localTools/index.ts's module doc) to the SAME live settings mirror
  // agentLoop.ts's own injected settingsReader reads through. Idempotent
  // and cheap to call every run; before this, nothing in the sidecar ever
  // called setSettingsReader(), so that bare getter's default
  // (shims/settingsReaderRun.ts) always threw.
  setSettingsReader(getSettingsMirrorReader());

  let emittedFirstDelta = false;
  const coalescer = createPortFrameCoalescer((frames) => {
    if (!emittedFirstDelta && frames.length > 0) {
      emittedFirstDelta = true;
      traceSidecarRuntimeEvent('sidecar.agent_delta_emitted', {
        runId,
        frameCount: frames.length,
        stage: 'first_delta_emitted',
        durationMs: Date.now() - startedAt,
      });
    }
    sendNotification('agent.delta', { runId, frames });
  });
  const push = (frame: PortFrame): void => coalescer.push(frame);

  const mirror = createConversationRunMirror(conversationId, {
    conversation: params.conversationSnapshot,
    indexEntry: params.indexEntrySnapshot,
  });

  const chatDelta = createFrameChatDelta(push, mirror.applyChatDeltaWrite);
  const pushOrdered = (frame: PortFrame): void => chatDelta.pushTransportFrame(frame);
  const scratchpadPort = createFrameScratchpadPort(pushOrdered);

  // ── ExecutionPort + plannedSteps patch mirror (item 6 — see design gap
  // escalated in P1-3B-2-REPORT.md §2b / this batch's report §6) ──────────
  const innerExecPort = createFrameExecutionPort(push, chatDelta.pushTransportTask);
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
  const createdControllers = new Set<AbortController>();
  const abortRegistry: AbortRegistry = {
    hasAbortController: (convId) => controllers.has(convId),
    getAbortController: (convId) => {
      let c = controllers.get(convId);
      if (!c) {
        c = new AbortController();
        controllers.set(convId, c);
        createdControllers.add(c);
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
  const toolInvoker = createReverseToolInvoker(runId, params.toolList, conversationId);

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
    pushFrame: pushOrdered,
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
    loopId: runId,
    chatDelta,
    controllers,
    coalescer,
    applyConvPatch: mirror.applyConvPatch,
    applyExecPatch,
  });
  traceSidecarRuntimeEvent('sidecar.agent_loop_started', {
    runId,
    conversationId,
    stage: 'agent_loop_running',
    durationMs: Date.now() - startedAt,
  });

  try {
    const options: AgentLoopOptions = {
      blockedTools: params.options.blockedTools,
      allowedTools: params.options.allowedTools,
      authorizationScopeId: params.options.authorizationScopeId,
      runPermissionCeiling: params.options.runPermissionCeiling,
      imContext: params.options.imContext,
      initiatedBy: params.options.initiatedBy,
      prePersistedUserMessageId: params.options.prePersistedUserMessageId,
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
      runtimeEvent: (event, attributes) => {
        // Stamp the conversation so loop-emitted sidecar events join the same
        // run timeline as the renderer/main planes during diagnosis; an
        // explicit conversationId from the loop still wins.
        traceSidecarRuntimeEvent(`sidecar.${event}`, { conversationId, ...attributes });
      },
    };
    const result: AgentLoopResult = await agentRunContext.run(runCtx, () =>
      runAgentLoop(conversationId, params.userMessage, options),
    );
    traceSidecarRuntimeEvent('sidecar.agent_run_completed', {
      runId,
      conversationId,
      stage: 'completed',
      outcome: result.reason,
      durationMs: Date.now() - startedAt,
    });
    // Terminal fact is ordered AFTER every final delta frame and BEFORE the
    // RPC response. If that response is lost, the shell can still settle the
    // run from this idempotent notification without re-executing any work.
    await chatDelta.drain();
    coalescer.flush();
    const terminal = createAgentRunTerminal(runId, result);
    rememberTerminal(runId, terminal);
    sendNotification('agent.terminal', terminal);
    return terminal.result;
  } catch (error) {
    traceSidecarRuntimeEvent('sidecar.agent_run_failed', {
      runId,
      conversationId,
      stage: 'failed',
      outcome: 'error',
      errorType: sidecarRuntimeErrorType(error),
      durationMs: Date.now() - startedAt,
    });
    await chatDelta.drain();
    coalescer.flush();
    const upstream = error instanceof LLMError
      ? normalizeUpstreamErrorDetails(error.upstream)
      : undefined;
    const message = error instanceof LLMError
      ? formatLlmTerminalError(error)
      : error instanceof Error ? error.message : String(error);
    const terminal = createAgentRunTerminal(
      runId,
      {
        reason: 'error',
        error: message,
        messageTaken: true,
        ...(upstream ? { upstream } : {}),
      },
      {
        errorType: sidecarRuntimeErrorType(error),
        message,
        ...(error instanceof Error && !(error instanceof LLMError) && error.stack
          ? { stack: error.stack }
          : {}),
        ...(upstream ? { upstream } : {}),
      },
    );
    rememberTerminal(runId, terminal);
    sendNotification('agent.terminal', terminal);
    if (error instanceof LLMError) {
      throw new RpcError(-32000, message, {
        name: 'LLMError',
        code: error.code,
        retryable: error.retryable,
        statusCode: error.statusCode,
        message,
        ...(upstream ? { upstream } : {}),
      });
    }
    throw error;
  } finally {
    coalescer.flush();
    if (params.options.authorizationScopeId !== undefined) {
      for (const controller of createdControllers) {
        if (!controller.signal.aborted) {
          controller.abort(new Error('Scoped agent run finished'));
        }
      }
    }
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

export interface AgentAbortAck {
  accepted: boolean;
  state: 'aborting' | 'not_found';
}

/**
 * `{ runId }` — abort THIS run's conversation-scoped AbortController and
 * return an acknowledgement. Flushing before the ACK creates an ordering
 * barrier: every frame emitted before Stop is already on stdout before the
 * shell receives this response and performs its own idempotent finalization.
 * Unknown/already-finished runIds are still safe and idempotent.
 */
export async function handleAgentAbort(rawParams: unknown): Promise<AgentAbortAck> {
  const { runId } = parseAbortParams(rawParams);
  const run = activeRuns.get(runId);
  traceSidecarRuntimeEvent('sidecar.agent_abort_received', {
    runId,
    method: 'agent.abort',
    stage: run ? 'aborting' : 'not_found',
  });
  if (!run) {
    const registered = runRegistry.get(runId);
    if (!registered || registered.state === 'terminal') {
      return { accepted: false, state: 'not_found' };
    }
    registered.cancelRequested = true;
    return { accepted: true, state: 'aborting' };
  }
  run.coalescer.flush();
  run.controllers.get(run.conversationId)?.abort();
  await run.chatDelta.drain();
  run.coalescer.flush();
  traceSidecarRuntimeEvent('sidecar.agent_abort_ack_ready', {
    runId,
    method: 'agent.abort',
    stage: 'aborting',
    outcome: 'success',
  });
  return { accepted: true, state: 'aborting' };
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
  for (const entry of runRegistry.values()) {
    if (entry.state !== 'terminal') entry.cancelRequested = true;
  }
  for (const run of activeRuns.values()) {
    for (const controller of run.controllers.values()) controller.abort();
  }
}

/** Test-only accessor. */
export function __getActiveAgentRunCount(): number {
  return activeRuns.size;
}

/** Test-only reset for the bounded idempotency registry. */
export function __resetAgentRunRegistryForTests(): void {
  runRegistry.clear();
}
