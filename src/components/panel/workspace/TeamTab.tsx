import { useMemo } from 'react';
import { Check, ChevronRight, Loader2, Users, XCircle, CircleDashed } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n, format } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { useTeamStore } from '@/stores/teamStore';
import { useTaskExecutionStore } from '@/stores/taskExecutionStore';
import { usePreviewStore } from '@/stores/previewStore';
import { resolveTeamRouteContext } from '@/core/team/teamRouteResolver';
import { collectMemberDispatches, summarizeByMember, type DispatchStatus, type MemberSummary } from '@/components/team/teamDispatches';

function StatusIcon({ status }: { status: DispatchStatus | 'idle' }) {
  if (status === 'running') return <Loader2 aria-hidden="true" className="h-3.5 w-3.5 text-[var(--abu-clay)] motion-safe:animate-spin" />;
  if (status === 'completed') return <Check aria-hidden="true" className="h-3.5 w-3.5 text-[var(--abu-success)]" />;
  if (status === 'error') return <XCircle aria-hidden="true" className="h-3.5 w-3.5 text-[var(--abu-danger)]" />;
  return <CircleDashed aria-hidden="true" className="h-3.5 w-3.5 text-[var(--abu-text-muted)]" />;
}

function statusLabel(status: DispatchStatus | 'idle', t: ReturnType<typeof useI18n>['t']): string {
  switch (status) {
    case 'running': return t.workspace.agentStatusRunning;
    case 'completed': return t.workspace.agentStatusDone;
    case 'error': return t.workspace.agentStatusError;
    case 'idle': return t.workspace.teamMemberIdle;
    default: return t.workspace.agentStatusIncomplete;
  }
}

/**
 * Team overview for a team-pinned conversation (design §2.6): the leader and
 * every member with its latest status and hand-offs; a hand-off opens the
 * member's read-only process tab.
 */
export default function TeamTab({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  const teamId = useChatStore((s) => s.conversations[conversationId]?.teamId);
  const messages = useChatStore((s) => s.conversations[conversationId]?.messages);
  const teams = useTeamStore((s) => s.teams);
  const executions = useTaskExecutionStore((s) => s.executions);
  const openSubagent = usePreviewStore((s) => s.openSubagent);

  const team = useMemo(() => resolveTeamRouteContext(teamId), [teamId, teams]); // eslint-disable-line react-hooks/exhaustive-deps
  const dispatches = useMemo(
    () => collectMemberDispatches({ conversationId, executions: Object.values(executions), messages: messages ?? [] }),
    [conversationId, executions, messages],
  );
  const members: MemberSummary[] = useMemo(
    () => summarizeByMember(team?.members.map((m) => m.name) ?? [], dispatches),
    [team, dispatches],
  );

  if (!team) {
    return (
      <div className="h-full overflow-auto p-5">
        <p className="text-minor text-[var(--abu-text-muted)]">{t.workspace.teamNotPinned}</p>
      </div>
    );
  }

  const leaderRunning = Object.values(executions).some((exec) => exec.conversationId === conversationId && exec.status === 'running');
  const avatarOf = (name: string): string => {
    const def = name === team.leader.name ? team.leader : team.members.find((m) => m.name === name);
    return def?.avatar?.trim() || '🤖';
  };

  return (
    <div className="h-full overflow-auto p-5" data-testid="team-tab">
      <div className="mx-auto max-w-3xl space-y-4">
        <header className="rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-muted)] p-4">
          <div className="flex items-center gap-2 text-body font-medium text-[var(--abu-text-primary)]">
            <Users aria-hidden="true" className="h-4 w-4 shrink-0" strokeWidth={1.5} />
            <span className="truncate">{team.teamName}</span>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <span aria-hidden="true" className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--abu-bg-base)] text-body">{avatarOf(team.leader.name)}</span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-body text-[var(--abu-text-primary)]">
                <span className="truncate">{team.leader.name}</span>
                <span className="rounded-md bg-[var(--abu-bg-base)] px-1.5 py-0.5 text-caption text-[var(--abu-text-tertiary)]">{t.workspace.teamLeaderBadge}</span>
              </div>
              <div className="flex items-center gap-1 text-caption text-[var(--abu-text-muted)]">
                <StatusIcon status={leaderRunning ? 'running' : 'idle'} />
                <span>{leaderRunning ? t.workspace.agentStatusRunning : t.workspace.teamLeaderIdle}</span>
              </div>
            </div>
          </div>
        </header>

        <section className="rounded-lg border border-[var(--abu-border)] overflow-hidden">
          <div className="border-b border-[var(--abu-border-subtle)] px-4 py-2 text-minor font-medium text-[var(--abu-text-primary)]">
            {format(t.workspace.teamMembersHeader, { count: members.length })}
          </div>
          {members.length === 0 ? (
            <p className="px-4 py-3 text-minor text-[var(--abu-text-muted)]">{t.workspace.teamNoMembers}</p>
          ) : (
            <ul className="divide-y divide-[var(--abu-border-subtle)]">
              {members.map((member) => (
                <li key={member.agent} className="px-4 py-3" data-testid="team-member-row">
                  <div className="flex items-center gap-3">
                    <span aria-hidden="true" className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--abu-bg-muted)] text-body">{avatarOf(member.agent)}</span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-body text-[var(--abu-text-primary)]">{member.agent}</div>
                      <div className="flex flex-wrap items-center gap-x-2 text-caption text-[var(--abu-text-muted)]">
                        <span className="inline-flex items-center gap-1"><StatusIcon status={member.status} />{statusLabel(member.status, t)}</span>
                        <span>{member.dispatches.length > 0 ? format(t.workspace.teamDispatchCount, { n: member.dispatches.length }) : t.workspace.teamNoDispatchYet}</span>
                      </div>
                    </div>
                  </div>
                  {member.dispatches.length > 0 && (
                    <ul className="mt-2 space-y-1 pl-11">
                      {member.dispatches.map((d, index) => (
                        <li key={d.key}>
                          <button
                            type="button"
                            onClick={() => openSubagent(d.identity, d.taskIndex, member.agent)}
                            className={cn(
                              'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-caption hover:bg-[var(--abu-bg-hover)]',
                              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--abu-focus-ring)]',
                            )}
                            aria-label={format(t.workspace.teamOpenDispatch, { n: index + 1, label: d.label })}
                          >
                            <StatusIcon status={d.status} />
                            <span className="shrink-0 text-[var(--abu-text-tertiary)]">{format(t.workspace.teamDispatchOrdinal, { n: index + 1 })}</span>
                            <span className="min-w-0 flex-1 truncate text-[var(--abu-text-primary)]">{d.label}</span>
                            <span className="shrink-0 text-[var(--abu-text-muted)]">{format(t.workspace.agentTools, { count: d.stepCount })}</span>
                            <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-[var(--abu-text-muted)]" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
