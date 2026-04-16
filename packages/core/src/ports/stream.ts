import type {
  Message,
  MessageContent,
  ToolResult,
  AgentStatus,
  ConversationStatus,
} from '../../../../src/types';

/**
 * StreamEvent —— Agent 对外流式事件协议。
 * 前后端/跨进程唯一契约。任何 UI 需要感知的 core 状态变更都通过这里流出。
 */
export type StreamEvent =
  | { type: 'conversation.started'; conversationId: string; loopId: string }
  | { type: 'conversation.complete'; conversationId: string; status: ConversationStatus }
  | { type: 'message.start'; messageId: string; role: 'assistant' }
  | { type: 'message.delta'; messageId: string; delta: string }
  | { type: 'message.thinking.delta'; messageId: string; delta: string }
  | { type: 'message.complete'; messageId: string; message: Message }
  | {
      type: 'tool.call.start';
      toolCallId: string;
      name: string;
      input: Record<string, unknown>;
    }
  | { type: 'tool.call.delta'; toolCallId: string; delta: string }
  | {
      type: 'tool.call.result';
      toolCallId: string;
      result: ToolResult;
      isError: boolean;
    }
  | { type: 'agent.status'; status: AgentStatus }
  | { type: 'skill.activated'; skillName: string }
  | { type: 'delegate.started'; agentName: string; subConversationId: string }
  | {
      type: 'context.warning';
      level: 0 | 1 | 2 | 3;
      usedTokens: number;
      maxTokens: number;
    }
  | {
      type: 'context.compressed';
      fromRange: [number, number];
      toMessageId: string;
    }
  | { type: 'rate.limited'; retryAfterMs: number }
  | {
      type: 'error';
      code: string;
      message: string;
      recoverable: boolean;
    };

/** 用于 type-narrow 的辅助 */
export type StreamEventType = StreamEvent['type'];

export type StreamEventOfType<T extends StreamEventType> = Extract<
  StreamEvent,
  { type: T }
>;

// 引用占位，防止 import 被 ts 当成未使用
export type _UsedImports = MessageContent;
