/**
 * SkillDraftsPanel — inline review UI for pending skill drafts.
 *
 * Rendered at the top of SkillsSection whenever the workspace has drafts
 * on disk. Hidden entirely when the drafts list is empty, so the main
 * skills panel layout is unchanged for users who don't use self-evolution.
 *
 * On first appearance it swaps in a one-time onboarding card that lets the
 * user pick a proactivity preset (shy / companion / butler). After confirm
 * it flips `soul.draftsOnboardingShown` and falls through to the normal
 * list view.
 *
 * Batch ops ([全部采纳] / [全部拒绝]) gate behind ConfirmDialog when ≥5
 * drafts would be touched. Individual accept / reject buttons apply
 * inline without a confirm — the cost of a mistake is low because
 * rejected drafts land in drafts/.trash/ for 7 days anyway.
 */

import { useState } from 'react';
import { useI18n, format } from '@/i18n';
import { useSkillDraftsStore } from '@/stores/skillDraftsStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useToastStore } from '@/stores/toastStore';
import { Check, X, Trash2, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import ConfirmDialog from '@/components/common/ConfirmDialog';
import type { DraftRecord } from '@/core/skill/drafts';

type ProactivityLevel = 'shy' | 'companion' | 'butler';

function relativeTime(ms: number, now: number = Date.now()): string {
  const diff = ms - now;
  const abs = Math.abs(diff);
  const unit = (n: number, single: string, plural: string) =>
    `${n} ${n === 1 ? single : plural}`;
  if (abs < 60_000) return unit(Math.round(abs / 1000), 'second', 'seconds');
  if (abs < 3_600_000) return unit(Math.round(abs / 60_000), 'minute', 'minutes');
  if (abs < 86_400_000) return unit(Math.round(abs / 3_600_000), 'hour', 'hours');
  return unit(Math.round(abs / 86_400_000), 'day', 'days');
}

export default function SkillDraftsPanel() {
  const { t } = useI18n();
  const drafts = useSkillDraftsStore((s) => s.drafts);
  const acceptDraft = useSkillDraftsStore((s) => s.acceptDraft);
  const rejectDraft = useSkillDraftsStore((s) => s.rejectDraft);
  const addToast = useToastStore((s) => s.addToast);
  const onboardingShown = useSettingsStore(
    (s) => s.soul?.draftsOnboardingShown ?? false,
  );
  const setProactivity = useSettingsStore((s) => s.setProactivity);
  const setDraftsOnboardingShown = useSettingsStore(
    (s) => s.setDraftsOnboardingShown,
  );
  const proactivity = useSettingsStore(
    (s) => s.soul?.proactivity ?? 'companion',
  );

  const [confirmAllOpen, setConfirmAllOpen] = useState<'accept' | 'reject' | null>(null);
  const [onboardingPick, setOnboardingPick] = useState<ProactivityLevel>(proactivity);

  // Hidden state: no drafts → render nothing, let SkillsSection show its
  // regular content without any draft-section chrome.
  if (drafts.length === 0) return null;

  // ── Onboarding branch ─────────────────────────────────────────────────
  if (!onboardingShown) {
    const levels: Array<{
      id: ProactivityLevel;
      emoji: string;
      title: string;
      desc: string;
    }> = [
      { id: 'shy',       emoji: '🌱', title: t.toolbox.draftsOnboardPickShy,       desc: t.toolbox.draftsOnboardShyDesc       },
      { id: 'companion', emoji: '🌿', title: t.toolbox.draftsOnboardPickCompanion, desc: t.toolbox.draftsOnboardCompanionDesc },
      { id: 'butler',    emoji: '🌳', title: t.toolbox.draftsOnboardPickButler,    desc: t.toolbox.draftsOnboardButlerDesc    },
    ];

    const handleConfirmOnboarding = () => {
      setProactivity(onboardingPick);
      setDraftsOnboardingShown(true);
    };

    return (
      <div className="mx-4 my-3 p-4 rounded-xl border border-[var(--abu-border)] bg-[var(--abu-bg-elevated)]">
        <div className="flex items-center gap-2 mb-2">
          <Sparkles className="h-4 w-4 text-[var(--abu-clay)]" />
          <span className="text-body font-semibold text-[var(--abu-text-primary)]">
            {t.toolbox.draftsOnboardTitle}
          </span>
        </div>
        <p className="text-minor text-[var(--abu-text-tertiary)] leading-relaxed mb-3">
          {t.toolbox.draftsOnboardBody}
        </p>
        <div className="flex flex-col gap-1.5 mb-4">
          {levels.map((lv) => (
            <button
              key={lv.id}
              onClick={() => setOnboardingPick(lv.id)}
              className={cn(
                'flex items-start gap-2.5 px-3 py-2 rounded-lg text-left transition-colors border',
                onboardingPick === lv.id
                  ? 'bg-[var(--abu-clay-tint)] border-[var(--abu-clay-ring)]'
                  : 'border-transparent hover:bg-[var(--abu-bg-active)]',
              )}
            >
              <span className="text-h-sm leading-none mt-0.5">{lv.emoji}</span>
              <div className="flex-1 min-w-0">
                <div className="text-minor font-semibold text-[var(--abu-text-primary)]">
                  {lv.title}
                </div>
                <div className="text-caption text-[var(--abu-text-muted)] mt-0.5">
                  {lv.desc}
                </div>
              </div>
            </button>
          ))}
        </div>
        <div className="flex justify-end">
          <button
            onClick={handleConfirmOnboarding}
            className="px-3 py-1.5 rounded-lg text-minor font-medium text-white bg-[var(--abu-clay)] hover:bg-[var(--abu-clay-hover)] transition-colors"
          >
            {t.toolbox.draftsOnboardConfirm}
          </button>
        </div>
      </div>
    );
  }

  // ── Normal list branch ────────────────────────────────────────────────
  const handleAccept = async (name: string) => {
    const r = await acceptDraft(name);
    if (!r.ok) {
      addToast({ type: 'error', title: t.toolbox.draftsAcceptError, message: r.error });
    }
  };

  const handleReject = async (name: string) => {
    const r = await rejectDraft(name);
    if (!r.ok) {
      addToast({ type: 'error', title: t.toolbox.draftsRejectError, message: r.error });
    }
  };

  const handleAcceptAll = async () => {
    setConfirmAllOpen(null);
    // Snapshot list — store will mutate as we go.
    const names = drafts.map((d) => d.skillName);
    for (const n of names) {
      const r = await acceptDraft(n);
      if (!r.ok) {
        addToast({ type: 'error', title: t.toolbox.draftsAcceptError, message: `${n}: ${r.error}` });
      }
    }
  };

  const handleRejectAll = async () => {
    setConfirmAllOpen(null);
    const names = drafts.map((d) => d.skillName);
    for (const n of names) {
      const r = await rejectDraft(n);
      if (!r.ok) {
        addToast({ type: 'error', title: t.toolbox.draftsRejectError, message: `${n}: ${r.error}` });
      }
    }
  };

  const needsBatchConfirm = drafts.length >= 5;

  return (
    <>
      <div className="mx-4 my-3 rounded-xl border border-[var(--abu-border)] bg-[var(--abu-bg-elevated)] overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--abu-border)]">
          <div className="flex items-center gap-2">
            <Sparkles className="h-3.5 w-3.5 text-[var(--abu-clay)]" />
            <span className="text-minor font-semibold text-[var(--abu-text-primary)]">
              {t.toolbox.draftsTitle}
            </span>
            <span className="text-caption text-[var(--abu-text-muted)]">
              {format(t.toolbox.draftsCount, { count: String(drafts.length) })}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => (needsBatchConfirm ? setConfirmAllOpen('accept') : handleAcceptAll())}
              className="px-2 py-1 rounded-md text-caption text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-active)] transition-colors"
            >
              {t.toolbox.draftsAcceptAll}
            </button>
            <button
              onClick={() => (needsBatchConfirm ? setConfirmAllOpen('reject') : handleRejectAll())}
              className="px-2 py-1 rounded-md text-caption text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-active)] transition-colors"
            >
              {t.toolbox.draftsRejectAll}
            </button>
          </div>
        </div>
        <div className="max-h-64 overflow-y-auto overlay-scroll">
          {drafts.map((d) => (
            <DraftCard key={d.id} draft={d} onAccept={handleAccept} onReject={handleReject} />
          ))}
        </div>
      </div>

      <ConfirmDialog
        open={confirmAllOpen === 'accept'}
        title={t.toolbox.draftsAcceptAll}
        message={format(t.toolbox.draftsConfirmAcceptAll, { count: String(drafts.length) })}
        confirmText={t.toolbox.draftsAcceptAll}
        cancelText="×"
        onConfirm={handleAcceptAll}
        onCancel={() => setConfirmAllOpen(null)}
      />
      <ConfirmDialog
        open={confirmAllOpen === 'reject'}
        title={t.toolbox.draftsRejectAll}
        message={format(t.toolbox.draftsConfirmRejectAll, { count: String(drafts.length) })}
        confirmText={t.toolbox.draftsRejectAll}
        cancelText="×"
        onConfirm={handleRejectAll}
        onCancel={() => setConfirmAllOpen(null)}
        variant="danger"
      />
    </>
  );
}

function DraftCard({
  draft,
  onAccept,
  onReject,
}: {
  draft: DraftRecord;
  onAccept: (name: string) => void;
  onReject: (name: string) => void;
}) {
  const { t } = useI18n();
  const now = Date.now();
  const isExpired = draft.expiresAt <= now;
  const createdWhen = relativeTime(draft.createdAt, now);
  const expiresWhen = relativeTime(draft.expiresAt, now);

  return (
    <div className="px-3 py-2 border-b border-[var(--abu-border-subtle)] last:border-b-0 hover:bg-[var(--abu-bg-active)] transition-colors">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-minor font-semibold text-[var(--abu-text-primary)] truncate">
            {draft.skillName}
          </div>
          {draft.triggerReason && (
            <div className="text-caption text-[var(--abu-text-muted)] mt-0.5 line-clamp-2">
              <span className="text-[var(--abu-text-tertiary)]">
                {t.toolbox.draftsTriggerReason}:
              </span>{' '}
              {draft.triggerReason}
            </div>
          )}
          <div className="flex items-center gap-1.5 mt-1 text-caption text-[var(--abu-text-muted)]">
            <span>{format(t.toolbox.draftsCreatedAgo, { when: createdWhen })}</span>
            <span>·</span>
            <span className={cn(isExpired && 'text-[var(--abu-danger)] font-medium')}>
              {isExpired ? t.toolbox.draftsExpired : format(t.toolbox.draftsExpiresIn, { when: expiresWhen })}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => onAccept(draft.skillName)}
            title={t.toolbox.draftsAccept}
            className="p-1 rounded hover:bg-[var(--abu-clay-tint)] text-[var(--abu-clay)] transition-colors"
          >
            <Check className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => onReject(draft.skillName)}
            title={t.toolbox.draftsReject}
            className="p-1 rounded hover:bg-[var(--abu-danger-bg)] text-[var(--abu-text-muted)] hover:text-[var(--abu-danger)] transition-colors"
          >
            {isExpired ? <Trash2 className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
    </div>
  );
}
