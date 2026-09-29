import { grantBrowserPermissionTargets } from '@/core/permissions/browserPermissionConfig';
import { isRetryableTeamIdentity } from '@/core/agent/teamConfirmationIdentity';
import { memo, useMemo, useState } from 'react';
import { Button } from '@/components/ds/button';
import { AppIcons } from '@/components/ds/icons';
import { InlineMessage } from '@/components/ds/inline-message';
import { StatusIcon } from '@/components/ds/status-icon';
import { Tooltip } from '@/components/ds/tooltip';
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
function TeamConfirmationsStrip({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  const [saving, setSaving] = useState<string | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const pending = useTeamConfirmationStore((s) => s.pending);
  const items = useMemo(() => pendingFor(pending, conversationId), [pending, conversationId]);
  const runRules = useTeamConfirmationStore((s) => s.runRules);
  /**
   * Read REACTIVELY, not through `getState()`: a row in `pending` is persisted
   * and can outlive the verdict it was captured under, so the button has to
   * follow the CURRENT one. Subscribing here also means revoking the site in
   * Settings › 网站授权 (or blocking it from a dialog in another conversation)
   * retracts the button live, without this strip remounting.
   */
  const permissions = useSettingsStore((s) => s.browserPermissionConfigV2);
  const rules = Object.entries(runRules).filter(([, rule]) => rule.item.conversationId === conversationId);
  if (items.length === 0 && rules.length === 0) return null;

  const followUp = (text: string, teamConfirmationRetryId?: string) => {
    const running = useChatStore.getState().conversations[conversationId]?.status === 'running';
    if (running) {
      enqueueUserInput(conversationId, text, false, teamConfirmationRetryId);
      return;
    }
    void runAgentLoopDispatched(conversationId, text, { initiatedBy: 'user', teamConfirmationRetryId }).catch(() => {
      // Runtime grants are cleared by dispatch's finally; an unrelated later
      // message cannot pick up this failed retry's approval.
    });
  };
  const memberLabel = (item: TeamConfirmation) => item.member ?? t.team.confirmationLeader;

  const approve = (item: TeamConfirmation, mode: TeamApprovalMode) => {
    const selection = useTeamConfirmationStore.getState().selectRetry(item.id, mode);
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
    <div className="mx-3 mb-2 rounded-panel border border-separator bg-surface px-3 py-2" data-testid="team-confirmations-strip">
      <div className="mb-1 flex items-center gap-2 text-ui font-medium text-label">
        <StatusIcon tone="warning" size="sm" />
        {format(t.team.confirmationStripTitle, { n: items.length })}
      </div>
      {saveFailed && <div className="mb-1"><InlineMessage tone="danger">{t.settings.browserSaveFailed}</InlineMessage></div>}
      <ul className="max-h-40 space-y-2 overflow-y-auto pr-1">
        {items.map((item) => (
          <li key={item.id} className="flex flex-wrap items-center gap-2" data-testid="team-confirmation-item">
            <div className="w-full min-w-0 text-ui-sm text-label-secondary">
              <span className="text-label">{memberLabel(item)}</span>
              <span>{t.team.confirmationSeparator}</span>
              <code className="line-clamp-2 break-all align-top font-code text-caption" title={item.detail}>{item.detail}</code>
              {item.kind === 'file' && <div>{item.capability === 'write'
                ? (item.additionalCapabilities?.includes('read') ? t.team.confirmationWriteRead : t.team.confirmationWrite)
                : t.team.confirmationRead}</div>}
              {item.identity && <div>{t.team.confirmationCwd}: <code className="font-code text-caption">{item.identity.cwd ?? t.team.confirmationDefaultCwd}</code></div>}
              {item.browserPermissionTargets?.map((target, index) => <div key={index}><code className="font-code text-caption">{target.origin}{target.embeddedIn ? ` (${target.embeddedIn})` : ''}</code></div>)}
              {item.browserOrigin && <div>{t.team.confirmationOrigin}: <code className="font-code text-caption">{item.browserOrigin}</code></div>}
              {isRetryableTeamIdentity(item.identity) && <div>{format(t.team.confirmationRequestOrdinal, { n: item.identity!.requestOrdinal })}</div>}
              {!isRetryableTeamIdentity(item.identity) && <div>{t.team.confirmationLegacy}</div>}
              {item.reason && <span className="ml-1 text-label-tertiary" title={item.reason}>（{item.reason.slice(0, 40)}{item.reason.length > 40 ? '…' : ''}）</span>}
            </div>
            <Button
              variant="primary"
              size="sm"
              icon={AppIcons.done}
              onClick={() => approve(item, 'once')}
              disabled={saving !== null || !isRetryableTeamIdentity(item.identity)}
              aria-label={`${t.team.confirmationApprove}: ${item.detail}`}
            >
              {t.team.confirmationApprove}
            </Button>
            {item.kind !== 'browser' && item.kind !== 'browser-upload' && (
              <Tooltip content={t.team.confirmationRunRule}>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={saving !== null || !isRetryableTeamIdentity(item.identity)}
                  onClick={() => approve(item, 'run')}
                  aria-label={`${t.team.confirmationApproveRun}: ${item.detail}`}
                >
                  {t.team.confirmationApproveRun}
                </Button>
              </Tooltip>
            )}
            {canOfferSite(item) && (
              <Button
                variant="secondary"
                size="sm"
                disabled={saving !== null || !isRetryableTeamIdentity(item.identity)}
                onClick={() => void allowSite(item)}
                data-testid="team-confirmation-allow-site"
                aria-label={item.browserPermissionResource === 'upload' ? t.settings.browserResourceGrantUpload : t.settings.browserResourceGrantBrowse}
              >
                {item.browserPermissionResource === 'upload' ? t.settings.browserResourceGrantUpload : t.settings.browserResourceGrantBrowse}
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              icon={AppIcons.close}
              onClick={() => reject(item)}
              aria-label={`${t.team.confirmationReject}: ${item.detail}`}
            >
              {t.team.confirmationReject}
            </Button>
          </li>
        ))}
      </ul>
      {rules.map(([id, rule]) => <div key={id} className="mt-1 flex flex-wrap items-center gap-2 text-ui-sm text-label-secondary">
        <span className="min-w-0">{t.team.confirmationRunRule}: {memberLabel(rule.item)} · {rule.item.detail} · {t.team.confirmationCwd}: {rule.item.identity?.cwd ?? t.team.confirmationDefaultCwd}</span>
        <Button variant="plain" size="sm" onClick={() => useTeamConfirmationStore.getState().revoke(id)}>{t.team.confirmationRevoke}</Button>
      </div>)}
    </div>
  );
}

// ChatView re-renders on every streamed token; the strip's own inputs do not change then.
export default memo(TeamConfirmationsStrip);
