import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useSettingsStore, type TeamTab } from '@/stores/settingsStore';
import { useTeamStore, type Team } from '@/stores/teamStore';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { agentRegistry } from '@/core/agent/registry';
import { ensureRoleId, effectiveRoleId } from '@/core/team/roleIdentity';
import { useI18n, format } from '@/i18n';
import { Bot, UsersRound, Search } from 'lucide-react';
import TopTabNav from '@/components/toolbox/TopTabNav';
import DialogShell from './DialogShell';
import TeamAvatar from './TeamAvatar';
import AgentAvatar from '@/components/common/AgentAvatar';
import ConfirmDialog from '@/components/common/ConfirmDialog';
import ToolboxCreateMenu from '@/components/toolbox/ToolboxCreateMenu';
import AgentsSection from '@/components/customize/AgentsSection';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Toggle } from '@/components/ui/toggle';
import { SearchSelect, MultiSearchSelect, type SearchSelectOption } from '@/components/ui/search-select';
import type { SubagentDefinition } from '@/types';

/**
 * 团队 view (R1: management surface — PRD docs/abu-team-prd-v2.md).
 *
 * Design language mirrors ToolboxView exactly: TopTabNav below chrome, search
 * + create on the right, no page title, no manual refresh (stores are the
 * single source and re-render on change). Two tabs: 队员 · 团队 — work is
 * handed to a team inside a conversation (@团队), not from a task board.
 *
 * 队员 tab reuses AgentsSection — a 队员 IS a custom agent (single identity
 * source), which also inherits the toolbox's IME-safe editors for free.
 */

function EmptyState({ icon: Icon, title, hint, action }: {
  icon: typeof UsersRound; title: string; hint?: string; action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-2 text-center px-8">
      <Icon className="h-8 w-8 text-[var(--abu-text-tertiary)]" strokeWidth={1.5} />
      <div className="text-body font-medium text-[var(--abu-text-secondary)]">{title}</div>
      {hint && <div className="text-caption text-[var(--abu-text-tertiary)] max-w-sm">{hint}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/**
 * Selectable member pool: every enabled agent — user-defined AND enabled
 * marketplace/builtin roles (user feedback 2026-08-31: office users组队 most
 * often start from 市场 roles). Disabled agents stay out.
 */
function useMemberPool(): SubagentDefinition[] {
  const { agents } = useDiscoveryStore();
  const disabledAgents = useSettingsStore((s) => s.disabledAgents);
  const [full, setFull] = useState<SubagentDefinition[]>([]);
  useEffect(() => {
    const disabled = new Set(disabledAgents ?? []);
    const list: SubagentDefinition[] = [];
    for (const meta of agents) {
      const a = agentRegistry.getAgent(meta.name);
      if (!a) continue;
      if (a.name === 'abu' || a.managed || disabled.has(a.name)) continue;
      list.push(a);
    }
    setFull(list);
  }, [agents, disabledAgents]);
  return full;
}

function roleLabel(agents: SubagentDefinition[], roleId: string, fallback: string): string {
  return agents.find((a) => effectiveRoleId(a) === roleId)?.name ?? fallback;
}

function memberOption(a: SubagentDefinition): SearchSelectOption {
  return { value: a.name, label: a.name, description: a.description || undefined, icon: <AgentAvatar agent={a} size="sm" /> };
}

// ---------------------------------------------------------------- Team dialog

function TeamEditDialog({ open, onClose, team, onSwitchToMembers }: {
  open: boolean; onClose: () => void; team: Team | null; onSwitchToMembers: () => void;
}) {
  const { t } = useI18n();
  const addToast = useToastStore((s) => s.addToast);
  const refresh = useDiscoveryStore((s) => s.refresh);
  const createTeam = useTeamStore((s) => s.createTeam);
  const updateTeam = useTeamStore((s) => s.updateTeam);
  const archiveTeam = useTeamStore((s) => s.archiveTeam);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const agents = useMemberPool();

  const [name, setName] = useState('');
  const [leaderName, setLeaderName] = useState<string>('');
  const [memberNames, setMemberNames] = useState<string[]>([]);
  const [leaderNote, setLeaderNote] = useState('');
  const [requireApproval, setRequireApproval] = useState(false);
  const [avatar, setAvatar] = useState('');
  const [saving, setSaving] = useState(false);
  // Members whose agent is disabled / deleted / managed cannot be shown in the
  // picker, but they are still part of the team: keep their roleIds and write
  // them back on save instead of silently dropping them.
  const [hiddenMemberRoleIds, setHiddenMemberRoleIds] = useState<string[]>([]);
  // The pool refreshes (new array identity) whenever discovery re-runs — including
  // ensureRoleId's own refresh during save. Seed from it once per open, via a ref,
  // so a refresh never wipes what the user has typed.
  const agentsRef = useRef(agents);
  useEffect(() => { agentsRef.current = agents; }, [agents]);

  useEffect(() => {
    if (!open) return;
    const pool = agentsRef.current;
    if (team) {
      setName(team.name);
      setLeaderName(roleLabel(pool, team.leaderRoleId, ''));
      const members = team.memberRoleIds.filter((id) => id !== team.leaderRoleId);
      setMemberNames(members.map((id) => roleLabel(pool, id, '')).filter(Boolean));
      setHiddenMemberRoleIds(members.filter((id) => !roleLabel(pool, id, '')));
      setLeaderNote(team.leaderNote ?? '');
      setRequireApproval(team.requirePlanApproval === true);
      setAvatar(team.avatar ?? '');
    } else {
      setName(''); setLeaderName(''); setMemberNames([]); setHiddenMemberRoleIds([]); setLeaderNote(''); setRequireApproval(false); setAvatar('');
    }
  }, [open, team]);

  // A leader whose agent is currently hidden keeps its roleId; the team stays editable.
  const leaderKept = !leaderName && !!team?.leaderRoleId;
  const handleSave = async () => {
    if (!name.trim() || (!leaderName && !leaderKept) || saving) return;
    setSaving(true);
    try {
      // Resolve stable roleIds, writing them into AGENT.md on first use.
      const resolve = async (agentName: string): Promise<string> => {
        const agent = agentRegistry.getAgent(agentName);
        if (!agent) throw new Error(`agent not found: ${agentName}`);
        const { roleId, wrote } = await ensureRoleId(agent);
        if (wrote) await refresh();
        return roleId;
      };
      const leaderRoleId = leaderName ? await resolve(leaderName) : (team as Team).leaderRoleId;
      const memberRoleIds: string[] = [...hiddenMemberRoleIds.filter((id) => id !== leaderRoleId)];
      for (const n of memberNames) {
        if (n === leaderName) continue;
        memberRoleIds.push(await resolve(n));
      }
      if (team) {
        updateTeam(team.id, { name: name.trim(), leaderRoleId, memberRoleIds, leaderNote: leaderNote.trim() || undefined, requirePlanApproval: requireApproval, avatar: avatar.trim() || undefined });
        addToast({ type: 'success', title: t.team.teamSaved });
      } else {
        createTeam({ name: name.trim(), leaderRoleId, memberRoleIds, leaderNote: leaderNote.trim() || undefined, requirePlanApproval: requireApproval, avatar: avatar.trim() || undefined });
        addToast({ type: 'success', title: t.team.teamCreated });
      }
      onClose();
    } catch (err) {
      addToast({ type: 'error', title: t.team.teamSaveFailed, message: String(err) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <DialogShell open={open} onClose={onClose} title={team ? t.team.editTeam : t.team.newTeam} wide>
      <div className="space-y-4">
        <div>
          <label className="text-caption font-medium text-[var(--abu-text-secondary)]">{t.team.fieldName}</label>
          <div className="mt-1 flex items-center gap-2">
            <TeamAvatar avatar={avatar} size="lg" />
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t.team.fieldNamePlaceholder} className="flex-1" data-testid="team-name-input" />
            <Input
              value={avatar}
              onChange={(e) => setAvatar(e.target.value.slice(0, 4))}
              placeholder={t.team.fieldAvatarPlaceholder}
              aria-label={t.team.fieldAvatar}
              title={t.team.fieldAvatarHint}
              className="w-20 text-center"
              data-testid="team-avatar-input"
            />
          </div>
        </div>

        {agents.length === 0 ? (
          <div className="rounded-xl bg-[var(--abu-bg-muted)] px-4 py-3 flex items-center justify-between">
            <span className="text-caption text-[var(--abu-text-secondary)]">{t.team.noMembersYet}</span>
            {/* Never a dead end: creating the missing thing is one click away. */}
            <Button size="sm" variant="outline" onClick={() => { onClose(); onSwitchToMembers(); }}>{t.team.createMemberNow}</Button>
          </div>
        ) : (
          <>
            {/* Two separate dropdowns (user feedback 2026-08-31): a single
                crown-in-list picker made the leader choice easy to miss. */}
            <div>
              <label className="text-caption font-medium text-[var(--abu-text-secondary)]">{t.team.fieldLeader}</label>
              <div className="text-caption text-[var(--abu-text-tertiary)] mt-0.5">{t.team.fieldLeaderHint}</div>
              <SearchSelect
                className="mt-1.5"
                value={leaderName || null}
                onChange={(name) => {
                  setLeaderName(name);
                  setMemberNames((prev) => prev.filter((n) => n !== name));
                }}
                options={agents.map(memberOption)}
                placeholder={t.team.leaderPlaceholder}
                searchPlaceholder={t.team.searchPlaceholder}
                emptyText={t.team.pickerEmpty}
                testId="team-leader-select"
              />
            </div>
            <div>
              <label className="text-caption font-medium text-[var(--abu-text-secondary)]">{t.team.fieldMembers}</label>
              <div className="text-caption text-[var(--abu-text-tertiary)] mt-0.5">{t.team.fieldMembersHint}</div>
              <MultiSearchSelect
                className="mt-1.5"
                values={memberNames.filter((n) => n !== leaderName)}
                onChange={setMemberNames}
                options={agents.filter((a) => a.name !== leaderName).map(memberOption)}
                placeholder={t.team.membersPlaceholder}
                searchPlaceholder={t.team.searchPlaceholder}
                emptyText={t.team.pickerEmpty}
                testId="team-members-select"
              />
            </div>
          </>
        )}

        <div className="flex items-center justify-between rounded-xl bg-[var(--abu-bg-muted)] px-3 py-2.5">
          <div className="min-w-0 pr-3">
            <div className="text-body text-[var(--abu-text-primary)]">{t.team.fieldPlanApproval}</div>
            <div className="text-caption text-[var(--abu-text-tertiary)]">{t.team.fieldPlanApprovalHint}</div>
          </div>
          <Toggle checked={requireApproval} onChange={() => setRequireApproval((v) => !v)} size="md" />
        </div>

        <div>
          <label className="text-caption font-medium text-[var(--abu-text-secondary)]">{t.team.fieldLeaderNote}</label>
          {/* Tell the user exactly how this text is used — mechanism, not mystery. */}
          <div className="text-caption text-[var(--abu-text-tertiary)] mt-0.5">{t.team.fieldLeaderNoteHint}</div>
          <Textarea value={leaderNote} onChange={(e) => setLeaderNote(e.target.value)} rows={2} className="mt-1" placeholder={t.team.fieldLeaderNotePlaceholder} />
        </div>

        <div className="flex items-center gap-2 pt-1">
          {team && (
            <Button variant="ghost" className="text-[var(--abu-danger)]" onClick={() => setConfirmArchive(true)} data-testid="team-archive">
              {t.team.archiveTeamAction}
            </Button>
          )}
          <div className="flex-1" />
          <Button variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
          <Button onClick={handleSave} disabled={!name.trim() || (!leaderName && !leaderKept) || saving} data-testid="team-save">
            {team ? t.common.save : t.team.createTeamAction}
          </Button>
        </div>
        <ConfirmDialog
          open={confirmArchive}
          title={t.team.archiveTeamTitle}
          message={format(t.team.archiveTeamMessage, { name: team?.name ?? '' })}
          confirmText={t.team.archiveTeamAction}
          cancelText={t.common.cancel}
          variant="danger"
          onCancel={() => setConfirmArchive(false)}
          onConfirm={() => {
            if (team) archiveTeam(team.id);
            setConfirmArchive(false);
            addToast({ type: 'success', title: t.team.teamArchived });
            onClose();
          }}
        />
      </div>
    </DialogShell>
  );
}

// ---------------------------------------------------------------- Task dialog

function ArchivedTeams({ teams, open = false, className }: { teams: Team[]; open?: boolean; className?: string }) {
  const { t } = useI18n();
  if (teams.length === 0) return null;
  return (
    <details open={open} className={className}>
      <summary className="cursor-pointer text-caption text-[var(--abu-text-tertiary)] select-none px-1">
        {format(t.team.archivedSection, { count: String(teams.length) })}
      </summary>
      <div className="mt-2 space-y-2">
        {teams.map((team) => (
          <div key={team.id} className="flex items-center gap-3 rounded-xl bg-[var(--abu-bg-muted)] px-4 py-3 opacity-70">
            <TeamAvatar avatar={team.avatar} size="lg" className="opacity-70" />
            <div className="flex-1 min-w-0 text-body text-[var(--abu-text-secondary)] truncate">{team.name}</div>
            <Button size="sm" variant="outline" onClick={() => useTeamStore.getState().restoreTeam(team.id)}>{t.team.restoreTeamAction}</Button>
          </div>
        ))}
      </div>
    </details>
  );
}

export default function TeamView() {
  const { activeTeamTab: persistedTeamTab, setActiveTeamTab } = useSettingsStore();
  // A stale persisted value (e.g. the removed 'pipelines' tab) falls back to
  // the default tab instead of rendering an empty pane.
  const activeTeamTab: TeamTab = persistedTeamTab === 'teams' ? 'teams' : 'members';
  const { t } = useI18n();
  const teams = useTeamStore((s) => s.teams);
  const startNewConversation = useChatStore((s) => s.startNewConversation);
  const switchConversation = useChatStore((s) => s.switchConversation);
  const conversationIndex = useChatStore((s) => s.conversationIndex);
  const setPendingInput = useChatStore((s) => s.setPendingInput);
  const closeTeam = useSettingsStore((s) => s.closeTeam);

  const [search, setSearch] = useState('');
  // AgentsSection filters by the shared toolbox query — bind the members-tab
  // search box to it so typing actually filters (bug: local state was ignored).
  const toolboxSearchQuery = useSettingsStore((s) => s.toolboxSearchQuery);
  const setToolboxSearchQuery = useSettingsStore((s) => s.setToolboxSearchQuery);
  const [manualCreateTrigger, setManualCreateTrigger] = useState(0);
  const [teamDialog, setTeamDialog] = useState<{ open: boolean; team: Team | null }>({ open: false, team: null });

  useEffect(() => { setSearch(''); setToolboxSearchQuery(''); }, [activeTeamTab, setToolboxSearchQuery]);

  const activeTeams = useMemo(() => teams.filter((tm) => !tm.archivedAt), [teams]);
  const agents = useMemberPool();

  const navItems = [
    { id: 'members' as TeamTab, label: t.team.tabMembers, icon: Bot },
    { id: 'teams' as TeamTab, label: t.team.tabTeams, icon: UsersRound },
  ];

  // AI-create for 队员 reuses the toolbox idiom: jump to chat with a crafted prompt.
  const handleAICreateMember = () => {
    closeTeam();
    startNewConversation();
    setPendingInput(t.toolbox.aiCreateAgentPrompt);
  };

  const renderHeaderRight = () => {
    const isMembers = activeTeamTab === 'members';
    const searchBox = isMembers ? (
      <div className="relative w-52 shrink-0">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--abu-text-tertiary)] pointer-events-none" />
        <Input
          type="text"
          placeholder={t.team.searchPlaceholder}
          value={isMembers ? toolboxSearchQuery : search}
          onChange={(e) => (isMembers ? setToolboxSearchQuery(e.target.value) : setSearch(e.target.value))}
          className="h-8 pl-8 pr-3 text-body"
        />
      </div>
    ) : null;

    let createControl: ReactNode = null;
    if (activeTeamTab === 'members') {
      createControl = (
        <ToolboxCreateMenu
          onAICreate={handleAICreateMember}
          onManualCreate={() => setManualCreateTrigger((c) => c + 1)}
          triggerTestId="member-create-trigger"
        />
      );
    } else if (activeTeamTab === 'teams') {
      createControl = <ToolboxCreateMenu onClick={() => setTeamDialog({ open: true, team: null })} triggerTestId="team-create-trigger" />;
    }
    return <>{searchBox}{createControl}</>;
  };

  const renderContent = () => {
    switch (activeTeamTab) {
      case 'members':
        // Single identity source: this IS the toolbox agents surface.
        return <AgentsSection manualCreateTrigger={manualCreateTrigger} />;
      case 'teams': {
        const archivedTeams = teams.filter((tm) => tm.archivedAt);
        if (activeTeams.length === 0) {
          return (
            <div className="h-full flex flex-col">
              <div className="flex-1 min-h-0">
                <EmptyState
                  icon={UsersRound}
                  title={t.team.teamsEmpty}
                  hint={t.team.teamsEmptyHint}
                  action={<Button size="sm" onClick={() => setTeamDialog({ open: true, team: null })}>{t.team.newTeam}</Button>}
                />
              </div>
              {/* Archived teams must stay reachable even with zero active ones
                  (real-machine bug 2026-08-31: the section vanished). */}
              <ArchivedTeams teams={archivedTeams} open className="p-4 pt-0" />
            </div>
          );
        }
        return (
          <div className="p-4 space-y-2 overflow-y-auto h-full">
            {activeTeams.map((team) => (
              <div
                key={team.id}
                className="flex items-center gap-3 rounded-xl bg-[var(--abu-bg-muted)] px-4 py-3 cursor-pointer hover:bg-[var(--abu-bg-hover)]"
                onClick={() => setTeamDialog({ open: true, team })}
                data-testid={`team-row-${team.name}`}
              >
                <TeamAvatar avatar={team.avatar} size="lg" />
                <div className="flex-1 min-w-0">
                  <div className="text-body text-[var(--abu-text-primary)] truncate">{team.name}</div>
                  <div className="text-caption text-[var(--abu-text-tertiary)] truncate">
                    {format(t.team.teamRowSummary, {
                      leader: roleLabel(agents, team.leaderRoleId, t.team.unknownMember),
                      count: String(team.memberRoleIds.filter((id) => id !== team.leaderRoleId).length),
                    })}
                  </div>
                  {(() => {
                    const recent = Object.values(conversationIndex)
                      .filter((meta) => meta.teamId === team.id)
                      .sort((a, b) => b.updatedAt - a.updatedAt)
                      .slice(0, 5);
                    return (
                      <div className="mt-1.5 flex flex-wrap items-center gap-1" data-testid={`team-recent-${team.name}`}>
                        <span className="text-caption text-[var(--abu-text-muted)]">{recent.length > 0 ? t.team.recentConversations : t.team.noConversationsYet}</span>
                        {recent.map((meta) => (
                          <button
                            key={meta.id}
                            type="button"
                            onClick={(e) => { e.stopPropagation(); void switchConversation(meta.id); closeTeam(); }}
                            className="max-w-[200px] truncate rounded-md bg-[var(--abu-bg-base)] px-1.5 py-0.5 text-caption text-[var(--abu-text-secondary)] hover:text-[var(--abu-text-primary)]"
                            title={meta.title}
                          >
                            {meta.title}
                          </button>
                        ))}
                      </div>
                    );
                  })()}
                </div>
              </div>
            ))}
            <ArchivedTeams teams={archivedTeams} className="pt-2" />
          </div>
        );
      }
    }
  };

  return (
    <div className="h-full bg-[var(--abu-bg-base)] flex flex-col">
      <TopTabNav items={navItems} activeId={activeTeamTab} onSelect={setActiveTeamTab} belowChrome right={renderHeaderRight()} />
      <div className="flex-1 overflow-hidden">{renderContent()}</div>
      <TeamEditDialog
        open={teamDialog.open}
        team={teamDialog.team}
        onClose={() => setTeamDialog({ open: false, team: null })}
        onSwitchToMembers={() => { setActiveTeamTab('members'); setManualCreateTrigger((c) => c + 1); }}
      />
    </div>
  );
}
