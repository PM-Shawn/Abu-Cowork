import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * The drafts of 「创建应用」 (docs/app-spec.md): each creation conversation
 * writes its app into its own folder under `~/Abu Apps/<id>/`, the
 * conversation's workspace. This remembers which conversation owns which
 * folder — the only way `app_prepare` and the preview card find a draft — and
 * which app a confirmed draft became.
 */
export interface AppDraft {
  id: string;
  dir: string;
  createdAt: string;
  /** The app the draft was added as, once the user confirmed it. */
  appId?: string;
}

interface AppDraftState {
  draftsByConversation: Record<string, AppDraft>;
}

interface AppDraftActions {
  record: (conversationId: string, draft: AppDraft) => void;
  markAdded: (conversationId: string, appId: string) => void;
}

export const useAppDraftStore = create<AppDraftState & AppDraftActions>()(
  persist(
    (set) => ({
      draftsByConversation: {},
      record: (conversationId, draft) => set((state) => ({ draftsByConversation: { ...state.draftsByConversation, [conversationId]: draft } })),
      markAdded: (conversationId, appId) => set((state) => {
        const draft = state.draftsByConversation[conversationId];
        if (!draft) throw new Error(`conversation ${conversationId} has no app draft`);
        return { draftsByConversation: { ...state.draftsByConversation, [conversationId]: { ...draft, appId } } };
      }),
    }),
    {
      name: 'abu-app-drafts',
      version: 1,
      partialize: (state) => ({ draftsByConversation: state.draftsByConversation }),
    },
  ),
);
