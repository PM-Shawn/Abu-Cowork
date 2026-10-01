import { useEffect, useState } from 'react';
import { Button } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Pressable } from '@/components/ds/pressable';
import { Spinner } from '@/components/ds/spinner';
import { StatusIcon } from '@/components/ds/status-icon';
import { Tag } from '@/components/ds/tag';
import { useI18n, format } from '@/i18n';
import { useVisibleTeams } from '@/core/team/useVisibleTeams';
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

/**
 * The still mark of a member or a hand-off. The dot sits in a box as wide as a
 * small icon, so the words after any mark, and after a spinner, share one column.
 */
function DispatchMark({ status }: { status: DispatchStatus | 'idle' }) {
  if (status === 'running') return <Icon icon={AppIcons.loading} size="sm" className="text-label-tertiary" />;
  if (status === 'completed') return <StatusIcon tone="success" size="sm" />;
  if (status === 'error') return <StatusIcon tone="danger" size="sm" />;
  return (
    <span aria-hidden="true" className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
      <span className="h-2 w-2 rounded-full border border-control-border" />
    </span>
  );
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
  const teams = useVisibleTeams();
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
        <p className="text-ui-sm text-label-tertiary">{t.workspace.teamNotPinned}</p>
      </div>
    );
  }

  const defOf = (name: string) => memberDefByName(team, name);
  const teamAvatar = teams.find((entry) => entry.id === team.teamId)?.avatar;
  const runningCount = members.filter((member) => member.status === 'running').length;

  return (
    <div className="h-full overflow-auto p-5" data-testid="team-tab">
      <div className="mx-auto max-w-3xl space-y-4">
        <header className="rounded-panel border border-separator bg-surface p-4">
          <div className="flex items-center gap-2 text-ui font-medium text-label">
            <TeamAvatar avatar={teamAvatar} size="sm" />
            <span className="truncate">{team.teamName}</span>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <AgentAvatar agent={defOf(team.leader.name)} size="lg" round />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-ui text-label">
                <span className="truncate">{team.leader.name}</span>
                <Tag>{t.workspace.teamLeaderBadge}</Tag>
              </div>
              {/* One height for both states, so the card does not grow when the leader starts. */}
              <div className="flex h-5 items-center">
                {leaderRunning ? (
                  <Spinner size="sm" label={t.workspace.agentStatusRunning} />
                ) : (
                  <span className="inline-flex items-center gap-2 text-caption text-label-tertiary">
                    <DispatchMark status="idle" />
                    {t.workspace.teamLeaderIdle}
                  </span>
                )}
              </div>
            </div>
          </div>
        </header>

        <section className="overflow-hidden rounded-panel border border-separator">
          <div className="flex items-center gap-2 border-b border-separator px-4 py-2 text-ui font-medium text-label">
            <span>{format(t.workspace.teamMembersHeader, { count: members.length })}</span>
            {runningCount > 0 && (
              <Spinner size="sm" labelHidden label={format(t.batch.batchStatusRunningCount, { n: runningCount })} />
            )}
          </div>
          {members.length === 0 ? (
            <p className="px-4 py-3 text-ui-sm text-label-tertiary">{t.workspace.teamNoMembers}</p>
          ) : (
            <ul className="divide-y divide-separator">
              {members.map((member) => (
                <li key={member.agent} className="flex items-start gap-3 px-4 py-3" data-testid="team-member-row">
                  <AgentAvatar agent={defOf(member.agent)} size="lg" round />
                  {/* The hand-offs sit in the name's column, next to the avatar. */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-ui text-label">{member.agent}</div>
                        <div className="flex flex-wrap items-center gap-x-2 text-caption text-label-tertiary">
                          <span className="inline-flex items-center gap-1"><DispatchMark status={member.status} />{statusLabel(member.status, t)}</span>
                          <span>{member.dispatches.length > 0 ? format(t.workspace.teamDispatchCount, { n: member.dispatches.length }) : t.workspace.teamNoDispatchYet}</span>
                        </div>
                      </div>
                      <Button
                        variant="plain"
                        size="sm"
                        icon={AppIcons.appendInstruction}
                        onClick={() => appendInstruction(member.agent)}
                        title={t.workspace.teamAppendInstruction}
                      >
                        {t.workspace.teamAppendInstruction}
                      </Button>
                    </div>
                    {member.dispatches.length > 0 && (
                      <ul className="mt-2 space-y-1">
                        {member.dispatches.map((d, index) => {
                          const stalled = stalledMinutes(d);
                          return (
                            <li key={d.key}>
                              <Pressable
                                onClick={() => openSubagent(d.identity, d.taskIndex, member.agent)}
                                className="flex w-full items-center gap-2 rounded-control px-2 py-1 text-left text-caption hover:bg-fill-hover"
                                aria-label={format(t.workspace.teamOpenDispatch, { n: index + 1, label: d.label })}
                              >
                                <DispatchMark status={d.status} />
                                <span className="shrink-0 text-label-tertiary">{format(t.workspace.teamDispatchOrdinal, { n: index + 1 })}</span>
                                <span className="min-w-0 flex-1 truncate text-label">{d.label}</span>
                                {stalled !== null && (
                                  <span className="inline-flex shrink-0 items-center gap-1" data-testid="dispatch-stalled">
                                    <StatusIcon tone="warning" size="sm" />
                                    <span className="text-warning">{format(t.workspace.teamStalledFor, { n: stalled })}</span>
                                  </span>
                                )}
                                <span className="shrink-0 text-label-tertiary">{format(t.workspace.agentTools, { count: d.stepCount })}</span>
                                <Icon icon={AppIcons.disclose} size="sm" className="text-label-tertiary" />
                              </Pressable>
                              {d.live && d.status === 'running' && (
                                <div className="mt-1">
                                  <Button
                                    variant="secondary"
                                    size="sm"
                                    icon={AppIcons.stop}
                                    onClick={() => requestDispatchCancel(d.key)}
                                    aria-label={format(t.workspace.teamStopDispatch, { member: member.agent })}
                                    title={format(t.workspace.teamStopDispatch, { member: member.agent })}
                                  >
                                    {t.workspace.teamStopDispatchShort}
                                  </Button>
                                </div>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
