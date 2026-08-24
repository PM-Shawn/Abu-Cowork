/**
 * Subagent host — sidecar-side handler for the `subagent.run` /
 * `subagent.abort` protocol extension (P1-3a "正式步 3a", see
 * docs/2026-07-19-phase1-p3-loop-migration-staging.md §2). Runs the REAL,
 * bundled `runSubagentLoop` (from `src/core/agent/subagentLoop.ts`) inside
 * this process, with per-run injected `SettingsReader`/`ToolInvoker` ports
 * (P1-3a-pre's port #7 + the new per-run-injectable-options extension —
 * see subagentLoop.ts's `SubagentLoopOptions.settingsReader`/`toolInvoker`).
 *
 * Per-run isolation: each `subagent.run` gets its OWN `AbortController`,
 * `ToolInvoker` (closes over its OWN `runId` for `tool.invoke` routing),
 * and `AsyncLocalStorage` context (`subagentRunContext.ts` — carries the
 * i18n bag / resolved LLM creds to the shimmed leaves that read them via
 * bare imports rather than injected ports). Two concurrent runs never share
 * mutable state.
 *
 * Tool execution ALWAYS reverses to the shell via `tool.invoke` — no local
 * short-circuit for the fs six-family this phase (see this file's
 * `createReverseToolInvoker` doc comment for why: correctness over latency,
 * per the design doc's explicit instruction).
 */
import type { SubagentDefinition, ToolDefinition, ToolExecutionContext, ToolResult } from '@/types';
import type { IMContext } from '@/core/agent/orchestrator';
import type { SettingsReader } from '@/core/agent/ports/settingsReader';
import type { ToolInvoker } from '@/core/agent/ports/toolInvoker';
import type { CapsPort } from '@/core/agent/ports/capsPort';
import type { WorkspaceReader } from '@/core/agent/ports/workspaceReader';
import type { SettingsState } from '@/stores/settingsStore';
import type { SubagentUiStrings } from '@/core/agent/subagentUiStrings';
import { runSubagentLoop, type SubagentLoopOptions, type SubagentProgressEvent, type SubagentStopReason } from '@/core/agent/subagentLoop';
import { toolResultToString } from '@/core/tools/toolResultToString';
import { RpcError } from './protocol';
import { sendRequest, sendNotification } from './rpcClient';
import { findActiveRunDeltaForConversation } from './agentLoopHost';
import { subagentRunContext, type SubagentRunContext } from './subagentRunContext';
import { SUBAGENT_RUN_WIRE_FIELDS as SHARED_SUBAGENT_RUN_WIRE_FIELDS } from '@/core/agent/subagentWireContract';

interface SerializableToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolDefinition['inputSchema'];
}

function toWireToolContext(context: ToolExecutionContext | undefined): ToolExecutionContext | undefined {
  if (!context) return undefined;
  const { abortSignal: _abortSignal, ...wireContext } = context;
  return wireContext;
}

export interface SubagentHostRunParams {
  runId: string;
  agent: SubagentDefinition;
  task: string;
  context?: string;
  parentConversationSummary?: string;
  parentConversationId?: string;
  imContext?: IMContext;
  allowedTools?: string[];
  /** Run-scoped denylist — must mirror allowedTools across the wire (see
   *  subagentRunner.ts's SubagentRunParams doc: omitting it silently
   *  disarmed every blockedTools-only safety tier on the sidecar path). */
  blockedTools?: string[];
  locale: string;
  uiStrings: SubagentUiStrings;
  settingsSnapshot: SettingsState;
  resolvedCreds: { apiKey: string; baseUrl: string | undefined; forceOpenAiCompatible: boolean };
  tools: SerializableToolDefinition[];
  workspacePathSnapshot: string | null;
}

export const SUBAGENT_HOST_RUN_WIRE_FIELDS =
  SHARED_SUBAGENT_RUN_WIRE_FIELDS satisfies readonly (keyof SubagentHostRunParams)[];

type AssertNever<T extends never> = T;

type SubagentWireBackedLoopOptionField = Extract<
  typeof SUBAGENT_HOST_RUN_WIRE_FIELDS[number],
  keyof SubagentLoopOptions
>;

type SubagentHostOnlyRunWireField = Exclude<
  typeof SUBAGENT_HOST_RUN_WIRE_FIELDS[number],
  keyof SubagentLoopOptions
>;

export const SUBAGENT_HOST_ONLY_RUN_WIRE_FIELDS = [
  'runId',
  'locale',
  'uiStrings',
  'settingsSnapshot',
  'resolvedCreds',
  'tools',
  'workspacePathSnapshot',
] as const satisfies readonly SubagentHostOnlyRunWireField[];

/** Runtime form of `SUBAGENT_RUN_WIRE_FIELDS ∩ keyof SubagentLoopOptions`.
 * The reverse exhaustiveness gate below makes a newly-added host-only field
 * fail typecheck until it is classified here; every other canonical wire
 * field is therefore a loop option and enters this derived list automatically.
 */
const hostOnlyRunWireFieldSet = new Set<string>(SUBAGENT_HOST_ONLY_RUN_WIRE_FIELDS);
export const SUBAGENT_HOST_LOOP_OPTION_WIRE_FIELDS = SUBAGENT_HOST_RUN_WIRE_FIELDS.filter(
  (field): field is SubagentWireBackedLoopOptionField => !hostOnlyRunWireFieldSet.has(field),
);

/** Reverse exhaustiveness gate in production code; sidecar tests are not a
 * substitute for `tsc` checking newly-added host params against the wire. */
export type SubagentHostRunParamsWireExhaustive = AssertNever<
  Exclude<keyof SubagentHostRunParams, typeof SUBAGENT_HOST_RUN_WIRE_FIELDS[number]>
>;

export type SubagentHostOnlyRunWireFieldsExhaustive = AssertNever<
  Exclude<SubagentHostOnlyRunWireField, typeof SUBAGENT_HOST_ONLY_RUN_WIRE_FIELDS[number]>
>;

interface SerializableSubagentResult {
  text: string;
  toolCallCount: number;
  turnCount: number;
  tokenUsage: { input: number; output: number };
  duration: number;
  stopReason: SubagentStopReason;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseSubagentRunParams(params: unknown): SubagentHostRunParams {
  if (!isRecord(params)) throw new RpcError(-32602, 'Invalid params: expected object');
  const { runId, agent, task, tools, settingsSnapshot, resolvedCreds, uiStrings, locale } = params;
  if (typeof runId !== 'string' || !runId) {
    throw new RpcError(-32602, 'Invalid params: runId must be a non-empty string');
  }
  if (!isRecord(agent) || typeof (agent as { name?: unknown }).name !== 'string') {
    throw new RpcError(-32602, 'Invalid params: agent must be a SubagentDefinition');
  }
  if (typeof task !== 'string') {
    throw new RpcError(-32602, 'Invalid params: task must be a string');
  }
  if (!Array.isArray(tools)) {
    throw new RpcError(-32602, 'Invalid params: tools must be an array');
  }
  if (!isRecord(settingsSnapshot)) {
    throw new RpcError(-32602, 'Invalid params: settingsSnapshot must be an object');
  }
  if (!isRecord(resolvedCreds)) {
    throw new RpcError(-32602, 'Invalid params: resolvedCreds must be an object');
  }
  if (!isRecord(uiStrings)) {
    throw new RpcError(-32602, 'Invalid params: uiStrings must be an object');
  }
  if (typeof locale !== 'string') {
    throw new RpcError(-32602, 'Invalid params: locale must be a string');
  }
  if (
    params.allowedTools !== undefined &&
    (!Array.isArray(params.allowedTools) || params.allowedTools.some((entry) => typeof entry !== 'string'))
  ) {
    throw new RpcError(-32602, 'Invalid params: allowedTools must be a string array');
  }
  if (
    params.blockedTools !== undefined &&
    (!Array.isArray(params.blockedTools) || params.blockedTools.some((entry) => typeof entry !== 'string'))
  ) {
    throw new RpcError(-32602, 'Invalid params: blockedTools must be a string array');
  }
  const { workspacePathSnapshot } = params;
  if (workspacePathSnapshot !== null && typeof workspacePathSnapshot !== 'string') {
    throw new RpcError(-32602, 'Invalid params: workspacePathSnapshot must be a string or null');
  }
  return params as unknown as SubagentHostRunParams;
}

/**
 * Bounded, DOCUMENTED degradation (not a silent no-op): `subagentLoop.ts`
 * calls `capsPort.get()` to overlay runtime-discovered model capability
 * overrides (max output tokens / context window / reasoning-observed) on
 * top of the static capability table, and `capsPort.recordReasoningObserved()`
 * to persist a newly-observed reasoning model back to
 * `discoveredCapabilitiesStore` for future runs.
 *
 * Doing this correctly out-of-process requires an ack/mirror contract —
 * `capsPort.ts`'s OWN module doc already flags this as a real design
 * concern for any future out-of-process implementation ("MUST NOT
 * fire-and-forget the record* writes... without an ack or a
 * synchronously-updated local mirror"). Building that full bidirectional
 * channel is out of scope for this card (not in the "per-run injectable
 * options" list the design doc names, and not needed for a subagent to
 * complete its task correctly).
 *
 * So: `get()` always returns `undefined` (falls back to the static
 * capability table — the same behavior a fresh install with no discovered
 * overrides yet already has) and the `record*` writes are no-ops (this
 * run's capability discovery, if any, just doesn't get persisted for
 * future runs — a lost optimization, not a correctness bug: the model
 * still gets a sane budget via the static table + the reactive
 * `thinking: 'uncontrollable'` fallback subagentLoop.ts already has for an
 * unexpectedly-reasoning model). Documented here and in P1-3a-REPORT.md as
 * a known limitation, per the card's "escalate cleanly instead of silently
 * degrade" rule — this IS the escalation.
 */
function createDegradedCapsPort(): CapsPort {
  return {
    get: () => undefined,
    recordMaxOutputTokens: () => {},
    recordContextWindow: () => {},
    recordReasoningObserved: () => {},
  };
}

function parseAbortParams(params: unknown): { runId: string } {
  if (!isRecord(params) || typeof params.runId !== 'string') {
    throw new RpcError(-32602, 'Invalid params: runId must be a string');
  }
  return { runId: params.runId };
}

/**
 * Builds a per-run `ToolInvoker` whose `getAllTools()` returns the STATIC
 * snapshot pushed in `subagent.run` params (each entry's `execute` is a
 * defensive stub that throws if ever called — it never should be:
 * `executeAnyTool` below is the only path subagentLoop.ts actually calls,
 * and it ALWAYS reverses to the shell). `executeAnyTool()` sends a
 * `tool.invoke` request back to the shell for EVERY tool, including the fs
 * six-family — no local short-circuit via `fsHost.ts` this phase. The
 * design doc explicitly allows a short-circuit ONLY if the semantics are
 * verified identical to the shell's wrapped path (pathSafety + permissions
 * + approvals live in `src/core/tools/registry.ts`'s wrappers around raw
 * fs, not in `fsHost.ts` itself, which is a bare fs bridge with NO
 * safety/permission logic — see fsHost.ts's own module doc: "No path-safety
 * / permission logic lives here"). Verifying that equivalence is out of
 * scope for this phase, so per "when in doubt, everything goes reverse —
 * correctness over latency", every tool call round-trips to the shell.
 */
function createReverseToolInvoker(runId: string, tools: SerializableToolDefinition[]): ToolInvoker {
  const fullTools: ToolDefinition[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    execute: async () => {
      throw new Error(
        `[sidecar] ToolDefinition.execute() called directly for "${t.name}" — this should never happen; subagentLoop.ts only calls invoker.executeAnyTool(), which reverses to the shell via tool.invoke.`,
      );
    },
  }));

  return {
    getAllTools: () => fullTools,
    executeAnyTool: async (name, input, _onConfirm, _onFilePerm, context) => {
      return (await sendRequest('tool.invoke', {
        runId,
        toolName: name,
        input,
        context: toWireToolContext(context as ToolExecutionContext | undefined),
      })) as ToolResult;
    },
    toolResultToString,
  };
}

const activeRuns = new Map<string, { controller: AbortController }>();

export async function handleSubagentRun(rawParams: unknown): Promise<unknown> {
  const params = parseSubagentRunParams(rawParams);
  const { runId } = params;

  if (activeRuns.has(runId)) {
    throw new RpcError(-32602, `Invalid params: runId "${runId}" is already active`);
  }

  const controller = new AbortController();
  activeRuns.set(runId, { controller });

  const settingsReader: SettingsReader = { getSnapshot: () => params.settingsSnapshot };
  const toolInvoker = createReverseToolInvoker(runId, params.tools);
  const workspaceReader: WorkspaceReader = { getCurrentPath: () => params.workspacePathSnapshot };
  const capsPort = createDegradedCapsPort();
  // tool-start inputs, cached so the tool-end image-persistence path below can
  // record the call with its real input (tool-end events don't carry it).
  const toolInputById = new Map<string, Record<string, unknown>>();

  const runCtx: SubagentRunContext = {
    runId,
    locale: params.locale,
    uiStrings: params.uiStrings,
    resolvedCreds: params.resolvedCreds,
  };

  // Record<> is intentional: optional loop fields still have to be present in
  // this projection (while preserving their `undefined` value type) so adding
  // a canonical wire-backed option cannot compile until the host forwards it.
  const wireBackedLoopOptions = {
    agent: params.agent,
    task: params.task,
    context: params.context,
    parentConversationSummary: params.parentConversationSummary,
    parentConversationId: params.parentConversationId,
    imContext: params.imContext,
    allowedTools: params.allowedTools,
    blockedTools: params.blockedTools,
  } satisfies Pick<SubagentLoopOptions, SubagentWireBackedLoopOptionField>
    & Record<SubagentWireBackedLoopOptionField, unknown>;

  const options: SubagentLoopOptions = {
    ...wireBackedLoopOptions,
    signal: controller.signal,
    settingsReader,
    toolInvoker,
    workspaceReader,
    capsPort,
    // Progress forwarding (follow-up to the initial P1-3a delivery — see
    // P1-3a-REPORT.md §10 concern #1, now CLOSED): subagentLoop.ts's
    // tool-start/tool-end/turn-complete onProgress callback feeds the
    // shell's execution-panel child-step visualization
    // (delegate_to_agent/run_agent_batch's onProgress wiring in
    // agentTools.ts/orchestrationTools.ts). Without this, a sidecar-run
    // subagent would look completely frozen until the final result —
    // fire-and-forget NOTIFICATION per event (same discipline as
    // hook.notify: progress must never block the loop on an ack).
    //
    // Serializability: every SubagentProgressEvent variant is already
    // JSON-safe. tool-start's `toolInput` is the parsed tool_use JSON
    // object (always JSON-safe — it came FROM parsed JSON). tool-end
    // carries the stringified `result` plus an optional `resultContent`
    // (the raw ToolResultContent[] blocks, for child-step image
    // rendering) — both plain data: resultContent is the same JSON-safe
    // array the tool.invoke response already carried in this direction's
    // mirror, so forwarding it back is a second copy of known-serializable
    // data, not a new projection concern. turn-complete is two numbers.
    // Verified by reading, not assumed.
    //
    // Ordering: progress notifications and the final subagent.run RESPONSE
    // travel the same single ordered NDJSON stdout pipe (one JSON-RPC
    // message per line, written in emission order — see protocol.ts's
    // module doc). Every onProgress call here happens synchronously within
    // runSubagentLoop's execution, strictly before that same async call
    // resolves and handleSubagentRun returns its result below — so every
    // progress notification for a run is guaranteed to reach the shell
    // BEFORE that run's final response. Not asserted anywhere (pipe
    // ordering is a platform guarantee, not app logic to test) — documented
    // here per the follow-up card's instruction.
    //
    // Image persistence (sidecar-authoritative when the PARENT loop is also
    // sidecar-run): a tool-end whose resultContent carries an image is
    // additionally recorded onto the parent message via the parent run's
    // frame ChatDelta — mirror + shell in frame order — so the entry
    // survives the parent run's ledger checkpoint. The shell's own
    // eventRouter append (completeChildStep) still fires when it processes
    // this same event; both writers are idempotent per tool-call id
    // (chatStore + conversationRunMirror dedup), so double delivery is
    // harmless. When the parent loop is NOT sidecar-run there is no active
    // run here and the shell-side append is the (sufficient) authority.
    onProgress: (event: SubagentProgressEvent) => {
      if (event.type === 'tool-start') {
        toolInputById.set(event.id, event.toolInput);
      } else if (
        event.type === 'tool-end'
        && params.parentConversationId
        && event.resultContent?.some((b) => b.type === 'image')
      ) {
        const parentRun = findActiveRunDeltaForConversation(params.parentConversationId);
        if (parentRun) {
          parentRun.chatDelta.appendMessageToolCall(params.parentConversationId, parentRun.loopId, {
            id: event.id,
            name: event.toolName,
            input: toolInputById.get(event.id) ?? {},
            result: event.result,
            resultContent: event.resultContent,
            isError: event.error || undefined,
            hidden: true,
            fromSubagent: true,
          });
        }
      }
      sendNotification('subagent.progress', { runId, event });
    },
    // commandConfirmCallback/filePermissionCallback intentionally omitted:
    // createReverseToolInvoker's executeAnyTool ALWAYS reverses to the
    // shell's tool.invoke handler, which threads the SESSION's REAL
    // callbacks shell-side (subagentRunner.ts's handleToolInvoke) — a
    // sidecar-local callback here would never be reached (nothing in this
    // process calls registry.ts's confirmation/permission machinery
    // locally; the shell's registry does, on the other end of the wire).
  };

  try {
    const result = await subagentRunContext.run(runCtx, () => runSubagentLoop(options));
    return {
      text: result.text,
      toolCallCount: result.toolCallCount,
      turnCount: result.turnCount,
      tokenUsage: result.tokenUsage,
      duration: result.duration,
      stopReason: result.stopReason,
    } satisfies SerializableSubagentResult;
  } finally {
    activeRuns.delete(runId);
  }
}

export function handleSubagentAbort(rawParams: unknown): void {
  const { runId } = parseAbortParams(rawParams);
  const run = activeRuns.get(runId);
  if (!run) return; // unknown/already-finished runId — silent no-op, matches llm.abort's discipline
  run.controller.abort();
}

/** Abort every in-flight subagent run — used by the `shutdown` notification handler before exit (mirrors llmHost.ts's shutdownAll()). */
export function shutdownAllSubagentRuns(): void {
  for (const run of activeRuns.values()) {
    run.controller.abort();
  }
}

/** Test-only accessor. */
export function __getActiveSubagentRunCount(): number {
  return activeRuns.size;
}
