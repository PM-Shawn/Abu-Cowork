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

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { MessageSquare, Check, Pencil, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useI18n } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { resolveUserQuestion } from '@/core/agent/permissionBridge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { UserQuestionPayload, UserQuestionResult, UserQuestionAnswerItem } from '@/types';

interface Props {
  conversationId: string;
  messageId: string;
  toolCallId: string;
  payload: UserQuestionPayload;
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

export default function UserQuestionDock({ conversationId, messageId, toolCallId, payload }: Props) {
  const { t, format } = useI18n();
  const setAnswers = useChatStore((s) => s.setToolCallUserQuestionAnswers);

  const questions = useMemo(() => payload?.questions ?? [], [payload]);
  const total = questions.length;

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
  }, [buildAnswers, conversationId, messageId, toolCallId, setAnswers]);

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
    if (!q) return;

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
          if (q.multiSelect) toggleOption(label, true);
          else selectAndAdvance(label);
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
      className="rounded-xl border border-[var(--abu-border)] bg-white shadow-md overflow-hidden outline-none"
    >
      {/* Header: question + pager */}
      <div className="px-3 py-2 border-b border-[var(--abu-border-subtle)] flex items-start gap-2">
        <MessageSquare className="h-3.5 w-3.5 text-[var(--abu-clay)] shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="inline-block px-1.5 py-0.5 rounded bg-[var(--abu-bg-base)] border border-[var(--abu-border-subtle)] text-[11px] text-[var(--abu-text-tertiary)] font-medium">
              {q.header}
            </span>
            <span className="text-[11px] text-[var(--abu-text-muted)]">{hint}</span>
          </div>
          <p className="mt-1 text-[13px] text-[var(--abu-text-primary)] leading-snug">{q.question}</p>
        </div>
        {/* Pager controls */}
        <div className="flex items-center gap-1 shrink-0">
          <span className="text-[11px] text-[var(--abu-text-tertiary)] tabular-nums mr-0.5">
            {format(t.userQuestion.pager, { current: page + 1, total })}
          </span>
          <button
            type="button"
            onClick={goPrev}
            disabled={page === 0}
            aria-label={t.userQuestion.prevQuestion}
            className="btn-ghost p-1 rounded-md text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-muted)] disabled:opacity-30 disabled:pointer-events-none"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={goNext}
            disabled={isLast}
            aria-label={t.userQuestion.nextQuestion}
            className="btn-ghost p-1 rounded-md text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-muted)] disabled:opacity-30 disabled:pointer-events-none"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={handleCancel}
            aria-label={t.userQuestion.close}
            className="btn-ghost p-1 rounded-md text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-muted)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Options for the current question */}
      <div className="px-3 py-2 space-y-1">
        {q.options.map((opt, oIdx) => {
          const isChecked = !state.skipped && state.selected.has(opt.label);
          const isHighlighted = highlight === oIdx;
          return (
            <button
              key={oIdx}
              type="button"
              onClick={() => (q.multiSelect ? toggleOption(opt.label, true) : selectAndAdvance(opt.label))}
              onMouseEnter={() => setHighlight(oIdx)}
              className={cn(
                'w-full text-left px-2 py-1.5 rounded-lg text-[13px] transition-colors flex items-start gap-2',
                isChecked
                  ? 'bg-[var(--abu-clay-bg)] border border-[var(--abu-clay-ring)] text-[var(--abu-text-primary)]'
                  : cn(
                      'border text-[var(--abu-text-secondary)]',
                      isHighlighted
                        ? 'bg-[var(--abu-bg-muted)] border-[var(--abu-border)]'
                        : 'border-[var(--abu-border-subtle)]',
                    ),
              )}
            >
              <span className="mt-0.5 w-3.5 text-[11px] text-[var(--abu-text-muted)] tabular-nums shrink-0 text-center">
                {oIdx + 1}
              </span>
              <span
                className={cn(
                  'mt-0.5 h-3.5 w-3.5 flex-shrink-0 border flex items-center justify-center',
                  q.multiSelect ? 'rounded-sm' : 'rounded-full',
                  isChecked ? 'bg-[var(--abu-clay)] border-[var(--abu-clay)]' : 'border-[var(--abu-border)]',
                )}
              >
                {isChecked && <Check className="h-2.5 w-2.5 text-white" />}
              </span>
              <span className="flex-1 min-w-0">
                <span className="font-medium">{opt.label}</span>
                {opt.description && (
                  <span className="block text-[11px] text-[var(--abu-text-muted)] mt-0.5">
                    {opt.description}
                  </span>
                )}
              </span>
            </button>
          );
        })}

        {/* "Other…" row */}
        <div>
          <button
            type="button"
            onClick={() => toggleOther(q.multiSelect)}
            onMouseEnter={() => setHighlight(optionCount)}
            className={cn(
              'w-full text-left px-2 py-1.5 rounded-lg text-[13px] transition-colors flex items-center gap-2',
              state.otherChecked
                ? 'bg-[var(--abu-clay-bg)] border border-[var(--abu-clay-ring)] text-[var(--abu-text-primary)]'
                : cn(
                    'border text-[var(--abu-text-tertiary)]',
                    highlight === optionCount
                      ? 'bg-[var(--abu-bg-muted)] border-[var(--abu-border)]'
                      : 'border-[var(--abu-border-subtle)]',
                  ),
            )}
          >
            <span className="w-3.5 shrink-0 flex items-center justify-center">
              <Pencil className="h-3 w-3" />
            </span>
            <span
              className={cn(
                'h-3.5 w-3.5 flex-shrink-0 border flex items-center justify-center',
                q.multiSelect ? 'rounded-sm' : 'rounded-full',
                state.otherChecked ? 'bg-[var(--abu-clay)] border-[var(--abu-clay)]' : 'border-[var(--abu-border)]',
              )}
            >
              {state.otherChecked && <Check className="h-2.5 w-2.5 text-white" />}
            </span>
            <span className="italic">{t.userQuestion.otherOptionLabel}</span>
          </button>

          {state.otherChecked && (
            <div className="mt-1.5 pl-1">
              <Input
                type="text"
                value={state.otherText}
                onChange={(e) => setOtherText(e.target.value)}
                placeholder={t.userQuestion.otherInputPlaceholder}
                className="h-8 text-[13px]"
                autoFocus
              />
            </div>
          )}
        </div>

        {/* "Skip" row */}
        <button
          type="button"
          onClick={skipAndAdvance}
          onMouseEnter={() => setHighlight(optionCount + 1)}
          className={cn(
            'w-full text-left px-2 py-1 rounded-lg text-[12px] transition-colors flex items-center gap-2',
            state.skipped
              ? 'text-[var(--abu-text-secondary)] bg-[var(--abu-bg-muted)] border border-[var(--abu-border)]'
              : cn(
                  'border border-transparent text-[var(--abu-text-muted)]',
                  highlight === optionCount + 1 && 'bg-[var(--abu-bg-muted)]',
                ),
          )}
        >
          <span className="w-3.5 shrink-0" />
          <span className={cn('h-3.5 w-3.5 flex-shrink-0 flex items-center justify-center')}>
            {state.skipped && <Check className="h-3 w-3 text-[var(--abu-text-secondary)]" />}
          </span>
          <span>{t.userQuestion.skip}</span>
        </button>
      </div>

      {/* Footer: hint + next/submit */}
      <div className="px-3 py-1.5 border-t border-[var(--abu-border-subtle)] bg-[var(--abu-bg-base)] flex items-center justify-between gap-2">
        <p className="text-[11px] text-[var(--abu-text-muted)] truncate">{t.userQuestion.navHint}</p>
        {isLast ? (
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={!canSubmit}
            title={!canSubmit ? t.userQuestion.submitDisabledHint : undefined}
            className="text-xs shrink-0"
          >
            {t.userQuestion.submitButton}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            onClick={goNext}
            disabled={!currentAnswered}
            className="text-xs shrink-0"
          >
            {t.userQuestion.nextQuestion}
          </Button>
        )}
      </div>
    </div>
  );
}
