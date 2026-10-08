import { useEffect, useMemo, useRef } from 'react';
import { useConfirm } from '@/components/ds/confirm-context';
import { useI18n } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import type { ConversationRowFocus } from './conversationRowFocus';
import { UNDO_OFFER_MS } from './undoOffer';

/**
 * 删除会话, chosen in a conversation row's menu (the sidebar's recent tasks and the tasks of a
 * project; there is no other way to delete a conversation).
 *
 * The record is read first. A conversation that can be read is deleted at once, and the recent
 * tasks offer to undo it for a few seconds. One whose record is on disk and cannot be read
 * (`chatStore.loadFailures`) has nothing an undo could bring back, so the user is asked first, by
 * name, once the menu has gone and has given the focus back to the row. The answer is checked
 * against the store as it is then: a conversation that has gone meanwhile is left alone, and one
 * that has been read meanwhile is deleted like any other. One delete per conversation at a time.
 */
export interface DeleteConversation {
  /** For the menu item. */
  fromMenu: (convId: string) => void;
  /** For the row menus' close hook: the menu has gone. Call it before the hook does anything else. */
  menuClosed: () => void;
  /** A row menu opened: a question that waited for the menu before it is dropped, unasked. */
  menuOpened: () => void;
}

/** True when the conversation is listed and its record could not be read. */
function isUnreadable(convId: string): boolean {
  const state = useChatStore.getState();
  return state.conversationIndex[convId] !== undefined
    && state.conversations[convId] === undefined
    && state.loadFailures[convId] === true;
}

export function useDeleteConversation(rowFocus: ConversationRowFocus, offersUndo: boolean): DeleteConversation {
  const { t, format } = useI18n();
  const confirm = useConfirm();
  const deleting = useRef(new Set<string>());
  // The menu the delete was chosen from is still on its way out, and the conversation whose
  // question waits for it.
  const menuClosing = useRef(false);
  const parked = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const latest = useRef({ t, format, confirm, rowFocus, offersUndo });
  useEffect(() => { latest.current = { t, format, confirm, rowFocus, offersUndo }; });

  return useMemo(() => {
    const chat = useChatStore.getState;
    const remove = async (convId: string, menuHasGone: boolean) => {
      if (deleting.current.has(convId)) return;
      deleting.current.add(convId);
      try {
        if (!menuHasGone) await chat().loadConversation(convId);
        if (isUnreadable(convId)) {
          if (!menuHasGone && menuClosing.current) {
            // The close hook asks: a question opened now would take the focus from a menu that
            // is leaving, and give it back to nothing.
            parked.current = convId;
            return;
          }
          if (!mounted.current) return;
          const { t: words, format: fill, confirm: ask } = latest.current;
          // The name is taken before asking; the answer is checked against the store below.
          const confirmed = await ask({
            title: words.sidebar.deleteUnreadableTitle,
            message: fill(words.sidebar.deleteUnreadableMessage, { name: chat().conversationIndex[convId].title }),
            confirmLabel: words.common.delete,
            tone: 'danger',
          });
          if (!confirmed || !mounted.current) return;
          if (chat().conversationIndex[convId] === undefined) return;
        }
        const current = latest.current;
        // Null for a conversation that is not in memory: nothing to offer back.
        const json = current.offersUndo ? chat().exportConversation(convId) : null;
        current.rowFocus.note(convId);
        chat().deleteConversation(convId);
        if (json) {
          // One offer at a time: the notification list shows equal notifications as one, the newest,
          // with its time started again. So only the last delete can be undone.
          useToastStore.getState().addToast({
            type: 'info',
            title: current.t.sidebar.conversationDeleted,
            duration: UNDO_OFFER_MS,
            actions: [{ label: current.t.sidebar.undo, onClick: () => { chat().importConversation(json, { keepPermissionMode: true }); } }],
          });
        }
      } finally {
        deleting.current.delete(convId);
      }
    };
    return {
      fromMenu: (convId) => {
        menuClosing.current = true;
        parked.current = null;
        void remove(convId, false);
      },
      menuClosed: () => {
        menuClosing.current = false;
        const convId = parked.current;
        parked.current = null;
        // After this hook the menu hands the focus back to the row; the question opens after that.
        if (convId !== null) queueMicrotask(() => { void remove(convId, true); });
      },
      menuOpened: () => {
        menuClosing.current = false;
        parked.current = null;
      },
    };
  }, []);
}
