/**
 * Orchestration tools — deterministic fan-out + join for multi-agent workflows.
 *
 * `run_agent_batch`: runs N sub-agent tasks in parallel via Promise.allSettled
 * over runSubagentLoop, then joins and returns ONE aggregated text result.
 *
 * This is the synchronous alternative to the lossy fire-and-forget
 * `delegate_to_agent async:true` path — it blocks until all sub-agents finish.
 */

import type { ToolDefinition, ToolExecutionContext, SubagentDefinition } from '../../../types';
import { TOOL_NAMES } from '../toolNames';
import { agentRegistry } from '../../agent/registry';
import { runSubagentLoop } from '../../agent/subagentLoop';
import { useSettingsStore } from '../../../stores/settingsStore';
import { getCurrentLoopContext, getLoopContext } from '../../agent/permissionBridge';
import { extractParentConversationSummary } from '../../agent/subagentLoop';
import { useChatStore } from '../../../stores/chatStore';
import { buildSchemaInstruction, extractJsonObject, validateStructured } from '../../agent/structuredOutput';
import { useBatchProgressStore } from '../../../stores/batchProgressStore';

// ─── Preset agents (mirrored from agentTools.ts) ──────────────────────────
// Kept local so orchestrationTools has no runtime dependency on agentTools.ts.

const PRESET_AGENTS: Record<string, { description: string; systemPrompt: string; tools: string[] }> = {
  research: {
    description: '信息搜索和调研',
    systemPrompt: '你是一个专业的调研助手。专注于搜索、阅读和分析信息，输出结构化的调研结果。',
    tools: [TOOL_NAMES.READ_FILE, TOOL_NAMES.LIST_DIRECTORY, TOOL_NAMES.FIND_FILES, TOOL_NAMES.SEARCH_FILES, TOOL_NAMES.WEB_SEARCH, TOOL_NAMES.HTTP_FETCH],
  },
  writer: {
    description: '内容创作和文档撰写',
    systemPrompt: '你是一个专业的写作助手。擅长撰写文档、报告、邮件等各类文字内容。',
    tools: [TOOL_NAMES.READ_FILE, TOOL_NAMES.WRITE_FILE, TOOL_NAMES.EDIT_FILE, TOOL_NAMES.LIST_DIRECTORY, TOOL_NAMES.FIND_FILES, TOOL_NAMES.SEARCH_FILES, TOOL_NAMES.WEB_SEARCH],
  },
  executor: {
    description: '执行复杂操作任务',
    systemPrompt: '你是一个高效的执行助手。能够使用各种工具完成文件操作、命令执行等任务。',
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
      reject(new Error('子代理执行超时（已中止）'));
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
        reason: new Error('已取消'),
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

  const header = `共 ${total} 个子任务，成功 ${successCount}，失败 ${failCount}`;

  if (total === 0) return header;

  const sections = entries.map((entry, i) => {
    const title = `### 子任务 ${i + 1}: ${entry.label}`;
    const body = entry.status === 'ok' ? entry.text : `[失败] ${entry.text}`;
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
              description: 'Built-in role: research (read-only research), writer (read/write content creation), executor (all-purpose execution). Mutually exclusive with agent_name; defaults to research when neither is provided',
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
    if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
      return 'Error: tasks 必须是非空数组';
    }
    if (rawTasks.length > 16) {
      return 'Error: tasks 最多支持 16 个子任务';
    }

    for (let i = 0; i < rawTasks.length; i++) {
      const t = rawTasks[i];
      if (!t.task || typeof t.task !== 'string' || t.task.trim() === '') {
        return `Error: tasks[${i}].task 不能为空`;
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
    const batchId = toolExecContext?.toolCallId ?? `batch-${Date.now()}`;

    // ── 3. Extract parent conversation summary ─────────────────────────────
    let parentConversationSummary: string | undefined;
    try {
      const chatState = useChatStore.getState();
      const activeConvId = chatState.activeConversationId;
      if (activeConvId) {
        const messages = chatState.conversations[activeConvId]?.messages ?? [];
        parentConversationSummary = extractParentConversationSummary(messages);
      }
    } catch {
      // Non-critical
    }

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
          return `Error: tasks[${i}] 代理 "${agentName}" 未找到。可用代理: ${available || '无'}。系统角色 type: ${presetList}`;
        }
        const { disabledAgents } = useSettingsStore.getState();
        if (disabledAgents.includes(agentName)) {
          return `Error: tasks[${i}] 代理 "${agentName}" 已被停用`;
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
      useBatchProgressStore.getState().initBatch(batchId, resolvedTasks.map((r) => r.label));
    } catch {
      // Best-effort
    }

    const settled = await runWithConcurrency(
      resolvedTasks,
      concurrency,
      async (resolved, idx) => {
        // Belt-and-suspenders: if we raced the abort check in the worker loop,
        // bail before starting a fresh sub-agent run.
        if (loopCtx?.signal?.aborted) throw new Error('已取消');
        const effectiveTask =
          schema !== undefined
            ? resolved.task + buildSchemaInstruction(schema)
            : resolved.task;
        let currentTurn = 0;
        return runWithTimeout(
          (sig) => runSubagentLoop({
            agent: resolved.agent,
            task: effectiveTask,
            context: resolved.context,
            parentConversationSummary,
            signal: sig,
            commandConfirmCallback: loopCtx?.commandConfirmCallback,
            filePermissionCallback: loopCtx?.filePermissionCallback,
            onProgress: (event) => {
              try {
                const store = useBatchProgressStore.getState();
                if (event.type === 'tool-start') {
                  if (store.batches[batchId]?.tasks[idx]?.status === 'queued') {
                    store.setTaskRunning(batchId, idx);
                  }
                  store.setTaskActivity(batchId, idx, `调用 ${event.toolName}`, currentTurn);
                } else if (event.type === 'turn-complete') {
                  currentTurn = event.turn;
                  store.setTaskActivity(batchId, idx, '', currentTurn);
                }
              } catch {
                // Best-effort: never let store errors break the batch
              }
            },
          }),
          SUBAGENT_WALLCLOCK_TIMEOUT_MS,
          loopCtx?.signal,
        );
      },
      loopCtx?.signal,
    );

    // Mark all tasks done in store (best-effort)
    try {
      const store = useBatchProgressStore.getState();
      settled.forEach((result, i) => {
        const isError = result.status === 'rejected'
          || (result.status === 'fulfilled' && result.value.text.startsWith('Error:'));
        store.setTaskDone(batchId, i, isError);
      });
    } catch {
      // Best-effort
    }

    // ── 6. Aggregate results ───────────────────────────────────────────────
    if (schema !== undefined) {
      // Structured path: extract + validate JSON from each sub-agent's output
      const structuredEntries = settled.map((result, i) => {
        const task = resolvedTasks[i].label;
        if (result.status === 'rejected') {
          const errMsg =
            result.reason instanceof Error ? result.reason.message : String(result.reason);
          return { task, ok: false, error: errMsg };
        }
        const extracted = extractJsonObject(result.value.text);
        if (extracted === null) {
          return { task, ok: false, error: '未能解析出匹配的 JSON' };
        }
        const validation = validateStructured(extracted, schema);
        if (!validation.ok) {
          return {
            task,
            ok: false,
            error: `缺少必填字段: ${validation.missing.join(', ')}`,
          };
        }
        return { task, ok: true, data: extracted };
      });
      return aggregateStructuredResults(structuredEntries);
    }

    // Text aggregation path (behavior-preserving, schema absent)
    const entries = settled.map((result, i) => {
      const label = resolvedTasks[i].label;
      if (result.status === 'fulfilled') {
        return { label, status: 'ok' as const, text: result.value.text };
      }
      const errMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
      return { label, status: 'error' as const, text: errMsg };
    });

    return aggregateBatchResults(entries);
  },

  // Already parallelizes internally — parent must not double-parallelize this tool.
  isConcurrencySafe: () => false,
};
