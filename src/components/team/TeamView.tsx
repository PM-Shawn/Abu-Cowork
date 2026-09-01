import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useSettingsStore, type TeamTab } from '@/stores/settingsStore';
import { useTeamStore, selectPendingTasks, type Team, type TeamTask } from '@/stores/teamStore';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { agentRegistry } from '@/core/agent/registry';
import { ensureRoleId, effectiveRoleId } from '@/core/team/roleIdentity';
import { useI18n, format } from '@/i18n';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { Inbox, ListTodo, Bot, UsersRound, Search, Paperclip, X } from 'lucide-react';
import TopTabNav from '@/components/toolbox/TopTabNav';
import DialogShell from './DialogShell';
import ConfirmDialog from '@/components/common/ConfirmDialog';
import TaskDetailDialog from './TaskDetailDialog';
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
 * single source and re-render on change). Tab order is user-pinned:
 * 收件箱 · 任务 · 队员 · 团队.
 *
 * 队员 tab reuses AgentsSection — a 队员 IS a custom agent (single identity
 * source), which also inherits the toolbox's IME-safe editors for free.
 */

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
  return { value: a.name, label: a.name, description: a.description || undefined, icon: a.avatar ?? '🤖' };
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
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (team) {
      setName(team.name);
      setLeaderName(roleLabel(agents, team.leaderRoleId, ''));
      setMemberNames(team.memberRoleIds.map((id) => roleLabel(agents, id, '')).filter(Boolean));
      setLeaderNote(team.leaderNote ?? '');
      setRequireApproval(team.requirePlanApproval === true);
    } else {
      setName(''); setLeaderName(''); setMemberNames([]); setLeaderNote(''); setRequireApproval(false);
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
        updateTeam(team.id, { name: name.trim(), leaderRoleId, memberRoleIds, leaderNote: leaderNote.trim() || undefined, requirePlanApproval: requireApproval });
        addToast({ type: 'success', title: t.team.teamSaved });
      } else {
        createTeam({ name: name.trim(), leaderRoleId, memberRoleIds, leaderNote: leaderNote.trim() || undefined, requirePlanApproval: requireApproval });
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
          <Button onClick={handleSave} disabled={!name.trim() || !leaderName || saving} data-testid="team-save">
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

function TaskCreateDialog({ open, onClose, teams, agents }: { open: boolean; onClose: () => void; teams: Team[]; agents: SubagentDefinition[] }) {
  const { t } = useI18n();
  const addToast = useToastStore((s) => s.addToast);
  const createTask = useTeamStore((s) => s.createTask);
  const refresh = useDiscoveryStore((s) => s.refresh);
  // Assignee: a team OR a single member — one searchable dropdown, teams
  // first with a kind badge (user feedback 2026-08-31: no flat chips).
  const [assignee, setAssignee] = useState<string | null>(null);
  const [goal, setGoal] = useState('');
  const [attachments, setAttachments] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (open) {
      setGoal('');
      setAttachments([]);
      setAssignee(teams.length === 1 && agents.length === 0 ? `team:${teams[0].id}` : null);
    }
  }, [open, teams, agents]);

  const pickFiles = async () => {
    const picked = await openDialog({ multiple: true });
    if (!picked) return;
    const paths = (Array.isArray(picked) ? picked : [picked]).filter((p): p is string => typeof p === 'string');
    setAttachments((prev) => Array.from(new Set([...prev, ...paths])));
  };

  const options: SearchSelectOption[] = [
    ...teams.map((team) => ({ value: `team:${team.id}`, label: team.name, icon: '👥', badge: t.team.kindTeam })),
    ...agents.map((a) => ({ ...memberOption(a), value: `member:${a.name}` })),
  ];

  const handleCreate = async () => {
    if (!assignee || !goal.trim() || creating) return;
    setCreating(true);
    try {
      let task;
      if (assignee.startsWith('team:')) {
        task = createTask({ teamId: assignee.slice(5), goal, attachments });
      } else {
        const name = assignee.slice(7);
        const agent = agentRegistry.getAgent(name);
        if (!agent) throw new Error(`agent not found: ${name}`);
        const { roleId, wrote } = await ensureRoleId(agent);
        if (wrote) await refresh();
        task = createTask({ memberRoleId: roleId, goal, attachments });
      }
      addToast({ type: 'success', title: t.team.taskCreated });
      onClose();
      // Planning (team) or direct execution (member) starts right away; the
      // plan is visible-not-blocking unless the team opted into strict mode.
      void import('@/core/team/orchestrator').then((mod) => mod.kickoffTask(task.id));
    } catch (err) {
      addToast({ type: 'error', title: t.team.taskCreateFailed, message: String(err) });
    } finally {
      setCreating(false);
    }
  };

  return (
    <DialogShell open={open} onClose={onClose} title={t.team.newTask}>
      <div className="space-y-4">
        {/* What first, who second (user feedback 2026-08-31). */}
        <div>
          <label className="text-caption font-medium text-[var(--abu-text-secondary)]">{t.team.fieldTaskGoal}</label>
          <Textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={4} className="mt-1" placeholder={t.team.fieldTaskGoalPlaceholder} data-testid="task-goal-input" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <label className="text-caption font-medium text-[var(--abu-text-secondary)]">{t.team.fieldTaskFiles}</label>
            <Button size="xs" variant="ghost" onClick={() => { void pickFiles(); }} data-testid="task-pick-files">
              <Paperclip className="h-3.5 w-3.5" />{t.team.addFiles}
            </Button>
          </div>
          {attachments.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1.5">
              {attachments.map((path) => (
                <span key={path} className="inline-flex items-center gap-1 rounded-lg bg-[var(--abu-bg-muted)] px-2 py-0.5 text-caption text-[var(--abu-text-secondary)] max-w-[220px]">
                  <span className="truncate" title={path}>{path.split('/').pop()}</span>
                  <X className="h-3 w-3 shrink-0 cursor-pointer text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)]" onClick={() => setAttachments((prev) => prev.filter((x) => x !== path))} />
                </span>
              ))}
            </div>
          )}
        </div>
        <div>
          <label className="text-caption font-medium text-[var(--abu-text-secondary)]">{t.team.fieldTaskAssignee}</label>
          <SearchSelect
            className="mt-1"
            value={assignee}
            onChange={setAssignee}
            options={options}
            placeholder={t.team.assigneePlaceholder}
            searchPlaceholder={t.team.searchPlaceholder}
            emptyText={t.team.pickerEmpty}
            testId="task-assignee-select"
          />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
          <Button onClick={() => { void handleCreate(); }} disabled={!assignee || !goal.trim() || creating} data-testid="task-create">{t.team.createTaskAction}</Button>
        </div>
      </div>
    </DialogShell>
  );
}

// ---------------------------------------------------------------- Tab bodies

function statusMeta(t: ReturnType<typeof useI18n>['t'], status: TeamTask['status']): { label: string; cls: string } {
  switch (status) {
    case 'awaiting_plan': return { label: t.team.statusPreparing, cls: 'text-[var(--abu-warning)] bg-[var(--abu-warning-bg)]' };
    case 'running': return { label: t.team.statusRunning, cls: 'text-[var(--abu-info)] bg-[var(--abu-info-bg)]' };
    case 'pending_review': return { label: t.team.statusPendingReview, cls: 'text-[var(--abu-clay)] bg-[var(--abu-bg-hover)]' };
    case 'blocked': return { label: t.team.statusBlocked, cls: 'text-[var(--abu-danger)] bg-[var(--abu-danger-bg)]' };
    case 'done': return { label: t.team.statusDone, cls: 'text-[var(--abu-text-tertiary)] bg-[var(--abu-bg-muted)]' };
  }
}

function KanbanCard({ task, team, agents, t, onOpen }: {
  task: TeamTask; team: Team | undefined; agents: SubagentDefinition[]; t: ReturnType<typeof useI18n>['t']; onOpen: (id: string) => void;
}) {
  const assignee = team?.name
    ?? (task.memberRoleId ? roleLabel(agents, task.memberRoleId, t.team.unknownMember) : t.team.unknownTeam);
  return (
    <div
      className="rounded-lg bg-[var(--abu-bg-base)] border border-[var(--abu-border-subtle)] shadow-sm px-3 py-2.5 cursor-pointer hover:border-[var(--abu-border-hover)]"
      onClick={() => onOpen(task.id)}
      data-testid={`task-card-${task.id}`}
    >
      <div className="text-body text-[var(--abu-text-primary)] line-clamp-2">{task.goal.split('\n')[0]}</div>
      <div className="text-caption text-[var(--abu-text-tertiary)] mt-1 truncate">{assignee}</div>
      {task.status === 'blocked' && (
        <div className="text-caption text-[var(--abu-danger)] mt-0.5 truncate">{task.statusNote ?? t.team.statusBlocked}</div>
      )}
    </div>
  );
}

function TaskRow({ task, team, t, onOpen }: { task: TeamTask; team: Team | undefined; t: ReturnType<typeof useI18n>['t']; onOpen: (id: string) => void }) {
  // A proposal waiting on the user (strict teams) reads 待确认分工, not 准备中.
  const meta = (task.status === 'awaiting_plan' && task.plan && team?.requirePlanApproval)
    ? { label: t.team.statusAwaitingPlan, cls: 'text-[var(--abu-warning)] bg-[var(--abu-warning-bg)]' }
    : statusMeta(t, task.status);
  return (
    <div
      className="flex items-center gap-3 rounded-xl bg-[var(--abu-bg-muted)] px-4 py-3 cursor-pointer hover:bg-[var(--abu-bg-hover)]"
      onClick={() => onOpen(task.id)}
      data-testid={`task-row-${task.id}`}
    >
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
  const { activeTeamTab: persistedTeamTab, setActiveTeamTab } = useSettingsStore();
  // A stale persisted value (e.g. the removed 'pipelines' tab) falls back to
  // the default tab instead of rendering an empty pane.
  const activeTeamTab: TeamTab = persistedTeamTab === 'inbox' || persistedTeamTab === 'members' || persistedTeamTab === 'teams' ? persistedTeamTab : 'tasks';
  const { t } = useI18n();
  const teams = useTeamStore((s) => s.teams);
  const tasks = useTeamStore((s) => s.tasks);
  const startNewConversation = useChatStore((s) => s.startNewConversation);
  const setPendingInput = useChatStore((s) => s.setPendingInput);
  const closeTeam = useSettingsStore((s) => s.closeTeam);

  const [search, setSearch] = useState('');
  // AgentsSection filters by the shared toolbox query — bind the members-tab
  // search box to it so typing actually filters (bug: local state was ignored).
  const toolboxSearchQuery = useSettingsStore((s) => s.toolboxSearchQuery);
  const setToolboxSearchQuery = useSettingsStore((s) => s.setToolboxSearchQuery);
  const [manualCreateTrigger, setManualCreateTrigger] = useState(0);
  const [teamDialog, setTeamDialog] = useState<{ open: boolean; team: Team | null }>({ open: false, team: null });
  const [taskDialogOpen, setTaskDialogOpen] = useState(false);
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null);
  // Notification deep link: a notice click parks the target task id in the
  // store; consume it once and open the detail.
  const focusTaskId = useTeamStore((s) => s.focusTaskId);
  useEffect(() => {
    if (!focusTaskId) return;
    setDetailTaskId(focusTaskId);
    useTeamStore.getState().setFocusTaskId(null);
  }, [focusTaskId]);

  useEffect(() => { setSearch(''); setToolboxSearchQuery(''); }, [activeTeamTab, setToolboxSearchQuery]);

  const activeTeams = useMemo(() => teams.filter((tm) => !tm.archivedAt), [teams]);
  const agents = useMemberPool();
  const pending = useMemo(() => selectPendingTasks(tasks, teams), [tasks, teams]);

  // Tab order user-pinned 2026-08-31: 任务 · 收件箱 · 队员 · 团队.
  const navItems = [
    { id: 'tasks' as TeamTab, label: t.team.tabTasks, icon: ListTodo },
    { id: 'inbox' as TeamTab, label: t.team.tabInbox, icon: Inbox, badgeCount: pending.length },
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
    const searchBox = (activeTeamTab === 'tasks' || isMembers) ? (
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
              <TaskRow key={task.id} task={task} team={teams.find((tm) => tm.id === task.teamId)} t={t} onOpen={setDetailTaskId} />
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
              action={(activeTeams.length > 0 || agents.length > 0)
                ? <Button size="sm" onClick={() => setTaskDialogOpen(true)}>{t.team.newTask}</Button>
                // No dead ends: creating a task needs an assignee first, offer that instead.
                : <Button size="sm" variant="outline" onClick={() => setActiveTeamTab('teams')}>{t.team.goCreateTeam}</Button>}
            />
          );
        }
        // Kanban: the tab is for WATCHING flow (user decision 2026-08-31) —
        // initiation lives in the chat composer; the top-right + stays as a
        // secondary shortcut. Blocked tasks sit in the running column with
        // their red note so the board stays four columns.
        const columns: Array<{ key: string; title: string; items: typeof list }> = [
          { key: 'preparing', title: t.team.statusPreparing, items: list.filter((task) => task.status === 'awaiting_plan') },
          { key: 'running', title: t.team.statusRunning, items: list.filter((task) => task.status === 'running' || task.status === 'blocked') },
          { key: 'review', title: t.team.statusPendingReview, items: list.filter((task) => task.status === 'pending_review') },
          { key: 'done', title: t.team.statusDone, items: list.filter((task) => task.status === 'done') },
        ];
        return (
          <div className="p-4 h-full overflow-x-auto">
            <div className="flex gap-3 h-full min-w-[640px]">
              {columns.map((col) => (
                // Full-height tinted lane per column — a board, not floating
                // groups (user feedback 2026-08-31).
                <div key={col.key} className="flex-1 min-w-0 flex flex-col rounded-xl bg-[var(--abu-bg-muted)] p-2" data-testid={`kanban-${col.key}`}>
                  <div className="text-caption font-medium text-[var(--abu-text-secondary)] px-1.5 pt-0.5 pb-2 shrink-0">
                    {col.title} <span className="text-[var(--abu-text-tertiary)]">{col.items.length}</span>
                  </div>
                  <div className="space-y-2 overflow-y-auto flex-1 min-h-0">
                    {col.items.map((task) => (
                      <KanbanCard key={task.id} task={task} team={teams.find((tm) => tm.id === task.teamId)} agents={agents} t={t} onOpen={setDetailTaskId} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      }
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
              {archivedTeams.length > 0 && (
                <div className="p-4 pt-0">
                  <details open>
                    <summary className="cursor-pointer text-caption text-[var(--abu-text-tertiary)] select-none px-1">
                      {format(t.team.archivedSection, { count: String(archivedTeams.length) })}
                    </summary>
                    <div className="mt-2 space-y-2">
                      {archivedTeams.map((team) => (
                        <div key={team.id} className="flex items-center gap-3 rounded-xl bg-[var(--abu-bg-muted)] px-4 py-3 opacity-70">
                          <UsersRound className="h-5 w-5 text-[var(--abu-text-tertiary)] shrink-0" strokeWidth={1.75} />
                          <div className="flex-1 min-w-0 text-body text-[var(--abu-text-secondary)] truncate">{team.name}</div>
                          <Button size="sm" variant="outline" onClick={() => useTeamStore.getState().restoreTeam(team.id)}>{t.team.restoreTeamAction}</Button>
                        </div>
                      ))}
                    </div>
                  </details>
                </div>
              )}
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
            {archivedTeams.length > 0 && (
              <details className="pt-2">
                <summary className="cursor-pointer text-caption text-[var(--abu-text-tertiary)] select-none px-1">
                  {format(t.team.archivedSection, { count: String(archivedTeams.length) })}
                </summary>
                <div className="mt-2 space-y-2">
                  {archivedTeams.map((team) => (
                    <div key={team.id} className="flex items-center gap-3 rounded-xl bg-[var(--abu-bg-muted)] px-4 py-3 opacity-70">
                      <UsersRound className="h-5 w-5 text-[var(--abu-text-tertiary)] shrink-0" strokeWidth={1.75} />
                      <div className="flex-1 min-w-0 text-body text-[var(--abu-text-secondary)] truncate">{team.name}</div>
                      <Button size="sm" variant="outline" onClick={() => useTeamStore.getState().restoreTeam(team.id)}>{t.team.restoreTeamAction}</Button>
                    </div>
                  ))}
                </div>
              </details>
            )}
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
      <TaskCreateDialog open={taskDialogOpen} onClose={() => setTaskDialogOpen(false)} teams={activeTeams} agents={agents} />
      <TaskDetailDialog taskId={detailTaskId} onClose={() => setDetailTaskId(null)} />
    </div>
  );
}
