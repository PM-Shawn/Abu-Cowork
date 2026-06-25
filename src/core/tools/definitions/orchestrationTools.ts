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

/**
 * Run `items` through `fn` with at most `limit` concurrent in-flight calls.
 * Result order matches input order. Errors from `fn` produce `rejected`
 * settled results rather than propagating (same contract as Promise.allSettled).
 */
export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
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
    '并行运行多个子代理任务，所有任务完成后一次性返回聚合报告。' +
    '每个任务可指定 type（系统内置角色：research/writer/executor）或 agent_name（用户自定义代理）；' +
    '两者均未指定时默认使用 research 调研角色。' +
    '适用于需要同时调研多个独立话题、并行处理多个文件、或将大任务拆分为独立子任务并行执行的场景。' +
    '注意：所有子任务均完成后结果才会一起回传，期间会阻塞当前对话。',
  inputSchema: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        description: '子任务列表，1-16 个，每个任务独立并行执行',
        minItems: 1,
        maxItems: 16,
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              description: '系统内置角色：research（只读调研）、writer（读写创作）、executor（全能执行）。与 agent_name 二选一；两者均不填时默认 research',
              enum: ['research', 'writer', 'executor'],
            },
            agent_name: {
              type: 'string',
              description: '用户自定义代理名称。与 type 二选一',
            },
            task: {
              type: 'string',
              description: '该子任务的任务描述（必填）',
            },
            context: {
              type: 'string',
              description: '附加上下文（可选）',
            },
          },
          required: ['task'],
        },
      },
      concurrency: {
        type: 'number',
        description: '最大并发子代理数，默认 4，范围 1-8',
      },
      schema: {
        type: 'object',
        description:
          '可选。提供 JSON Schema 时，每个子任务返回匹配该结构的 JSON 对象，聚合成 JSON 数组返回（适合批量提取结构化数据）。',
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
        const effectiveTask =
          schema !== undefined
            ? resolved.task + buildSchemaInstruction(schema)
            : resolved.task;
        let currentTurn = 0;
        return runSubagentLoop({
          agent: resolved.agent,
          task: effectiveTask,
          context: resolved.context,
          parentConversationSummary,
          signal: loopCtx?.signal,
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
        });
      },
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
