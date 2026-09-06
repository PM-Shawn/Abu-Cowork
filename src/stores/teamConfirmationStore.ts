import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { generateId } from '@/lib/utils';

/**
 * Confirmations a team run could not wait for (block O "审批不阻塞"): the
 * action was refused at the time, and sits here until the user approves or
 * rejects it. Approving a command / browser / self-extension action stores a
 * one-shot approval consumed by the next identical request in the same
 * conversation; file access is granted through permissionStore instead.
 */
export type TeamConfirmationKind = 'command' | 'browser' | 'self-extension' | 'file';

export interface TeamConfirmation {
  id: string;
  conversationId: string;
  kind: TeamConfirmationKind;
  /** The command / action summary / file path the user is asked about. */
  detail: string;
  reason?: string;
  /** Member name; undefined when the leader itself asked. */
  member?: string;
  path?: string;
  capability?: 'read' | 'write';
  createdAt: number;
}

export type TeamConfirmationInput = Omit<TeamConfirmation, 'id' | 'createdAt'>;

export function confirmationKey(item: Pick<TeamConfirmation, 'kind' | 'detail'>): string {
  return `${item.kind}:${item.detail}`;
}

interface TeamConfirmationState {
  pending: Record<string, TeamConfirmation>;
  /** conversationId → one-shot approval keys (confirmationKey). */
  approvedOnce: Record<string, string[]>;
}

interface TeamConfirmationActions {
  /** Add unless the same conversation already has this kind+detail pending; returns null then. */
  add: (item: TeamConfirmationInput) => TeamConfirmation | null;
  remove: (id: string) => void;
  approveOnce: (conversationId: string, key: string) => void;
  /** True (and consumed) when an identical request was approved earlier. */
  consumeApproval: (conversationId: string, key: string) => boolean;
  clearConversation: (conversationId: string) => void;
}

export type TeamConfirmationStore = TeamConfirmationState & TeamConfirmationActions;

export function pendingFor(pending: Record<string, TeamConfirmation>, conversationId: string): TeamConfirmation[] {
  return Object.values(pending)
    .filter((item) => item.conversationId === conversationId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export const useTeamConfirmationStore = create<TeamConfirmationStore>()(
  persist(
    immer((set, get) => ({
      pending: {},
      approvedOnce: {},

      add: (item) => {
        const key = confirmationKey(item);
        const duplicate = Object.values(get().pending).some(
          (existing) => existing.conversationId === item.conversationId && confirmationKey(existing) === key,
        );
        if (duplicate) return null;
        const entry: TeamConfirmation = { ...item, id: generateId(), createdAt: Date.now() };
        set((state) => { state.pending[entry.id] = entry; });
        return entry;
      },

      remove: (id) => set((state) => { delete state.pending[id]; }),

      approveOnce: (conversationId, key) => set((state) => {
        const list = state.approvedOnce[conversationId] ?? [];
        if (!list.includes(key)) state.approvedOnce[conversationId] = [...list, key];
      }),

      consumeApproval: (conversationId, key) => {
        const list = get().approvedOnce[conversationId] ?? [];
        if (!list.includes(key)) return false;
        set((state) => {
          const rest = (state.approvedOnce[conversationId] ?? []).filter((entry) => entry !== key);
          if (rest.length === 0) delete state.approvedOnce[conversationId];
          else state.approvedOnce[conversationId] = rest;
        });
        return true;
      },

      clearConversation: (conversationId) => set((state) => {
        for (const [id, item] of Object.entries(state.pending)) {
          if (item.conversationId === conversationId) delete state.pending[id];
        }
        delete state.approvedOnce[conversationId];
      }),
    })),
    { name: 'abu-team-confirmations' },
  ),
);
