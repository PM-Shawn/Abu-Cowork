import { useShallow } from 'zustand/react/shallow';
import { useChatStore } from '@/stores/chatStore';
import type { ToolCall } from '@/types';

type ToolCallList = ToolCall[] | undefined;

const EMPTY_TOOL_CALL_LISTS: ToolCallList[] = [];

// The tool calls of the active conversation, one entry per message. The store keeps
// each message's `toolCalls` array as it is while text streams into `content`, so a
// component reading this renders again only when a tool call is added or changes.
export function useActiveToolCallLists(): ToolCallList[] {
  return useChatStore(useShallow((s) => {
    const id = s.activeConversationId;
    const messages = id ? s.conversations[id]?.messages : undefined;
    return messages ? messages.map((message) => message.toolCalls) : EMPTY_TOOL_CALL_LISTS;
  }));
}
