/**
 * UserQuestionDock — the interactive, paginated surface for a pending
 * ask_user_question call. Docks above the composer (rendered from ChatView),
 * shows ONE question at a time with a pager, and resolves the pending bridge
 * entry on submit / cancel.
 *
 * Behaviour (mirrors Claude desktop):
 * - One question per page, `current / total` counter + ‹ › arrows + ×.
 * - Numbered options (1..n) + a trailing "Other…" free-text escape hatch,
 *   plus an optional "Skip" per question.
 * - Single-select: click / Enter selects and auto-advances; multi-select:
 *   toggle multiple, then advance manually. Last page shows Submit.
 * - Keyboard: ↑/↓ move highlight, Enter selects/advances/submits, ←/→ page.
 *
 * Settled (read-only) rendering lives in UserQuestionCard — not here.
 */

import { memo, useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useI18n } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { resolveUserQuestion } from '@/core/agent/permissionBridge';
import { Button, IconButton } from '@/components/ds/button';
import { dropsHeldEscape, dropsHeldRepeat } from '@/components/ds/heldKey';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Pressable } from '@/components/ds/pressable';
import { Tag } from '@/components/ds/tag';
import { TextField } from '@/components/ds/text-field';
import { cn } from '@/lib/utils';
import type { UserQuestionPayload, UserQuestionResult, UserQuestionAnswerItem } from '@/types';

interface Props {
  conversationId: string;
  messageId: string;
  toolCallId: string;
  payload: UserQuestionPayload;
  /** Fired the moment an answer is submitted — the dock unmounts synchronously
   *  on resolve, so the parent uses this for optimistic "正在继续…" feedback. */
  onSubmitted?: () => void;
}

/** Per-question local selection state */
interface QuestionState {
  selected: Set<string>;
  otherChecked: boolean;
  otherText: string;
  skipped: boolean;
}

function initQuestionStates(count: number): QuestionState[] {
  return Array.from({ length: count }, () => ({
    selected: new Set<string>(),
    otherChecked: false,
    otherText: '',
    skipped: false,
  }));
}

function UserQuestionDock({ conversationId, messageId, toolCallId, payload, onSubmitted }: Props) {
  const { t, format } = useI18n();
  const setAnswers = useChatStore((s) => s.setToolCallUserQuestionAnswers);

  const questions = useMemo(() => payload?.questions ?? [], [payload]);
  const total = questions.length;
  // Two-step confirm mode (plan approval): single-select clicks only select;
  // submission requires the explicit confirm button. Guards destructive
  // approvals against click-through.
  const confirmMode = !!payload?.confirm;

  const [page, setPage] = useState(0);
  const [questionStates, setQuestionStates] = useState<QuestionState[]>(() =>
    initQuestionStates(total),
  );
  // Index of the keyboard-highlighted row: 0..options-1 = options,
  // options = "Other…", options+1 = "Skip".
  const [highlight, setHighlight] = useState(0);

  const containerRef = useRef<HTMLDivElement>(null);

  const q = questions[page];
  const state = questionStates[page];
  const isLast = page === total - 1;

  // Focus the dock so keyboard nav works as soon as it appears / pages.
  useEffect(() => {
    containerRef.current?.focus();
    setHighlight(0);
  }, [page]);

  // ── Selection mutators ──────────────────────────────────────────────────

  const toggleOption = useCallback((label: string, multiSelect: boolean) => {
    setQuestionStates((prev) => {
      const next = prev.map((s, i) => (i === page ? { ...s, selected: new Set(s.selected) } : s));
      const st = next[page];
      st.skipped = false;
      if (multiSelect) {
        if (st.selected.has(label)) st.selected.delete(label);
        else st.selected.add(label);
      } else {
        st.selected = new Set([label]);
        st.otherChecked = false;
      }
      return next;
    });
  }, [page]);

  const toggleOther = useCallback((multiSelect: boolean) => {
    setQuestionStates((prev) => {
      const next = prev.map((s, i) => (i === page ? { ...s, selected: new Set(s.selected) } : s));
      const st = next[page];
      st.skipped = false;
      if (multiSelect) {
        st.otherChecked = !st.otherChecked;
      } else {
        st.otherChecked = !st.otherChecked;
        if (st.otherChecked) st.selected = new Set();
      }
      return next;
    });
  }, [page]);

  const setOtherText = useCallback((text: string) => {
    setQuestionStates((prev) => {
      const next = [...prev];
      next[page] = { ...prev[page], otherText: text };
      return next;
    });
  }, [page]);

  // ── Validity ────────────────────────────────────────────────────────────

  const isAnswered = useCallback((idx: number): boolean => {
    const st = questionStates[idx];
    if (!st) return false;
    if (st.skipped) return true;
    const hasRegular = st.selected.size > 0;
    const hasOther = st.otherChecked && st.otherText.trim().length > 0;
    return hasRegular || hasOther;
  }, [questionStates]);

  const currentAnswered = isAnswered(page);
  // Submit allowed unless every question is empty (all-skip is also blocked).
  const anyRealAnswer = questions.some((_, i) => {
    const st = questionStates[i];
    return !st.skipped && (st.selected.size > 0 || (st.otherChecked && st.otherText.trim().length > 0));
  });
  const allResolved = questions.every((_, i) => isAnswered(i));
  const canSubmit = total > 0 && allResolved && anyRealAnswer;

  // ── Navigation / submit ─────────────────────────────────────────────────

  const goPrev = useCallback(() => setPage((p) => Math.max(0, p - 1)), []);
  const goNext = useCallback(() => setPage((p) => Math.min(total - 1, p + 1)), [total]);

  // Build the answer payload from a given snapshot of states. Pure so callers
  // can submit with a freshly-derived snapshot without waiting on a re-render.
  const buildAnswers = useCallback((states: QuestionState[]): UserQuestionAnswerItem[] =>
    questions.map((question, i) => {
      const st = states[i];
      if (st.skipped) {
        return { header: question.header, question: question.question, selected: [t.userQuestion.skippedMarker] };
      }
      let selected: string[];
      if (question.multiSelect) {
        selected = [...st.selected];
        if (st.otherChecked && st.otherText.trim()) selected.push(st.otherText.trim());
      } else {
        selected = st.otherChecked && st.otherText.trim() ? [st.otherText.trim()] : [...st.selected];
      }
      return { header: question.header, question: question.question, selected };
    }), [questions, t.userQuestion.skippedMarker]);

  const submitWith = useCallback((states: QuestionState[]) => {
    const result: UserQuestionResult = { answers: buildAnswers(states) };
    setAnswers(conversationId, messageId, toolCallId, result);
    resolveUserQuestion(toolCallId, result);
    onSubmitted?.();
  }, [buildAnswers, conversationId, messageId, toolCallId, setAnswers, onSubmitted]);

  const handleSubmit = useCallback(() => {
    submitWith(questionStates);
  }, [submitWith, questionStates]);

  const handleCancel = useCallback(() => {
    resolveUserQuestion(toolCallId, null);
  }, [toolCallId]);

  // Single-select: apply the choice, then advance — or submit if it's the
  // last page. On the last page we submit with a freshly-derived snapshot so
  // the just-applied selection is included without waiting on a re-render.
  const selectAndAdvance = useCallback((label: string) => {
    const next = questionStates.map((s, i) =>
      i === page ? { ...s, selected: new Set([label]), otherChecked: false, skipped: false } : s,
    );
    setQuestionStates(next);
    if (isLast) submitWith(next);
    else goNext();
  }, [questionStates, page, isLast, submitWith, goNext]);

  // Skip marks the current question skipped and advances. On the last page it
  // submits, provided at least one other question carries a real answer.
  const skipAndAdvance = useCallback(() => {
    const next = questionStates.map((s, i) =>
      i === page ? { ...s, skipped: true, selected: new Set<string>(), otherChecked: false } : s,
    );
    setQuestionStates(next);
    if (isLast) {
      const hasReal = next.some((st) => !st.skipped && (st.selected.size > 0 || (st.otherChecked && st.otherText.trim().length > 0)));
      if (hasReal) submitWith(next);
    } else {
      goNext();
    }
  }, [questionStates, page, isLast, submitWith, goNext]);

  // ── Keyboard ────────────────────────────────────────────────────────────

  const rowCount = (q?.options.length ?? 0) + 2; // options + Other + Skip

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Don't hijack typing inside the "Other" text field.
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
      if (e.key === 'Escape') {
        e.preventDefault();
        containerRef.current?.focus();
      }
      return;
    }
    // If a native button has focus (e.g. the Tab-focused confirm footer
    // button), return without preventDefault so its native click fires —
    // otherwise Enter would be hijacked into toggleOption on the hovered row,
    // which could silently flip a rejection into an approval.
    if (e.target instanceof HTMLButtonElement) return;
    if (!q) return;
    // One press of Enter answers once. The dock takes the focus by itself when a question
    // arrives or the page turns, and the Enter that sent the message, or that answered the page
    // before, may still be down: its repeats choose nothing and confirm nothing (ds/heldKey.ts).
    if (dropsHeldRepeat(e)) return;
    // Nor does a held Escape cancel a question that arrives: one press of Escape cancels.
    if (e.key === 'Escape' && dropsHeldEscape(e)) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlight((h) => (h + 1) % rowCount);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlight((h) => (h - 1 + rowCount) % rowCount);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        goPrev();
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (!isLast) goNext();
        break;
      case 'Enter': {
        e.preventDefault();
        const optionCount = q.options.length;
        if (highlight < optionCount) {
          const label = q.options[highlight].label;
          if (q.multiSelect) {
            toggleOption(label, true);
          } else if (confirmMode) {
            // Confirm mode: first Enter selects; a second Enter on the
            // already-selected option submits (still an explicit two-step).
            if (state.selected.has(label) && canSubmit) handleSubmit();
            else toggleOption(label, false);
          } else {
            selectAndAdvance(label);
          }
        } else if (highlight === optionCount) {
          toggleOther(q.multiSelect);
        } else {
          // Skip row — mark skipped and advance / submit.
          skipAndAdvance();
        }
        break;
      }
      case 'Escape':
        e.preventDefault();
        handleCancel();
        break;
    }
  };

  if (total === 0) return null;

  const hint = q.multiSelect ? t.userQuestion.multiSelectHint : t.userQuestion.singleSelectHint;
  const optionCount = q.options.length;

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className="overflow-hidden rounded-panel border border-separator bg-surface outline-none"
    >
      {/* Header: question + pager */}
      <div className="flex items-start gap-2 border-b border-separator px-3 py-2">
        {!confirmMode && (
          <span className="flex h-lh shrink-0 items-center text-ui">
            <Icon icon={AppIcons.conversation} size="sm" className="text-label-secondary" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Tag>{q.header}</Tag>
            <span className="text-caption text-label-tertiary">{hint}</span>
          </div>
          <p className="mt-1 text-ui text-label">{q.question}</p>
        </div>
        {/* Pager controls */}
        <div className="flex shrink-0 items-center gap-1">
          <span className="mr-1 text-caption tabular-nums text-label-tertiary">
            {format(t.userQuestion.pager, { current: page + 1, total })}
          </span>
          <IconButton size="sm" icon={AppIcons.previous} label={t.userQuestion.prevQuestion} onClick={goPrev} disabled={page === 0} />
          <IconButton size="sm" icon={AppIcons.disclose} label={t.userQuestion.nextQuestion} onClick={goNext} disabled={isLast} />
          <IconButton size="sm" icon={AppIcons.close} label={t.userQuestion.close} onClick={handleCancel} />
        </div>
      </div>

      {/* Options for the current question */}
      <div className="space-y-1 px-3 py-2">
        {q.options.map((opt, oIdx) => {
          const isChecked = !state.skipped && state.selected.has(opt.label);
          return (
            <Pressable
              key={oIdx}
              onClick={() => {
                if (q.multiSelect) toggleOption(opt.label, true);
                else if (confirmMode) toggleOption(opt.label, false);
                else selectAndAdvance(opt.label);
              }}
              onMouseEnter={() => setHighlight(oIdx)}
              className={optionRowClass(isChecked, highlight === oIdx)}
            >
              <span className="flex h-lh w-4 shrink-0 items-center justify-center text-caption tabular-nums text-label-tertiary">
                {oIdx + 1}
              </span>
              <span className="flex h-lh shrink-0 items-center">
                <ChoiceMark multiSelect={q.multiSelect} checked={isChecked} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="font-medium">{opt.label}</span>
                {opt.description && (
                  <span className="block text-ui-sm text-label-tertiary">
                    {opt.description}
                  </span>
                )}
              </span>
            </Pressable>
          );
        })}

        {/* "Other…" row */}
        <div>
          <Pressable
            onClick={() => toggleOther(q.multiSelect)}
            onMouseEnter={() => setHighlight(optionCount)}
            className={optionRowClass(state.otherChecked, highlight === optionCount)}
          >
            <span className="flex h-lh w-4 shrink-0 items-center justify-center">
              <Icon icon={AppIcons.customAnswer} size="sm" className="text-label-tertiary" />
            </span>
            <span className="flex h-lh shrink-0 items-center">
              <ChoiceMark multiSelect={q.multiSelect} checked={state.otherChecked} />
            </span>
            <span className="italic">{t.userQuestion.otherOptionLabel}</span>
          </Pressable>

          {state.otherChecked && (
            <div className="mt-1 pl-1">
              <TextField
                value={state.otherText}
                onChange={(e) => setOtherText(e.target.value)}
                placeholder={t.userQuestion.otherInputPlaceholder}
                autoFocus
              />
            </div>
          )}
        </div>

        {/* "Skip" row */}
        <Pressable
          onClick={skipAndAdvance}
          onMouseEnter={() => setHighlight(optionCount + 1)}
          className={cn(
            'flex w-full items-center gap-2 rounded-control border px-2 py-1 text-left text-ui-sm transition-colors duration-fast',
            state.skipped
              ? 'border-control-border bg-fill-selected text-label-secondary'
              : cn('border-transparent text-label-tertiary', highlight === optionCount + 1 && 'bg-fill-hover'),
          )}
        >
          <span className="w-4 shrink-0" />
          <span className="flex w-4 shrink-0 items-center justify-center">
            {state.skipped && <Icon icon={AppIcons.done} size="sm" className="text-label-secondary" />}
          </span>
          <span>{t.userQuestion.skip}</span>
        </Pressable>
      </div>

      {/* Footer: hint + next/submit */}
      <div className="flex items-center justify-between gap-2 border-t border-separator px-3 py-2">
        <p className="truncate text-caption text-label-tertiary">{t.userQuestion.navHint}</p>
        {isLast ? (
          <Button
            variant="primary"
            size="sm"
            onClick={handleSubmit}
            disabled={!canSubmit}
            title={!canSubmit ? t.userQuestion.submitDisabledHint : undefined}
          >
            {confirmMode ? t.userQuestion.confirmButton : t.userQuestion.submitButton}
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            onClick={goNext}
            disabled={!currentAnswered}
          >
            {t.userQuestion.nextQuestion}
          </Button>
        )}
      </div>
    </div>
  );
}

function optionRowClass(checked: boolean, highlighted: boolean): string {
  return cn(
    'flex w-full items-start gap-2 rounded-control border px-2 py-1 text-left text-ui transition-colors duration-fast',
    checked
      ? 'border-control-border bg-fill-selected text-label'
      : cn('border-separator text-label-secondary', highlighted && 'bg-fill-hover'),
  );
}

// The same marks as ds Checkbox (several answers) and RadioGroup (one answer).
function ChoiceMark({ multiSelect, checked }: { multiSelect: boolean; checked: boolean }) {
  if (multiSelect) {
    return (
      <span className={cn(
        'flex h-4 w-4 items-center justify-center rounded-control border',
        checked ? 'border-emphasis bg-emphasis text-on-emphasis' : 'border-control-border bg-field',
      )}>
        {checked && <Icon icon={AppIcons.done} size="sm" />}
      </span>
    );
  }
  return (
    <span className={cn(
      'flex h-4 w-4 items-center justify-center rounded-full border bg-field',
      checked ? 'border-emphasis' : 'border-control-border',
    )}>
      {checked && <span className="h-2 w-2 rounded-full bg-emphasis" />}
    </span>
  );
}

// ChatView re-renders on every streamed token; the dock's own props do not change then.
export default memo(UserQuestionDock);
