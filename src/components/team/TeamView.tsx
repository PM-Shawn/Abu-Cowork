import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useSettingsStore, type TeamTab } from '@/stores/settingsStore';
import { useTeamStore, type Team } from '@/stores/teamStore';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { agentRegistry } from '@/core/agent/registry';
import { ensureRoleId, effectiveRoleId, resolveRoleId, roleIdAgentName } from '@/core/team/roleIdentity';
import { useI18n, format } from '@/i18n';
import { Bot, UsersRound, Search, MessageCircle, MoreHorizontal, Pencil, Trash2, X } from 'lucide-react';
import TopTabNav from '@/components/toolbox/TopTabNav';
import DialogShell from './DialogShell';
import TeamAvatar from './TeamAvatar';
import AgentAvatar from '@/components/common/AgentAvatar';
import ConfirmDialog from '@/components/common/ConfirmDialog';
import ToolboxCreateMenu from '@/components/toolbox/ToolboxCreateMenu';
import ToolDetailModal from '@/components/toolbox/ToolDetailModal';
import ToolCard from '@/components/toolbox/ToolCard';
import ToolGrid from '@/components/toolbox/ToolGrid';
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
  // Match the frontmatter `roleId` as well as the effective one: a team saved
  // before plugin agents got synthetic `plugin:<name>` ids still stores the
  // legacy `role-…` id for them. Without this the member drops out of the
  // picker (and can be re-added as a duplicate); with it the id self-heals —
  // saving rewrites the membership with `ensureRoleId`'s current id.
  return agents.find((a) => effectiveRoleId(a) === roleId || a.roleId === roleId)?.name ?? fallback;
}

function memberOption(a: SubagentDefinition): SearchSelectOption {
  return { value: a.name, label: a.name, description: a.description || undefined, icon: <AgentAvatar agent={a} size="sm" /> };
}

/**
 * Primary line for each invalid member, so two of them never read the same.
 * Name-keyed ids (`builtin:` / `plugin:`) still spell the name; a `role-…` id
 * carries none, so those are numbered 1-based among themselves, in stored order.
 */
function invalidMemberLabels(roleIds: string[], named: string, numbered: string): { id: string; label: string }[] {
  let unnamed = 0;
  return roleIds.map((id) => {
    const name = roleIdAgentName(id);
    return { id, label: name ? format(named, { name }) : format(numbered, { n: String(++unnamed) }) };
  });
}

/** Two-line label of an invalid member row: which one, then why (muted caption). */
function InvalidMemberText({ label, reason }: { label: string; reason: string }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate text-body text-[var(--abu-danger)]">{label}</span>
      <span className="block truncate text-caption text-[var(--abu-text-tertiary)]">{reason}</span>
    </span>
  );
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
  const agents = useMemberPool();

  const [name, setName] = useState('');
  const [leaderName, setLeaderName] = useState<string>('');
  const [memberNames, setMemberNames] = useState<string[]>([]);
  const [leaderNote, setLeaderNote] = useState('');
  const [requireApproval, setRequireApproval] = useState(false);
  const [avatar, setAvatar] = useState('');
  const [saving, setSaving] = useState(false);
  // Members not offered by the picker fall into two very different buckets:
  // - hidden: the agent exists but is disabled / managed — still a real member,
  //   kept and written back untouched;
  // - invalid: no live agent answers to the roleId at all (deleted, or edited
  //   before role-id survived edits). Shown below the picker with a remove
  //   action; kept on save unless the user removes it — never dropped silently.
  const [hiddenMemberRoleIds, setHiddenMemberRoleIds] = useState<string[]>([]);
  const [invalidMemberRoleIds, setInvalidMemberRoleIds] = useState<string[]>([]);
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
      const notInPicker = members.filter((id) => !roleLabel(pool, id, ''));
      setHiddenMemberRoleIds(notInPicker.filter((id) => resolveRoleId(id) !== null));
      setInvalidMemberRoleIds(notInPicker.filter((id) => resolveRoleId(id) === null));
      setLeaderNote(team.leaderNote ?? '');
      setRequireApproval(team.requirePlanApproval === true);
      setAvatar(team.avatar ?? '');
    } else {
      setName(''); setLeaderName(''); setMemberNames([]); setHiddenMemberRoleIds([]); setInvalidMemberRoleIds([]); setLeaderNote(''); setRequireApproval(false); setAvatar('');
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
      const memberRoleIds: string[] = [...hiddenMemberRoleIds, ...invalidMemberRoleIds].filter((id) => id !== leaderRoleId);
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
        {/* Outside the pool branch: a team whose every agent is gone still
            needs its ghosts listed — and removable — while the pool is empty. */}
        {invalidMemberRoleIds.length > 0 && (
          <div className="rounded-xl bg-[var(--abu-bg-muted)] px-3 py-2.5 space-y-1.5">
            <div className="text-caption text-[var(--abu-text-secondary)]">{t.team.editInvalidMembers}</div>
            {invalidMemberLabels(invalidMemberRoleIds, t.team.memberInvalidNamed, t.team.memberInvalidNumbered).map(({ id, label }) => {
              return (
                <div key={id} className="flex items-center gap-2" data-testid={`team-edit-invalid-${id}`}>
                  <Bot className="h-4 w-4 text-[var(--abu-text-tertiary)]" />
                  <InvalidMemberText label={label} reason={t.team.memberInvalidReason} />
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={t.team.memberInvalidRemove}
                    title={t.team.memberInvalidRemove}
                    onClick={() => setInvalidMemberRoleIds((prev) => prev.filter((x) => x !== id))}
                    data-testid={`team-edit-invalid-remove-${id}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              );
            })}
          </div>
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
          <div className="flex-1" />
          <Button variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
          <Button onClick={handleSave} disabled={!name.trim() || (!leaderName && !leaderKept) || saving} data-testid="team-save">
            {team ? t.common.save : t.team.createTeamAction}
          </Button>
        </div>
      </div>
    </DialogShell>
  );
}

// ---------------------------------------------------------------- Task dialog

export default function TeamView() {
  const { activeTeamTab: persistedTeamTab, setActiveTeamTab } = useSettingsStore();
  // A stale persisted value (e.g. the removed 'pipelines' tab) falls back to
  // the default tab instead of rendering an empty pane.
  const activeTeamTab: TeamTab = persistedTeamTab === 'teams' ? 'teams' : 'members';
  const { t } = useI18n();
  const teams = useTeamStore((s) => s.teams);
  // Roles resolve through the agent registry, which is not a React-reactive
  // source; subscribe to discovery so the card grid re-renders when the roster
  // changes (same reason useConversationTeam subscribes — useTeamDispatches.ts).
  const discoveredAgents = useDiscoveryStore((s) => s.agents);
  const startNewConversation = useChatStore((s) => s.startNewConversation);
  const createConversation = useChatStore((s) => s.createConversation);
  const setPendingInput = useChatStore((s) => s.setPendingInput);
  const closeTeam = useSettingsStore((s) => s.closeTeam);

  // Primary action of the detail: a fresh conversation already pinned to this
  // team, nothing prefilled — the user says what they want in their own words.
  const startChatWithTeam = (team: Team) => {
    createConversation(null, { teamId: team.id });
    setDetailTeam(null);
    closeTeam();
  };

  // One local box for both tabs. It used to write into the toolbox's shared
  // query so AgentsSection would filter; that surface is now Extensions, whose
  // query belongs to another view — AgentsSection takes ours as a prop instead.
  const [search, setSearch] = useState('');
  const [manualCreateTrigger, setManualCreateTrigger] = useState(0);
  const [teamDialog, setTeamDialog] = useState<{ open: boolean; team: Team | null }>({ open: false, team: null });
  const [detailTeam, setDetailTeam] = useState<Team | null>(null);
  const [detailMenuOpen, setDetailMenuOpen] = useState(false);
  const [confirmDeleteTeam, setConfirmDeleteTeam] = useState<Team | null>(null);

  useEffect(() => { setSearch(''); }, [activeTeamTab]);

  // `manualCreateTrigger` is a counter AgentsSection acts on whenever it mounts
  // with a value > 0 — without a reset, returning to 队员 replays the last
  // 手动创建 as a blank editor. Same reset ToolboxModal does on its tab change.
  // `onSwitchToMembers` still opens it once: the tab switch and the bump share
  // a commit, and the section's (child) effect runs before this (parent) reset.
  const lastView = useRef(activeTeamTab);
  useEffect(() => {
    if (lastView.current === activeTeamTab) return;
    lastView.current = activeTeamTab;
    setManualCreateTrigger(0);
  }, [activeTeamTab]);

  const activeTeams = teams;

  // `_agents` is unused by value — it exists only to make `discoveredAgents`
  // a visible input of this derived text, so the caller's subscription to the
  // discovery store isn't dead code from the compiler's point of view.
  // The card's leader slot is one segment of a ` · ` summary line, so it takes
  // the short label; the explanatory clause lives in the detail and the editor.
  const cardSummary = (team: Team, _agents: typeof discoveredAgents) => format(t.team.teamRowSummary, {
    leader: resolveRoleId(team.leaderRoleId)?.name ?? t.team.memberInvalidShort,
    count: String(team.memberRoleIds.filter((id) => id !== team.leaderRoleId && resolveRoleId(id) !== null).length),
  });

  const navItems = [
    { id: 'members' as TeamTab, label: t.team.tabMembers, icon: Bot },
    { id: 'teams' as TeamTab, label: t.team.tabTeams, icon: UsersRound },
  ];

  // AI-create for 队员 reuses the toolbox idiom: jump to chat with a crafted prompt.
  const handleAICreateTeam = () => {
    closeTeam();
    startNewConversation();
    setPendingInput(t.team.aiCreateTeamPrompt);
  };

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
          value={search}
          onChange={(e) => setSearch(e.target.value)}
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
      createControl = (
        <ToolboxCreateMenu
          onAICreate={handleAICreateTeam}
          onManualCreate={() => setTeamDialog({ open: true, team: null })}
          triggerTestId="team-create-trigger"
          menuTestId="team-create-menu"
        />
      );
    }
    return <>{searchBox}{createControl}</>;
  };

  const renderContent = () => {
    switch (activeTeamTab) {
      case 'members':
        // Single identity source: this IS the toolbox agents surface.
        return <AgentsSection manualCreateTrigger={manualCreateTrigger} searchQuery={search} />;
      case 'teams': {
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
            </div>
          );
        }
        return (
          // Same grid + card the 队员 tab uses (ToolGrid/ToolCard), not a
          // hand-rolled row: a team and a member are peers in this surface, so
          // they must look and behave alike.
          <div className="flex-1 overflow-y-scroll overlay-scroll px-8 pb-6 h-full">
            <ToolGrid>
              {activeTeams.map((team) => (
                <ToolCard
                    key={team.id}
                    item={{
                      id: team.id,
                      testId: `team-row-${team.name}`,
                      name: team.name,
                      description: cardSummary(team, discoveredAgents),
                      avatar: <TeamAvatar avatar={team.avatar} />,
                    }}
                    onClick={() => setDetailTeam(team)}
                  />
              ))}
            </ToolGrid>
          </div>
        );
      }
    }
  };

  return (
    <div className="h-full bg-[var(--abu-bg-base)] flex flex-col">
      <TopTabNav items={navItems} activeId={activeTeamTab} onSelect={setActiveTeamTab} belowChrome right={renderHeaderRight()} />
      <div className="flex-1 overflow-hidden">{renderContent()}</div>
      {/* Team detail — same shell and header grammar as the 队员 detail:
          read-only body, primary CTA + "…" (edit / archive) in the header.
          Opening a team used to jump straight into the edit form, which is
          why 团队 felt unlike every other list in the app. */}
      <ToolDetailModal
        open={!!detailTeam}
        onClose={() => { setDetailTeam(null); setDetailMenuOpen(false); }}
        maxWidth="max-w-2xl"
        avatar={detailTeam ? <TeamAvatar avatar={detailTeam.avatar} size="lg" /> : undefined}
        title={detailTeam?.name}
        headerActions={detailTeam ? (
          <>
            <button
              onClick={() => startChatWithTeam(detailTeam)}
              className="flex items-center gap-1.5 px-2.5 h-7 rounded-md text-minor font-medium text-[var(--abu-clay)] bg-[var(--abu-clay-bg)] hover:bg-[var(--abu-clay-bg-15)] border border-[var(--abu-clay-40)] hover:border-[var(--abu-clay)] transition-colors"
              data-testid="team-detail-start-chat"
            >
              <MessageCircle className="h-3.5 w-3.5" />
              <span>{t.team.detailStartChat}</span>
            </button>
            <div className="relative">
              <button
                onClick={(e) => { e.stopPropagation(); setDetailMenuOpen((v) => !v); }}
                className="p-1.5 rounded-lg text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-muted)] transition-colors"
                data-testid="team-detail-menu"
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
              {detailMenuOpen && (
                <div className="absolute right-0 top-8 z-10 bg-[var(--abu-bg-base)] border border-[var(--abu-border)] rounded-lg shadow-lg py-1 min-w-[140px]">
                  <button
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-minor text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-muted)] transition-colors"
                    onClick={() => { setTeamDialog({ open: true, team: detailTeam }); setDetailMenuOpen(false); setDetailTeam(null); }}
                    data-testid="team-detail-edit"
                  >
                    <Pencil className="h-3 w-3" />
                    {t.team.detailEdit}
                  </button>
                  <button
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-minor text-[var(--abu-danger)] hover:bg-[var(--abu-danger-bg)] transition-colors"
                    onClick={() => { setConfirmDeleteTeam(detailTeam); setDetailMenuOpen(false); }}
                    data-testid="team-detail-delete"
                  >
                    <Trash2 className="h-3 w-3" />
                    {t.team.deleteTeamAction}
                  </button>
                </div>
              )}
            </div>
          </>
        ) : undefined}
      >
        {detailTeam && (() => {
          const memberIds = detailTeam.memberRoleIds.filter((id) => id !== detailTeam.leaderRoleId);
          // Same predicate the run uses (resolveRoleId), so the count here never
          // disagrees with the "队员 · N" the workspace tab shows mid-run.
          const leader = resolveRoleId(detailTeam.leaderRoleId) ?? undefined;
          const members = memberIds.map((id) => ({ id, agent: resolveRoleId(id) ?? undefined }));
          const validMembers = members.filter((m) => m.agent);
          const invalidMembers = invalidMemberLabels(members.filter((m) => !m.agent).map((m) => m.id), t.team.memberInvalidNamed, t.team.memberInvalidNumbered);
          const removeInvalid = (roleId: string) => {
            useTeamStore.getState().updateTeam(detailTeam.id, { memberRoleIds: detailTeam.memberRoleIds.filter((id) => id !== roleId) });
            setDetailTeam(useTeamStore.getState().teams.find((team) => team.id === detailTeam.id) ?? null);
          };
          // Skills live on each member, not on the team — the union answers
          // "what can this team actually do" without opening every member.
          const skills = [...new Set([leader, ...members.map((m) => m.agent)]
            .flatMap((a) => a?.skills ?? []))].sort();
          const row = (agent: SubagentDefinition | undefined, fallback: string, onPick?: () => void) => (
            <button
              type="button"
              disabled={!agent}
              onClick={onPick}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-[var(--abu-bg-muted)] disabled:cursor-default disabled:hover:bg-transparent"
            >
              {agent ? <AgentAvatar agent={agent} size="sm" /> : <Bot className="h-4 w-4 text-[var(--abu-text-tertiary)]" />}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body text-[var(--abu-text-primary)]">{agent?.name ?? fallback}</span>
                {agent?.description && <span className="block truncate text-caption text-[var(--abu-text-tertiary)]">{agent.description}</span>}
              </span>
            </button>
          );
          return (
            <div className="space-y-5">
              <div>
                <div className="text-minor text-[var(--abu-text-muted)] mb-1">{t.team.detailLeader}</div>
                {row(leader, t.team.memberInvalid)}
              </div>
              <div>
                <div className="text-minor text-[var(--abu-text-muted)] mb-1">{format(t.team.detailMembers, { count: String(validMembers.length) })}</div>
                {validMembers.length === 0 && invalidMembers.length === 0
                  ? <div className="text-caption text-[var(--abu-text-tertiary)]">{t.team.detailNoMembers}</div>
                  : <div className="space-y-0.5">
                      {validMembers.map((m) => <div key={m.id}>{row(m.agent, t.team.memberInvalid)}</div>)}
                      {invalidMembers.map((m) => (
                        <div key={m.id} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5" data-testid={`team-member-invalid-${m.id}`}>
                          <Bot className="h-4 w-4 text-[var(--abu-text-tertiary)]" />
                          <InvalidMemberText label={m.label} reason={t.team.memberInvalidReason} />
                          <Button size="xs" variant="ghost" onClick={() => removeInvalid(m.id)}>{t.team.memberInvalidRemove}</Button>
                        </div>
                      ))}
                    </div>}
              </div>
              <div>
                <div className="text-minor text-[var(--abu-text-muted)] mb-1">{t.team.detailPlanApproval}</div>
                <div className="text-body text-[var(--abu-text-secondary)]">
                  {detailTeam.requirePlanApproval ? t.team.detailPlanApprovalOn : t.team.detailPlanApprovalOff}
                </div>
              </div>
              {detailTeam.leaderNote?.trim() && (
                <div>
                  <div className="text-minor text-[var(--abu-text-muted)] mb-1">{t.team.detailLeaderNote}</div>
                  <div className="whitespace-pre-wrap text-body text-[var(--abu-text-secondary)]">{detailTeam.leaderNote.trim()}</div>
                </div>
              )}
              <div>
                <div className="text-minor text-[var(--abu-text-muted)]">{t.team.detailSkills}</div>
                <div className="text-caption text-[var(--abu-text-tertiary)] mb-1.5">{t.team.detailSkillsHint}</div>
                {skills.length === 0
                  ? <div className="text-caption text-[var(--abu-text-tertiary)]">{t.team.detailNoSkills}</div>
                  : <div className="flex flex-wrap gap-1">{skills.map((name) => (
                      <span key={name} className="rounded-md bg-[var(--abu-bg-muted)] px-2 py-0.5 text-caption text-[var(--abu-text-secondary)]">{name}</span>
                    ))}</div>}
              </div>
            </div>
          );
        })()}
      </ToolDetailModal>
      <ConfirmDialog
        open={!!confirmDeleteTeam}
        title={t.team.deleteTeamTitle}
        message={format(t.team.deleteTeamMessage, { name: confirmDeleteTeam?.name ?? '' })}
        confirmText={t.team.deleteTeamAction}
        cancelText={t.common.cancel}
        variant="danger"
        onCancel={() => setConfirmDeleteTeam(null)}
        onConfirm={() => {
          if (confirmDeleteTeam) useTeamStore.getState().deleteTeam(confirmDeleteTeam.id);
          setConfirmDeleteTeam(null);
          setDetailTeam(null);
        }}
      />
      <TeamEditDialog
        open={teamDialog.open}
        team={teamDialog.team}
        onClose={() => setTeamDialog({ open: false, team: null })}
        onSwitchToMembers={() => { setActiveTeamTab('members'); setManualCreateTrigger((c) => c + 1); }}
      />
    </div>
  );
}
