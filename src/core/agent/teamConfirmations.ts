import { confirmationKey, useTeamConfirmationStore, type TeamConfirmationInput } from '@/stores/teamConfirmationStore';
import { notifyTeamConfirmationPending } from '@/utils/notifications';
import { getI18n, format } from '@/i18n';
import { isRetryableTeamIdentity } from './teamConfirmationIdentity';
import { getConversationReader } from './ports/conversationReader';

export type TeamConfirmationDecision = 'ask' | 'approved' | 'pending';

/** Record a request without granting authority. Non-team callers use their normal dialog. */
export function decideTeamConfirmation(
  conversationId: string,
  item: Omit<TeamConfirmationInput, 'conversationId'>,
): TeamConfirmationDecision {
  if (!conversationId) return 'ask';
  // Synchronous on purpose: the dialog path must keep enqueueing before the
  // caller's promise settles (existing callers read the pending entry right
  // after calling). The reader port avoids a store import cycle.
  if (!getConversationReader().getConversation(conversationId)?.teamId) return 'ask';

  const store = useTeamConfirmationStore.getState();
  if (store.consumeApproval({ ...item, conversationId })) return 'approved';
  const added = store.add({ ...item, conversationId });
  if (added) {
    const t = getI18n().team;
    notifyTeamConfirmationPending(
      format(t.confirmationNotice, { member: added.member ?? t.confirmationLeader, detail: added.detail }),
      conversationId,
    );
  }
  return 'pending';
}

/** A deferred request is not a human rejection. Background/legacy callers cannot wait. */
export class TeamConfirmationPendingError extends Error {
  constructor() { super('Team confirmation pending'); this.name = 'TeamConfirmationPendingError'; }
}

const waiters = new Map<string, (allowed: boolean) => void>();

/** Only the exact, still-live call can receive this answer. No reusable grant is minted. */
export function respondToTeamConfirmation(id: string, allowed: boolean): boolean {
  const answer = waiters.get(id);
  if (!answer) return false;
  answer(allowed);
  return true;
}

export function waitForTeamConfirmation(
  conversationId: string,
  item: Omit<TeamConfirmationInput, 'conversationId'>,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!signal || !isRetryableTeamIdentity(item.identity)) return Promise.reject(new TeamConfirmationPendingError());
  if (signal.aborted) return Promise.reject(new DOMException('Approval cancelled', 'AbortError'));
  const pending = Object.values(useTeamConfirmationStore.getState().pending).find((entry) =>
    confirmationKey(entry) === confirmationKey({ ...item, conversationId })
    && entry.identity?.loopId === item.identity?.loopId && entry.identity?.dispatchId === item.identity?.dispatchId
    && entry.identity?.callId === item.identity?.callId && entry.identity?.parametersDigest === item.identity?.parametersDigest);
  if (!pending || waiters.has(pending.id)) return Promise.reject(new TeamConfirmationPendingError());
  const id = pending.id;
  return new Promise<boolean>((resolve, reject) => {
    let unsubscribe = () => {};
    const cleanup = () => {
      waiters.delete(id);
      signal.removeEventListener('abort', abort);
      unsubscribe();
    };
    const abort = () => {
      cleanup();
      useTeamConfirmationStore.getState().setWaiting(id, false);
      reject(new DOMException('Approval cancelled', 'AbortError'));
    };
    waiters.set(id, (allowed) => {
      if (signal.aborted) { abort(); return; }
      cleanup();
      useTeamConfirmationStore.getState().finishWaiting(id, Date.now());
      resolve(allowed);
    });
    useTeamConfirmationStore.getState().setWaiting(id, true);
    unsubscribe = useTeamConfirmationStore.subscribe((state) => {
      if (!state.pending[id] || !state.waiting[id]) abort();
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
