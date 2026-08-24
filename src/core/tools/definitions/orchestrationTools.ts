/**
 * Orchestration tools — deterministic fan-out + join for multi-agent workflows.
 *
 * `run_agent_batch`: runs N sub-agent tasks in parallel via Promise.allSettled
 * over runSubagentLoop, then joins and returns ONE aggregated text result.
 *
 * This is the synchronous alternative to the lossy fire-and-forget
 * `delegate_to_agent async:true` path — it blocks until all sub-agents finish.
 */

import type {
  BatchIdentity,
  BatchTaskTerminalReason,
  BatchTaskTerminalStatus,
  BatchTerminalSummary,
  ToolDefinition,
  ToolExecutionContext,
  SubagentDefinition,
  SubagentStopReason,
} from '../../../types';
import { TOOL_NAMES } from '../toolNames';
import { agentRegistry } from '../../agent/registry';
import { getSubagentRunInheritance, runSubagent } from '../../agent/subagentRunner';
import { getSettingsReader } from '../../agent/ports/settingsReader';
import { getCurrentLoopContext, getLoopContext } from '../../agent/permissionBridge';
import { isSubagentResultError, type SubagentResult } from '../../agent/subagentLoop';
import { resolveParentConversationSummary } from '../../agent/parentConversationSummary';
import { buildSchemaInstruction, extractJsonObject, validateStructured } from '../../agent/structuredOutput';
import { subagentStopReasonFromBatchSummary } from '../../agent/batchTerminalSummary';
import { useBatchProgressStore } from '../../../stores/batchProgressStore';
import { getI18n, format } from '../../../i18n';

// ─── Preset agents (mirrored from agentTools.ts) ──────────────────────────
// Kept local so orchestrationTools has no runtime dependency on agentTools.ts.

const PRESET_AGENTS: Record<string, { description: string; systemPrompt: string; tools: string[] }> = {
  research: {
    description: 'Information search and research',
    systemPrompt: 'You are a professional research assistant. Focus on searching, reading, and analyzing information, and output structured research results.',
    tools: [TOOL_NAMES.READ_FILE, TOOL_NAMES.LIST_DIRECTORY, TOOL_NAMES.FIND_FILES, TOOL_NAMES.SEARCH_FILES, TOOL_NAMES.WEB_SEARCH, TOOL_NAMES.HTTP_FETCH],
  },
  writer: {
    description: 'Content creation and document writing',
    systemPrompt: 'You are a professional writing assistant. Skilled at writing documents, reports, emails, and other text content.',
    tools: [TOOL_NAMES.READ_FILE, TOOL_NAMES.WRITE_FILE, TOOL_NAMES.EDIT_FILE, TOOL_NAMES.LIST_DIRECTORY, TOOL_NAMES.FIND_FILES, TOOL_NAMES.SEARCH_FILES, TOOL_NAMES.WEB_SEARCH],
  },
  executor: {
    description: 'Executing complex operational tasks',
    systemPrompt: 'You are an efficient execution assistant. Able to use various tools to complete file operations, command execution, and other tasks.',
    tools: [],
  },
};

function buildPresetAgent(type: string): SubagentDefinition {
  const preset = PRESET_AGENTS[type];
  return {
    name: `preset-${type}`,
    description: preset.description,
    systemPrompt: preset.systemPrompt,
    filePath: '__preset__',
    tools: preset.tools.length > 0 ? preset.tools : undefined,
    maxTurns: type === 'research' ? 15 : 20,
  };
}

// ─── Pure exported helpers ─────────────────────────────────────────────────

/**
 * Clamp a concurrency value to [1, 8]. Non-numbers or out-of-range values
 * fall back to 4 (the safe default for sub-agent batches).
 */
export function clampConcurrency(n: unknown): number {
  if (typeof n !== 'number' || !isFinite(n)) return 4;
  if (n < 1) return 1;
  if (n > 8) return 8;
  return Math.floor(n);
}

/** Per-sub-agent wall-clock timeout; tunable, candidate for a future user setting. */
export const SUBAGENT_WALLCLOCK_TIMEOUT_MS = 10 * 60 * 1000; // 10 min per sub-agent

/**
 * Run `factory` with its own AbortSignal, racing against a hard wall-clock timeout.
 *
 * - Creates a per-task AbortController.
 * - If `parentSignal` is already aborted, aborts the controller immediately;
 *   otherwise forwards parent abort via a `{ once: true }` listener.
 * - After `timeoutMs`, aborts the controller and rejects with a timeout error.
 * - Cleans up the timeout and the parent-abort listener in `finally`.
 */
export function runWithTimeout<T>(
  factory: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();

  // Forward parent abort to the task controller.
  const onParentAbort = () => controller.abort();
  if (parentSignal?.aborted) {
    controller.abort();
  } else if (parentSignal) {
    parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  // Single outer promise avoids a floating rejected timeoutPromise that would
  // trigger Vitest / Node unhandledRejection events between the timer callback
  // running synchronously and the microtask handlers being called.
  return new Promise<T>((resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      controller.abort();
      reject(new Error(getI18n().toolResult.orchestration.errTimeout));
    }, timeoutMs);
    // Attach to factory; once the outer promise settles, subsequent
    // resolve/reject calls are no-ops (Promise semantics).
    factory(controller.signal).then(resolve, reject);
  }).finally(() => {
    clearTimeout(timeoutHandle);
    if (parentSignal) {
      parentSignal.removeEventListener('abort', onParentAbort);
    }
  });
}

/**
 * Run `items` through `fn` with at most `limit` concurrent in-flight calls.
 * Result order matches input order. Errors from `fn` produce `rejected`
 * settled results rather than propagating (same contract as Promise.allSettled).
 *
 * When `signal` is provided and becomes aborted, workers stop claiming new
 * items. Any slot that was never claimed (queued-but-not-started) is filled
 * with `{ status: 'rejected', reason: Error('已取消') }` so the returned
 * array always has exactly `items.length` settled entries.
 */
export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      // Stop pulling new items if the batch was cancelled.
      if (signal?.aborted) break;
      const i = nextIndex++;
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i], i) };
      } catch (err) {
        results[i] = { status: 'rejected', reason: err };
      }
    }
  }

  const workers: Promise<void>[] = [];
  const actualLimit = Math.min(limit, items.length);
  for (let w = 0; w < actualLimit; w++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  // Fill any slots that workers never reached (aborted before claiming them).
  for (let i = 0; i < results.length; i++) {
    if (results[i] === undefined) {
      (results as Array<PromiseSettledResult<R> | undefined>)[i] = {
        status: 'rejected',
        reason: new Error(getI18n().toolResult.orchestration.errCancelled),
      };
    }
  }

  return results;
}

/**
 * Format batch results into a human-readable, sectioned report.
 *
 * Header line: `共 N 个子任务，成功 X，失败 Y`
 * Each section: `### 子任务 N: <label>\n<text>` (ok)
 *               `### 子任务 N: <label>\n[失败] <text>` (error)
 */
export function aggregateBatchResults(
  entries: Array<{ label: string; status: 'ok' | 'error'; text: string }>,
): string {
  const total = entries.length;
  const successCount = entries.filter((e) => e.status === 'ok').length;
  const failCount = total - successCount;
  const t = getI18n().toolResult.orchestration;

  const header = format(t.batchHeader, { total, successCount, failCount });

  if (total === 0) return header;

  const sections = entries.map((entry, i) => {
    const title = format(t.batchSectionTitle, { n: i + 1, label: entry.label });
    const body = entry.status === 'ok' ? entry.text : format(t.batchFailPrefix, { text: entry.text });
    return `${title}\n${body}`;
  });

  return [header, ...sections].join('\n\n');
}

/**
 * Aggregate structured sub-agent results into a JSON array string.
 *
 * Each entry carries:
 *   - `task`: the label (first 60 chars of the task description)
 *   - `ok`: whether extraction + validation succeeded
 *   - `data`: the parsed JSON object (present when ok is true)
 *   - `error`: human-readable reason (present when ok is false)
 *
 * Returns `JSON.stringify(entries, null, 2)` — a pretty-printed JSON array.
 */
export function aggregateStructuredResults(
  entries: Array<{ task: string; ok: boolean; data?: Record<string, unknown>; error?: string }>,
): string {
  return JSON.stringify(entries, null, 2);
}

export function resolveBatchStopReason(summary: BatchTerminalSummary): SubagentStopReason {
  return subagentStopReasonFromBatchSummary(summary);
}

function terminalForSettledResult(
  result: PromiseSettledResult<SubagentResult>,
  structuredOk: boolean | undefined,
): { status: BatchTaskTerminalStatus; reason: BatchTaskTerminalReason } {
  if (result.status === 'rejected') {
    const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
    const timeoutMessage = getI18n().toolResult.orchestration.errTimeout;
    const cancelledMessage = getI18n().toolResult.orchestration.errCancelled;
    if (message === timeoutMessage) return { status: 'failed', reason: 'timeout' };
    if (message === cancelledMessage) return { status: 'stopped', reason: 'aborted' };
    return { status: 'failed', reason: 'error' };
  }
  switch (result.value.stopReason) {
    case 'completed':
      if (structuredOk === false) return { status: 'failed', reason: 'invalid_structured' };
      return { status: 'succeeded', reason: 'completed' };
    case 'aborted':
      return { status: 'stopped', reason: 'aborted' };
    case 'max_turns':
      return { status: 'incomplete', reason: 'max_turns' };
    case 'error':
      return { status: 'failed', reason: 'error' };
  }
}

type StructuredEntry = { task: string; ok: boolean; data?: Record<string, unknown>; error?: string };

function structuredEntryForSettledResult(
  result: PromiseSettledResult<SubagentResult>,
  task: string,
  schema: Record<string, unknown>,
): StructuredEntry {
  if (result.status === 'rejected') {
    const errMsg =
      result.reason instanceof Error ? result.reason.message : String(result.reason);
    return { task, ok: false, error: errMsg };
  }
  if (isSubagentResultError(result.value)) {
    return { task, ok: false, error: result.value.text };
  }
  const extracted = extractJsonObject(result.value.text);
  if (extracted === null) {
    return { task, ok: false, error: getI18n().toolResult.orchestration.errJsonParseFailed };
  }
  const validation = validateStructured(extracted, schema);
  if (!validation.ok) {
    return {
      task,
      ok: false,
      error: format(getI18n().toolResult.orchestration.errMissingFields, { fields: validation.missing.join(', ') }),
    };
  }
  return { task, ok: true, data: extracted };
}

export function aggregateSubagentTextResults(
  settled: PromiseSettledResult<SubagentResult>[],
  labels: string[],
): string {
  const entries = settled.map((result, i) => {
    const label = labels[i];
    if (result.status === 'fulfilled') {
      return {
        label,
        status: isSubagentResultError(result.value) ? 'error' as const : 'ok' as const,
        text: result.value.text,
      };
    }
    const errMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
    return { label, status: 'error' as const, text: errMsg };
  });
  return aggregateBatchResults(entries);
}

// ─── Task item type ────────────────────────────────────────────────────────

interface BatchTaskItem {
  type?: string;
  agent_name?: string;
  task: string;
  context?: string;
}

// ─── Tool definition ───────────────────────────────────────────────────────

export const runAgentBatchTool: ToolDefinition = {
  name: TOOL_NAMES.RUN_AGENT_BATCH,
  description:
    'Run multiple sub-agent tasks in parallel and return an aggregated report once all tasks complete.' +
    ' Each task can specify type (built-in role: research/writer/executor) or agent_name (user-defined agent);' +
    ' defaults to the research role when neither is specified.' +
    ' Suitable for simultaneously researching multiple independent topics, processing multiple files in parallel, or splitting a large task into independent sub-tasks for parallel execution.' +
    ' Note: results are returned together only after all sub-tasks complete; the current conversation is blocked during this time.',
  inputSchema: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        description: 'List of sub-tasks, 1–16 items, each executed independently in parallel',
        minItems: 1,
        maxItems: 16,
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              description: 'Built-in role with a fixed tool boundary: research (lookup-focused: file reads, search, web and general HTTP requests), writer (content authoring: read/write/edit files plus web search), executor (full toolset — includes browser, image and MCP tools, except nested delegation and user prompts). Mutually exclusive with agent_name; defaults to research when neither is provided',
              enum: ['research', 'writer', 'executor'],
            },
            agent_name: {
              type: 'string',
              description: 'User-defined agent name. Mutually exclusive with type',
            },
            task: {
              type: 'string',
              description: 'Task description for this sub-task (required)',
            },
            context: {
              type: 'string',
              description: 'Additional context (optional)',
            },
          },
          required: ['task'],
        },
      },
      concurrency: {
        type: 'number',
        description: 'Maximum number of concurrent sub-agents, default 4, range 1–8',
      },
      schema: {
        type: 'object',
        description:
          'Optional. When a JSON Schema is provided, each sub-task returns a JSON object matching that structure, aggregated into a JSON array (suitable for batch structured data extraction).',
      },
    },
    required: ['tasks'],
  },

  execute: async (input: Record<string, unknown>, toolExecContext?: ToolExecutionContext): Promise<string> => {
    // ── 1. Parse + validate ────────────────────────────────────────────────
    const rawTasks = input.tasks as BatchTaskItem[] | undefined;
    const ot = getI18n().toolResult.orchestration;
    if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
      return ot.errTasksRequired;
    }
    if (rawTasks.length > 16) {
      return ot.errTasksTooMany;
    }

    for (let i = 0; i < rawTasks.length; i++) {
      const taskItem = rawTasks[i];
      if (!taskItem.task || typeof taskItem.task !== 'string' || taskItem.task.trim() === '') {
        return format(ot.errTaskEmpty, { i });
      }
    }

    const concurrency = clampConcurrency(input.concurrency as unknown);
    const rawSchema = input.schema;
    const schema: Record<string, unknown> | undefined =
      rawSchema !== null && typeof rawSchema === 'object' && !Array.isArray(rawSchema)
        ? (rawSchema as Record<string, unknown>)
        : undefined;

    // ── 2. Resolve parent loop context for callbacks ───────────────────────
    const loopCtx = toolExecContext?.loopId
      ? getLoopContext(toolExecContext.loopId)
      : getCurrentLoopContext();

    // ── Tool call ID for batch progress tracking ──────────────────────────
    const batchIdentity: BatchIdentity = {
      conversationId: toolExecContext?.conversationId ?? '__unknown_conversation__',
      batchToolCallId: toolExecContext?.toolCallId ?? `batch-${Date.now()}`,
    };

    // ── 3. Extract parent conversation summary ─────────────────────────────
    const parentConversationSummary = resolveParentConversationSummary(toolExecContext);

    // ── 4. Resolve each task's agent ──────────────────────────────────────
    type ResolvedTask = { agent: SubagentDefinition; task: string; context?: string; label: string };

    const resolvedTasks: ResolvedTask[] = [];
    for (let i = 0; i < rawTasks.length; i++) {
      const item = rawTasks[i];
      let agent: SubagentDefinition | undefined;
      const agentType = item.type;
      const agentName = item.agent_name;

      if (agentType && PRESET_AGENTS[agentType]) {
        agent = buildPresetAgent(agentType);
      } else if (agentName) {
        agent = agentRegistry.getAgent(agentName);
        if (!agent) {
          const available = agentRegistry
            .getAvailableAgents()
            .filter((a) => a.name !== 'abu')
            .map((a) => `${a.name}`)
            .join(', ');
          const presetList = Object.keys(PRESET_AGENTS).join(', ');
          return format(ot.errBatchAgentNotFound, { i, agentName, available: available || getI18n().toolResult.valueNone, presetList });
        }
        const { disabledAgents } = getSettingsReader().getSnapshot();
        if (disabledAgents.includes(agentName)) {
          return format(ot.errBatchAgentDisabled, { i, agentName });
        }
      } else {
        // Default to research when neither type nor agent_name provided
        agent = buildPresetAgent('research');
      }

      resolvedTasks.push({
        agent,
        task: item.task,
        context: item.context,
        label: item.task.slice(0, 60) + (item.task.length > 60 ? '…' : ''),
      });
    }

    // ── 5. Run all sub-agents with concurrency pool ────────────────────────

    // Initialize batch progress (best-effort — store failure must never break the batch)
    try {
      useBatchProgressStore.getState().initBatch(batchIdentity, resolvedTasks.map((r) => r.label));
    } catch {
      // Best-effort
    }

    const structuredEntries: StructuredEntry[] | undefined = schema === undefined
      ? undefined
      : new Array(resolvedTasks.length);
    let latestTerminalSummary: BatchTerminalSummary | undefined;
    const claimedTaskIndices = new Set<number>();

    const reportTerminalSummary = (summary: BatchTerminalSummary | undefined): void => {
      if (!summary) return;
      latestTerminalSummary = summary;
      toolExecContext?.reportMetadata?.({ batchTerminalSummary: summary });
      if (summary.tasks.length === summary.taskCount) {
        toolExecContext?.reportMetadata?.({ subagentStopReason: resolveBatchStopReason(summary) });
      }
    };

    const terminalizeTask = (
      idx: number,
      terminal: { status: BatchTaskTerminalStatus; reason: BatchTaskTerminalReason },
    ): void => {
      try {
        reportTerminalSummary(useBatchProgressStore.getState().setTaskTerminal(batchIdentity, idx, terminal));
      } catch {
        // Best-effort: progress state must never break the batch.
      }
    };

    const terminalizeUnclaimedAbort = (): void => {
      for (let i = 0; i < resolvedTasks.length; i++) {
        if (!claimedTaskIndices.has(i)) {
          terminalizeTask(i, { status: 'stopped', reason: 'aborted' });
        }
      }
    };

    if (loopCtx?.signal?.aborted) {
      terminalizeUnclaimedAbort();
    } else {
      loopCtx?.signal?.addEventListener('abort', terminalizeUnclaimedAbort, { once: true });
    }

    const settled = await runWithConcurrency(
      resolvedTasks,
      concurrency,
      async (resolved, idx) => {
        // Belt-and-suspenders: if we raced the abort check in the worker loop,
        // bail before starting a fresh sub-agent run.
        if (loopCtx?.signal?.aborted) throw new Error(getI18n().toolResult.orchestration.errCancelled);
        claimedTaskIndices.add(idx);
        // A task can spend its whole run answering directly without calling a
        // tool. Mark it running at worker admission, not at its first
        // tool-start event, so those tasks never appear queued until done.
        try {
          useBatchProgressStore.getState().setTaskRunning(batchIdentity, idx);
        } catch {
          // Best-effort: progress state must never break the batch.
        }
        const effectiveTask =
          schema !== undefined
            ? resolved.task + buildSchemaInstruction(schema)
            : resolved.task;
        let currentTurn = 0;
        try {
          const result = await runWithTimeout(
            (sig) => runSubagent({
              agent: resolved.agent,
              task: effectiveTask,
              context: resolved.context,
              parentConversationSummary,
              signal: sig,
              commandConfirmCallback: loopCtx?.commandConfirmCallback,
              filePermissionCallback: loopCtx?.filePermissionCallback,
              allowedTools: loopCtx?.allowedTools,
              blockedTools: loopCtx?.blockedTools,
              imContext: loopCtx?.imContext,
              ...getSubagentRunInheritance(loopCtx, toolExecContext?.authorizationScopeId, toolExecContext?.workspacePath),
              onProgress: (event) => {
                try {
                  const store = useBatchProgressStore.getState();
                  if (event.type === 'tool-start') {
                    store.startTaskStep(batchIdentity, idx, event);
                    store.setTaskActivity(batchIdentity, idx, format(getI18n().toolResult.orchestration.activityCalling, { toolName: event.toolName }), currentTurn);
                  } else if (event.type === 'tool-end') {
                    // Preserve rich blocks verbatim: BatchProgress turns image
                    // blocks into DetailBlockView input while this in-memory
                    // batch card remains open.
                    store.finishTaskStep(batchIdentity, idx, {
                      id: event.id,
                      toolName: event.toolName,
                      result: event.result,
                      resultContent: event.resultContent,
                      error: event.error,
                    });
                  } else if (event.type === 'turn-complete') {
                    currentTurn = event.turn;
                    store.setTaskActivity(batchIdentity, idx, '', currentTurn);
                    if (event.usage) {
                      store.setTaskTokenUsage(batchIdentity, idx, event.usage);
                    }
                  }
                } catch {
                  // Best-effort: never let store errors break the batch
                }
              },
            }),
            SUBAGENT_WALLCLOCK_TIMEOUT_MS,
            loopCtx?.signal,
          );
          const settledResult = { status: 'fulfilled', value: result } as const satisfies PromiseSettledResult<SubagentResult>;
          if (structuredEntries !== undefined && schema !== undefined) {
            structuredEntries[idx] = structuredEntryForSettledResult(settledResult, resolved.label, schema);
          }
          try {
            useBatchProgressStore.getState().setTaskFinalStats(batchIdentity, idx, {
              toolCallCount: result.toolCallCount,
              tokenUsage: {
                inputTokens: result.tokenUsage.input,
                outputTokens: result.tokenUsage.output,
              },
            });
          } catch {
            // Best-effort
          }
          terminalizeTask(idx, terminalForSettledResult(settledResult, structuredEntries?.[idx]?.ok));
          return result;
        } catch (err) {
          const settledResult = { status: 'rejected', reason: err } as const satisfies PromiseSettledResult<SubagentResult>;
          if (structuredEntries !== undefined && schema !== undefined) {
            structuredEntries[idx] = structuredEntryForSettledResult(settledResult, resolved.label, schema);
          }
          terminalizeTask(idx, terminalForSettledResult(settledResult, structuredEntries?.[idx]?.ok));
          throw err;
        }
      },
      loopCtx?.signal,
    );
    loopCtx?.signal?.removeEventListener('abort', terminalizeUnclaimedAbort);

    if (structuredEntries !== undefined && schema !== undefined) {
      settled.forEach((result, i) => {
        structuredEntries[i] ??= structuredEntryForSettledResult(result, resolvedTasks[i].label, schema);
      });
    }

    for (let i = 0; i < settled.length; i++) {
      const result = settled[i];
      if (result.status === 'rejected' && !latestTerminalSummary?.tasks.some((task) => task.taskIndex === i)) {
        terminalizeTask(i, terminalForSettledResult(result, structuredEntries?.[i]?.ok));
      }
    }

    // ── 6. Aggregate results ───────────────────────────────────────────────
    if (structuredEntries !== undefined) {
      return aggregateStructuredResults(structuredEntries);
    }

    // Text aggregation path (behavior-preserving, schema absent)
    return aggregateSubagentTextResults(settled, resolvedTasks.map((task) => task.label));
  },

  // Already parallelizes internally — parent must not double-parallelize this tool.
  isConcurrencySafe: () => false,
};
