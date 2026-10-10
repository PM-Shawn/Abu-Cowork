import { useI18n } from '@/i18n';
import { Spinner } from '@/components/ds/spinner';
import { getConversationAgentState, useChatStore } from '@/stores/chatStore';

/**
 * AgentStatusStrip — a small line above the composer that surfaces the two
 * states that would otherwise be a silent dead wait on a slow/flaky provider:
 * context compaction and LLM-call retries (Bug 1: 计划同意后死寂).
 *
 * Renders nothing when neither is active.
 */
export default function AgentStatusStrip({ conversationId }: { conversationId: string }) {
  const { t, format } = useI18n();
  const isCompressing = useChatStore((s) => s.conversations[conversationId]?.isCompressing ?? false);
  const retryInfo = useChatStore((s) => getConversationAgentState(s.agentStates, conversationId).retryInfo);

  if (!isCompressing && !retryInfo) return null;

  // Retry is the more urgent signal — show it first if both are somehow active.
  const text = retryInfo
    ? format(t.chat.retrying, { attempt: retryInfo.attempt, max: retryInfo.maxAttempts })
    : t.chat.compressingContext;

  // The strip is one place: its only spinner carries the words.
  return (
    <div className="flex min-w-0 items-center px-3 py-2">
      <Spinner label={text} />
    </div>
  );
}
