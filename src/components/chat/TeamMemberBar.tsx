import { memo, useCallback, useState } from 'react';
import { useI18n, format } from '@/i18n';
import type { TranslationDict } from '@/i18n/types';
import { usePreviewStore } from '@/stores/previewStore';
import { usePluginStore } from '@/stores/pluginStore';
import { memberDefByName, useTeamDispatches } from '@/components/team/useTeamDispatches';
import { requestDispatchCancel } from '@/core/agent/dispatchCancel';
import AgentAvatar from '@/components/common/AgentAvatar';
import { Button, IconButton } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Pressable } from '@/components/ds/pressable';
import { StatusIcon } from '@/components/ds/status-icon';

const CHIP = 'inline-flex h-6 max-w-45 items-center gap-1 rounded-control border border-separator bg-surface px-2 text-caption text-label transition-colors duration-fast hover:bg-fill-hover';

/**
 * Pill that reports how many stored team members no longer resolve to a live
 * agent. Rendered identically whether the strip is collapsed or expanded —
 * per brief D3 it is also the way out: opening the team panel is where a
 * member gets removed or replaced.
 */
function UnresolvedMembersPill({ t, unresolved, onOpen }: { t: TranslationDict; unresolved: number; onOpen: () => void }) {
  if (unresolved <= 0) return null;
  return (
    <Pressable
      className="inline-flex h-6 items-center gap-1 rounded-control border border-separator px-2 text-caption text-danger transition-colors duration-fast hover:bg-fill-hover"
      onClick={onOpen}
      title={t.workspace.teamMemberBarUnresolvedHint}
      data-testid="team-member-bar-unresolved"
    >
      <StatusIcon tone="danger" size="sm" />
      {unresolved === 1 ? t.workspace.teamMemberBarUnresolvedOne : format(t.workspace.teamMemberBarUnresolved, { n: unresolved })}
    </Pressable>
  );
}

/**
 * The collapse control carries a tooltip, and the bar re-renders on every
 * streamed token (it reads the conversation's messages). Memoized with a
 * stable toggle so the tooltip is left alone while text streams.
 */
const CollapseToggle = memo(function CollapseToggle({ collapsed, onToggle, expandLabel, collapseLabel }: {
  collapsed: boolean;
  onToggle: () => void;
  expandLabel: string;
  collapseLabel: string;
}) {
  return (
    <IconButton
      size="sm"
      icon={collapsed ? AppIcons.expand : AppIcons.collapse}
      label={collapsed ? expandLabel : collapseLabel}
      aria-expanded={!collapsed}
      onClick={onToggle}
    />
  );
});

// The bar's running marks stand still: the step block in the chat above holds
// the one spinner for the hand-off that is running.
function RunningMark() {
  return <Icon icon={AppIcons.loading} size="sm" className="text-label-tertiary" />;
}

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
  // Before plugin records are ready every file-backed expert fails to resolve
  // (launch, a plugin install), so "unavailable" would be a false claim then.
  const pluginRecordsReady = usePluginStore((s) => s.activationReady);
  // Collapsed = leader chip + a "{n} members" pill (running mark kept so
  // activity stays visible). Session-local on purpose: it is a glance control,
  // not a preference.
  const [collapsed, setCollapsed] = useState(false);
  const toggleCollapsed = useCallback(() => setCollapsed((value) => !value), []);

  if (!team) return null;
  const defOf = (name: string) => memberDefByName(team, name);
  const anyRunning = members.some((member) => member.status === 'running');
  const unresolved = pluginRecordsReady ? (team.unresolvedMemberRoleIds?.length ?? 0) : 0;
  const toggle = (
    <CollapseToggle
      collapsed={collapsed}
      onToggle={toggleCollapsed}
      expandLabel={t.workspace.teamMemberBarExpand}
      collapseLabel={t.workspace.teamMemberBarCollapse}
    />
  );
  const leaderChip = (
    <Pressable className={CHIP} onClick={() => openTeam(conversationId)} title={t.workspace.teamOpenOverview}>
      <AgentAvatar agent={defOf(team.leader.name)} size="xs" round />
      <span className="truncate">{team.leader.name}</span>
      <span className="text-label-tertiary">{t.workspace.teamLeaderBadge}</span>
    </Pressable>
  );

  if (collapsed) {
    return (
      <div className="flex flex-wrap items-center gap-2 px-3 py-2" data-testid="team-member-bar" data-collapsed="true" aria-label={t.workspace.teamTitle}>
        {leaderChip}
        <Pressable className={CHIP} onClick={() => openTeam(conversationId)} title={t.workspace.teamOpenOverview}>
          <span className="truncate">{members.length === 1 ? t.workspace.teamMemberBarCollapsedOne : format(t.workspace.teamMemberBarCollapsed, { n: members.length })}</span>
          {anyRunning && <RunningMark />}
        </Pressable>
        <UnresolvedMembersPill t={t} unresolved={unresolved} onOpen={() => openTeam(conversationId)} />
        {toggle}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2" data-testid="team-member-bar" aria-label={t.workspace.teamTitle}>
      {leaderChip}
      {members.map((member) => (
        <Pressable
          key={member.agent}
          className={CHIP}
          onClick={() => (member.latest ? openSubagent(member.latest.identity, member.latest.taskIndex, member.agent) : openTeam(conversationId))}
          title={member.latest ? format(t.workspace.teamDispatchCount, { n: member.dispatches.length }) : t.workspace.teamNoDispatchYet}
          data-status={member.status}
        >
          <AgentAvatar agent={defOf(member.agent)} size="xs" round />
          <span className="truncate">{member.agent}</span>
          {member.status === 'running' && <RunningMark />}
          {member.status === 'completed' && <StatusIcon tone="success" size="sm" />}
          {member.status === 'error' && <StatusIcon tone="danger" size="sm" />}
        </Pressable>
      ))}
      <UnresolvedMembersPill t={t} unresolved={unresolved} onOpen={() => openTeam(conversationId)} />
      {members.map((m) => ({ m, running: m.dispatches.find((d) => d.live && d.status === 'running') })).filter((x) => x.running).map(({ m, running }) => (
        <Button
          key={`stop-${m.agent}`}
          variant="secondary"
          size="sm"
          icon={AppIcons.stop}
          onClick={() => running && requestDispatchCancel(running.key)}
          aria-label={format(t.workspace.teamStopDispatch, { member: m.agent })}
          title={format(t.workspace.teamStopDispatch, { member: m.agent })}
        >
          <span className="truncate">{format(t.workspace.teamStopDispatchShortNamed, { member: m.agent })}</span>
        </Button>
      ))}
      {toggle}
    </div>
  );
}
