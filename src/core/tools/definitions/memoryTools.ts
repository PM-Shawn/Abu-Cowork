import type { ToolDefinition } from '../../../types';
import { useChatStore } from '../../../stores/chatStore';
import { useWorkspaceStore } from '../../../stores/workspaceStore';
import { appendTaskLog, type TaskCategory } from '../../agent/taskLog';
import { getTodos, addTodo, updateTodo, setTodos, formatTodosForPrompt } from '../../agent/todoManager';
import type { TodoStatus } from '../../agent/todoManager';
import { TOOL_NAMES } from '../toolNames';
import type { MemoryType } from '../../memdir/types';

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
  execute: async (input) => {
    const steps = input.steps as string[];
    if (!steps || steps.length === 0) {
      return '已记录执行计划';
    }
    return `已记录执行计划：${steps.length}个步骤`;
  },
  isConcurrencySafe: false,
};

export const updateMemoryTool: ToolDefinition = {
  name: TOOL_NAMES.UPDATE_MEMORY,
  description: '保存持久记忆。记忆按当前工作区隔离存储，无工作区时存为全局记忆。注意：项目规则（.abu/ABU.md）由用户手动维护，不要用此工具修改规则。',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '记忆名称（简短标题）' },
      content: { type: 'string', description: '记忆内容（必填）' },
      description: { type: 'string', description: '一句话描述，用于索引检索' },
      type: {
        type: 'string',
        description: '分类: user(用户偏好/角色/知识水平) / feedback(行为纠正或确认，含原因和适用场景) / project(项目动态/决策/技术栈) / reference(外部系统指针)',
        enum: ['user', 'feedback', 'project', 'reference'],
      },
      action: {
        type: 'string',
        description: '操作类型: append(添加，默认) / clear(清空所有记忆)',
        enum: ['append', 'clear'],
      },
    },
    required: ['name', 'content'],
  },
  execute: async (input, context) => {
    const action = (input.action as string) || 'append';
    const content = (input.content as string) || '';
    const name = (input.name as string) || content.slice(0, 40);
    const description = (input.description as string) || content.slice(0, 80);
    const type = ((input.type as string) || 'project') as MemoryType;

    try {
      const workspacePath = context?.workspacePath ?? useWorkspaceStore.getState().currentPath;

      if (action === 'clear') {
        const { clearAllMemories } = await import('../../memdir/write');
        const count = await clearAllMemories(workspacePath);
        return `已清空记忆（${count} 条）。`;
      }

      // Append: write a new .md memory file
      if (!content) return '错误：content 不能为空。';

      const { writeMemory } = await import('../../memdir/write');
      const filename = await writeMemory({
        name,
        description,
        type,
        content,
        source: 'agent_explicit',
        workspacePath,
      });

      return `已保存记忆 [${type}]: ${name} → ${filename}`;
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
