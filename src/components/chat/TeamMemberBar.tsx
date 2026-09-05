import { Check, Loader2, XCircle, Square } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n, format } from '@/i18n';
import { usePreviewStore } from '@/stores/previewStore';
import { memberDefByName, useTeamDispatches } from '@/components/team/useTeamDispatches';
import { requestDispatchCancel } from '@/core/agent/dispatchCancel';
import AgentAvatar from '@/components/common/AgentAvatar';

/**
 * WorkBuddy-style member strip under the transcript: leader chip + one chip per
 * member with a status mark. A member chip opens its latest process tab; the
 * leader chip opens the team overview tab.
 */
export default function TeamMemberBar({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  const openSubagent = usePreviewStore((s) => s.openSubagent);
  const openTeam = usePreviewStore((s) => s.openTeam);
  const { team, members } = useTeamDispatches(conversationId);

  if (!team) return null;
  const defOf = (name: string) => memberDefByName(team, name);
  const chip = 'inline-flex max-w-[180px] items-center gap-1 rounded-full border border-[var(--abu-border-subtle)] bg-[var(--abu-bg-base)] px-2 py-0.5 text-caption text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)] transition-colors';

  return (
    <div className="flex flex-wrap items-center gap-1.5 px-3 py-1.5" data-testid="team-member-bar" aria-label={t.workspace.teamTitle}>
      <button type="button" className={chip} onClick={() => openTeam(conversationId)} title={t.workspace.teamOpenOverview}>
        <AgentAvatar agent={defOf(team.leader.name)} size="xs" round />
        <span className="truncate">{team.leader.name}</span>
        <span className="text-[var(--abu-text-tertiary)]">{t.workspace.teamLeaderBadge}</span>
      </button>
      {members.map((member) => (
        <button
          key={member.agent}
          type="button"
          className={cn(chip, member.status === 'running' && 'border-[var(--abu-clay)]')}
          onClick={() => (member.latest ? openSubagent(member.latest.identity, member.latest.taskIndex, member.agent) : openTeam(conversationId))}
          title={member.latest ? format(t.workspace.teamDispatchCount, { n: member.dispatches.length }) : t.workspace.teamNoDispatchYet}
          data-status={member.status}
        >
          <AgentAvatar agent={defOf(member.agent)} size="xs" round />
          <span className="truncate">{member.agent}</span>
          {member.status === 'running' && <Loader2 aria-hidden="true" className="h-3 w-3 text-[var(--abu-clay)] motion-safe:animate-spin" />}
          {member.status === 'completed' && <Check aria-hidden="true" className="h-3 w-3 text-[var(--abu-success)]" />}
          {member.status === 'error' && <XCircle aria-hidden="true" className="h-3 w-3 text-[var(--abu-danger)]" />}
        </button>
      ))}
      {members.map((m) => ({ m, running: m.dispatches.find((d) => d.live && d.status === 'running') })).filter((x) => x.running).map(({ m, running }) => (
        <button
          key={`stop-${m.agent}`}
          type="button"
          onClick={() => running && requestDispatchCancel(running.key)}
          aria-label={format(t.workspace.teamStopDispatch, { member: m.agent })}
          title={format(t.workspace.teamStopDispatch, { member: m.agent })}
          className="inline-flex items-center gap-1 rounded-full border border-[var(--abu-border-subtle)] px-2 py-0.5 text-caption text-[var(--abu-text-muted)] hover:bg-[var(--abu-danger-bg)] hover:text-[var(--abu-danger)]"
        >
          <Square aria-hidden="true" className="h-3 w-3" />
          <span className="truncate">{format(t.workspace.teamStopDispatchShortNamed, { member: m.agent })}</span>
        </button>
      ))}
    </div>
  );
}
