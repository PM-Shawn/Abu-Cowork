import { useMemo } from 'react';
import { useI18n, format } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { useTeamStore } from '@/stores/teamStore';
import { useTaskExecutionStore } from '@/stores/taskExecutionStore';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import { getComposerDraftKey, getComposerDraftScopeForEnterpriseMode, updateComposerDraft } from '@/stores/composerDraftStore';
import { resolveTeamRouteContext } from '@/core/team/teamRouteResolver';
import { collectMemberDispatches } from '@/components/team/teamDispatches';

const MAX_STEP_CHIPS = 5;

/**
 * After the leader's turn ends, offer the two follow-ups people otherwise do
 * not know they can ask for: redo one step, or have one member revise. A chip
 * drops its text into the composer (nothing is sent).
 */
export default function TeamFollowUpChips({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  const conversation = useChatStore((s) => s.conversations[conversationId]);
  const teams = useTeamStore((s) => s.teams);
  const executions = useTaskExecutionStore((s) => s.executions);
  const draftScope = useEnterpriseStore((state) => getComposerDraftScopeForEnterpriseMode(state.mode));

  const team = useMemo(() => resolveTeamRouteContext(conversation?.teamId), [conversation?.teamId, teams]); // eslint-disable-line react-hooks/exhaustive-deps
  const chips = useMemo(() => {
    if (!team || !conversation || conversation.status === 'running') return [];
    const messages = conversation.messages;
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant' || last.isStreaming) return [];
    const lastPlan = [...messages].reverse().find((m) => m.role === 'assistant' && (m.plannedSteps?.length ?? 0) > 0)?.plannedSteps ?? [];
    const dispatched = new Set(
      collectMemberDispatches({ conversationId, executions: Object.values(executions), messages }).map((d) => d.agent),
    );
    const stepChips = lastPlan.slice(0, MAX_STEP_CHIPS).map((step) => ({
      key: `step-${step.index}`,
      label: format(t.team.followUpRedoStep, { n: step.index }),
      text: `${format(t.team.followUpRedoStep, { n: step.index })}：`,
      title: step.description,
    }));
    const memberChips = team.members
      .filter((m) => dispatched.has(m.name))
      .map((m) => ({
        key: `member-${m.name}`,
        label: format(t.team.followUpMemberRevise, { member: m.name }),
        text: `${format(t.team.followUpMemberRevise, { member: m.name })}：`,
        title: m.description,
      }));
    return [...stepChips, ...memberChips];
  }, [team, conversation, conversationId, executions, t]);

  if (chips.length === 0) return null;
  const draftKey = getComposerDraftKey(conversationId, draftScope);
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-3 pb-1" data-testid="team-follow-up-chips">
      <span className="text-caption text-[var(--abu-text-muted)]">{t.team.followUpHint}</span>
      {chips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          title={chip.title}
          onClick={() => updateComposerDraft(draftKey, (draft) => ({ ...draft, text: draft.text.trim() ? `${draft.text.trimEnd()} ${chip.text}` : chip.text }))}
          className="rounded-full border border-[var(--abu-border-subtle)] bg-[var(--abu-bg-base)] px-2 py-0.5 text-caption text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)] transition-colors"
        >
          {chip.label}
        </button>
      ))}
    </div>
  );
}
