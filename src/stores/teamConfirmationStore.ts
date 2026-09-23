import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { generateId } from '@/lib/utils';
import { clearTeamConfirmationIdentities, isRetryableTeamIdentity, type TeamConfirmationIdentity } from '@/core/agent/teamConfirmationIdentity';
import { teamTaskRuleCategory } from '@/core/agent/teamApprovalScope';
import type { DangerLevel } from '@/core/tools/commandSafety';
import type { BrowserOperationClass } from '@/core/permissions/browserToolPolicy';

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
  /**
   * Browser confirmations only: the authorization PAYLOAD of the original
   * request, carried so the strip can offer the same per-site grant the
   * desktop dialog offers instead of only "allow this one retry".
   *
   * These four fields are payload, NOT identity: they must never enter
   * `confirmationKey`. An approval is keyed by who asked, what kind of action
   * it is, and the exact parameters — adding the origin or the requester's
   * own `allowPersistentGrant` there would let a request that differs only in
   * its payload spend (or miss) a grant that was given for another one.
   */
  browserOrigin?: string;
  browserOperationClass?: BrowserOperationClass;
  browserPermissionResource?: import('@/core/permissions/browserPermissionDefaults').BrowserPermissionResource;
  browserPermissionTargets?: import('@/core/permissions/browserPermissionConfig').BrowserPermissionTarget[];
  /** The REQUESTER's ceiling; `mayOfferPersistentGrant` still lowers it. */
  allowPersistentGrant?: boolean;
  level?: DangerLevel;
  createdAt: number;
}
export type TeamConfirmationInput = Omit<TeamConfirmation, 'id' | 'createdAt'>;
export type TeamApprovalMode = 'once';
interface Approval {
  item: TeamConfirmation;
  mode: TeamApprovalMode;
  loopId: string;
  /** Claimed by the first retry of the original dispatch, not a sibling. */
  dispatchId?: string;
}
/**
 * "Allow for this task": one member may repeat one category of request
 * (see teamApprovalScope.ts) for the rest of the team task, whichever run of
 * the task it happens in. A task starts with a request the user typed and
 * continues through every run started from the confirmation strip.
 */
export interface TaskRule {
  item: TeamConfirmation;
  taskId: string;
  category: string;
  createdAt: number;
}
interface RetrySelection { item: TeamConfirmation; mode: TeamApprovalMode }

export function confirmationKey(item: Pick<TeamConfirmation, 'conversationId' | 'member' | 'kind' | 'identity'>): string {
  return JSON.stringify([item.conversationId, item.member ?? null, item.kind,
    item.identity?.toolName, item.identity?.parametersDigest, item.identity?.cwd]);
}

interface TeamConfirmationState {
  pending: Record<string, TeamConfirmation>;
  approvedOnce: Record<string, Approval>;
  /** Runtime only: a restart ends every task. */
  taskRules: Record<string, TaskRule>;
  /** The team task each conversation is in. Runtime only. */
  currentTaskByConversation: Record<string, string>;
  /** UI-owned handoff, inert until its specific queued turn starts. Never persisted. */
  retrySelections: Record<string, RetrySelection>;
}
interface TeamConfirmationActions {
  add: (item: TeamConfirmationInput) => TeamConfirmation | null;
  remove: (id: string) => void;
  /**
   * A run is starting in a team conversation. `continues` is true only for a
   * run the confirmation strip started; anything else begins a new task and
   * retires the previous task's rules.
   */
  beginTask: (conversationId: string, continues: boolean) => { taskId: string; retiredTaskId?: string };
  /** "Allow for this task". False when the request has no category (must be asked every time). */
  approveForTask: (id: string) => boolean;
  /** "Allow all": every pending request of the conversation that has a category. Returns how many. */
  approveAllForTask: (conversationId: string) => number;
  selectRetry: (id: string) => string | undefined;
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
    pending: {}, approvedOnce: {}, taskRules: {}, currentTaskByConversation: {}, retrySelections: {},
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
    remove: (id) => set((s) => { delete s.pending[id]; }),
    beginTask: (conversationId, continues) => {
      const current = get().currentTaskByConversation[conversationId];
      if (continues && current) return { taskId: current };
      const taskId = generateId();
      set((s) => {
        s.currentTaskByConversation[conversationId] = taskId;
        for (const [id, rule] of Object.entries(s.taskRules)) {
          if (rule.item.conversationId === conversationId) delete s.taskRules[id];
        }
      });
      return current ? { taskId, retiredTaskId: current } : { taskId };
    },
    approveForTask: (id) => {
      const item = get().pending[id];
      if (!item || !isRetryableTeamIdentity(item.identity)) return false;
      const category = teamTaskRuleCategory(item);
      if (!category) return false;
      const taskId = get().currentTaskByConversation[item.conversationId]
        ?? get().beginTask(item.conversationId, false).taskId;
      set((s) => {
        s.taskRules[id] = { item, taskId, category, createdAt: Date.now() };
        // Anything else pending that this rule now covers would be allowed on
        // its retry anyway; leaving it on the strip would ask twice.
        for (const [otherId, other] of Object.entries(s.pending)) {
          if (other.conversationId === item.conversationId && (other.member ?? null) === (item.member ?? null)
            && isRetryableTeamIdentity(other.identity) && teamTaskRuleCategory(other) === category) delete s.pending[otherId];
        }
      });
      return true;
    },
    approveAllForTask: (conversationId) => {
      let approved = 0;
      for (const item of pendingFor(get().pending, conversationId)) {
        if (get().pending[item.id] && get().approveForTask(item.id)) approved += 1;
      }
      return approved;
    },
    selectRetry: (id) => {
      const item = get().pending[id];
      if (!item || !isRetryableTeamIdentity(item.identity)) return undefined;
      set((s) => { s.retrySelections[id] = { item, mode: 'once' }; delete s.pending[id]; });
      return id;
    },
    beginRetry: (conversationId, loopId, selectionId) => {
      if (!selectionId) return;
      const selected = get().retrySelections[selectionId];
      if (!selected || selected.item.conversationId !== conversationId) return;
      set((s) => {
        // Every selection is allow-once, including one persisted by an older
        // build under a wider mode: it binds to this retry and nothing else.
        s.approvedOnce[selectionId] = { item: selected.item, mode: 'once', loopId,
          ...(selected.item.identity?.dispatchId === 'leader' ? { dispatchId: 'leader' } : {}) };
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
      const taskId = get().currentTaskByConversation[item.conversationId];
      const category = teamTaskRuleCategory(item);
      if (taskId && category && Object.values(get().taskRules).some((rule) => rule.taskId === taskId
        && rule.item.conversationId === item.conversationId
        && (rule.item.member ?? null) === (item.member ?? null)
        && rule.category === category)) return true;
      const entry = Object.entries(get().approvedOnce).find(([, approval]) => approval.loopId === item.identity!.loopId
        && confirmationKey(approval.item) === confirmationKey(item)
        && approval.dispatchId === item.identity!.dispatchId
        && approval.item.identity?.requestOrdinal === item.identity!.requestOrdinal);
      if (!entry) return false;
      set((s) => { delete s.approvedOnce[entry[0]]; });
      return true;
    },
    revoke: (id) => set((s) => {
      delete s.pending[id]; delete s.retrySelections[id]; delete s.approvedOnce[id]; delete s.taskRules[id];
    }),
    clearRun: (conversationId, loopId) => set((s) => {
      clearTeamConfirmationIdentities(conversationId, loopId);
      for (const [id, approval] of Object.entries(s.approvedOnce)) {
        if (approval.item.conversationId === conversationId && approval.loopId === loopId) delete s.approvedOnce[id];
      }
      // Task rules outlive the run: the task goes on in the next run the strip
      // starts. Refused requests stay visible for a later explicit retry.
    }),
    clearConversation: (conversationId) => set((s) => {
      clearTeamConfirmationIdentities(conversationId);
      delete s.currentTaskByConversation[conversationId];
      for (const [id, item] of Object.entries(s.pending)) if (item.conversationId === conversationId) delete s.pending[id];
      for (const grants of [s.approvedOnce, s.taskRules, s.retrySelections]) {
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
      approvedOnce: {}, taskRules: {}, currentTaskByConversation: {}, retrySelections: {},
    }),
  }),
);

/** The team task a conversation is in, if it is a team conversation that has started one. */
export function taskIdFor(conversationId: string): string | undefined {
  return useTeamConfirmationStore.getState().currentTaskByConversation[conversationId];
}
