/**
 * SkillProposalCard — inline review UI for agent-proposed skills.
 *
 * Renders below a `skill_manage` tool call whose result carried a
 * `notice_card` payload (see ToolCall.noticeCard). Gives the user three
 * actions in the conversation stream, so they don't have to hunt the
 * Toolbox drafts panel to decide:
 *   - 采纳         → promote draft to workspace-auto (live skill)
 *   - 拒绝         → move to drafts/.trash/ (7-day recovery)
 *   - 这类别再提议 → reject + write a feedback memory so the agent stops
 *                    proposing similar skills (governed by Module F's
 *                    "create 前必读 feedback" guardrail)
 *
 * Once the user clicks, the action is persisted on the tool call via
 * `setToolCallNoticeCardAction`, so re-opening the conversation shows
 * the settled state instead of live buttons.
 */

import { useState } from 'react';
import { Sparkles, Check, X, Ban, Clock, Trash2, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { useI18n } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useSkillDraftsStore } from '@/stores/skillDraftsStore';
import { useToastStore } from '@/stores/toastStore';
import { writeMemory } from '@/core/memdir/write';
import { cn } from '@/lib/utils';
import MarkdownRenderer from './MarkdownRenderer';
import type { InteractiveNoticeCard, NoticeCardAction } from '@/types';

interface Props {
  conversationId: string;
  messageId: string;
  toolCallId: string;
  card: InteractiveNoticeCard;
  /** If set, user already clicked; render settled state instead of buttons. */
  settledAction?: NoticeCardAction;
}

export default function SkillProposalCard({
  conversationId,
  messageId,
  toolCallId,
  card,
  settledAction,
}: Props) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [processing, setProcessing] = useState(false);
  const addToast = useToastStore((s) => s.addToast);
  const setAction = useChatStore((s) => s.setToolCallNoticeCardAction);
  const acceptDraft = useSkillDraftsStore((s) => s.acceptDraft);
  const rejectDraft = useSkillDraftsStore((s) => s.rejectDraft);
  // Task #40: detect zombie cards — draft was accepted elsewhere / expired
  // into trash / manually deleted. We subscribe to drafts list so if the
  // user's card is no longer live, we fall back to a muted "missing" state
  // instead of showing clickable buttons that would then error out.
  // `isLoading` guard prevents false-positive on initial mount before
  // listDrafts has had a chance to populate.
  const draftExists = useSkillDraftsStore((s) =>
    s.drafts.some((d) => d.skillName === card.skillProposal?.skillName),
  );
  const draftsLoading = useSkillDraftsStore((s) => s.isLoading);
  const draftsInitialized = useSkillDraftsStore((s) => s.lastRefreshedAt !== null);
  // Task #50: Gate actionable buttons behind first-time onboarding.
  // Without this, a first-run user sees a skill proposal card before
  // they've ever encountered the Toolbox's proactivity-preset picker —
  // so they either commit blindly or dismiss something they don't
  // understand. Agent-auto proposals still fire (gating them would be
  // a chicken-and-egg deadlock: no proposal → no visible draft → no
  // onboarding trigger), but the in-chat buttons wait until the user
  // completes Toolbox onboarding.
  const onboardingShown = useSettingsStore(
    (s) => s.soul?.draftsOnboardingShown ?? false,
  );

  // ── Skill-patched notice (Task #41) ─────────────────────────────
  // Lightweight read-only pill for "agent silently modified a skill".
  // No buttons, no settled state — just a visibility surface so the
  // user sees when Abu self-edits a skill. Future Task #24 can hang
  // a "view diff" button off this payload without schema changes.
  if (card.type === 'skill-patched' && card.skillPatched) {
    const p = card.skillPatched;
    return (
      <div className="my-2 px-3 py-2 rounded-lg border border-[var(--abu-border-subtle)] bg-[var(--abu-bg-muted)] text-minor text-[var(--abu-text-tertiary)] flex items-start gap-2">
        <Sparkles className="h-3.5 w-3.5 text-[var(--abu-clay)] flex-shrink-0 mt-0.5" />
        <div className="min-w-0">
          <span>{t.toolbox.skillPatchedCardLabel} </span>
          <span className="font-medium text-[var(--abu-text-primary)]">{p.skillName}</span>
          {p.summary && (
            <span className="text-[var(--abu-text-muted)]"> — {p.summary}</span>
          )}
        </div>
      </div>
    );
  }

  // ── Skill-deleted notice (Task #17 v2) ────────────────────────────
  // Read-only pill for "agent deleted a skill". Destructive action
  // already happened on the filesystem, so this is pure signalling.
  // For draft-source deletes we surface the 7-day recovery hint;
  // workspace-auto deletes show the "permanent" tag so users know
  // they'd need to recreate if they want it back.
  if (card.type === 'skill-deleted' && card.skillDeleted) {
    const d = card.skillDeleted;
    return (
      <div className="my-2 px-3 py-2 rounded-lg border border-[var(--abu-border-subtle)] bg-[var(--abu-bg-muted)] text-minor text-[var(--abu-text-tertiary)] flex items-start gap-2">
        <Trash2 className="h-3.5 w-3.5 text-[var(--abu-text-muted)] flex-shrink-0 mt-0.5" />
        <div className="min-w-0">
          <span>{t.toolbox.skillDeletedCardLabel} </span>
          <span className="font-medium text-[var(--abu-text-primary)]">{d.skillName}</span>
          <span className="text-[var(--abu-text-muted)]">
            {' '}— {d.rescuable ? t.toolbox.skillDeletedCardRescuable : t.toolbox.skillDeletedCardPermanent}
          </span>
        </div>
      </div>
    );
  }

  // Module I MVP originally only supported skill-proposal. Beyond that
  // type, branch above and return early.
  if (card.type !== 'skill-proposal' || !card.skillProposal) return null;
  const proposal = card.skillProposal;

  const commit = (action: NoticeCardAction) => {
    setAction(conversationId, messageId, toolCallId, action);
  };

  // Pass the workspace captured at proposal time, not the live global store.
  // The global store can have drifted — e.g. user restarts Abu and reopens
  // this conversation; chatStore.setActiveConversation clears the workspace
  // if conv.workspacePath was never bound. Card-local workspace ensures
  // accept / reject still succeed.
  const cardWorkspace = proposal.workspacePath;

  const handleAccept = async () => {
    setProcessing(true);
    const r = await acceptDraft(proposal.skillName, cardWorkspace);
    setProcessing(false);
    if (!r.ok) {
      addToast({ type: 'error', title: t.toolbox.draftsAcceptError, message: r.error });
      return;
    }
    commit('accepted');
  };

  const handleReject = async () => {
    setProcessing(true);
    const r = await rejectDraft(proposal.skillName, undefined, cardWorkspace);
    setProcessing(false);
    if (!r.ok) {
      addToast({ type: 'error', title: t.toolbox.draftsRejectError, message: r.error });
      return;
    }
    commit('rejected');
  };

  const handleRejectCategory = async () => {
    setProcessing(true);
    // Reject the draft first, then write a feedback memory so future
    // companion/butler-level prompts pick it up (Module F's "create 前
    // 扫 feedback memory" guardrail). `category: true` flags this as
    // a whole-category reject so skillDraftsStore settles peer cards
    // with 'rejected-category' tone instead of plain 'rejected'.
    const r = await rejectDraft(proposal.skillName, {
      category: true,
      workspaceOverride: cardWorkspace,
    });
    if (!r.ok) {
      setProcessing(false);
      addToast({ type: 'error', title: t.toolbox.draftsRejectError, message: r.error });
      return;
    }
    try {
      await writeMemory({
        name: `不要主动为类似 "${proposal.skillName}" 的任务建议 skill`,
        description: `用户拒绝了 skill 提议 "${proposal.skillName}"，并选择「这类别再提议」。`,
        type: 'feedback',
        content: [
          `规则：遇到类似"${proposal.skillName}"（${proposal.description}）的任务时，不主动调用 skill_manage(create, agent_proposed=true)。`,
          '',
          `**Why:** 用户 ${new Date().toISOString().slice(0, 10)} 拒绝了该类提议并标记"同类不再提议"。`,
          '',
          '**How to apply:** 识别到类似模式时，直接完成任务，不提议创建 skill。用户若真需要再明说。',
        ].join('\n'),
        source: 'agent_explicit',
        workspacePath: cardWorkspace,
      });
    } catch (err) {
      // Memory write is best-effort — even if it fails, the draft is already
      // in trash so the primary user intent is honored.
      console.warn('[SkillProposalCard] feedback memory write failed:', err);
    }
    setProcessing(false);
    commit('rejected-category');
  };

  // Defer is a no-op against the filesystem — the draft stays live,
  // only the in-chat card is cleared. User can still accept/reject
  // from the drafts panel later (and settleCardsForSkill will flip
  // this card's state when they do).
  const handleDefer = () => {
    commit('deferred');
  };

  // ── Settled state: render the outcome, no buttons ────────────────────
  if (settledAction) {
    const label =
      settledAction === 'accepted'
        ? t.toolbox.skillProposalCardAccepted
        : settledAction === 'rejected-category'
          ? t.toolbox.skillProposalCardRejectedCategory
          : settledAction === 'deferred'
            ? t.toolbox.skillProposalCardDeferred
            : t.toolbox.skillProposalCardRejected;

    // Task #33: clicking an "accepted" pill deep-links to the Toolbox
    // with the skill pre-filtered in the search box. Rejected pills stay
    // non-interactive — the skill isn't live, nothing useful to jump to.
    const isAccepted = settledAction === 'accepted';
    const handleJumpToToolbox = () => {
      const { openToolbox, setToolboxSearchQuery } = useSettingsStore.getState();
      openToolbox('skills');
      // openToolbox clears the search query first; set it after so the
      // toolbox opens already narrowed to this skill.
      setToolboxSearchQuery(proposal.skillName);
    };

    const baseClass = 'my-2 px-3 py-2 rounded-lg border border-[var(--abu-border-subtle)] bg-[var(--abu-bg-muted)] text-minor text-[var(--abu-text-tertiary)]';
    const content = (
      <>
        <span className="font-medium">{proposal.skillName}</span> — {label}
        {isAccepted && (
          <span className="ml-2 text-[var(--abu-clay)]">{t.toolbox.skillProposalCardJump}</span>
        )}
      </>
    );

    return isAccepted ? (
      <button
        onClick={handleJumpToToolbox}
        className={`${baseClass} w-full text-left hover:bg-[var(--abu-bg-elevated)] hover:border-[var(--abu-clay-ring)] transition-colors cursor-pointer`}
      >
        {content}
      </button>
    ) : (
      <div className={baseClass}>{content}</div>
    );
  }

  // ── Missing-draft state: draft was accepted via panel / expired into
  //    trash / manually deleted. Render a muted read-only pill instead of
  //    clickable buttons that would error with "draft not found".
  //
  //    Settled state takes priority over missing — if the user already
  //    clicked a button, honor that UX trace regardless of current draft
  //    presence. We only fall here when !settledAction.
  //
  //    Guarded by draftsInitialized so the first render (before listDrafts
  //    has populated) doesn't flash a false "missing" state. ──────────
  if (draftsInitialized && !draftsLoading && !draftExists) {
    return (
      <div className="my-2 px-3 py-2 rounded-lg border border-[var(--abu-border-subtle)] bg-[var(--abu-bg-muted)] text-minor text-[var(--abu-text-tertiary)]">
        <span className="font-medium">{proposal.skillName}</span> — {t.toolbox.skillProposalCardMissing}
      </div>
    );
  }

  // ── First-use onboarding gate (Task #50) ─────────────────────────
  // If the user hasn't completed the Toolbox drafts onboarding yet,
  // render a muted prompt card with a one-tap button that opens
  // Toolbox → Drafts, where the proactivity-preset picker is waiting.
  // Still shows the skill name + description so the user has context,
  // but buttons are suppressed until preferences are set.
  if (!onboardingShown) {
    const handleOpenToolbox = () => {
      useSettingsStore.getState().openToolbox('skills');
    };
    return (
      <div className="my-2 rounded-xl border border-[var(--abu-border-subtle)] bg-[var(--abu-bg-muted)] overflow-hidden">
        <div className="px-3 py-2.5">
          <div className="text-minor font-semibold text-[var(--abu-text-primary)] flex items-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5 text-[var(--abu-clay)]" />
            {proposal.skillName}
          </div>
          {proposal.description && (
            <div className="text-caption text-[var(--abu-text-muted)] mt-0.5 leading-relaxed line-clamp-2">
              {proposal.description}
            </div>
          )}
          <div className="text-caption text-[var(--abu-text-tertiary)] mt-2 leading-relaxed">
            {t.toolbox.skillProposalCardOnboardGate}
          </div>
          <button
            onClick={handleOpenToolbox}
            className="mt-2 px-2.5 py-1 rounded-md text-caption font-medium text-white bg-[var(--abu-clay)] hover:bg-[var(--abu-clay-hover)] transition-colors"
          >
            {t.toolbox.skillProposalCardOnboardGateAction}
          </button>
        </div>
      </div>
    );
  }

  // ── Active state: buttons + collapsible preview ──────────────────────
  return (
    <div className="my-2 rounded-xl border border-[var(--abu-border)] bg-[var(--abu-bg-elevated)] overflow-hidden">
      <div className="px-3 py-2 border-b border-[var(--abu-border-subtle)] flex items-center gap-2">
        <Sparkles className="h-3.5 w-3.5 text-[var(--abu-clay)]" />
        <span className="text-minor font-semibold text-[var(--abu-text-primary)]">
          {t.toolbox.skillProposalCardTitle}
        </span>
      </div>

      <div className="px-3 py-2.5">
        <div className="text-body font-semibold text-[var(--abu-text-primary)]">
          {proposal.skillName}
        </div>
        {proposal.description && (
          <div className="text-minor text-[var(--abu-text-tertiary)] mt-0.5 leading-relaxed">
            {proposal.description}
          </div>
        )}
        {proposal.triggerReason && (
          <div className="text-caption text-[var(--abu-text-muted)] mt-1.5">
            <span className="text-[var(--abu-text-tertiary)]">
              {t.toolbox.skillProposalCardWhy}：
            </span>
            {proposal.triggerReason}
          </div>
        )}

        {/* Expand / collapse trigger */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-2 flex items-center gap-1 text-caption text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] transition-colors"
        >
          {expanded ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
          <span>
            {expanded
              ? t.toolbox.skillProposalCardCollapse
              : t.toolbox.skillProposalCardExpand}
          </span>
        </button>

        {expanded && (
          <div className="mt-2 max-h-72 overflow-y-auto overlay-scroll rounded-md border border-[var(--abu-border-subtle)] bg-[var(--abu-bg-base)] px-3 py-2 text-minor leading-relaxed">
            <MarkdownRenderer content={proposal.fullContent} />
          </div>
        )}
      </div>

      <div className="px-3 py-2 border-t border-[var(--abu-border-subtle)] flex items-center gap-2 bg-[var(--abu-bg-base)]">
        <button
          onClick={handleAccept}
          disabled={processing}
          className={cn(
            'px-3 py-1 rounded-md text-minor font-medium text-white transition-colors flex items-center gap-1',
            'bg-[var(--abu-clay)] hover:bg-[var(--abu-clay-hover)] disabled:opacity-60',
          )}
        >
          {processing ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Check className="h-3 w-3" />
          )}
          {t.toolbox.skillProposalCardAccept}
        </button>
        <button
          onClick={handleReject}
          disabled={processing}
          className="px-3 py-1 rounded-md text-minor text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-muted)] transition-colors flex items-center gap-1 disabled:opacity-60"
        >
          <X className="h-3 w-3" />
          {t.toolbox.skillProposalCardReject}
        </button>
        <button
          onClick={handleRejectCategory}
          disabled={processing}
          className="px-3 py-1 rounded-md text-minor text-[var(--abu-text-muted)] hover:text-[var(--abu-danger)] hover:bg-[var(--abu-danger-bg)] transition-colors flex items-center gap-1 disabled:opacity-60"
          title={t.toolbox.skillProposalCardRejectCategory}
        >
          <Ban className="h-3 w-3" />
          {t.toolbox.skillProposalCardRejectCategory}
        </button>
        {/* Defer — pushed to the right edge via ml-auto so the three
            accept/reject actions stay visually grouped; "decide later"
            is a neutral escape hatch, not another commit. */}
        <button
          onClick={handleDefer}
          disabled={processing}
          className="ml-auto px-3 py-1 rounded-md text-minor text-[var(--abu-text-muted)] hover:text-[var(--abu-text-tertiary)] hover:bg-[var(--abu-bg-muted)] transition-colors flex items-center gap-1 disabled:opacity-60"
          title={t.toolbox.skillProposalCardDefer}
        >
          <Clock className="h-3 w-3" />
          {t.toolbox.skillProposalCardDefer}
        </button>
      </div>
    </div>
  );
}
