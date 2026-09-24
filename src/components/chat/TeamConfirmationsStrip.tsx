import { grantBrowserPermissionTargets } from '@/core/permissions/browserPermissionConfig';
import { isRetryableTeamIdentity } from '@/core/agent/teamConfirmationIdentity';
import { teamTaskRuleCategory } from '@/core/agent/teamApprovalScope';
import { forgiveMember, resetDispatchCount } from '@/core/team/teamRunBounds';
import { useMemo, useState } from 'react';
import { ShieldAlert, Check, X } from 'lucide-react';
import { useI18n, format } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { mayOfferPersistentGrant } from '@/core/permissions/alwaysAskPolicy';
import {
  pendingFor,
  useTeamConfirmationStore,
  type StoppedDispatch,
  type TeamConfirmation,
} from '@/stores/teamConfirmationStore';
import { enqueueUserInput } from '@/core/agent/userInputQueue';
import { runAgentLoopDispatched } from '@/core/agent/agentLoopRunner';
import { describeTaskRuleScope } from './teamTaskRuleScope';

const PRIMARY_BUTTON = 'inline-flex shrink-0 items-center gap-1 rounded-md bg-[var(--abu-clay)] px-2 py-0.5 text-caption text-white hover:opacity-90';
const SECONDARY_BUTTON = 'inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 text-caption';

/**
 * "需要你确认" strip for a team conversation: every action the run refused
 * because nobody could confirm it, and every hand-off the task's bounds
 * stopped. A request can be allowed once, allowed for the rest of the team
 * task (same member, same kind of request — see teamApprovalScope.ts), or,
 * for a site, allowed from now on; "this task" allowances are listed at the
 * bottom and can be revoked.
 */
export default function TeamConfirmationsStrip({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  const [saving, setSaving] = useState<string | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const pending = useTeamConfirmationStore((s) => s.pending);
  const items = useMemo(() => pendingFor(pending, conversationId), [pending, conversationId]);
  const taskRules = useTeamConfirmationStore((s) => s.taskRules);
  const stopped = useTeamConfirmationStore((s) => s.stopped);
  /**
   * Read REACTIVELY, not through `getState()`: a row in `pending` is persisted
   * and can outlive the verdict it was captured under, so the button has to
   * follow the CURRENT one. Subscribing here also means revoking the site in
   * Settings (or blocking it from a dialog in another conversation) retracts
   * the button live, without this strip remounting.
   */
  const permissions = useSettingsStore((s) => s.browserPermissionConfigV2);
  const rules = Object.entries(taskRules).filter(([, rule]) => rule.item.conversationId === conversationId);
  const stoppedItems = Object.values(stopped)
    .filter((entry) => entry.conversationId === conversationId)
    .sort((a, b) => a.createdAt - b.createdAt);
  if (items.length === 0 && rules.length === 0 && stoppedItems.length === 0) return null;

  const followUp = (text: string, teamConfirmationRetryId?: string) => {
    const running = useChatStore.getState().conversations[conversationId]?.status === 'running';
    if (running) {
      enqueueUserInput(conversationId, text, false, teamConfirmationRetryId, true);
      return;
    }
    void runAgentLoopDispatched(conversationId, text, { initiatedBy: 'user', teamConfirmationRetryId, continuesTeamTask: true }).catch(() => {
      // Runtime grants are cleared by dispatch's finally; an unrelated later
      // message cannot pick up this failed retry's approval.
    });
  };
  const memberLabel = (item: TeamConfirmation) => item.member ?? t.team.confirmationLeader;
  const categoryOf = (item: TeamConfirmation) =>
    isRetryableTeamIdentity(item.identity) ? teamTaskRuleCategory(item) : null;
  const approvableForTask = items.filter((item) => categoryOf(item) !== null);

  const approveOnce = (item: TeamConfirmation) => {
    const selection = useTeamConfirmationStore.getState().selectRetry(item.id);
    if (!selection) return;
    followUp(format(t.team.confirmationApprovedFollowUp, { member: memberLabel(item), detail: item.detail }), selection);
  };
  const approveTask = (item: TeamConfirmation) => {
    if (!useTeamConfirmationStore.getState().approveForTask(item.id)) return;
    followUp(t.team.confirmationApprovedTaskFollowUp);
  };
  const approveAll = () => {
    if (useTeamConfirmationStore.getState().approveAllForTask(conversationId) > 0) {
      followUp(t.team.confirmationApprovedTaskFollowUp);
    }
  };
  /**
   * The per-site grant is offered strictly where the desktop dialog would
   * offer it: the requester has to have allowed a standing grant,
   * `mayOfferPersistentGrant` may only lower that — never raise it, and the
   * user must not have BLOCKED the origin. No new authorization semantics
   * live here.
   *
   * The block check is what keeps this surface from being the one place a
   * verdict can be undone without showing it: a denied site never reaches a
   * dialog at all, and the Settings row names what it is changing, while this
   * row's payload is frozen at the moment the call was refused.
   */
  const canOfferSite = (item: TeamConfirmation) =>
    (item.kind === 'browser' || item.kind === 'browser-upload') && !!item.browserOrigin
    && mayOfferPersistentGrant({ level: item.level ?? 'warn', kind: item.kind, allowPersistentGrant: item.allowPersistentGrant })
    && !!item.browserPermissionResource && !!item.browserPermissionTargets?.length
    && grantBrowserPermissionTargets(permissions, item.browserPermissionResource, item.browserPermissionTargets) !== null;
  const siteGrantLabel = (item: TeamConfirmation) => item.browserPermissionResource === 'upload'
    ? t.settings.browserResourceGrantUpload
    : item.browserPermissionResource === 'script'
      ? t.settings.browserResourceGrantScript
      : t.settings.browserResourceGrantBrowse;
  const allowSite = async (item: TeamConfirmation) => {
    if (saving || !canOfferSite(item)) return;
    const current = () => useTeamConfirmationStore.getState().pending[item.id] === item;
    setSaving(item.id); setSaveFailed(false);
    const saved = await useSettingsStore.getState().grantBrowserPermissionTargets(item.browserPermissionResource!, item.browserPermissionTargets!, current);
    setSaving(null);
    if (saved && current()) approveOnce(item);
    else if (current()) setSaveFailed(true);
  };
  const reject = (item: TeamConfirmation) => {
    useTeamConfirmationStore.getState().remove(item.id);
    followUp(format(t.team.confirmationRejectedFollowUp, { member: memberLabel(item), detail: item.detail }));
  };
  const tryAnotherWay = (entry: StoppedDispatch) => {
    if (entry.reason === 'member_blocked' && entry.member) forgiveMember(entry.taskId, entry.member);
    else resetDispatchCount(entry.taskId);
    useTeamConfirmationStore.getState().removeStopped(entry.id);
    followUp(t.team.stoppedTryAnotherWayFollowUp);
  };
  const skip = (entry: StoppedDispatch) => {
    useTeamConfirmationStore.getState().removeStopped(entry.id);
    followUp(t.team.stoppedSkipFollowUp);
  };

  return (
    <div className="mx-3 mb-1.5 rounded-lg border border-[var(--abu-warning)] bg-[var(--abu-bg-muted)] px-3 py-2" data-testid="team-confirmations-strip">
      {items.length + stoppedItems.length > 0 && (
        <div className="mb-1 flex items-center gap-1.5 text-caption font-medium text-[var(--abu-text-primary)]">
          <ShieldAlert aria-hidden="true" className="h-3.5 w-3.5 text-[var(--abu-warning)]" />
          <span className="flex-1">{format(t.team.confirmationStripTitle, { n: items.length + stoppedItems.length })}</span>
          {items.length >= 2 && approvableForTask.length > 0 && (
            <button type="button" disabled={saving !== null} onClick={approveAll} className={SECONDARY_BUTTON}>
              {t.team.confirmationApproveAll}
            </button>
          )}
        </div>
      )}
      {saveFailed && <p role="alert">{t.settings.browserSaveFailed}</p>}
      <ul className="max-h-60 space-y-2 overflow-y-auto pr-1">
        {items.map((item) => {
          const retryable = isRetryableTeamIdentity(item.identity);
          const category = categoryOf(item);
          const offerSite = retryable && canOfferSite(item);
          return (
            <li key={item.id} className="flex flex-wrap items-center gap-2" data-testid="team-confirmation-item">
              <div className="min-w-0 w-full text-caption text-[var(--abu-text-secondary)]">
                <span className="text-[var(--abu-text-primary)]">{memberLabel(item)}</span>
                <span>{t.team.confirmationSeparator}</span>
                <code className="line-clamp-2 break-all align-top" title={item.detail}>{item.detail}</code>
                {item.kind === 'file' && <div>{item.capability === 'write'
                  ? (item.additionalCapabilities?.includes('read') ? t.team.confirmationWriteRead : t.team.confirmationWrite)
                  : t.team.confirmationRead}</div>}
                {item.identity && (item.kind === 'command' || item.kind === 'file') && <div>{t.team.confirmationCwd}: <code>{item.identity.cwd ?? t.team.confirmationDefaultCwd}</code></div>}
                {item.browserOrigin && <div>{t.team.confirmationOrigin}: <code>{item.browserOrigin}</code></div>}
                {item.browserPermissionTargets?.filter((target) => target.embeddedIn).map((target, index) =>
                  <div key={index}><code>{target.origin} ({target.embeddedIn})</code></div>)}
                {!retryable && <div>{t.team.confirmationExpired}</div>}
                {item.reason && <span className="ml-1 text-[var(--abu-text-muted)]" title={item.reason}>（{item.reason.slice(0, 40)}{item.reason.length > 40 ? '…' : ''}）</span>}
              </div>
              {retryable && (
                <button
                  type="button"
                  onClick={() => approveOnce(item)}
                  disabled={saving !== null}
                  className={category ? SECONDARY_BUTTON : PRIMARY_BUTTON}
                  aria-label={`${t.team.confirmationApprove}: ${item.detail}`}
                >
                  {!category && <Check aria-hidden="true" className="h-3 w-3" />}
                  {t.team.confirmationApprove}
                </button>
              )}
              {category && (
                <button
                  type="button"
                  onClick={() => approveTask(item)}
                  disabled={saving !== null}
                  data-primary="true"
                  className={PRIMARY_BUTTON}
                  aria-label={`${t.team.confirmationApproveTask}: ${item.detail}`}
                >
                  <Check aria-hidden="true" className="h-3 w-3" />
                  {t.team.confirmationApproveTask}
                </button>
              )}
              {offerSite && (
                <button type="button" disabled={saving !== null}
                  onClick={() => void allowSite(item)}
                  data-testid="team-confirmation-allow-site"
                  className={SECONDARY_BUTTON}
                  aria-label={siteGrantLabel(item)}>
                  {siteGrantLabel(item)}
                </button>
              )}
              <button
                type="button"
                onClick={() => reject(item)}
                className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-caption text-[var(--abu-text-muted)] hover:bg-[var(--abu-danger-bg)] hover:text-[var(--abu-danger)]"
                aria-label={`${t.team.confirmationReject}: ${item.detail}`}
              >
                <X aria-hidden="true" className="h-3 w-3" />
                {t.team.confirmationReject}
              </button>
              {(category || (offerSite && item.browserPermissionResource === 'script')) && (
                <div className="w-full text-caption text-[var(--abu-text-muted)]">
                  {category && <div>{describeTaskRuleScope(category, memberLabel(item), t.team)}</div>}
                  {offerSite && item.browserPermissionResource === 'script' && <div>{t.team.confirmationScriptRisk}</div>}
                </div>
              )}
            </li>
          );
        })}
        {stoppedItems.map((entry) => (
          <li key={entry.id} className="flex flex-wrap items-center gap-2" data-testid="team-stopped-item">
            <div className="min-w-0 w-full text-caption text-[var(--abu-text-secondary)]">
              {entry.reason === 'member_blocked'
                ? format(t.team.stoppedMemberBlocked, { member: entry.member ?? t.team.confirmationLeader, n: entry.count })
                : format(t.team.stoppedRunCap, { n: entry.count })}
              {entry.lastFailure && <div className="text-[var(--abu-text-muted)]">{format(t.team.stoppedLastFailure, { reason: entry.lastFailure })}</div>}
            </div>
            <button type="button" className={PRIMARY_BUTTON} onClick={() => tryAnotherWay(entry)}>
              {t.team.stoppedTryAnotherWay}
            </button>
            <button type="button" className={SECONDARY_BUTTON} onClick={() => skip(entry)}>
              {t.team.stoppedSkip}
            </button>
          </li>
        ))}
      </ul>
      {rules.length > 0 && (
        <div className="mt-2 border-t border-[var(--abu-border)] pt-1.5 text-caption text-[var(--abu-text-secondary)]">
          <div className="mb-0.5 text-[var(--abu-text-primary)]">{t.team.confirmationTaskRules}</div>
          {rules.map(([id, rule]) => {
            const scope = describeTaskRuleScope(rule.category, memberLabel(rule.item), t.team);
            return (
              <div key={id} className="flex items-center gap-2">
                <span className="min-w-0 flex-1">{scope}</span>
                <button type="button" className="shrink-0 underline"
                  aria-label={`${t.team.confirmationRevoke}: ${scope}`}
                  onClick={() => useTeamConfirmationStore.getState().revoke(id)}>
                  {t.team.confirmationRevoke}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
