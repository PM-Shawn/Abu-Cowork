import { useState } from 'react';
import type { ConversationBranchOrigin } from '@/types';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useI18n } from '@/i18n';
import { Pressable } from '@/components/ds/pressable';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';

export function ConversationBranchOrigin({ origin }: { origin: ConversationBranchOrigin }) {
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
  return <div className="my-3 flex items-center gap-3 text-ui-sm text-label-secondary" data-testid="branch-origin">
    <span className="flex-1 border-t border-separator" aria-hidden="true" />
    {status ? <span className="inline-flex items-center gap-2"><Icon icon={AppIcons.branch} size="sm" />{status}</span> : <Pressable className="inline-flex items-center gap-2 text-link" aria-disabled={reading} onClick={() => { void open(); }}>
      <Icon icon={AppIcons.branch} size="sm" className="text-label-secondary" />
      {t.chat.branch.source}
    </Pressable>}
    <span className="flex-1 border-t border-separator" aria-hidden="true" />
  </div>;
}
