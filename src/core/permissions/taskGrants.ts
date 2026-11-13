/**
 * Approvals that cover the rest of one task.
 *
 * Some asks are about a kind of action the user decides for the task in front
 * of them, not for each step: acting on a government site (the first click or
 * fill of a task asks; the rest of that task does not), or a connector tool that
 * sends messages (approved once, it sends the rest of the task's messages). A
 * grant here is keyed by the conversation, so it never reaches another task,
 * and lasts `TASK_GRANT_TTL_MS`, the same half hour the browser, plugin and
 * Computer Use task grants last. Kept in memory: a restart ends every task.
 *
 * Team runs never mint one (the caller checks): a team member's approval is
 * scoped to that one retried step by `teamConfirmations.ts`.
 */

export const TASK_GRANT_TTL_MS = 30 * 60 * 1000;

/** What a task grant covers. Each kind is keyed by something of its own. */
export type TaskGrantKind = 'government-site' | 'connector-tool';

const grants = new Map<string, number>();

function grantKey(kind: TaskGrantKind, conversationId: string, subject: string): string {
  // JSON, not a joined string: no conversation id or subject can spell another pair.
  return JSON.stringify([kind, conversationId, subject]);
}

/** Whether this task already approved `subject` (a site origin, a tool name). */
export function hasTaskGrant(
  kind: TaskGrantKind,
  conversationId: string | undefined,
  subject: string,
  now: number = Date.now(),
): boolean {
  if (conversationId === undefined || subject === '') return false;
  const key = grantKey(kind, conversationId, subject);
  const grantedAt = grants.get(key);
  if (grantedAt === undefined) return false;
  if (now - grantedAt >= TASK_GRANT_TTL_MS) {
    grants.delete(key);
    return false;
  }
  return true;
}

export function grantTask(
  kind: TaskGrantKind,
  conversationId: string | undefined,
  subject: string,
  now: number = Date.now(),
): void {
  if (conversationId === undefined || subject === '') return;
  grants.set(grantKey(kind, conversationId, subject), now);
}

export function __resetTaskGrantsForTests(): void {
  grants.clear();
}
