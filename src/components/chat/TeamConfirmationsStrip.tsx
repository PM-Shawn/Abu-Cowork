import { grantBrowserPermissionTargets } from '@/core/permissions/browserPermissionConfig';
import { isRetryableTeamIdentity } from '@/core/agent/teamConfirmationIdentity';
import { useMemo, useState } from 'react';
import { ShieldAlert, Check, X } from 'lucide-react';
import { useI18n, format } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { mayOfferPersistentGrant } from '@/core/permissions/alwaysAskPolicy';
import { pendingFor, useTeamConfirmationStore, type TeamConfirmation, type TeamApprovalMode } from '@/stores/teamConfirmationStore';
import { enqueueUserInput } from '@/core/agent/userInputQueue';
import { runAgentLoopDispatched } from '@/core/agent/agentLoopRunner';

/**
 * "需要你确认" strip for a team conversation (block O): every action the run
 * refused because nobody could confirm it, with approve / reject. Approving
 * authorizes a specific retry turn; reusable exact-parameter rules are visible
 * and revocable, and expire when that run settles.
 */
export default function TeamConfirmationsStrip({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  const [saving, setSaving] = useState<string | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const pending = useTeamConfirmationStore((s) => s.pending);
  const items = useMemo(() => pendingFor(pending, conversationId), [pending, conversationId]);
  const taskRules = useTeamConfirmationStore((s) => s.taskRules);
  /**
   * Read REACTIVELY, not through `getState()`: a row in `pending` is persisted
   * and can outlive the verdict it was captured under, so the button has to
   * follow the CURRENT one. Subscribing here also means revoking the site in
   * Settings › 网站授权 (or blocking it from a dialog in another conversation)
   * retracts the button live, without this strip remounting.
   */
  const permissions = useSettingsStore((s) => s.browserPermissionConfigV2);
  const rules = Object.entries(taskRules).filter(([, rule]) => rule.item.conversationId === conversationId);
  if (items.length === 0 && rules.length === 0) return null;

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

  const approve = (item: TeamConfirmation, mode: TeamApprovalMode | 'task') => {
    if (mode === 'task') {
      if (!useTeamConfirmationStore.getState().approveForTask(item.id)) return;
      followUp(format(t.team.confirmationApprovedFollowUp, { member: memberLabel(item), detail: item.detail }));
      return;
    }
    const selection = useTeamConfirmationStore.getState().selectRetry(item.id);
    if (!selection) return;
    followUp(format(t.team.confirmationApprovedFollowUp, { member: memberLabel(item), detail: item.detail }), selection);
  };
  /**
   * The strip's only SCOPE control. "Allow this retry" and the run rule are
   * both keyed on the exact parameters, so a form fill — different values on
   * every call — is asked field by field. A site grant is what the browser
   * gate actually consults (`registry.ts`'s `granted` disjunct), in a team
   * conversation like any other.
   *
   * It is offered strictly where the desktop dialog would offer it: the
   * requester has to have allowed a standing grant,
   * `mayOfferPersistentGrant` may only lower that — never raise it, and the
   * user must not have BLOCKED the origin. No new authorization semantics
   * live here.
   *
   * The block check is what keeps this surface from being the one place a
   * verdict can be undone without showing it: a denied site never reaches a
   * dialog at all, and the Settings row names what it is changing, while this
   * row's payload is frozen at the moment the call was refused. `'denied'` is
   * read directly rather than through `getSiteVerdict` on purpose — a block is
   * absolute in every direction, so none of that function's scoped-grant
   * qualification applies to it.
   */
  const canOfferSite = (item: TeamConfirmation) =>
    (item.kind === 'browser' || item.kind === 'browser-upload') && !!item.browserOrigin
    && mayOfferPersistentGrant({ level: item.level ?? 'warn', kind: item.kind, allowPersistentGrant: item.allowPersistentGrant })
    && !!item.browserPermissionResource && !!item.browserPermissionTargets?.length
    && grantBrowserPermissionTargets(permissions, item.browserPermissionResource, item.browserPermissionTargets) !== null;
  const allowSite = async (item: TeamConfirmation) => {
    if (saving || !canOfferSite(item)) return;
    const current = () => useTeamConfirmationStore.getState().pending[item.id] === item;
    setSaving(item.id); setSaveFailed(false);
    const saved = await useSettingsStore.getState().grantBrowserPermissionTargets(item.browserPermissionResource!, item.browserPermissionTargets!, current);
    setSaving(null);
    if (saved && current()) approve(item, 'once');
    else if (current()) setSaveFailed(true);
  };
  const reject = (item: TeamConfirmation) => {
    useTeamConfirmationStore.getState().remove(item.id);
    followUp(format(t.team.confirmationRejectedFollowUp, { member: memberLabel(item), detail: item.detail }));
  };

  return (
    <div className="mx-3 mb-1.5 rounded-lg border border-[var(--abu-warning)] bg-[var(--abu-bg-muted)] px-3 py-2" data-testid="team-confirmations-strip">
      <div className="mb-1 flex items-center gap-1.5 text-caption font-medium text-[var(--abu-text-primary)]">
        <ShieldAlert aria-hidden="true" className="h-3.5 w-3.5 text-[var(--abu-warning)]" />
        {format(t.team.confirmationStripTitle, { n: items.length })}
      </div>
      {saveFailed && <p role="alert">{t.settings.browserSaveFailed}</p>}
      <ul className="max-h-40 space-y-1 overflow-y-auto pr-1">
        {items.map((item) => (
          <li key={item.id} className="flex flex-wrap items-center gap-2" data-testid="team-confirmation-item">
            <div className="min-w-0 w-full text-caption text-[var(--abu-text-secondary)]">
              <span className="text-[var(--abu-text-primary)]">{memberLabel(item)}</span>
              <span>{t.team.confirmationSeparator}</span>
              <code className="line-clamp-2 break-all align-top" title={item.detail}>{item.detail}</code>
              {item.kind === 'file' && <div>{item.capability === 'write'
                ? (item.additionalCapabilities?.includes('read') ? t.team.confirmationWriteRead : t.team.confirmationWrite)
                : t.team.confirmationRead}</div>}
              {item.identity && <div>{t.team.confirmationCwd}: <code>{item.identity.cwd ?? t.team.confirmationDefaultCwd}</code></div>}
              {item.browserPermissionTargets?.map((target, index) => <div key={index}><code>{target.origin}{target.embeddedIn ? ` (${target.embeddedIn})` : ''}</code></div>)}
              {item.browserOrigin && <div>{t.team.confirmationOrigin}: <code>{item.browserOrigin}</code></div>}
              {isRetryableTeamIdentity(item.identity) && <div>{format(t.team.confirmationRequestOrdinal, { n: item.identity!.requestOrdinal })}</div>}
              {!isRetryableTeamIdentity(item.identity) && <div>{t.team.confirmationLegacy}</div>}
              {item.reason && <span className="ml-1 text-[var(--abu-text-muted)]" title={item.reason}>（{item.reason.slice(0, 40)}{item.reason.length > 40 ? '…' : ''}）</span>}
            </div>
            <button
              type="button"
              onClick={() => approve(item, 'once')}
              disabled={saving !== null || !isRetryableTeamIdentity(item.identity)}
              className="inline-flex shrink-0 items-center gap-1 rounded-md bg-[var(--abu-clay)] px-2 py-0.5 text-caption text-white hover:opacity-90"
              aria-label={`${t.team.confirmationApprove}: ${item.detail}`}
            >
              <Check aria-hidden="true" className="h-3 w-3" />
              {t.team.confirmationApprove}
            </button>
            {item.kind !== 'browser' && item.kind !== 'browser-upload' && <button type="button" disabled={saving !== null || !isRetryableTeamIdentity(item.identity)}
              onClick={() => approve(item, 'task')}
              title={t.team.confirmationRunRule}
              className="shrink-0 rounded-md border px-2 py-0.5 text-caption"
              aria-label={`${t.team.confirmationApproveRun}: ${item.detail}`}>
              {t.team.confirmationApproveRun}
            </button>}
            {canOfferSite(item) && (
              <button type="button" disabled={saving !== null || !isRetryableTeamIdentity(item.identity)}
                onClick={() => void allowSite(item)}
                data-testid="team-confirmation-allow-site"
                className="shrink-0 rounded-md border px-2 py-0.5 text-caption"
                aria-label={item.browserPermissionResource === 'upload' ? t.settings.browserResourceGrantUpload : t.settings.browserResourceGrantBrowse}>
                {item.browserPermissionResource === 'upload' ? t.settings.browserResourceGrantUpload : t.settings.browserResourceGrantBrowse}
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
          </li>
        ))}
      </ul>
      {rules.map(([id, rule]) => <div key={id} className="mt-1 text-caption">
        {t.team.confirmationRunRule}: {memberLabel(rule.item)} · {rule.item.detail} · {t.team.confirmationCwd}: {rule.item.identity?.cwd ?? t.team.confirmationDefaultCwd}
        <button type="button" className="ml-2 underline" onClick={() => useTeamConfirmationStore.getState().revoke(id)}>{t.team.confirmationRevoke}</button>
      </div>)}
    </div>
  );
}
