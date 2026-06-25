/**
 * UserQuestionCard — read-only rendering of a *settled* ask_user_question call.
 *
 * The interactive / paginated surface now lives in UserQuestionDock (docked
 * above the composer). This component only renders once the user has answered:
 * a right-aligned "user message" style bubble where each question is shown as
 * two lines — `Q: <question>` / `A: <selected>` — with a blank line between
 * questions. Multi-select answers join with "、"; "Other" shows the custom text.
 *
 * If a tool call reaches this component without `userQuestionAnswers` (e.g.
 * drained / timed out after the dock unmounted), a minimal cancelled marker is
 * shown instead.
 */

import { MessageSquare } from 'lucide-react';
import { useI18n } from '@/i18n';
import type { ToolCall } from '@/types';

interface Props {
  toolCall: ToolCall;
}

export default function UserQuestionCard({ toolCall }: Props) {
  const { t } = useI18n();

  // ── Cancelled / drained (no answers) ───────────────────────────────────
  if (!toolCall.userQuestionAnswers) {
    return (
      <div className="my-2 px-3 py-2 rounded-lg border border-[var(--abu-border-subtle)] bg-[var(--abu-bg-muted)] text-xs text-[var(--abu-text-tertiary)]">
        <MessageSquare className="inline h-3.5 w-3.5 mr-1.5" />
        {t.userQuestion.cardTitle} — {t.userQuestion.cancelledLabel}
      </div>
    );
  }

  // ── Settled: left-aligned, integrated "your choices" card (agent side) ──
  const { answers } = toolCall.userQuestionAnswers;

  return (
    <div className="my-2 flex justify-start w-full">
      <div className="max-w-[460px] rounded-xl border border-[var(--abu-border)] bg-white px-3.5 py-3">
        <div className="flex items-center gap-1.5 mb-2 text-[11px] font-semibold text-[var(--abu-text-tertiary)]">
          <MessageSquare className="h-3.5 w-3.5 text-[var(--abu-clay)]" />
          {t.userQuestion.yourChoiceLabel}
        </div>
        <div className="divide-y divide-[var(--abu-border-subtle)]">
          {answers.map((ans, i) => (
            <div key={i} className="py-1.5 first:pt-0 last:pb-0">
              <p className="text-[12px] text-[var(--abu-text-tertiary)] mb-0.5 break-words">{ans.question}</p>
              <p className="text-[13.5px] font-semibold text-[var(--abu-text-primary)] break-words">
                {ans.selected.join('、')}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
