import { useState } from 'react';
import type { ConversationBranchOrigin } from '@/types';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useI18n, format } from '@/i18n';
import { Pressable } from '@/components/ds/pressable';

export function ConversationBranchOrigin({ origin, workspacePath }: { origin: ConversationBranchOrigin; workspacePath?: string | null }) {
  const { t } = useI18n();
  const sourceMeta = useChatStore(state => state.conversationIndex[origin.sourceConversationId]);
  const source = useChatStore(state => state.conversations[origin.sourceConversationId]);
  const failed = useChatStore(state => state.loadFailures[origin.sourceConversationId]);
  const [reading, setReading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const status = !sourceMeta ? t.chat.branch.sourceDeleted : failed ? t.chat.branch.sourceInaccessible
    : unavailable || (source && !source.messages.some(message => message.id === origin.sourceMessageId)) ? t.chat.branch.sourceUnavailable : null;
  const open = async () => {
    if (reading || status) return;
    setReading(true);
    const selected = useChatStore.getState().activeConversationId;
    let moved = false;
    const unsubscribe = useChatStore.subscribe((state, previous) => { if (state.activeConversationId !== previous.activeConversationId) moved = true; });
    const unsubscribeView = useSettingsStore.subscribe((state, previous) => { if (state.viewMode !== previous.viewMode) moved = true; });
    try {
      await useChatStore.getState().loadConversation(origin.sourceConversationId);
      const loaded = useChatStore.getState().conversations[origin.sourceConversationId];
      if (!loaded?.messages.some(message => message.id === origin.sourceMessageId)) { setUnavailable(true); return; }
      if (moved || useChatStore.getState().activeConversationId !== selected) return;
      useChatStore.getState().setPendingSearchJump({ convId: origin.sourceConversationId, query: '', messageId: origin.sourceMessageId });
      await useChatStore.getState().switchConversation(origin.sourceConversationId);
    } finally { unsubscribe(); unsubscribeView(); setReading(false); }
  };
  return <div className="my-3 flex flex-col items-start gap-1 border-t border-separator pt-3 text-ui-sm text-label-secondary" data-testid="branch-origin">
    {status ? <span>{status}</span> : <Pressable className="text-link" aria-disabled={reading} onClick={() => { void open(); }}>
      {format(t.chat.branch.source, { title: sourceMeta?.title ?? origin.sourceTitle })}
    </Pressable>}
    <span>{t.chat.branch.boundary}</span>
    {workspacePath && <span>{t.chat.branch.currentFiles}</span>}
  </div>;
}
