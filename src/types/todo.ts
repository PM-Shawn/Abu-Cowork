// src/types/todo.ts

/**
 * Todo — 用户/Agent 的待办事项
 *
 * 来源（source）记录是怎么进来的：
 * - manual: 用户在待办视图里手动新建
 * - conversation: 用户从对话气泡点 "+ 加入待办"
 * - agent_proposed: Agent 调用 create_todo 提议（状态先在 inbox 里待确认）
 * - agent_created: Agent 执行中自动创建（直接 in_progress，V1.5 接入）
 */
export type TodoStatus = 'todo' | 'in_progress' | 'done' | 'cancelled';
export type TodoAssignee = 'human' | 'agent';
export type TodoPriority = 'high' | 'medium' | 'low';
export type TodoSource = 'manual' | 'conversation' | 'agent_proposed' | 'agent_created';

export interface Todo {
  id: string;
  title: string;
  /** 多行备注/正文，支持换行（不强制 Markdown） */
  notes?: string;
  status: TodoStatus;
  assignee: TodoAssignee;
  priority?: TodoPriority;
  /** 截止日（unix ms），可选 */
  dueAt?: number;
  source: TodoSource;
  /** 创建该待办的来源对话 ID（conversation / agent_* 时存在） */
  sourceConversationId?: string;
  /** Agent 执行时关联到的对话 ID 列表（V1.5 起会写入） */
  linkedConversationIds: string[];
  /** 归属项目，空则为全局待办 */
  projectId?: string;
  createdAt: number;
  updatedAt: number;
  /** 完成时间，用于"今天完成"的时间过滤 */
  completedAt?: number;
}

/**
 * InboxItem 状态：
 * - pending: 待用户处理
 * - accepted: 用户已接受（如 agent_proposed_todo 已加入待办）
 * - ignored: 用户已忽略（保留历史，不再展示在"待处理" tab）
 */
export type InboxItemStatus = 'pending' | 'accepted' | 'ignored';

/**
 * InboxItem — 收件箱条目
 *
 * 类型说明：
 * - agent_proposed_todo: Agent 提议创建待办，payload 携带 Todo 草稿
 * - agent_confirmation: Agent 执行中拿不准，请求用户给指令
 * - agent_result: Agent 执行完结果待审阅
 * - agent_error: Agent 执行出错
 *
 * V1 只完整实现 agent_proposed_todo（其他类型预留枚举值，V1.5 才会被生产代码触发）
 */
export type InboxItemType =
  | 'agent_proposed_todo'
  | 'agent_confirmation'
  | 'agent_result'
  | 'agent_error';

export interface InboxItem {
  id: string;
  type: InboxItemType;
  /** 摘要，用于侧边栏/列表展示 */
  summary: string;
  /** 关联对话（如有），点击 InboxItem 时可跳转 */
  conversationId?: string;
  /** 关联待办（agent_result / agent_confirmation 时存在） */
  todoId?: string;
  /** 类型特定 payload：agent_proposed_todo 时为 Todo 草稿（不含 id/时间戳） */
  payload?: Record<string, unknown>;
  /** 是否未读（影响 sidebar 角标，进入收件箱时自动清零） */
  unread: boolean;
  /** 处理状态：pending 显示操作按钮；accepted/ignored 仅作为历史显示 */
  status: InboxItemStatus;
  createdAt: number;
  /** 用户处理时间（accepted/ignored 时记录） */
  processedAt?: number;
}
