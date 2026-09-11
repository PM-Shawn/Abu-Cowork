import type { ToolExecutionContext } from '../../types';
import { useChatStore } from '../../stores/chatStore';
import { extractParentConversationSummary } from './subagentLoop';

/**
 * Resolve the parent conversation by the current tool execution context first.
 * activeConversationId is only a UI fallback; concurrent/headless runs can have
 * a different active conversation by the time a delegate tool executes.
 */
export function resolveParentConversationSummary(
  toolExecContext?: Pick<ToolExecutionContext, 'conversationId'>,
): string | undefined {
  try {
    const chatState = useChatStore.getState();
    const conversationId = toolExecContext?.conversationId ?? chatState.activeConversationId;
    if (!conversationId) return undefined;

    const messages = chatState.conversations[conversationId]?.messages ?? [];
    const summary = extractParentConversationSummary(messages);
    return summary || undefined;
  } catch {
    return undefined;
  }
}
