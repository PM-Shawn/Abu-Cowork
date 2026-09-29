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

import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
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
      <div className="my-2 flex items-center gap-2 rounded-panel border border-separator bg-surface px-3 py-2 text-ui-sm text-label-tertiary">
        <Icon icon={AppIcons.conversation} size="sm" />
        <span>{t.userQuestion.cardTitle} — {t.userQuestion.cancelledLabel}</span>
      </div>
    );
  }

  // ── Settled: left-aligned, integrated "your choices" card (agent side) ──
  const { answers } = toolCall.userQuestionAnswers;

  return (
    <div className="my-2 flex w-full justify-start">
      <div className="w-full max-w-115 rounded-panel border border-separator bg-surface px-4 py-3">
        <div className="mb-2 flex items-center gap-2 text-ui-sm font-medium text-label-tertiary">
          <Icon icon={AppIcons.conversation} size="sm" className="text-label-secondary" />
          {t.userQuestion.yourChoiceLabel}
        </div>
        <div className="divide-y divide-separator">
          {answers.map((ans, i) => (
            <div key={i} className="py-2 first:pt-0 last:pb-0">
              <p className="mb-1 break-words text-ui-sm text-label-tertiary">{ans.question}</p>
              <p className="break-words text-ui font-medium text-label">
                {ans.selected.join('、')}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
