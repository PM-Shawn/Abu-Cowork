/**
 * UserQuestionCard — interactive choice card rendering an ask_user_question call.
 *
 * Two modes:
 * - pending: there's a matching entry in the pending queue → interactive
 *   (select + submit)
 * - settled: tc.userQuestionAnswers is set, or the pending entry was
 *   drained/timed-out → read-only
 *
 * Each question gets an auto-appended "Other…" free-text escape hatch;
 * the submit button stays disabled until every question has a valid answer.
 */

import { useState, useRef, useEffect, useSyncExternalStore } from 'react';
import { MessageSquare, Check } from 'lucide-react';
import { useI18n } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { getPendingUserQuestions, resolveUserQuestion, subscribeUserQuestion } from '@/core/agent/permissionBridge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { ToolCall, UserQuestionPayload, UserQuestionResult, UserQuestionAnswerItem } from '@/types';

interface Props {
  conversationId: string;
  messageId: string;
  toolCall: ToolCall;
}

/** Per-question local selection state */
interface QuestionState {
  selected: Set<string>;
  otherChecked: boolean;
  otherText: string;
}

function initQuestionStates(count: number): QuestionState[] {
  return Array.from({ length: count }, () => ({
    selected: new Set<string>(),
    otherChecked: false,
    otherText: '',
  }));
}

export default function UserQuestionCard({ conversationId, messageId, toolCall }: Props) {
  const { t } = useI18n();
  const setAnswers = useChatStore((s) => s.setToolCallUserQuestionAnswers);

  // Subscribe to the pending queue — re-render when it changes
  const pendingQuestions = useSyncExternalStore(subscribeUserQuestion, getPendingUserQuestions);
  const isPending = pendingQuestions.some((pq) => pq.id === toolCall.id);

  // Question data comes from the tool input (available as soon as streaming ends)
  const payload = toolCall.input as unknown as UserQuestionPayload;
  const questions = payload?.questions ?? [];

  // Per-question selection state (only meaningful while interactive)
  const [questionStates, setQuestionStates] = useState<QuestionState[]>(() =>
    initQuestionStates(questions.length),
  );

  // Scroll into view when the card first appears as interactive
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isPending && cardRef.current) {
      cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [isPending]);

  // ── Settled state: already answered ────────────────────────────────────
  if (toolCall.userQuestionAnswers) {
    const { answers } = toolCall.userQuestionAnswers;
    return (
      <div className="my-2 rounded-xl border border-[var(--abu-border-subtle)] bg-[var(--abu-bg-muted)] overflow-hidden">
        <div className="px-3 py-2 border-b border-[var(--abu-border-subtle)] flex items-center gap-2">
          <MessageSquare className="h-3.5 w-3.5 text-[var(--abu-clay)]" />
          <span className="text-xs font-semibold text-[var(--abu-text-primary)]">
            {t.userQuestion.answeredLabel}
          </span>
        </div>
        <div className="px-3 py-2.5 space-y-2">
          {answers.map((ans, i) => (
            <div key={i} className="text-xs">
              <span className="inline-block px-1.5 py-0.5 rounded bg-[var(--abu-bg-base)] border border-[var(--abu-border-subtle)] text-[var(--abu-text-tertiary)] font-medium mr-1.5">
                {ans.header}
              </span>
              <span className="text-[var(--abu-text-secondary)]">{ans.question}</span>
              <div className="mt-1 ml-1 text-[var(--abu-text-primary)] font-medium">
                → {ans.selected.join('、')}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ── Not settled and not pending: cancelled / drained ───────────────────
  if (!isPending) {
    return (
      <div className="my-2 px-3 py-2 rounded-lg border border-[var(--abu-border-subtle)] bg-[var(--abu-bg-muted)] text-xs text-[var(--abu-text-tertiary)]">
        <MessageSquare className="inline h-3.5 w-3.5 mr-1.5" />
        {t.userQuestion.cardTitle} — {t.userQuestion.cancelledLabel}
      </div>
    );
  }

  // ── Interactive state ──────────────────────────────────────────────────

  const toggleOption = (qIdx: number, label: string, multiSelect: boolean) => {
    setQuestionStates((prev) => {
      const next = prev.map((s, i) =>
        i === qIdx ? { ...s, selected: new Set(s.selected) } : s,
      );
      const state = next[qIdx];
      if (multiSelect) {
        if (state.selected.has(label)) {
          state.selected.delete(label);
        } else {
          state.selected.add(label);
        }
      } else {
        // Single select: replace selection, drop "other"
        state.selected = new Set([label]);
        state.otherChecked = false;
      }
      return next;
    });
  };

  const toggleOther = (qIdx: number, multiSelect: boolean) => {
    setQuestionStates((prev) => {
      const next = prev.map((s, i) => (i === qIdx ? { ...s, selected: new Set(s.selected) } : s));
      const state = next[qIdx];
      if (multiSelect) {
        state.otherChecked = !state.otherChecked;
      } else {
        // Single select: checking "other" clears the regular selection
        state.otherChecked = !state.otherChecked;
        if (state.otherChecked) state.selected = new Set();
      }
      return next;
    });
  };

  const setOtherText = (qIdx: number, text: string) => {
    setQuestionStates((prev) => {
      const next = [...prev];
      next[qIdx] = { ...prev[qIdx], otherText: text };
      return next;
    });
  };

  /** Whether a single question has a valid answer */
  const isQuestionValid = (qIdx: number): boolean => {
    const q = questions[qIdx];
    const state = questionStates[qIdx];
    if (!q || !state) return false;
    const hasRegular = state.selected.size > 0;
    const hasOther = state.otherChecked && state.otherText.trim().length > 0;
    return hasRegular || hasOther;
  };

  const allValid = questions.length > 0 && questions.every((_, i) => isQuestionValid(i));

  const handleSubmit = () => {
    const answers: UserQuestionAnswerItem[] = questions.map((q, i) => {
      const state = questionStates[i];
      let selected: string[];
      if (q.multiSelect) {
        selected = [...state.selected];
        if (state.otherChecked && state.otherText.trim()) {
          selected.push(state.otherText.trim());
        }
      } else {
        if (state.otherChecked && state.otherText.trim()) {
          selected = [state.otherText.trim()];
        } else {
          selected = [...state.selected];
        }
      }
      return { header: q.header, question: q.question, selected };
    });

    const result: UserQuestionResult = { answers };
    setAnswers(conversationId, messageId, toolCall.id, result);
    resolveUserQuestion(toolCall.id, result);
  };

  return (
    <div
      ref={cardRef}
      className="my-2 rounded-xl border border-[var(--abu-border)] bg-[var(--abu-bg-elevated)] overflow-hidden"
    >
      {/* Header */}
      <div className="px-3 py-2 border-b border-[var(--abu-border-subtle)] flex items-center gap-2">
        <MessageSquare className="h-3.5 w-3.5 text-[var(--abu-clay)]" />
        <span className="text-xs font-semibold text-[var(--abu-text-primary)]">
          {t.userQuestion.cardTitle}
        </span>
      </div>

      {/* Questions */}
      <div className="px-3 py-2.5 space-y-4">
        {questions.map((q, qIdx) => {
          const state = questionStates[qIdx];
          const hint = q.multiSelect
            ? t.userQuestion.multiSelectHint
            : t.userQuestion.singleSelectHint;

          return (
            <div key={qIdx} className="space-y-1.5">
              {/* Header chip + question text */}
              <div className="flex items-start gap-2 flex-wrap">
                <span className="inline-block px-1.5 py-0.5 rounded bg-[var(--abu-bg-base)] border border-[var(--abu-border-subtle)] text-[11px] text-[var(--abu-text-tertiary)] font-medium flex-shrink-0">
                  {q.header}
                </span>
                <span className="text-xs text-[var(--abu-text-primary)] flex-1">
                  {q.question}
                </span>
                <span className="text-[11px] text-[var(--abu-text-muted)] flex-shrink-0">{hint}</span>
              </div>

              {/* Options */}
              <div className="pl-1 space-y-1">
                {q.options.map((opt, oIdx) => {
                  const isChecked = state.selected.has(opt.label);
                  return (
                    <button
                      key={oIdx}
                      type="button"
                      onClick={() => toggleOption(qIdx, opt.label, q.multiSelect)}
                      className={cn(
                        'w-full text-left px-2.5 py-1.5 rounded-lg text-xs transition-colors flex items-start gap-2',
                        isChecked
                          ? 'bg-[var(--abu-clay-bg)] border border-[var(--abu-clay-ring)] text-[var(--abu-text-primary)]'
                          : 'border border-[var(--abu-border-subtle)] text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-muted)] hover:border-[var(--abu-border)]',
                      )}
                    >
                      <span
                        className={cn(
                          'mt-0.5 h-3.5 w-3.5 flex-shrink-0 border flex items-center justify-center',
                          q.multiSelect ? 'rounded-sm' : 'rounded-full',
                          isChecked
                            ? 'bg-[var(--abu-clay)] border-[var(--abu-clay)]'
                            : 'border-[var(--abu-border)]',
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

                {/* "Other…" option */}
                <div>
                  <button
                    type="button"
                    onClick={() => toggleOther(qIdx, q.multiSelect)}
                    className={cn(
                      'w-full text-left px-2.5 py-1.5 rounded-lg text-xs transition-colors flex items-center gap-2',
                      state.otherChecked
                        ? 'bg-[var(--abu-clay-bg)] border border-[var(--abu-clay-ring)] text-[var(--abu-text-primary)]'
                        : 'border border-[var(--abu-border-subtle)] text-[var(--abu-text-tertiary)] hover:bg-[var(--abu-bg-muted)] hover:border-[var(--abu-border)]',
                    )}
                  >
                    <span
                      className={cn(
                        'h-3.5 w-3.5 flex-shrink-0 border flex items-center justify-center',
                        q.multiSelect ? 'rounded-sm' : 'rounded-full',
                        state.otherChecked
                          ? 'bg-[var(--abu-clay)] border-[var(--abu-clay)]'
                          : 'border-[var(--abu-border)]',
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
                        onChange={(e) => setOtherText(qIdx, e.target.value)}
                        placeholder={t.userQuestion.otherInputPlaceholder}
                        className="h-7 text-xs"
                        autoFocus
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div className="px-3 py-2 border-t border-[var(--abu-border-subtle)] bg-[var(--abu-bg-base)] flex items-center justify-end">
        <Button
          size="sm"
          onClick={handleSubmit}
          disabled={!allValid}
          title={!allValid ? t.userQuestion.submitDisabledHint : undefined}
          className="text-xs"
        >
          {t.userQuestion.submitButton}
        </Button>
      </div>
    </div>
  );
}
