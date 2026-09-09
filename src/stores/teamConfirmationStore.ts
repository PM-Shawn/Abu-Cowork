import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { generateId } from '@/lib/utils';
import { clearTeamConfirmationIdentities, isRetryableTeamIdentity, type TeamConfirmationIdentity } from '@/core/agent/teamConfirmationIdentity';

// 'browser-upload' stays distinct from 'browser' (dev #416): an upload is the
// one browser action whose consequence leaves the machine, so an approval for
// it must never be consumable by an ordinary browser action with the same
// parameters — the kind is part of the authorization key.
export type TeamConfirmationKind = 'command' | 'browser' | 'browser-upload' | 'self-extension' | 'file';
export interface TeamConfirmation {
  id: string;
  conversationId: string;
  kind: TeamConfirmationKind;
  /** Presentation only; never used as an authorization key. */
  detail: string;
  reason?: string;
  member?: string;
  path?: string;
  capability?: 'read' | 'write';
  additionalCapabilities?: Array<'read' | 'write'>;
  /** Missing on legacy records: they must be requested again, never approved. */
  identity?: TeamConfirmationIdentity;
  createdAt: number;
}
export type TeamConfirmationInput = Omit<TeamConfirmation, 'id' | 'createdAt'>;
export type TeamApprovalMode = 'once' | 'run';
interface Approval {
  item: TeamConfirmation;
  mode: TeamApprovalMode;
  loopId: string;
  /** Once only: claimed by the first retry of the original dispatch, not a sibling. */
  dispatchId?: string;
}
interface RetrySelection { item: TeamConfirmation; mode: TeamApprovalMode }

export function confirmationKey(item: Pick<TeamConfirmation, 'conversationId' | 'member' | 'kind' | 'identity'>): string {
  return JSON.stringify([item.conversationId, item.member ?? null, item.kind,
    item.identity?.toolName, item.identity?.parametersDigest, item.identity?.cwd]);
}

interface TeamConfirmationState {
  pending: Record<string, TeamConfirmation>;
  /** Live resolvers are held by the shell, never persisted. */
  waiting: Record<string, true>;
  permissionActivity: Record<string, { conversationId: string; loopId: string; at: number }>;
  approvedOnce: Record<string, Approval>;
  runRules: Record<string, Approval>;
  /** UI-owned handoff, inert until its specific queued turn starts. Never persisted. */
  retrySelections: Record<string, RetrySelection>;
}
interface TeamConfirmationActions {
  add: (item: TeamConfirmationInput) => TeamConfirmation | null;
  remove: (id: string) => void;
  setWaiting: (id: string, waiting: boolean) => void;
  finishWaiting: (id: string, at: number) => void;
  selectRetry: (id: string, mode: TeamApprovalMode) => string | undefined;
  beginRetry: (conversationId: string, loopId: string, selectionId?: string) => void;
  claimDispatch: (conversationId: string, loopId: string, dispatchId: string, fingerprint: string, member: string) => void;
  consumeApproval: (item: TeamConfirmationInput) => boolean;
  revoke: (id: string) => void;
  clearRun: (conversationId: string, loopId: string) => void;
  clearConversation: (conversationId: string) => void;
}
export type TeamConfirmationStore = TeamConfirmationState & TeamConfirmationActions;
export function pendingFor(pending: Record<string, TeamConfirmation>, conversationId: string): TeamConfirmation[] {
  return Object.values(pending).filter((item) => item.conversationId === conversationId).sort((a, b) => a.createdAt - b.createdAt);
}
export const useTeamConfirmationStore = create<TeamConfirmationStore>()(
  persist(immer((set, get) => ({
    pending: {}, waiting: {}, permissionActivity: {}, approvedOnce: {}, runRules: {}, retrySelections: {},
    add: (item) => {
      // Keep separate calls separate, even when their presentation/parameters match.
      const duplicate = Object.values(get().pending).some((old) => confirmationKey(old) === confirmationKey(item)
        && old.identity?.loopId === item.identity?.loopId && old.identity?.dispatchId === item.identity?.dispatchId
        && old.identity?.callId === item.identity?.callId);
      if (duplicate) return null;
      const entry = { ...item, id: generateId(), createdAt: Date.now() };
      set((s) => { s.pending[entry.id] = entry; });
      return entry;
    },
    remove: (id) => set((s) => { delete s.pending[id]; delete s.waiting[id]; }),
    setWaiting: (id, waiting) => set((s) => {
      if (waiting && s.pending[id]) s.waiting[id] = true;
      else delete s.waiting[id];
    }),
    finishWaiting: (id, at) => set((s) => {
      const item = s.pending[id];
      if (item?.identity) s.permissionActivity[JSON.stringify([item.conversationId, item.identity.dispatchId])] = {
        conversationId: item.conversationId, loopId: item.identity.loopId, at,
      };
      delete s.waiting[id]; delete s.pending[id];
    }),
    selectRetry: (id, mode) => {
      const item = get().pending[id];
      if (!item || get().waiting[id] || !isRetryableTeamIdentity(item.identity)) return undefined;
      set((s) => { s.retrySelections[id] = { item, mode }; delete s.pending[id]; });
      return id;
    },
    beginRetry: (conversationId, loopId, selectionId) => {
      if (!selectionId) return;
      const selected = get().retrySelections[selectionId];
      if (!selected || selected.item.conversationId !== conversationId) return;
      set((s) => {
        const approval: Approval = { ...selected, loopId,
          ...(selected.item.identity?.dispatchId === 'leader' ? { dispatchId: 'leader' } : {}) };
        if (selected.mode === 'once') s.approvedOnce[selectionId] = approval;
        else s.runRules[selectionId] = approval;
        delete s.retrySelections[selectionId];
      });
    },
    claimDispatch: (conversationId, loopId, dispatchId, fingerprint, member) => set((s) => {
      for (const approval of Object.values(s.approvedOnce)) {
        if (approval.loopId === loopId && approval.item.conversationId === conversationId
          && approval.item.member === member && !approval.dispatchId
          && approval.item.identity?.dispatchFingerprint === fingerprint) approval.dispatchId = dispatchId;
      }
    }),
    consumeApproval: (item) => {
      if (!isRetryableTeamIdentity(item.identity)) return false;
      const matches = (approval: Approval) => approval.loopId === item.identity!.loopId
        && confirmationKey(approval.item) === confirmationKey(item);
      if (Object.values(get().runRules).some(matches)) return true;
      const entry = Object.entries(get().approvedOnce).find(([, approval]) => matches(approval)
        && approval.dispatchId === item.identity!.dispatchId
        && approval.item.identity?.requestOrdinal === item.identity!.requestOrdinal);
      if (!entry) return false;
      set((s) => { delete s.approvedOnce[entry[0]]; });
      return true;
    },
    revoke: (id) => set((s) => {
      delete s.waiting[id]; delete s.pending[id]; delete s.retrySelections[id]; delete s.approvedOnce[id]; delete s.runRules[id];
    }),
    clearRun: (conversationId, loopId) => set((s) => {
      clearTeamConfirmationIdentities(conversationId, loopId);
      for (const grants of [s.approvedOnce, s.runRules]) {
        for (const [id, approval] of Object.entries(grants)) {
          if (approval.item.conversationId === conversationId && approval.loopId === loopId) delete grants[id];
        }
      }
      for (const [id, item] of Object.entries(s.pending)) {
        if (item.conversationId === conversationId && item.identity?.loopId === loopId) delete s.waiting[id];
      }
      for (const [key, activity] of Object.entries(s.permissionActivity)) {
        if (activity.conversationId === conversationId && activity.loopId === loopId) delete s.permissionActivity[key];
      }
      // Stopped requests stay visible for a later explicit retry. They confer no authority.
    }),
    clearConversation: (conversationId) => set((s) => {
      clearTeamConfirmationIdentities(conversationId);
      for (const [id, item] of Object.entries(s.pending)) if (item.conversationId === conversationId) { delete s.pending[id]; delete s.waiting[id]; }
      for (const [key, activity] of Object.entries(s.permissionActivity)) if (activity.conversationId === conversationId) delete s.permissionActivity[key];
      for (const grants of [s.approvedOnce, s.runRules, s.retrySelections]) {
        for (const [id, approval] of Object.entries(grants)) if (approval.item.conversationId === conversationId) delete grants[id];
      }
    }),
  })), {
    name: 'abu-team-confirmations',
    version: 1,
    migrate: (persisted, version) => {
      if (version < 1) return { pending: (persisted as Partial<TeamConfirmationState> | undefined)?.pending ?? {} };
      return persisted;
    },
    partialize: (state) => ({ pending: state.pending }),
    // Explicitly discard old persisted approvedOnce tickets as well as new runtime fields.
    merge: (persisted, current) => ({ ...current,
      pending: (persisted as Partial<TeamConfirmationState> | undefined)?.pending ?? {},
      waiting: {}, permissionActivity: {}, approvedOnce: {}, runRules: {}, retrySelections: {},
    }),
  }),
);
