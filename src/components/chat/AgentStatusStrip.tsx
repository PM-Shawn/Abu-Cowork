import { Loader2 } from 'lucide-react';
import { useI18n } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';

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
  const retryInfo = useChatStore((s) => s.retryInfo);

  if (!isCompressing && !retryInfo) return null;

  // Retry is the more urgent signal — show it first if both are somehow active.
  const text = retryInfo
    ? format(t.chat.retrying, { attempt: retryInfo.attempt, max: retryInfo.maxAttempts })
    : t.chat.compressingContext;

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-[12px] text-[var(--abu-text-tertiary)]">
      <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
      <span className="truncate">{text}</span>
    </div>
  );
}
