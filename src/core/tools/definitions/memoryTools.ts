import type { ToolDefinition, UserQuestionPayload, UserQuestionResult } from '../../../types';
import { useTaskExecutionStore } from '../../../stores/taskExecutionStore';
import { getPlanMode, setPlanMode } from '../../agent/planMode';
import { requestUserQuestion } from '../../agent/permissionBridge';
import { useChatStore } from '../../../stores/chatStore';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { appendTaskLog, type TaskCategory } from '../../agent/taskLog';
import { getTodos, addTodo, updateTodo, setTodos, formatTodosForPrompt } from '../../agent/todoManager';
import type { TodoStatus } from '../../agent/todoManager';
import { TOOL_NAMES } from '../toolNames';
import type { MemoryType } from '../../memdir/types';

// ── Plan-mode approval (B1) ─────────────────────────────────────────────────
export const PLAN_APPROVE_LABEL = '批准执行';
export const PLAN_REJECT_LABEL = '拒绝，重新规划';

/** Build a single approve/reject question presenting the plan steps for approval. */
export function buildPlanApprovalPayload(steps: string[]): UserQuestionPayload {
  const stepList = steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
  return {
    // Destructive approval: require the explicit confirm button — a single
    // stray click must not launch the plan.
    confirm: true,
    questions: [
      {
        header: '计划审批',
        question: `${stepList}\n\n是否批准执行此计划？`,
        multiSelect: false,
        options: [{ label: PLAN_APPROVE_LABEL }, { label: PLAN_REJECT_LABEL }],
      },
    ],
  };
}

/** True only if the user explicitly selected the approve option. */
export function interpretPlanApproval(result: UserQuestionResult | null): boolean {
  if (!result) return false;
  return result.answers[0]?.selected.includes(PLAN_APPROVE_LABEL) ?? false;
}

/**
 * High-risk operation keywords (heuristic). report_plan steps are natural-language
 * and user-facing (no tool names), so we match destructive / mutating / outbound
 * verbs to decide whether a plan needs explicit approval before execution. Tunable;
 * lean inclusive for safety — a borderline approval prompt is cheaper than an
 * unreviewed destructive run. Read-only verbs (查看/搜索/分析/list/read…) are absent
 * on purpose so pure-research plans never trigger.
 */
export const PLAN_RISK_KEYWORDS: readonly string[] = [
  // zh — destructive / mutating
  '删除', '删掉', '移动', '移到', '覆盖', '替换', '重命名', '改名', '清空', '清除',
  '卸载', '格式化', '重置', '丢弃', '抹除',
  // zh — outbound / execution
  '发送', '上传', '推送', '安装', '执行命令', '运行命令',
  // en (matched lowercase)
  'delete', 'remove', 'move', 'overwrite', 'replace', 'rename', 'clear',
  'uninstall', 'format', 'reset', 'discard', 'erase', 'send', 'upload', 'push', 'install',
];

/**
 * Noun compounds that contain a risky verb as a substring but describe a data
 * object, not an action ("查看安装包" is read-only). A keyword occurrence fully
 * contained inside one of these spans is ignored; any occurrence outside them
 * still triggers. Deliberately excludes executables (安装程序 / installer):
 * "运行安装程序" DOES execute an installer, and the gate leans inclusive —
 * a borderline approval prompt is cheaper than an unreviewed destructive run.
 */
export const PLAN_RISK_NOUN_EXCEPTIONS: readonly string[] = [
  '安装包', '安装目录', '安装文件',
  'installation package',
];

/** All [start, end) spans where an exception noun occurs in `text`. */
function exceptionSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const noun of PLAN_RISK_NOUN_EXCEPTIONS) {
    const n = noun.toLowerCase();
    let idx = text.indexOf(n);
    while (idx !== -1) {
      spans.push([idx, idx + n.length]);
      idx = text.indexOf(n, idx + 1);
    }
  }
  return spans;
}

/** True if any plan step mentions a high-risk operation (heuristic — see PLAN_RISK_KEYWORDS). */
export function planHasRiskySteps(steps: string[]): boolean {
  if (!Array.isArray(steps)) return false;
  return steps.some((s) => {
    const text = String(s).toLowerCase();
    const spans = exceptionSpans(text);
    return PLAN_RISK_KEYWORDS.some((kw) => {
      const k = kw.toLowerCase();
      let idx = text.indexOf(k);
      while (idx !== -1) {
        const end = idx + k.length;
        // Span-containment instead of substring-stripping: stripping corrupted
        // neighbors ("uninstaller" minus "installer" left "un ", losing the
        // "uninstall" match). An occurrence merely overlapping a span still counts.
        const contained = spans.some(([s0, e0]) => idx >= s0 && end <= e0);
        if (!contained) return true;
        idx = text.indexOf(k, idx + 1);
      }
      return false;
    });
  });
}

export const reportPlanTool: ToolDefinition = {
  name: TOOL_NAMES.REPORT_PLAN,
  description: 'Report the task execution plan. Must be called before starting any task to inform the user of the steps you are about to take. Describe steps in plain business language the user can understand — do not mention tool names.',
  inputSchema: {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of task steps described in user-understandable language. Example: ["Scan desktop files", "Identify invoices", "Create invoice folder", "Move invoices to folder"]'
      },
    },
    required: ['steps'],
  },
  execute: async (input, context) => {
    const steps = input.steps as string[];
    const hasSteps = Array.isArray(steps) && steps.length > 0;

    // Land the plan on the loop's execution so the progress panel shows it.
    // Called only for plans the user can act on — approved or approval-free.
    // A rejected/timed-out plan must NOT reach the panel (the user just said
    // no to exactly these steps).
    const landPlannedSteps = () => {
      const loopId = context?.loopId;
      if (!loopId || !hasSteps) return;
      const store = useTaskExecutionStore.getState();
      const exec = store.getExecutionByLoopId(loopId);
      if (!exec) return;
      store.setPlannedSteps(exec.id, steps.map((description, i) => ({
        index: i + 1,
        description,
        status: 'pending' as const,
      })));
    };

    // Plan approval (B1, auto-trigger): when a plan contains high-risk steps
    // (move/delete/overwrite/send/install…), require user approval BEFORE writes
    // are unlocked — no manual toggle needed; safe/read-only plans pass straight
    // through unchanged. Also honors an explicitly-set 'planning' mode (e.g. a
    // future manual toggle). On the gate: setPlanMode('planning') makes the tool
    // gate (toolExecutor) block writes until the user decides. Approve →
    // 'approved' (writes unlocked); reject/timeout → stay 'planning' (read-only)
    // so the agent revises and re-submits report_plan.
    const convId = context?.conversationId;
    const needsApproval = hasSteps && (planHasRiskySteps(steps) || (convId ? getPlanMode(convId) === 'planning' : false));
    if (convId && context?.toolCallId && needsApproval) {
      setPlanMode(convId, 'planning');
      const result = await requestUserQuestion(context.toolCallId, convId, buildPlanApprovalPayload(steps));
      if (interpretPlanApproval(result)) {
        setPlanMode(convId, 'approved');
        landPlannedSteps();
        return '用户已批准计划，现在可以开始执行。';
      }
      if (result === null) {
        return '计划审批超时或已取消，处于计划模式（只读）。可修改后重新提交计划。';
      }
      // A bare rejection carries no feedback — instructing the model to
      // "revise and resubmit" made it re-pop an identical approval card with
      // no words in between. Make it talk to the user first.
      return '用户未批准当前计划。请先向用户询问顾虑和期望的调整，在得到明确反馈之前不要重新提交相同的计划。当前为计划模式（只读）。';
    }

    if (!hasSteps) {
      return '已记录执行计划';
    }
    landPlannedSteps();
    return `已记录执行计划：${steps.length}个步骤`;
  },
  isConcurrencySafe: false,
};

export const updateMemoryTool: ToolDefinition = {
  name: TOOL_NAMES.UPDATE_MEMORY,
  description: `Save or update persistent memory. **Check <memory-index> in the system prompt before calling**: if a memory on the same topic already exists, choose edit to overwrite or delete to remove it — do not create duplicate entries.

## Four actions
- append (default): Write a new memory. Use only when there is no similar topic in the index.
- edit: Overwrite an existing memory by filename (use when the user changes their mind or adds Why/How).
- delete: Delete an outdated memory by filename (use when information conflicts and the new value is more appropriate).
- clear: Clear all memories (rarely used — only when the user explicitly requests it).

## 4 memory types
- user — User role, goals, knowledge level, long-term preferences. Example: user is a data team PM; prefers concise replies.
- feedback — User corrections or confirmations. Body structure: **rule + Why + How to apply**.
  - Example (correction): rule=don't use echo to write files; Why=Chinese text may be garbled; How=use the Write tool instead
  - Example (confirmation): rule=split refactoring into one-type-per-commit; Why=easier to trace back; How=follow this in future refactors
- project — Project progress, key decisions, TODOs, constraints. Body structure: **fact + Why + How to apply**.
- reference — Pointers to external resources (boards/docs/channel links).

## Do NOT save
- One-off task results ("X generated" / "translation done"), temporary state ("tests passed" / "port occupied")
- Derivable information (project paths, code patterns — readable from the project or grep)
- Small talk, greetings, one-off queries (weather, ad-hoc calculations)
- Content already covered in the project rules file (.abu/ABU.md)

Even if the user explicitly says "remember this list", ask first: which parts are *surprising and useful in the future*? Only save those.

## Check before writing (avoid duplicates / handle conflicts)
Scan <memory-index> first and handle based on the relationship between existing memory and new information:
- **New topic** (no similar entry in index) → append
- **Conflicting information** (same fact with different value, e.g. "user is Xiao Bao" → "user is Xiao Bai") → edit to overwrite the old entry, or delete then append. **Never leave two contradictory memories coexisting**.
- **Supplementary information** (original entry lacks Why/How, new conversation fills it in) → edit to complete the old entry, do not write a parallel new one.
- **Complete duplicate** → skip.

Three questions to judge: ①Conflict or supplement? ②Will coexistence confuse a future agent? ③Is the user's latest message changing a previous preference? Any "yes" → use edit/delete, not append.

## private flag + description writing (important)
Pass \`private: true\` when saving sensitive information such as ID numbers/bank cards/phone numbers/salary/medical/undisclosed business data. **For private memories, description must only state the "topic", not the "specific value"** — because description appears in the MEMORY.md index which is injected into every conversation's system prompt.
- ✅ description="personal ID number" / "ICBC account" / "this month's salary"
- ❌ description="ID 110105..." / "card 6228... PIN xxx"
Keep ordinary user preferences/work habits non-private; description can be more detailed to facilitate automatic reference each turn.`,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Operation type: append (write new, default) / edit (overwrite single entry) / delete (delete single entry) / clear (clear all)',
        enum: ['append', 'edit', 'delete', 'clear'],
      },
      filename: {
        type: 'string',
        description: 'Memory filename (required for edit and delete). The [filename](filename) part from a <memory-index> index line.',
      },
      name: { type: 'string', description: 'Memory name (required for append, optional for edit)' },
      content: { type: 'string', description: 'Memory content (required for append and edit)' },
      description: { type: 'string', description: 'One-sentence description (optional for append and edit; defaults to first 80 chars of content)' },
      type: {
        type: 'string',
        description: 'Category: user (user preferences/role/knowledge level) / feedback (behavior corrections or confirmations, including reason and applicable scenarios) / project (project progress/decisions) / reference (external system pointers)',
        enum: ['user', 'feedback', 'project', 'reference'],
      },
      private: {
        type: 'boolean',
        description: 'Whether this is a private memory. true means it will not be auto-injected into conversation context and can only be retrieved via read_memory when the user explicitly asks. Set to true only for sensitive content such as ID numbers/bank cards/phone numbers/salary/medical/family privacy/undisclosed business information. Default: false.',
      },
    },
    required: ['action'],
  },
  execute: async (input, context) => {
    const action = (input.action as string) || 'append';

    try {
      const workspacePath = context?.workspacePath ?? useWorkspaceStore.getState().currentPath;

      if (action === 'clear') {
        const { clearAllMemories } = await import('../../memdir/write');
        const count = await clearAllMemories(workspacePath);
        return `已清空记忆（${count} 条）。`;
      }

      if (action === 'delete') {
        const filename = (input.filename as string)?.trim();
        if (!filename) return 'Error: action=delete 必须提供 filename';
        const { deleteMemory } = await import('../../memdir/write');
        await deleteMemory(filename, workspacePath);
        return `已删除记忆: ${filename}`;
      }

      if (action === 'edit') {
        const filename = (input.filename as string)?.trim();
        if (!filename) return 'Error: action=edit 必须提供 filename';
        const content = (input.content as string) || '';
        if (!content) return 'Error: action=edit 必须提供 content';

        // Edit: read existing header to preserve type/created if not overridden,
        // then writeMemory with override filename to overwrite the .md file.
        const { scanMemoryFiles, readMemoryFile } = await import('../../memdir/scan');
        const { writeMemory } = await import('../../memdir/write');
        const { ContentSafetyError } = await import('../../safety/contentGuard');

        // Find the existing memory across both global and workspace dirs
        const [globalHeaders, wsHeaders] = await Promise.all([
          scanMemoryFiles(null),
          workspacePath ? scanMemoryFiles(workspacePath) : Promise.resolve([]),
        ]);
        const existing = [...globalHeaders, ...wsHeaders].find((h) => h.filename === filename);
        if (!existing) {
          return `Error: filename="${filename}" 不存在。请确认拼写（参考 <memory-index>），或改用 action=append 新写一条。`;
        }
        const existingFile = await readMemoryFile(existing.filePath);

        const name = (input.name as string) || existing.name;
        const description = (input.description as string) || content.slice(0, 80);
        const type = ((input.type as string) || existing.type) as MemoryType;
        // private: explicit override > existing value
        const isPrivate = typeof input.private === 'boolean' ? (input.private as boolean) : existing.private;
        // Determine which workspace this memory lives in (preserve, don't relocate)
        const liveWorkspace = wsHeaders.some((h) => h.filename === filename) ? workspacePath : null;

        try {
          await writeMemory({
            name,
            description,
            type,
            content,
            source: existingFile?.header.source ?? 'agent_explicit',
            workspacePath: liveWorkspace,
            filename, // override → overwrites the existing .md
            private: isPrivate,
          });
          return `已更新记忆 [${type}]: ${name} (${filename})${isPrivate ? ' 🔒' : ''}`;
        } catch (err) {
          if (err instanceof ContentSafetyError) {
            const patterns = err.scan.findings
              .filter((f) => f.severity === 'critical' || f.severity === 'high')
              .map((f) => `[${f.patternId}] ${f.description} (line ${f.line}: "${f.match}")`)
              .join('\n  ');
            return (
              `Error: memory content was blocked by the safety scanner.\n` +
              `Matched patterns:\n  ${patterns}\n` +
              `Rewrite the memory without these patterns and retry.`
            );
          }
          throw err;
        }
      }

      // action === 'append' (default): write a new .md memory file
      const content = (input.content as string) || '';
      const name = (input.name as string) || content.slice(0, 40);
      const description = (input.description as string) || content.slice(0, 80);
      const type = ((input.type as string) || 'project') as MemoryType;
      const isPrivate = (input.private as boolean) === true;

      if (!content) return '错误：append 时 content 不能为空。';

      const { writeMemory } = await import('../../memdir/write');
      const { ContentSafetyError } = await import('../../safety/contentGuard');
      try {
        const filename = await writeMemory({
          name,
          description,
          type,
          content,
          source: 'agent_explicit',
          workspacePath,
          private: isPrivate,
        });
        return `已保存记忆 [${type}]: ${name} → ${filename}${isPrivate ? ' 🔒' : ''}`;
      } catch (err) {
        if (err instanceof ContentSafetyError) {
          const patterns = err.scan.findings
            .filter((f) => f.severity === 'critical' || f.severity === 'high')
            .map((f) => `[${f.patternId}] ${f.description} (line ${f.line}: "${f.match}")`)
            .join('\n  ');
          return (
            `Error: memory content was blocked by the safety scanner.\n` +
            `Matched patterns:\n  ${patterns}\n` +
            `Rewrite the memory without these patterns and retry.`
          );
        }
        throw err;
      }
    } catch (err) {
      return `Error updating memory: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
  isConcurrencySafe: false,
};

export const todoWriteTool: ToolDefinition = {
  name: TOOL_NAMES.TODO_WRITE,
  description: 'Create or update a task plan. Can batch-set plan items or update the status of a single item. The plan is injected every turn so you always have visibility into current progress.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Operation type: set (batch-set plan items) / add (add single item) / update (update status) / read (read current plan)',
        enum: ['set', 'add', 'update', 'read'],
      },
      items: {
        type: 'array',
        items: { type: 'object' },
        description: 'List of plan items (used for set and add). Each item should contain content (string) and optional status (string: pending/in_progress/completed/cancelled)',
      },
      todo_id: { type: 'string', description: 'ID of the plan item to update (used for update)' },
      status: { type: 'string', description: 'New status (used for update)' },
      content: { type: 'string', description: 'New content (used for update or add)' },
    },
    required: ['action'],
  },
  execute: async (input, context) => {
    const action = input.action as string;

    // Prefer context (correct for scheduled/trigger tasks) over activeConversationId
    const conversationId = context?.conversationId ?? useChatStore.getState().activeConversationId;
    if (!conversationId) {
      return 'Error: 没有活跃会话';
    }

    switch (action) {
      case 'set': {
        const items = (input.items as Array<{ content: string; status?: string }>) ?? [];
        if (items.length === 0) return 'Error: 需要提供计划项列表';
        const result = setTodos(conversationId, items.map(i => ({
          content: i.content,
          status: (i.status as TodoStatus) ?? 'pending',
        })));
        return `已创建 ${result.length} 个计划项。\n${formatTodosForPrompt(conversationId)}`;
      }
      case 'add': {
        const content = (input.content as string) ?? (input.items as Array<{ content: string }>)?.[0]?.content;
        if (!content) return 'Error: 需要提供内容';
        const item = addTodo(conversationId, content);
        return `已添加计划项: ${item.content} (ID: ${item.id})`;
      }
      case 'update': {
        const todoId = input.todo_id as string;
        const status = input.status as string | undefined;
        const content = input.content as string | undefined;
        if (!todoId) return 'Error: 需要提供 todo_id';
        const updated = updateTodo(conversationId, todoId, {
          status: status as TodoStatus | undefined,
          content,
        });
        if (!updated) return `Error: 计划项 ${todoId} 不存在`;
        return `已更新计划项: ${updated.content} → ${updated.status}`;
      }
      case 'read': {
        const todos = getTodos(conversationId);
        if (todos.length === 0) {
          return '当前没有任务计划。使用 todo_write(action: "set") 创建计划。';
        }
        const formatted = formatTodosForPrompt(conversationId);
        const details = todos.map(t => `- ID: ${t.id} | ${t.status} | ${t.content}`).join('\n');
        return `${formatted}\n\n详细信息（含 ID）:\n${details}`;
      }
      default:
        return `Error: 未知操作 "${action}"。可用操作: set, add, update, read`;
    }
  },
  isConcurrencySafe: false,
};

export const logTaskCompletionTool: ToolDefinition = {
  name: TOOL_NAMES.LOG_TASK_COMPLETION,
  description: 'Log a summary after completing a task. Should be called after completing a real task assigned by the user (do not log for small talk or simple Q&A).',
  inputSchema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'One-sentence description of the completed task' },
      category: {
        type: 'string',
        description: 'Task category',
        enum: ['translation', 'coding', 'research', 'writing', 'data-processing', 'file-management', 'communication', 'other'],
      },
      tools_used: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of tool names used in this task',
      },
      skill_used: { type: 'string', description: 'Name of the skill used (if any)' },
      agent_used: { type: 'string', description: 'Name of the agent delegated to (if any)' },
      success: { type: 'boolean', description: 'Whether the task completed successfully' },
    },
    required: ['summary', 'category', 'success'],
  },
  execute: async (input) => {
    try {
      const entry = {
        id: Date.now().toString(36) + Math.random().toString(36).substring(2, 8),
        summary: input.summary as string,
        category: input.category as TaskCategory,
        toolsUsed: (input.tools_used as string[]) ?? [],
        skillUsed: (input.skill_used as string) ?? null,
        agentUsed: (input.agent_used as string) ?? null,
        success: input.success as boolean,
        timestamp: Date.now(),
      };
      await appendTaskLog(entry);
      return '任务已记录。';
    } catch (err) {
      return `Error logging task: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
  isConcurrencySafe: true,
};
