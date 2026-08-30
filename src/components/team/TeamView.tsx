import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useSettingsStore, type TeamTab } from '@/stores/settingsStore';
import { useTeamStore, selectPendingTasks, type Team, type TeamTask } from '@/stores/teamStore';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { agentRegistry } from '@/core/agent/registry';
import { ensureRoleId } from '@/core/team/roleIdentity';
import { useI18n, format } from '@/i18n';
import { Inbox, ListTodo, Bot, UsersRound, Search, X, Crown } from 'lucide-react';
import TopTabNav from '@/components/toolbox/TopTabNav';
import ToolboxCreateMenu from '@/components/toolbox/ToolboxCreateMenu';
import AgentsSection from '@/components/customize/AgentsSection';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import type { SubagentDefinition } from '@/types';

/**
 * 团队 view (R1: management surface — PRD docs/abu-team-prd-v2.md).
 *
 * Design language mirrors ToolboxView exactly: TopTabNav below chrome, search
 * + create on the right, no page title, no manual refresh (stores are the
 * single source and re-render on change). Tab order is user-pinned:
 * 收件箱 · 任务 · 队员 · 团队.
 *
 * 队员 tab reuses AgentsSection — a 队员 IS a custom agent (single identity
 * source), which also inherits the toolbox's IME-safe editors for free.
 */

/** Local dialog shell copying ConfirmDialog's portal/overlay pattern. */
function DialogShell({ open, onClose, title, children, wide }: {
  open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div data-electron-no-drag className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 animate-in fade-in duration-150" onClick={onClose}>
      <div
        className={`bg-[var(--abu-bg-base)] rounded-2xl shadow-xl border border-[var(--abu-border)] w-full ${wide ? 'max-w-lg' : 'max-w-md'} mx-4 max-h-[85vh] flex flex-col`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pt-4 pb-2">
          <h2 className="text-title font-semibold text-[var(--abu-text-primary)]">{title}</h2>
          <button onClick={onClose} className="btn-ghost p-1 rounded-md text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)]" aria-label="close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-5 pb-5 overflow-y-auto">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

function EmptyState({ icon: Icon, title, hint, action }: {
  icon: typeof Inbox; title: string; hint?: string; action?: ReactNode;
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

/** User-selectable member agents: user-defined custom agents only. */
function useMemberAgents(): SubagentDefinition[] {
  const { agents } = useDiscoveryStore();
  const [full, setFull] = useState<SubagentDefinition[]>([]);
  useEffect(() => {
    const list: SubagentDefinition[] = [];
    for (const meta of agents) {
      const a = agentRegistry.getAgent(meta.name);
      if (!a) continue;
      if (a.name === 'abu' || a.managed) continue;
      if (a.filePath === '__builtin__' || a.filePath.includes('builtin-agents')) continue;
      list.push(a);
    }
    setFull(list);
  }, [agents]);
  return full;
}

function roleLabel(agents: SubagentDefinition[], roleId: string, fallback: string): string {
  return agents.find((a) => a.roleId === roleId)?.name ?? fallback;
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
  const agents = useMemberAgents();

  const [name, setName] = useState('');
  const [leaderName, setLeaderName] = useState<string>('');
  const [memberNames, setMemberNames] = useState<string[]>([]);
  const [leaderNote, setLeaderNote] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (team) {
      setName(team.name);
      setLeaderName(roleLabel(agents, team.leaderRoleId, ''));
      setMemberNames(team.memberRoleIds.map((id) => roleLabel(agents, id, '')).filter(Boolean));
      setLeaderNote(team.leaderNote ?? '');
    } else {
      setName(''); setLeaderName(''); setMemberNames([]); setLeaderNote('');
    }
  }, [open, team, agents]);

  const handleSave = async () => {
    if (!name.trim() || !leaderName || saving) return;
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
      const leaderRoleId = await resolve(leaderName);
      const memberRoleIds: string[] = [];
      for (const n of memberNames) {
        if (n === leaderName) continue;
        memberRoleIds.push(await resolve(n));
      }
      if (team) {
        updateTeam(team.id, { name: name.trim(), leaderRoleId, memberRoleIds, leaderNote: leaderNote.trim() || undefined });
        addToast({ type: 'success', title: t.team.teamSaved });
      } else {
        createTeam({ name: name.trim(), leaderRoleId, memberRoleIds, leaderNote: leaderNote.trim() || undefined });
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
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t.team.fieldNamePlaceholder} className="mt-1" data-testid="team-name-input" />
        </div>

        <div>
          <label className="text-caption font-medium text-[var(--abu-text-secondary)]">{t.team.fieldMembers}</label>
          <div className="text-caption text-[var(--abu-text-tertiary)] mt-0.5">{t.team.fieldMembersHint}</div>
          {agents.length === 0 ? (
            <div className="mt-2 rounded-xl bg-[var(--abu-bg-muted)] px-4 py-3 flex items-center justify-between">
              <span className="text-caption text-[var(--abu-text-secondary)]">{t.team.noMembersYet}</span>
              {/* Never a dead end: creating the missing thing is one click away. */}
              <Button size="sm" variant="outline" onClick={() => { onClose(); onSwitchToMembers(); }}>{t.team.createMemberNow}</Button>
            </div>
          ) : (
            <div className="mt-2 space-y-1 max-h-48 overflow-y-auto pr-1" data-testid="team-member-picker">
              {agents.map((a) => {
                const selected = memberNames.includes(a.name);
                const isLeader = leaderName === a.name;
                return (
                  <div
                    key={a.filePath}
                    onClick={() => {
                      if (isLeader) return; // leader is always a member
                      setMemberNames((prev) => selected ? prev.filter((n) => n !== a.name) : [...prev, a.name]);
                    }}
                    className={`flex items-center gap-3 rounded-xl px-3 py-2 cursor-pointer border ${selected || isLeader ? 'border-[var(--abu-clay)] bg-[var(--abu-bg-hover)]' : 'border-transparent bg-[var(--abu-bg-muted)] hover:bg-[var(--abu-bg-hover)]'}`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-body text-[var(--abu-text-primary)] truncate">{a.avatar ? `${a.avatar} ` : ''}{a.name}</div>
                      <div className="text-caption text-[var(--abu-text-tertiary)] truncate">{a.description || '—'}</div>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setLeaderName(a.name);
                        setMemberNames((prev) => prev.includes(a.name) ? prev : [...prev, a.name]);
                      }}
                      className={`shrink-0 flex items-center gap-1 text-caption px-2 py-1 rounded-md ${isLeader ? 'text-[var(--abu-clay)] font-medium' : 'text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)]'}`}
                      title={t.team.setLeader}
                      data-testid={`set-leader-${a.name}`}
                    >
                      <Crown className="h-3.5 w-3.5" />{isLeader ? t.team.leaderBadge : t.team.setLeader}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          {!leaderName && agents.length > 0 && (
            <div className="text-caption text-[var(--abu-text-tertiary)] mt-1">{t.team.leaderRequiredHint}</div>
          )}
        </div>

        <div>
          <label className="text-caption font-medium text-[var(--abu-text-secondary)]">{t.team.fieldLeaderNote}</label>
          {/* Tell the user exactly how this text is used — mechanism, not mystery. */}
          <div className="text-caption text-[var(--abu-text-tertiary)] mt-0.5">{t.team.fieldLeaderNoteHint}</div>
          <Textarea value={leaderNote} onChange={(e) => setLeaderNote(e.target.value)} rows={2} className="mt-1" placeholder={t.team.fieldLeaderNotePlaceholder} />
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
          <Button onClick={handleSave} disabled={!name.trim() || !leaderName || saving} data-testid="team-save">
            {team ? t.common.save : t.team.createTeamAction}
          </Button>
        </div>
      </div>
    </DialogShell>
  );
}

// ---------------------------------------------------------------- Task dialog

function TaskCreateDialog({ open, onClose, teams }: { open: boolean; onClose: () => void; teams: Team[] }) {
  const { t } = useI18n();
  const addToast = useToastStore((s) => s.addToast);
  const createTask = useTeamStore((s) => s.createTask);
  const [teamId, setTeamId] = useState('');
  const [goal, setGoal] = useState('');

  useEffect(() => {
    if (open) {
      setGoal('');
      setTeamId(teams.length === 1 ? teams[0].id : '');
    }
  }, [open, teams]);

  const handleCreate = () => {
    if (!teamId || !goal.trim()) return;
    try {
      createTask({ teamId, goal });
      addToast({ type: 'success', title: t.team.taskCreated });
      onClose();
    } catch (err) {
      addToast({ type: 'error', title: t.team.taskCreateFailed, message: String(err) });
    }
  };

  return (
    <DialogShell open={open} onClose={onClose} title={t.team.newTask}>
      <div className="space-y-4">
        <div>
          <label className="text-caption font-medium text-[var(--abu-text-secondary)]">{t.team.fieldTaskTeam}</label>
          <div className="mt-1 flex flex-wrap gap-2">
            {teams.map((team) => (
              <button
                key={team.id}
                onClick={() => setTeamId(team.id)}
                className={`px-3 py-1.5 rounded-lg text-body border ${teamId === team.id ? 'border-[var(--abu-clay)] bg-[var(--abu-bg-hover)] text-[var(--abu-text-primary)]' : 'border-[var(--abu-border)] text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-hover)]'}`}
                data-testid={`task-team-${team.name}`}
              >
                {team.name}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="text-caption font-medium text-[var(--abu-text-secondary)]">{t.team.fieldTaskGoal}</label>
          {/* Deliberately the whole form: no acceptance criteria, no advanced
              settings, no model, no template — the leader derives structure. */}
          <Textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={4} className="mt-1" placeholder={t.team.fieldTaskGoalPlaceholder} data-testid="task-goal-input" />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
          <Button onClick={handleCreate} disabled={!teamId || !goal.trim()} data-testid="task-create">{t.team.createTaskAction}</Button>
        </div>
      </div>
    </DialogShell>
  );
}

// ---------------------------------------------------------------- Tab bodies

function statusMeta(t: ReturnType<typeof useI18n>['t'], status: TeamTask['status']): { label: string; cls: string } {
  switch (status) {
    case 'awaiting_plan': return { label: t.team.statusAwaitingPlan, cls: 'text-[var(--abu-warning)] bg-[var(--abu-warning-bg)]' };
    case 'running': return { label: t.team.statusRunning, cls: 'text-[var(--abu-info)] bg-[var(--abu-info-bg)]' };
    case 'pending_review': return { label: t.team.statusPendingReview, cls: 'text-[var(--abu-clay)] bg-[var(--abu-bg-hover)]' };
    case 'blocked': return { label: t.team.statusBlocked, cls: 'text-[var(--abu-danger)] bg-[var(--abu-danger-bg)]' };
    case 'done': return { label: t.team.statusDone, cls: 'text-[var(--abu-text-tertiary)] bg-[var(--abu-bg-muted)]' };
  }
}

function TaskRow({ task, team, t }: { task: TeamTask; team: Team | undefined; t: ReturnType<typeof useI18n>['t'] }) {
  const meta = statusMeta(t, task.status);
  return (
    <div className="flex items-center gap-3 rounded-xl bg-[var(--abu-bg-muted)] px-4 py-3">
      <div className="flex-1 min-w-0">
        <div className="text-body text-[var(--abu-text-primary)] truncate">{task.goal.split('\n')[0]}</div>
        <div className="text-caption text-[var(--abu-text-tertiary)] truncate">
          {team?.name ?? t.team.unknownTeam} · {new Date(task.createdAt).toLocaleString()}
        </div>
      </div>
      <span className={`shrink-0 text-caption px-2 py-0.5 rounded-md ${meta.cls}`}>{meta.label}</span>
    </div>
  );
}

// ---------------------------------------------------------------- Main view

export default function TeamView() {
  const { activeTeamTab, setActiveTeamTab } = useSettingsStore();
  const { t } = useI18n();
  const teams = useTeamStore((s) => s.teams);
  const tasks = useTeamStore((s) => s.tasks);
  const startNewConversation = useChatStore((s) => s.startNewConversation);
  const setPendingInput = useChatStore((s) => s.setPendingInput);
  const closeTeam = useSettingsStore((s) => s.closeTeam);

  const [search, setSearch] = useState('');
  const [manualCreateTrigger, setManualCreateTrigger] = useState(0);
  const [teamDialog, setTeamDialog] = useState<{ open: boolean; team: Team | null }>({ open: false, team: null });
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);

  useEffect(() => { setSearch(''); }, [activeTeamTab]);

  const activeTeams = useMemo(() => teams.filter((tm) => !tm.archivedAt), [teams]);
  const agents = useMemberAgents();
  const pending = useMemo(() => selectPendingTasks(tasks), [tasks]);

  const navItems = [
    { id: 'inbox' as TeamTab, label: t.team.tabInbox, icon: Inbox },
    { id: 'tasks' as TeamTab, label: t.team.tabTasks, icon: ListTodo },
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
    const searchBox = (activeTeamTab === 'tasks' || activeTeamTab === 'members') ? (
      <div className="relative w-52 shrink-0">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--abu-text-tertiary)] pointer-events-none" />
        <Input type="text" placeholder={t.team.searchPlaceholder} value={search} onChange={(e) => setSearch(e.target.value)} className="h-8 pl-8 pr-3 text-body" />
      </div>
    ) : null;

    let createControl: ReactNode = null;
    if (activeTeamTab === 'tasks') {
      createControl = <ToolboxCreateMenu onClick={() => setTaskDialogOpen(true)} triggerTestId="task-create-trigger" />;
    } else if (activeTeamTab === 'members') {
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
      case 'inbox': {
        if (pending.length === 0) {
          return <EmptyState icon={Inbox} title={t.team.inboxEmpty} hint={t.team.inboxEmptyHint} />;
        }
        return (
          <div className="p-4 space-y-2 overflow-y-auto h-full">
            {pending.map((task) => (
              <TaskRow key={task.id} task={task} team={teams.find((tm) => tm.id === task.teamId)} t={t} />
            ))}
          </div>
        );
      }
      case 'tasks': {
        const list = tasks.filter((task) => !search || task.goal.toLowerCase().includes(search.toLowerCase()));
        if (list.length === 0) {
          return (
            <EmptyState
              icon={ListTodo}
              title={t.team.tasksEmpty}
              hint={t.team.tasksEmptyHint}
              action={activeTeams.length > 0
                ? <Button size="sm" onClick={() => setTaskDialogOpen(true)}>{t.team.newTask}</Button>
                // No dead ends: creating a task needs a team first, offer that instead.
                : <Button size="sm" variant="outline" onClick={() => setActiveTeamTab('teams')}>{t.team.goCreateTeam}</Button>}
            />
          );
        }
        return (
          <div className="p-4 space-y-2 overflow-y-auto h-full">
            {list.map((task) => (
              <TaskRow key={task.id} task={task} team={teams.find((tm) => tm.id === task.teamId)} t={t} />
            ))}
          </div>
        );
      }
      case 'members':
        // Single identity source: this IS the toolbox agents surface.
        return <AgentsSection manualCreateTrigger={manualCreateTrigger} />;
      case 'teams': {
        if (activeTeams.length === 0) {
          return (
            <EmptyState
              icon={UsersRound}
              title={t.team.teamsEmpty}
              hint={t.team.teamsEmptyHint}
              action={<Button size="sm" onClick={() => setTeamDialog({ open: true, team: null })}>{t.team.newTeam}</Button>}
            />
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
                <UsersRound className="h-5 w-5 text-[var(--abu-text-tertiary)] shrink-0" strokeWidth={1.75} />
                <div className="flex-1 min-w-0">
                  <div className="text-body text-[var(--abu-text-primary)] truncate">{team.name}</div>
                  <div className="text-caption text-[var(--abu-text-tertiary)] truncate">
                    {format(t.team.teamRowSummary, {
                      leader: roleLabel(agents, team.leaderRoleId, t.team.unknownMember),
                      count: String(team.memberRoleIds.length),
                    })}
                  </div>
                </div>
              </div>
            ))}
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
      <TaskCreateDialog open={taskDialogOpen} onClose={() => setTaskDialogOpen(false)} teams={activeTeams} />
    </div>
  );
}
