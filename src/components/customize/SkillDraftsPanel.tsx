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
 * Batch ops ([全部采纳] / [全部拒绝]) ask first when ≥5 drafts would be
 * touched. Individual accept / reject buttons apply inline without a
 * question — the cost of a mistake is low because rejected drafts land in
 * drafts/.trash/ for 7 days anyway.
 *
 * `memo` with no props, and each draft row is `memo` with stable props: the
 * skills page renders for every character typed in its search box, and every
 * row holds two buttons with tooltips.
 */

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useI18n, format } from '@/i18n';
import { useSkillDraftsStore } from '@/stores/skillDraftsStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useToastStore } from '@/stores/toastStore';
import { cn } from '@/lib/utils';
import { Button, IconButton } from '@/components/ds/button';
import { useConfirm } from '@/components/ds/confirm-context';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Pressable } from '@/components/ds/pressable';
import { StatusIcon } from '@/components/ds/status-icon';
import { focusIsOnWindow } from '@/components/toolbox/plugins/cardFocus';
import type { DraftRecord } from '@/core/skill/drafts';

type ProactivityLevel = 'shy' | 'companion' | 'butler';

const PANEL = 'mx-4 my-3 overflow-hidden rounded-panel border border-separator';

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

function SkillDraftsPanel() {
  const { t } = useI18n();
  const confirm = useConfirm();
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

  const [onboardingPick, setOnboardingPick] = useState<ProactivityLevel>(proactivity);

  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // A draft that is accepted or rejected leaves the list with the button that was pressed. The
  // focus goes to the same button of the row that took its place, else of the row before it,
  // else — the panel has left with its last draft — to the page's 「添加」 button.
  const listRef = useRef<HTMLDivElement>(null);
  const pressedAt = useRef<number | null>(null);
  // Where the pressed button sits among the list's buttons.
  const notePressed = useCallback(() => {
    const active = document.activeElement;
    const index = Array.from(listRef.current?.querySelectorAll<HTMLElement>('button') ?? []).findIndex((button) => button === active);
    pressedAt.current = index >= 0 ? index : null;
  }, []);
  // 「全部采纳」 and 「全部拒绝」 sit in the title row, which leaves once no draft is left.
  const noteAllPressed = () => { pressedAt.current = 0; };
  const allDone = () => {
    // Drafts are left (some failed): the title row and its buttons are still there.
    if (useSkillDraftsStore.getState().drafts.length > 0) pressedAt.current = null;
  };
  useLayoutEffect(() => {
    const index = pressedAt.current;
    // Only when no control has the focus: the pressed button may still be there.
    if (index === null || !focusIsOnWindow()) return;
    pressedAt.current = null;
    const buttons = Array.from(listRef.current?.querySelectorAll<HTMLElement>('button') ?? []);
    // Each row holds two buttons, so the same button of the row before sits two back.
    const next = buttons[index] ?? buttons[index - 2] ?? buttons.at(-1)
      ?? document.querySelector<HTMLElement>('[data-testid="skill-create-trigger"]');
    next?.focus();
  }, [drafts]);

  const handleAccept = useCallback(async (name: string) => {
    notePressed();
    const r = await acceptDraft(name);
    if (!r.ok) {
      pressedAt.current = null;
      addToast({ type: 'error', title: t.toolbox.draftsAcceptError, message: r.error });
    }
  }, [acceptDraft, addToast, t, notePressed]);

  const handleReject = useCallback(async (name: string) => {
    notePressed();
    const r = await rejectDraft(name);
    if (!r.ok) {
      pressedAt.current = null;
      addToast({ type: 'error', title: t.toolbox.draftsRejectError, message: r.error });
    }
  }, [rejectDraft, addToast, t, notePressed]);

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
      <div className="mx-4 my-3 rounded-panel border border-separator p-4">
        <div className="mb-2 flex items-center gap-2">
          <Icon icon={AppIcons.sparkles} size="md" className="text-label-tertiary" />
          <span className="text-ui font-medium text-label">
            {t.toolbox.draftsOnboardTitle}
          </span>
        </div>
        <p className="mb-3 text-ui-sm text-label-secondary">
          {t.toolbox.draftsOnboardBody}
        </p>
        <div className="mb-4 flex flex-col gap-1">
          {levels.map((lv) => (
            <Pressable
              key={lv.id}
              aria-pressed={onboardingPick === lv.id}
              onClick={() => setOnboardingPick(lv.id)}
              className={cn(
                'flex items-start gap-3 rounded-control border px-3 py-2 text-left',
                onboardingPick === lv.id
                  ? 'border-control-border bg-fill-selected'
                  : 'border-transparent hover:bg-fill-hover',
              )}
            >
              <span className="text-title leading-none">{lv.emoji}</span>
              <div className="min-w-0 flex-1">
                <div className="text-ui-sm font-medium text-label">
                  {lv.title}
                </div>
                <div className="mt-1 text-caption text-label-tertiary">
                  {lv.desc}
                </div>
              </div>
            </Pressable>
          ))}
        </div>
        <div className="flex justify-end">
          <Button variant="primary" size="sm" onClick={handleConfirmOnboarding}>
            {t.toolbox.draftsOnboardConfirm}
          </Button>
        </div>
      </div>
    );
  }

  // ── Normal list branch ────────────────────────────────────────────────
  // Five drafts or more are asked about first. The answer acts on the drafts that are there at
  // that moment: one may have expired or been accepted elsewhere while the question was open.
  // An answer given after the panel has left the page touches nothing.
  const needsBatchConfirm = drafts.length >= 5;

  const handleAcceptAll = async () => {
    if (needsBatchConfirm) {
      const confirmed = await confirm({
        title: t.toolbox.draftsAcceptAll,
        message: format(t.toolbox.draftsConfirmAcceptAll, { count: String(drafts.length) }),
        confirmLabel: t.toolbox.draftsAcceptAll,
      });
      if (!confirmed || !mounted.current) return;
    }
    noteAllPressed();
    // Snapshot list — store will mutate as we go.
    const names = useSkillDraftsStore.getState().drafts.map((d) => d.skillName);
    for (const n of names) {
      const r = await acceptDraft(n);
      if (!r.ok) {
        addToast({ type: 'error', title: t.toolbox.draftsAcceptError, message: `${n}: ${r.error}` });
      }
    }
    allDone();
  };

  const handleRejectAll = async () => {
    if (needsBatchConfirm) {
      const confirmed = await confirm({
        title: t.toolbox.draftsRejectAll,
        message: format(t.toolbox.draftsConfirmRejectAll, { count: String(drafts.length) }),
        confirmLabel: t.toolbox.draftsRejectAll,
        tone: 'danger',
      });
      if (!confirmed || !mounted.current) return;
    }
    noteAllPressed();
    const names = useSkillDraftsStore.getState().drafts.map((d) => d.skillName);
    for (const n of names) {
      const r = await rejectDraft(n);
      if (!r.ok) {
        addToast({ type: 'error', title: t.toolbox.draftsRejectError, message: `${n}: ${r.error}` });
      }
    }
    allDone();
  };

  return (
    <div className={PANEL}>
      <div className="flex items-center justify-between border-b border-separator px-3 py-2">
        <div className="flex items-center gap-2">
          <Icon icon={AppIcons.sparkles} size="sm" className="text-label-tertiary" />
          <span className="text-ui-sm font-medium text-label">
            {t.toolbox.draftsTitle}
          </span>
          <span className="text-caption text-label-tertiary">
            {format(t.toolbox.draftsCount, { count: String(drafts.length) })}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="plain" size="sm" onClick={() => { void handleAcceptAll(); }}>
            {t.toolbox.draftsAcceptAll}
          </Button>
          <Button variant="plain" size="sm" onClick={() => { void handleRejectAll(); }}>
            {t.toolbox.draftsRejectAll}
          </Button>
        </div>
      </div>
      <div ref={listRef} className="max-h-64 overflow-y-auto overlay-scroll">
        {drafts.map((d) => (
          <DraftCard key={d.id} draft={d} onAccept={handleAccept} onReject={handleReject} />
        ))}
      </div>
    </div>
  );
}

export default memo(SkillDraftsPanel);

const DraftCard = memo(function DraftCard({
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
    <div className="border-b border-separator px-3 py-2 last:border-b-0">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-ui-sm font-medium text-label">
            {draft.skillName}
          </div>
          {draft.triggerReason && (
            <div className="mt-1 line-clamp-2 text-caption text-label-tertiary">
              <span className="text-label-secondary">
                {t.toolbox.draftsTriggerReason}:
              </span>{' '}
              {draft.triggerReason}
            </div>
          )}
          <div className="mt-1 flex items-center gap-1 text-caption text-label-tertiary">
            <span>{format(t.toolbox.draftsCreatedAgo, { when: createdWhen })}</span>
            <span>·</span>
            {isExpired ? (
              <span className="inline-flex items-center gap-1 font-medium text-danger">
                <StatusIcon tone="danger" size="sm" />
                {t.toolbox.draftsExpired}
              </span>
            ) : (
              <span>{format(t.toolbox.draftsExpiresIn, { when: expiresWhen })}</span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <IconButton size="sm" icon={AppIcons.done} label={t.toolbox.draftsAccept} onClick={() => onAccept(draft.skillName)} />
          <IconButton
            size="sm"
            icon={isExpired ? AppIcons.delete : AppIcons.close}
            label={t.toolbox.draftsReject}
            onClick={() => onReject(draft.skillName)}
          />
        </div>
      </div>
    </div>
  );
});
