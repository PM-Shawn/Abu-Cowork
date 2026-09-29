import { useSyncExternalStore } from 'react';
import { Button } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { subscribeCUStatus, getCUStatusSnapshot } from '@/core/agent/computerUseStatus';
import { useChatStore } from '@/stores/chatStore';
import { useI18n, format } from '@/i18n';

/**
 * Single indicator for the one physical screen Computer Use drives.
 *
 * ── Why Stop targets the session OWNER, not the open tab ──
 * This banner is deliberately global: it shows whenever ANY conversation is
 * driving the mouse/screen, because there is only one screen. But Abu's agent
 * loop lets different conversations run concurrently (`runAgentLoop`'s guard
 * only blocks a second loop on the SAME conversation), so the conversation
 * that owns the CU session is not necessarily the one on screen — e.g. a
 * background scheduled task takes control while the user is reading an idle
 * chat. Stop used to be wired in ChatView as
 * `cancelStreaming(activeConv.id)`, i.e. "cancel whatever tab is open", which
 * in that case cancelled the innocent idle conversation and left the runaway
 * session driving the screen.
 *
 * So the owner is resolved from the status snapshot's `activeConversationId`
 * (the field `computerUseStatus.ts` maintains as the session's owner) and
 * passed explicitly to `onStop`. Two consequences, both deliberate:
 *
 *  - There is NO fallback to the viewed conversation when no owner is
 *    resolvable. "No owner" means nothing is actually running, and falling
 *    back is exactly the bug above; the button is simply not rendered, the
 *    same way a stop control with no session behind it is inert.
 *  - When the owner is some OTHER conversation, the banner names it, so
 *    "Stop" is not a blind button that silently acts on an off-screen chat.
 */
export default function ComputerUseStatusBar({ onStop }: { onStop?: (conversationId: string) => void }) {
  const { t } = useI18n();
  const status = useSyncExternalStore(subscribeCUStatus, getCUStatusSnapshot);
  const ownerId = status.activeConversationId;
  const viewingId = useChatStore((s) => s.activeConversationId);
  // `conversationIndex` (not `conversations`) is the source of truth for what
  // exists — the owning conversation may not be among the ~5 loaded ones.
  const ownerTitle = useChatStore((s) => (ownerId ? s.conversationIndex[ownerId]?.title ?? null : null));

  if (status.status !== 'active') return null;

  const isSelf = ownerId !== null && ownerId === viewingId;
  const phaseLabel = {
    checking: t.computerUse.phaseChecking,
    'awaiting-approval': t.computerUse.phaseAwaitingApproval,
    observing: t.computerUse.phaseObserving,
    acting: t.computerUse.phaseActing,
    verifying: t.computerUse.phaseVerifying,
    blocked: t.computerUse.phaseBlocked,
  }[status.phase];
  const modeLabel = status.capabilityMode
    ? {
      full: t.computerUse.modeFull,
      structured: t.computerUse.modeStructured,
      unsupported: t.computerUse.modeUnsupported,
      unknown: t.computerUse.modeUnknown,
    }[status.capabilityMode]
    : null;

  return (
    <div className="mx-4 mt-2 flex items-center justify-between gap-3 rounded-panel border border-separator bg-surface px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <Icon icon={AppIcons.monitor} className="text-label-secondary" />
        <div className="min-w-0">
          <div className="text-ui font-medium text-label">
            <span>{t.computerUse.controlling}</span>
            {status.stepCount > 0 && ` ${format(t.computerUse.step, { step: status.stepCount })}`}
          </div>
          {!isSelf && (
            <div className="truncate text-ui-sm font-medium text-label" data-testid="cu-owner">
              {format(t.computerUse.fromConversation, {
                title: ownerTitle ?? t.computerUse.otherConversation,
              })}
            </div>
          )}
          <div className="truncate text-ui-sm text-label-secondary">
            {[status.targetApp, modeLabel, phaseLabel].filter(Boolean).join(' · ')}
          </div>
        </div>
      </div>
      {onStop && ownerId && (
        <Button variant="secondary" size="sm" icon={AppIcons.stop} onClick={() => onStop(ownerId)}>
          {t.computerUse.stop}
        </Button>
      )}
    </div>
  );
}
