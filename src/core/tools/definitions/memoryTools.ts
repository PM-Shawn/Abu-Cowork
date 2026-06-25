import type { ToolDefinition, UserQuestionPayload, UserQuestionResult } from '../../../types';
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

export const reportPlanTool: ToolDefinition = {
  name: TOOL_NAMES.REPORT_PLAN,
  description: '上报任务执行计划。在开始执行任何任务前必须先调用此工具，告知用户你将要执行的步骤。步骤描述要用用户能理解的业务语言，不要提及工具名称。',
  inputSchema: {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        items: { type: 'string' },
        description: '任务步骤数组，用用户能理解的语言描述。例如：["扫描桌面文件", "识别发票", "创建发票文件夹", "移动发票到文件夹"]'
      },
    },
    required: ['steps'],
  },
  execute: async (input, context) => {
    const steps = input.steps as string[];

    // Plan-mode approval gate (B1): while the conversation is in 'planning',
    // presenting a plan requires user approval before writes are unlocked.
    // Reuses the user-question UI; approve → 'approved' (the tool gate then allows
    // writes), reject → stay 'planning' so the agent revises and re-submits.
    const convId = context?.conversationId;
    if (convId && context?.toolCallId && getPlanMode(convId) === 'planning' && Array.isArray(steps) && steps.length > 0) {
      const result = await requestUserQuestion(context.toolCallId, convId, buildPlanApprovalPayload(steps));
      if (interpretPlanApproval(result)) {
        setPlanMode(convId, 'approved');
        return '用户已批准计划，现在可以开始执行。';
      }
      if (result === null) {
        return '计划审批超时或已取消，仍处于计划模式（只读）。可重新提交计划。';
      }
      return '用户未批准当前计划，请根据反馈修改后重新调用 report_plan。仍处于计划模式（只读）。';
    }

    if (!steps || steps.length === 0) {
      return '已记录执行计划';
    }
    return `已记录执行计划：${steps.length}个步骤`;
  },
  isConcurrencySafe: false,
};

export const updateMemoryTool: ToolDefinition = {
  name: TOOL_NAMES.UPDATE_MEMORY,
  description: `保存或更新持久记忆。**调用前先核对 system prompt 中的 <memory-index>**：如果已有相同主题的记忆，根据情况选择 edit 覆盖或 delete 删除，不要写重复条目。

## 四种 action
- append（默认）：新写一条记忆。仅在索引中没有相似主题时使用。
- edit：用 filename 覆盖某条已有记忆（用户改主意/补充 Why/How 时用）。
- delete：用 filename 删除某条已过时的记忆（信息冲突且新值更合适时用）。
- clear：清空所有记忆（极少用，仅用户明确要求时）。

## 4 类记忆 type
- user — 用户角色、目标、知识水平、长期偏好。例：用户是数据团队 PM；偏好简洁回复。
- feedback — 用户对你的纠正或确认。body 结构：**规则 + Why + How to apply**。
  - 例（纠正）：规则=不要用 echo 写文件；Why=中文易乱码；How=改用 Write 工具
  - 例（确认）：规则=重构按"一类一 commit"拆；Why=便于回溯；How=后续重构沿用
- project — 项目进展、关键决策、待办、约束。body 结构：**事实 + Why + How to apply**。
- reference — 外部资源指针（看板/文档/频道地址）。

## 不要保存
- 一次性任务结果（"X 已生成"/"翻译完成"）、临时状态（"测试通过"/"端口被占用"）
- 可派生信息（项目路径、代码模式 — 读项目/grep 就知道）
- 闲聊、问候、一次性查询（天气、临时计算）
- 项目规则文件（.abu/ABU.md）已包含的内容

即便用户明确说"记住这个清单"，先问：哪部分是 *意外的、未来还有用的*？只记那部分。

## 写入前必查（避免重复 / 处理冲突）
先扫 <memory-index>，按现有记忆与新信息的关系分情况：
- **新主题**（索引无相似条目）→ append
- **信息冲突**（同一事实不同值，如"用户叫小包" → "用户叫小白"）→ edit 覆盖旧条，或 delete 后再 append。**永远不要留下两条值矛盾的记忆并存**。
- **信息补充**（原条目缺 Why/How，新对话补全了）→ edit 把旧条补全，不要新写平行的。
- **完全同义重复** → 跳过。

判断三问：①冲突还是补充？②同时存在会不会让未来 Agent 困惑？③用户最近一句是不是在改之前的偏好？任一"是" → 用 edit/delete，不要 append。

## private 标记 + description 写法（重要）
保存身份证/银行卡/手机号/薪资/医疗/未公开商业等敏感信息时传 \`private: true\`。**对于 private 记忆，description 必须只写"主题"，不要写"具体值"**——因为 description 会出现在 MEMORY.md 索引里被注入到每轮对话的 system prompt。
- ✅ description="个人身份证号" / "工行账户" / "本月薪资"
- ❌ description="身份证 110105..." / "卡号 6228... 密码 xxx"
普通用户偏好/工作习惯保持非私密，description 可以写得详细一些方便每轮自动引用。`,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: '操作类型: append(新写，默认) / edit(覆盖单条) / delete(删除单条) / clear(清空全部)',
        enum: ['append', 'edit', 'delete', 'clear'],
      },
      filename: {
        type: 'string',
        description: '记忆文件名（edit 和 delete 必填）。来自 <memory-index> 索引行的 [filename](filename) 部分。',
      },
      name: { type: 'string', description: '记忆名称（append 必填，edit 可选）' },
      content: { type: 'string', description: '记忆内容（append 和 edit 必填）' },
      description: { type: 'string', description: '一句话描述（append 和 edit 可选；不传则取 content 前 80 字）' },
      type: {
        type: 'string',
        description: '分类: user(用户偏好/角色/知识水平) / feedback(行为纠正或确认，含原因和适用场景) / project(项目动态/决策) / reference(外部系统指针)',
        enum: ['user', 'feedback', 'project', 'reference'],
      },
      private: {
        type: 'boolean',
        description: '是否为私密记忆。true 表示不会自动注入对话上下文，仅用户明确询问时通过 read_memory 拉取。仅对身份证/银行卡/手机号/薪资/医疗/家庭隐私/未公开商业信息等敏感内容设为 true。默认 false。',
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
  description: '创建或更新任务计划。可以批量设置计划项，或更新单个项的状态。计划会在每轮对话中注入，确保你始终能看到当前进度。',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: '操作类型: set(批量设置计划) / add(添加单个) / update(更新状态) / read(读取当前计划)',
        enum: ['set', 'add', 'update', 'read'],
      },
      items: {
        type: 'array',
        items: { type: 'object' },
        description: '计划项列表（用于 set 和 add 操作）。每项应包含 content(string) 和可选 status(string: pending/in_progress/completed/cancelled)',
      },
      todo_id: { type: 'string', description: '要更新的计划项 ID（用于 update 操作）' },
      status: { type: 'string', description: '新状态（用于 update 操作）' },
      content: { type: 'string', description: '新内容（用于 update 或 add 操作）' },
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
  description: '任务完成后记录摘要。完成用户交办的实际任务后应调用（闲聊和简单问答不记录）。',
  inputSchema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: '一句话描述完成的任务' },
      category: {
        type: 'string',
        description: '任务分类',
        enum: ['translation', 'coding', 'research', 'writing', 'data-processing', 'file-management', 'communication', 'other'],
      },
      tools_used: {
        type: 'array',
        items: { type: 'string' },
        description: '本次使用的工具名称列表',
      },
      skill_used: { type: 'string', description: '使用的技能名称（如有）' },
      agent_used: { type: 'string', description: '委派的代理名称（如有）' },
      success: { type: 'boolean', description: '任务是否成功完成' },
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
