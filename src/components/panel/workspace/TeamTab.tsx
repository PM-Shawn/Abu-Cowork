import { useEffect, useState } from 'react';
import { Check, ChevronRight, Loader2, XCircle, CircleDashed, Square, MessageSquarePlus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n, format } from '@/i18n';
import { useTeamStore } from '@/stores/teamStore';
import { useTaskExecutionStore } from '@/stores/taskExecutionStore';
import { usePreviewStore } from '@/stores/previewStore';
import AgentAvatar from '@/components/common/AgentAvatar';
import TeamAvatar from '@/components/team/TeamAvatar';
import type { DispatchStatus } from '@/components/team/teamDispatches';
import { memberDefByName, useTeamDispatches } from '@/components/team/useTeamDispatches';
import { requestDispatchCancel } from '@/core/agent/dispatchCancel';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import { appendToComposerDraft, getComposerDraftKey, getComposerDraftScopeForEnterpriseMode } from '@/stores/composerDraftStore';

/** Minutes without a new step before a running hand-off is called out as stalled. */
export const STALL_MINUTES = 5;

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
    case 'interrupted': return t.workspace.teamDispatchInterrupted;
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
  const teams = useTeamStore((s) => s.teams);
  const leaderRunning = useTaskExecutionStore((s) => {
    for (const exec of Object.values(s.executions)) {
      if (exec.conversationId === conversationId && exec.status === 'running') return true;
    }
    return false;
  });
  const openSubagent = usePreviewStore((s) => s.openSubagent);
  const { team, dispatches, members } = useTeamDispatches(conversationId);
  const draftScope = useEnterpriseStore((state) => getComposerDraftScopeForEnterpriseMode(state.mode));
  const appendInstruction = (member: string) => {
    const text = format(t.team.followUpMemberAppend, { member });
    appendToComposerDraft(getComposerDraftKey(conversationId, draftScope), text);
  };

  // Stall hint: a running hand-off with no new step for a while.
  const anyRunning = dispatches.some((d) => d.live && d.status === 'running');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!anyRunning) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    setNow(Date.now());
    return () => window.clearInterval(timer);
  }, [anyRunning]);
  const stalledMinutes = (d: { live: boolean; status: DispatchStatus; lastActivityAt?: number }): number | null => {
    if (!d.live || d.status !== 'running' || d.lastActivityAt === undefined) return null;
    const minutes = Math.floor((now - d.lastActivityAt) / 60_000);
    return minutes >= STALL_MINUTES ? minutes : null;
  };

  if (!team) {
    return (
      <div className="h-full overflow-auto p-5">
        <p className="text-minor text-[var(--abu-text-muted)]">{t.workspace.teamNotPinned}</p>
      </div>
    );
  }

  const defOf = (name: string) => memberDefByName(team, name);
  const teamAvatar = teams.find((entry) => entry.id === team.teamId)?.avatar;

  return (
    <div className="h-full overflow-auto p-5" data-testid="team-tab">
      <div className="mx-auto max-w-3xl space-y-4">
        <header className="rounded-lg border border-[var(--abu-border)] bg-[var(--abu-bg-muted)] p-4">
          <div className="flex items-center gap-2 text-body font-medium text-[var(--abu-text-primary)]">
            <TeamAvatar avatar={teamAvatar} size="sm" />
            <span className="truncate">{team.teamName}</span>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <AgentAvatar agent={defOf(team.leader.name)} size="lg" round />
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
                    <AgentAvatar agent={defOf(member.agent)} size="lg" round />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-body text-[var(--abu-text-primary)]">{member.agent}</div>
                      <div className="flex flex-wrap items-center gap-x-2 text-caption text-[var(--abu-text-muted)]">
                        <span className="inline-flex items-center gap-1"><StatusIcon status={member.status} />{statusLabel(member.status, t)}</span>
                        <span>{member.dispatches.length > 0 ? format(t.workspace.teamDispatchCount, { n: member.dispatches.length }) : t.workspace.teamNoDispatchYet}</span>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => appendInstruction(member.agent)}
                      className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-caption text-[var(--abu-text-tertiary)] hover:bg-[var(--abu-bg-hover)] hover:text-[var(--abu-text-primary)]"
                      title={t.workspace.teamAppendInstruction}
                    >
                      <MessageSquarePlus aria-hidden="true" className="h-3.5 w-3.5" />
                      {t.workspace.teamAppendInstruction}
                    </button>
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
                            {stalledMinutes(d) !== null && (
                              <span className="shrink-0 text-[var(--abu-warning)]" data-testid="dispatch-stalled">{format(t.workspace.teamStalledFor, { n: stalledMinutes(d) ?? 0 })}</span>
                            )}
                            <span className="shrink-0 text-[var(--abu-text-muted)]">{format(t.workspace.agentTools, { count: d.stepCount })}</span>
                            <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-[var(--abu-text-muted)]" />
                          </button>
                          {d.live && d.status === 'running' && (
                            <button
                              type="button"
                              onClick={() => requestDispatchCancel(d.key)}
                              aria-label={format(t.workspace.teamStopDispatch, { member: member.agent })}
                              title={format(t.workspace.teamStopDispatch, { member: member.agent })}
                              className="mt-1 inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-caption text-[var(--abu-text-muted)] hover:bg-[var(--abu-danger-bg)] hover:text-[var(--abu-danger)]"
                            >
                              <Square aria-hidden="true" className="h-3 w-3" />
                              {t.workspace.teamStopDispatchShort}
                            </button>
                          )}
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
