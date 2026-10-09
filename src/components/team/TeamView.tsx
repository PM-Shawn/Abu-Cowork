import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useSettingsStore, type TeamTab } from '@/stores/settingsStore';
import { getVisibleTeams, isReadOnlyTeam, selectVisibleTeams, useTeamStore, type Team } from '@/stores/teamStore';
import { pluginTeamOwner } from '@/core/team/pluginTeams';
import { useAppStore, useSelectedApp } from '@/stores/appStore';
import { GENERAL_APP_ID } from '@/types/app';
import { appMembers, appsUsing } from '@/core/app/appScope';
import { refCatalogFrom } from '@/core/app/appRefs';
import { pluginDisplayName } from '@/core/plugin/installedStore';
import SourceBadge from '@/components/toolbox/SourceBadge';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { usePluginStore } from '@/stores/pluginStore';
import { useChatStore } from '@/stores/chatStore';
import { prepareExpertEntry } from '@/core/team/expertEntry';
import { teamIdentity } from '@/core/team/expertContact';
import { getEnterpriseMount } from '@/core/enterprise/mounts-registry';
import { useToastStore } from '@/stores/toastStore';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import { agentRegistry } from '@/core/agent/registry';
import { ensureRoleId, effectiveRoleId, resolveRoleId, roleIdAgentName } from '@/core/team/roleIdentity';
import { isBuiltinTeam } from '@/core/team/builtinTeams';
import { useI18n, format } from '@/i18n';
import TopTabNav from '@/components/toolbox/TopTabNav';
import SourceSubNav from '@/components/toolbox/SourceSubNav';
import { sourceTabId } from '@/components/toolbox/extensionSource';
import { useExtensionSourceStore } from '@/stores/extensionSourceStore';
import TeamAvatar from './TeamAvatar';
import AgentAvatar from '@/components/common/AgentAvatar';
import AvatarPicker from '@/components/common/AvatarPicker';
import ToolboxCreateMenu from '@/components/toolbox/ToolboxCreateMenu';
import ToolDetailModal from '@/components/toolbox/ToolDetailModal';
import ToolCard from '@/components/toolbox/ToolCard';
import ToolGrid from '@/components/toolbox/ToolGrid';
import { cardOrNeighbour, cardPlace, cardProps, focusByTestId, type CardPlace } from '@/components/toolbox/cardFocus';
import AgentsSection from '@/components/customize/AgentsSection';
import { Button, IconButton } from '@/components/ds/button';
import { Combobox, MultiCombobox, type ComboboxOption } from '@/components/ds/combobox';
import { useConfirm } from '@/components/ds/confirm-context';
import { Dialog, DialogClose } from '@/components/ds/dialog';
import { EmptyState } from '@/components/ds/empty-state';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { InlineMessage } from '@/components/ds/inline-message';
import { Menu, MenuItem } from '@/components/ds/menu';
import { Pressable } from '@/components/ds/pressable';
import { SegmentedControl } from '@/components/ds/segmented-control';
import { StatusIcon } from '@/components/ds/status-icon';
import { Switch } from '@/components/ds/switch';
import { Tag } from '@/components/ds/tag';
import { TextArea } from '@/components/ds/text-area';
import { TextField } from '@/components/ds/text-field';
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

/** Matches the header search against a team's name, description and expertise. */
function matchesTeamSearch(team: Team, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [team.name, team.description, ...(team.expertise ?? [])]
    .some((text) => text?.toLowerCase().includes(q));
}

/**
 * Selectable member pool: every agent — user-defined AND marketplace/builtin
 * roles (user feedback 2026-08-31: office users组队 most often start from 市场
 * roles). 停用 only keeps an expert out of Abu's automatic delegation, so it
 * says nothing about who may be picked into a team.
 */
function useMemberPool(): SubagentDefinition[] {
  const agents = useDiscoveryStore((s) => s.agents);
  // getAgent hides every file-backed agent until plugin records are ready,
  // which at launch lands after discovery — so readiness is a dependency too.
  const pluginRecordsReady = usePluginStore((s) => s.activationReady);
  // Computed during render (not in an effect) so a readiness flip reaches the
  // edit dialog's re-seed in the same commit, with the pool it was waiting for.
  return useMemo(() => {
    const list: SubagentDefinition[] = [];
    for (const meta of agents) {
      const a = agentRegistry.getAgent(meta.name);
      if (!a) continue;
      if (a.name === 'abu' || a.managed) continue;
      list.push(a);
    }
    return list;
  }, [agents, pluginRecordsReady]); // eslint-disable-line react-hooks/exhaustive-deps
}

function roleLabel(agents: SubagentDefinition[], roleId: string, fallback: string): string {
  // Match the frontmatter `roleId` as well as the effective one: a team saved
  // before plugin agents got synthetic `plugin:<name>` ids still stores the
  // legacy `role-…` id for them. Without this the member drops out of the
  // picker (and can be re-added as a duplicate); with it the id self-heals —
  // saving rewrites the membership with `ensureRoleId`'s current id.
  return agents.find((a) => effectiveRoleId(a) === roleId || a.roleId === roleId)?.name ?? fallback;
}

function memberOption(a: SubagentDefinition): ComboboxOption {
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
      <span className="block truncate text-ui text-danger">{label}</span>
      <span className="block truncate text-caption text-label-tertiary">{reason}</span>
    </span>
  );
}

/**
 * Puts the focus on the team's card; once that card has gone, on the card that took its place,
 * else the one before it, else the empty shelf's own button, else the page's 「添加」 button.
 */
function focusTeamCard(root: ParentNode | null, place: CardPlace | null): void {
  const card = root && place ? cardOrNeighbour(root, 'team', place.id, place.index) : null;
  if (card) card.focus();
  else if (!root || !focusByTestId('teams-mine-create', root)) focusByTestId('team-create-trigger');
}

const FIELD_LABEL = 'block text-ui-sm font-medium text-label-secondary';
const FIELD_HINT = 'mt-1 text-caption text-label-tertiary';
const SECTION_LABEL = 'text-ui-sm text-label-tertiary';
const GROUP_BOX = 'rounded-control bg-fill px-3 py-2';

// ---------------------------------------------------------------- Team dialog

/** What the form held when it was seeded. The window asks before closing once the form differs from it. */
interface TeamDraft {
  name: string;
  leaderName: string;
  memberNames: string[];
  invalidMemberRoleIds: string[];
  leaderNote: string;
  requireApproval: boolean;
  avatar: string;
  description: string;
  intro: string;
  expertiseStr: string;
  samplePromptsStr: string;
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((value, index) => value === b[index]);

const sameDraft = (a: TeamDraft, b: TeamDraft) => a.name === b.name
  && a.leaderName === b.leaderName
  && sameList(a.memberNames, b.memberNames)
  && sameList(a.invalidMemberRoleIds, b.invalidMemberRoleIds)
  && a.leaderNote === b.leaderNote
  && a.requireApproval === b.requireApproval
  && a.avatar === b.avatar
  && a.description === b.description
  && a.intro === b.intro
  && a.expertiseStr === b.expertiseStr
  && a.samplePromptsStr === b.samplePromptsStr;

function TeamEditDialog({ open, onClose, team, onSwitchToMembers, onSaved, onCloseAutoFocus }: {
  open: boolean; onClose: () => void; team: Team | null; onSwitchToMembers: () => void;
  /** The team that was saved: the one edited, or the one just created. */
  onSaved: (teamId: string) => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  const { t } = useI18n();
  const addToast = useToastStore((s) => s.addToast);
  const refresh = useDiscoveryStore((s) => s.refresh);
  const createTeam = useTeamStore((s) => s.createTeam);
  const updateTeam = useTeamStore((s) => s.updateTeam);
  const agents = useMemberPool();
  const pluginRecordsReady = usePluginStore((s) => s.activationReady);

  const [name, setName] = useState('');
  const [leaderName, setLeaderName] = useState<string>('');
  const [memberNames, setMemberNames] = useState<string[]>([]);
  const [leaderNote, setLeaderNote] = useState('');
  const [requireApproval, setRequireApproval] = useState(false);
  const [avatar, setAvatar] = useState('');
  const [description, setDescription] = useState('');
  const [intro, setIntro] = useState('');
  const [expertiseStr, setExpertiseStr] = useState('');
  const [samplePromptsStr, setSamplePromptsStr] = useState('');
  const [saving, setSaving] = useState(false);
  // Members not offered by the picker fall into two very different buckets:
  // - hidden: the agent exists but is managed — still a real member, kept and
  //   written back untouched;
  // - invalid: no live agent answers to the roleId at all (deleted, or edited
  //   before role-id survived edits). Shown below the picker with a remove
  //   action; kept on save unless the user removes it — never dropped silently.
  const [hiddenMemberRoleIds, setHiddenMemberRoleIds] = useState<string[]>([]);
  const [invalidMemberRoleIds, setInvalidMemberRoleIds] = useState<string[]>([]);
  const [baseline, setBaseline] = useState<TeamDraft | null>(null);
  // The pool refreshes (new array identity) whenever discovery re-runs — including
  // ensureRoleId's own refresh during save. Seed from it once per open, via a ref,
  // so a refresh never wipes what the user has typed.
  const agentsRef = useRef(agents);
  useEffect(() => { agentsRef.current = agents; }, [agents]);

  // Which team the form was seeded for, and whether plugin records were ready
  // then. Before they are, file-backed experts resolve to nothing, so a dialog
  // opened during launch seeds real members as invalid; it is re-seeded once
  // when the records turn ready — never on a later ready→not-ready blip (a
  // plugin install), which would wipe what the user has typed.
  const seeded = useRef<{ team: Team | null; ready: boolean } | null>(null);
  useEffect(() => {
    if (!open) { seeded.current = null; return; }
    const prev = seeded.current;
    if (prev && prev.team === team && (prev.ready || !pluginRecordsReady)) return;
    seeded.current = { team, ready: pluginRecordsReady };
    const pool = agentsRef.current;
    const blank: TeamDraft = {
      name: '', leaderName: '', memberNames: [], invalidMemberRoleIds: [], leaderNote: '', requireApproval: false,
      avatar: '', description: '', intro: '', expertiseStr: '', samplePromptsStr: '',
    };
    let hidden: string[] = [];
    let draft = blank;
    if (team) {
      const members = team.memberRoleIds.filter((id) => id !== team.leaderRoleId);
      const notInPicker = members.filter((id) => !roleLabel(pool, id, ''));
      hidden = notInPicker.filter((id) => resolveRoleId(id) !== null);
      draft = {
        name: team.name,
        leaderName: roleLabel(pool, team.leaderRoleId, ''),
        memberNames: members.map((id) => roleLabel(pool, id, '')).filter(Boolean),
        invalidMemberRoleIds: notInPicker.filter((id) => resolveRoleId(id) === null),
        leaderNote: team.leaderNote ?? '',
        requireApproval: team.requirePlanApproval === true,
        avatar: team.avatar ?? '',
        description: team.description ?? '',
        intro: team.intro ?? '',
        expertiseStr: (team.expertise ?? []).join('\n'),
        samplePromptsStr: (team.samplePrompts ?? []).join('\n'),
      };
    }
    setName(draft.name);
    setLeaderName(draft.leaderName);
    setMemberNames(draft.memberNames);
    setHiddenMemberRoleIds(hidden);
    setInvalidMemberRoleIds(draft.invalidMemberRoleIds);
    setLeaderNote(draft.leaderNote);
    setRequireApproval(draft.requireApproval);
    setAvatar(draft.avatar);
    setDescription(draft.description);
    setIntro(draft.intro);
    setExpertiseStr(draft.expertiseStr);
    setSamplePromptsStr(draft.samplePromptsStr);
    setBaseline(draft);
  }, [open, team, pluginRecordsReady]);

  // The picker's options. Rows of the list are compared by the identity of their option, so the
  // same objects are handed over between renders.
  const options = useMemo(() => agents.map(memberOption), [agents]);
  const memberOptions = useMemo(() => options.filter((option) => option.value !== leaderName), [options, leaderName]);
  const pickedMembers = memberNames.filter((n) => n !== leaderName);

  const dirty = open && baseline !== null && !sameDraft(
    { name, leaderName, memberNames, invalidMemberRoleIds, leaderNote, requireApproval, avatar, description, intro, expertiseStr, samplePromptsStr },
    baseline,
  );

  // A leader whose agent is currently hidden keeps its roleId; the team stays editable.
  const leaderKept = !leaderName && !!team?.leaderRoleId;
  // Exact match, not case-insensitive: this mirrors the store's own rule
  // (`createTeam` / `updateTeam`), and a dialog that refused more than the
  // store does would block names the user can save from anywhere else.
  const nameTaken = getVisibleTeams().some((other) => other.id !== team?.id && other.name === name.trim());
  const handleSave = async () => {
    // The window stays on the page while it fades out; a key press there saves nothing.
    if (!open) return;
    if (!name.trim() || nameTaken || (!leaderName && !leaderKept) || saving) return;
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
      const expertise = expertiseStr.split('\n').map((line) => line.trim()).filter(Boolean);
      const samplePrompts = samplePromptsStr.split('\n').map((line) => line.trim()).filter(Boolean);
      const display = {
        description: description.trim() || undefined,
        intro: intro.trim() || undefined,
        expertise: expertise.length ? expertise : undefined,
        samplePrompts: samplePrompts.length ? samplePrompts : undefined,
      };
      if (team) {
        updateTeam(team.id, { name: name.trim(), leaderRoleId, memberRoleIds, leaderNote: leaderNote.trim() || undefined, requirePlanApproval: requireApproval, avatar: avatar.trim() || undefined, ...display });
        addToast({ type: 'success', title: t.team.teamSaved });
        onSaved(team.id);
      } else {
        const created = createTeam({ name: name.trim(), leaderRoleId, memberRoleIds, leaderNote: leaderNote.trim() || undefined, requirePlanApproval: requireApproval, avatar: avatar.trim() || undefined, ...display });
        // The new team is on the other shelf: go there, or the create reads as
        // a create that did nothing.
        useExtensionSourceStore.getState().setSource('teams', 'mine');
        addToast({ type: 'success', title: t.team.teamCreated });
        onSaved(created.id);
      }
      onClose();
    } catch (err) {
      addToast({ type: 'error', title: t.team.teamSaveFailed, message: String(err) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      title={team ? t.team.editTeam : t.team.newTeam}
      size="lg"
      closeButton
      dirty={dirty}
      // The window opens on the name, past the avatar button beside it.
      initialFocus={(box) => box.querySelector<HTMLElement>('input')}
      onCloseAutoFocus={onCloseAutoFocus}
      footer={(
        <>
          <DialogClose asChild><Button variant="plain">{t.common.cancel}</Button></DialogClose>
          <Button
            variant="primary"
            busy={saving}
            disabled={!name.trim() || nameTaken || (!leaderName && !leaderKept)}
            onClick={() => { void handleSave(); }}
            data-testid="team-save"
          >
            {team ? t.common.save : t.team.createTeamAction}
          </Button>
        </>
      )}
    >
      <div className="space-y-4">
        <div>
          <label htmlFor="team-name" className={FIELD_LABEL}>{t.team.fieldName}</label>
          <div className="mt-1 flex items-center gap-2">
            <AvatarPicker value={avatar} onChange={setAvatar}>
              <TeamAvatar avatar={avatar} size="lg" />
            </AvatarPicker>
            <TextField
              id="team-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t.team.fieldNamePlaceholder}
              invalid={nameTaken}
              className="min-w-0 flex-1"
              data-testid="team-name-input"
            />
          </div>
          {nameTaken && (
            <p className="mt-1 flex items-center gap-1 text-caption text-danger" data-testid="team-name-taken">
              <StatusIcon tone="danger" size="sm" />
              {t.team.nameTakenHint}
            </p>
          )}
        </div>

        {agents.length === 0 ? (
          <div className={`flex items-center justify-between gap-3 ${GROUP_BOX}`}>
            <span className="text-caption text-label-secondary">{t.team.noMembersYet}</span>
            {/* Never a dead end: creating the missing thing is one click away. */}
            <Button size="sm" variant="secondary" onClick={() => { onClose(); onSwitchToMembers(); }}>{t.team.createMemberNow}</Button>
          </div>
        ) : (
          <>
            {/* Two separate dropdowns (user feedback 2026-08-31): a single
                crown-in-list picker made the leader choice easy to miss. */}
            <div>
              {/* The combobox carries this text as its name. */}
              <div className={FIELD_LABEL}>{t.team.fieldLeader}</div>
              <div className={FIELD_HINT}>{t.team.fieldLeaderHint}</div>
              {/* A column stretches the combobox to the width of the form. */}
              <div className="mt-2 flex flex-col" data-testid="team-leader-select">
                <Combobox
                  label={t.team.fieldLeader}
                  value={leaderName}
                  onValueChange={(picked) => {
                    setLeaderName(picked);
                    setMemberNames((prev) => prev.filter((n) => n !== picked));
                  }}
                  options={options}
                  placeholder={t.team.leaderPlaceholder}
                  searchPlaceholder={t.team.searchPlaceholder}
                  emptyText={t.team.pickerEmpty}
                />
              </div>
            </div>
            <div>
              <div className={FIELD_LABEL}>{t.team.fieldMembers}</div>
              <div className={FIELD_HINT}>{t.team.fieldMembersHint}</div>
              <div className="mt-2 flex flex-col" data-testid="team-members-select">
                <MultiCombobox
                  label={t.team.fieldMembers}
                  values={pickedMembers}
                  onValuesChange={setMemberNames}
                  options={memberOptions}
                  placeholder={t.team.membersPlaceholder}
                  searchPlaceholder={t.team.searchPlaceholder}
                  emptyText={t.team.pickerEmpty}
                />
              </div>
            </div>
          </>
        )}
        {/* Outside the pool branch: a team whose every agent is gone still
            needs its ghosts listed — and removable — while the pool is empty. */}
        {invalidMemberRoleIds.length > 0 && (
          <div className={`space-y-2 ${GROUP_BOX}`}>
            <div className="text-caption text-label-secondary">{t.team.editInvalidMembers}</div>
            {invalidMemberLabels(invalidMemberRoleIds, t.team.memberInvalidNamed, t.team.memberInvalidNumbered).map(({ id, label }) => {
              return (
                <div key={id} className="flex items-center gap-2" data-testid={`team-edit-invalid-${id}`}>
                  <Icon icon={AppIcons.agent} className="text-label-tertiary" />
                  <InvalidMemberText label={label} reason={t.team.memberInvalidReason} />
                  <IconButton
                    size="sm"
                    icon={AppIcons.remove}
                    label={t.team.memberInvalidRemove}
                    onClick={() => setInvalidMemberRoleIds((prev) => prev.filter((x) => x !== id))}
                    data-testid={`team-edit-invalid-remove-${id}`}
                  />
                </div>
              );
            })}
          </div>
        )}

        <div className={`flex items-center justify-between gap-3 ${GROUP_BOX}`}>
          <div className="min-w-0">
            <div className="text-ui text-label">{t.team.fieldPlanApproval}</div>
            <div className="text-caption text-label-tertiary">{t.team.fieldPlanApprovalHint}</div>
          </div>
          <Switch checked={requireApproval} onCheckedChange={setRequireApproval} aria-label={t.team.fieldPlanApproval} />
        </div>

        <div>
          <label htmlFor="team-leader-note" className={FIELD_LABEL}>{t.team.fieldLeaderNote}</label>
          {/* Tell the user exactly how this text is used — mechanism, not mystery. */}
          <div className={FIELD_HINT}>{t.team.fieldLeaderNoteHint}</div>
          <TextArea id="team-leader-note" value={leaderNote} onChange={(e) => setLeaderNote(e.target.value)} rows={2} className="mt-2" placeholder={t.team.fieldLeaderNotePlaceholder} />
        </div>

        <div>
          <label htmlFor="team-description" className={FIELD_LABEL}>{t.team.fieldDescription}</label>
          <TextField id="team-description" value={description} onChange={(e) => setDescription(e.target.value)} className="mt-1" placeholder={t.team.fieldDescriptionPlaceholder} />
        </div>
        <div>
          <label htmlFor="team-intro" className={FIELD_LABEL}>{t.team.fieldIntro}</label>
          <TextArea id="team-intro" value={intro} onChange={(e) => setIntro(e.target.value)} placeholder={t.toolbox.agentIntroPlaceholder} rows={3} className="mt-1" />
        </div>
        <div>
          <label htmlFor="team-expertise" className={FIELD_LABEL}>{t.team.fieldExpertise}</label>
          <TextArea id="team-expertise" value={expertiseStr} onChange={(e) => setExpertiseStr(e.target.value)} rows={3} className="mt-1" placeholder={t.team.fieldLinesHint} />
        </div>
        <div>
          <label htmlFor="team-sample-prompts" className={FIELD_LABEL}>{t.team.fieldSamplePrompts}</label>
          <TextArea id="team-sample-prompts" value={samplePromptsStr} onChange={(e) => setSamplePromptsStr(e.target.value)} rows={3} className="mt-1" placeholder={t.team.fieldSamplePromptsHint} />
        </div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- Team card

/**
 * One card of the shelf, the same grid and card the 专家 tab uses: a team and a
 * member are peers in this surface. `memo` with stable props: the page renders
 * for every window it opens and every character typed in its search box, and
 * the cards do not render with it.
 */
const TeamCard = memo(function TeamCard({ team, description, pluginName, onOpen }: {
  team: Team;
  description: string;
  /** The display name of the plugin that brought the team in, when one did. */
  pluginName: string | undefined;
  onOpen: (teamId: string) => void;
}) {
  return (
    <div className="h-full" {...cardProps('team', team.id)}>
      <ToolCard
        item={{
          id: team.id,
          testId: `team-row-${team.name}`,
          name: team.name,
          description,
          avatar: <TeamAvatar avatar={team.avatar} size="xl" />,
          badge: pluginName !== undefined ? <SourceBadge source={{ kind: 'plugin', plugin: pluginName }} /> : undefined,
        }}
        onClick={() => onOpen(team.id)}
      />
    </div>
  );
});

// ---------------------------------------------------------------- Team detail

/**
 * What the team's window shows: read-only, apart from removing a member no
 * expert answers to. It resolves the team's roles each time the page renders,
 * and the page renders when the roster or the plugin records change.
 */
function TeamDetailBody({ team, pluginName, onStartChat }: {
  team: Team;
  /** The display name of the plugin that brought the team in, when one did. */
  pluginName: string | undefined;
  onStartChat: (prompt: string) => void;
}) {
  const { t } = useI18n();
  const memberIds = team.memberRoleIds.filter((id) => id !== team.leaderRoleId);
  // Same predicate the run uses (resolveRoleId), so the count here never
  // disagrees with the "队员 · N" the workspace tab shows mid-run.
  const leader = resolveRoleId(team.leaderRoleId) ?? undefined;
  const leaderGhostName = leader ? undefined : roleIdAgentName(team.leaderRoleId);
  const members = memberIds.map((id) => ({ id, agent: resolveRoleId(id) ?? undefined }));
  const validMembers = members.filter((m) => m.agent);
  const invalidMembers = invalidMemberLabels(members.filter((m) => !m.agent).map((m) => m.id), t.team.memberInvalidNamed, t.team.memberInvalidNumbered);
  // The window shows the team as the store holds it, so the row leaves the list with the store's change.
  const removeInvalid = (roleId: string) => {
    useTeamStore.getState().updateTeam(team.id, { memberRoleIds: team.memberRoleIds.filter((id) => id !== roleId) });
  };
  // Skills live on each member, not on the team — the union answers
  // "what can this team actually do" without opening every member.
  const skills = [...new Set([leader, ...members.map((m) => m.agent)]
    .flatMap((a) => a?.skills ?? []))].sort();
  // A row names an expert and does nothing else, so it is a plain row.
  const row = (agent: SubagentDefinition | undefined, fallback: string) => {
    return (
      <div className="flex w-full items-center gap-2 rounded-control px-2 py-1">
        {agent ? <AgentAvatar agent={agent} size="sm" /> : <Icon icon={AppIcons.agent} className="text-label-tertiary" />}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-ui text-label">{agent?.name ?? fallback}</span>
          {agent?.description && <span className="block truncate text-caption text-label-tertiary">{agent.description}</span>}
        </span>
      </div>
    );
  };
  return (
    <div className="space-y-5">
      {pluginName !== undefined && (
        <div className="text-caption text-label-tertiary" data-testid="team-plugin-origin">
          {format(t.toolbox.itemFromPluginRemoveHint, { plugin: pluginName })}
        </div>
      )}
      {team.managed?.ready === false && (
        <div data-testid="team-managed-unavailable">
          <InlineMessage tone="danger">
            <div className="font-medium">{t.team.detailUnavailable}</div>
            {team.managed.unavailableReason && <div className="mt-1 text-ui-sm">{team.managed.unavailableReason}</div>}
          </InlineMessage>
        </div>
      )}
      <div>
        <div className={`mb-1 ${SECTION_LABEL}`}>{t.team.detailLeader}</div>
        {leader
          ? row(leader, t.team.memberInvalid)
          : (
            // Same two-line ghost as the members below, named when the id
            // carries a name. No 移除: a leader is replaced via 编辑.
            <div className="flex w-full items-center gap-2 rounded-control px-2 py-1" data-testid="team-leader-invalid">
              <Icon icon={AppIcons.agent} className="text-label-tertiary" />
              <InvalidMemberText
                label={leaderGhostName ? format(t.team.memberInvalidNamed, { name: leaderGhostName }) : t.team.memberInvalidShort}
                reason={t.team.memberInvalidReason}
              />
            </div>
          )}
      </div>
      <div>
        <div className={`mb-1 ${SECTION_LABEL}`}>{format(t.team.detailMembers, { count: String(validMembers.length) })}</div>
        {validMembers.length === 0 && invalidMembers.length === 0
          ? <div className="text-caption text-label-tertiary">{t.team.detailNoMembers}</div>
          : <div className="space-y-1">
              {validMembers.map((m) => <div key={m.id}>{row(m.agent, t.team.memberInvalid)}</div>)}
              {invalidMembers.map((m) => (
                <div key={m.id} className="flex w-full items-center gap-2 rounded-control px-2 py-1" data-testid={`team-member-invalid-${m.id}`}>
                  <Icon icon={AppIcons.agent} className="text-label-tertiary" />
                  <InvalidMemberText label={m.label} reason={t.team.memberInvalidReason} />
                  {!isReadOnlyTeam(team) && <Button size="sm" variant="plain" onClick={() => removeInvalid(m.id)}>{t.team.memberInvalidRemove}</Button>}
                </div>
              ))}
            </div>}
      </div>
      <div>
        <div className={`mb-1 ${SECTION_LABEL}`}>{t.team.detailPlanApproval}</div>
        <div className="text-ui text-label-secondary">
          {team.requirePlanApproval ? t.team.detailPlanApprovalOn : t.team.detailPlanApprovalOff}
        </div>
      </div>
      {team.leaderNote?.trim() && (
        <div>
          <div className={`mb-1 ${SECTION_LABEL}`}>{t.team.detailLeaderNote}</div>
          <div className="whitespace-pre-wrap text-ui text-label-secondary">{team.leaderNote.trim()}</div>
        </div>
      )}
      {!!team.expertise?.length && (
        <div>
          <div className={SECTION_LABEL}>{t.team.detailExpertise}</div>
          <ul className="mt-2 space-y-1">
            {team.expertise.map((item, index) => (
              <li key={index} className="flex items-start gap-2 text-ui text-label">
                <span className="flex h-5 shrink-0 items-center"><Icon icon={AppIcons.done} size="sm" className="text-label-tertiary" /></span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {!!team.samplePrompts?.length && (
        <div>
          <div className={SECTION_LABEL}>{t.team.detailSamplePrompts}</div>
          <ul className="mt-2 space-y-2">
            {team.samplePrompts.map((prompt, index) => (
              <li key={index}>
                <Pressable
                  onClick={() => onStartChat(prompt)}
                  className="flex w-full items-center gap-2 rounded-control border border-separator px-3 py-2 text-left text-ui text-label-secondary hover:bg-fill-hover"
                >
                  {prompt}
                </Pressable>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <div className={SECTION_LABEL}>{t.team.detailSkills}</div>
        <div className="mb-2 text-caption text-label-tertiary">{t.team.detailSkillsHint}</div>
        {skills.length === 0
          ? <div className="text-caption text-label-tertiary">{t.team.detailNoSkills}</div>
          : <div className="flex flex-wrap gap-1">{skills.map((name) => <Tag key={name}>{name}</Tag>)}</div>}
      </div>
    </div>
  );
}

/** The element the source sub-nav switches between — one pane here, since the
 *  两 tabs swap their content rather than keeping a panel each. */
const TEAM_PANEL_ID = 'team-source-panel';

/**
 * The page takes no props and reads each store one field at a time: the shell
 * renders for every piece of a streamed reply, and this page, with the menus,
 * windows and tooltips it mounts, does not render with it.
 */
function TeamView() {
  const persistedTeamTab = useSettingsStore((s) => s.activeTeamTab);
  const setActiveTeamTab = useSettingsStore((s) => s.setActiveTeamTab);
  // A stale persisted value (e.g. the removed 'pipelines' tab) falls back to
  // the default tab instead of rendering an empty pane.
  const activeTeamTab: TeamTab = persistedTeamTab === 'teams' ? 'teams' : 'members';
  const { t } = useI18n();
  const confirm = useConfirm();
  // 市场 | 我的 per tab, remembered across restarts (shared with 扩展's store —
  // the two pages show the same pair over different rosters).
  const sources = useExtensionSourceStore((s) => s.sources);
  const setSource = useExtensionSourceStore((s) => s.setSource);
  const teams = useTeamStore((s) => s.teams);
  const managedTeamSources = useTeamStore((s) => s.managedTeamSources);
  // Roles resolve through the agent registry, which is not a React-reactive
  // source; subscribe to discovery so the card grid re-renders when the roster
  // changes (same reason useConversationTeam subscribes — useTeamDispatches.ts).
  const discoveredAgents = useDiscoveryStore((s) => s.agents);
  // …and file-backed experts only resolve once plugin records are ready, which
  // at launch lands after discovery: re-render the cards and the open detail then.
  const pluginRecordsReady = usePluginStore((s) => s.activationReady);
  const installedPlugins = usePluginStore((s) => s.installed);
  const startNewConversation = useChatStore((s) => s.startNewConversation);
  const setPendingInput = useChatStore((s) => s.setPendingInput);
  const closeTeam = useSettingsStore((s) => s.closeTeam);
  const enterpriseMode = useEnterpriseStore((s) => s.mode);
  const enterpriseBinding = enterpriseMode.kind === 'enterprise' || enterpriseMode.kind === 'offline'
    ? enterpriseMode.binding
    : null;
  const enterpriseConfig = enterpriseMode.kind === 'enterprise'
    ? enterpriseMode.config
    : enterpriseMode.kind === 'offline'
      ? enterpriseMode.lastConfig
      : null;
  const OrganizationAgents = getEnterpriseMount('agentMarket');

  // One local box for both tabs. It used to write into the toolbox's shared
  // query so AgentsSection would filter; that surface is now Extensions, whose
  // query belongs to another view — AgentsSection takes ours as a prop instead.
  const [search, setSearch] = useState('');
  const [manualCreateTrigger, setManualCreateTrigger] = useState(0);
  // The edit window keeps the team it held while it fades out; the next opening says which team it is for.
  const [teamDialog, setTeamDialog] = useState<{ open: boolean; team: Team | null }>({ open: false, team: null });
  const [detailTeamId, setDetailTeamId] = useState<string | null>(null);

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

  // Inside an app the page opens on 「本应用」: the experts and teams the app's
  // scenes hand work to (product spec §5.5).
  const selectedApp = useSelectedApp();
  const inApp = selectedApp.appId !== GENERAL_APP_ID;
  const [appScope, setAppScope] = useState<'app' | 'all'>('app');
  const scopedToApp = inApp && appScope === 'app';
  const visibleTeams = useMemo(() => selectVisibleTeams({ teams, managedTeamSources }), [teams, managedTeamSources]);
  // The members are resolved against the live teams, experts and plugins, so
  // they are recomputed whenever any of them changes.
  const pluginActivations = usePluginStore((s) => s.activationByKey);
  const discoveredSkills = useDiscoveryStore((s) => s.skills);
  const members = useMemo(() => (scopedToApp
    ? appMembers(selectedApp, refCatalogFrom({ installed: installedPlugins, activations: pluginActivations, teams, managedTeamSources, agents: discoveredAgents, skills: discoveredSkills }))
    : undefined), [scopedToApp, selectedApp, installedPlugins, pluginActivations, teams, managedTeamSources, discoveredAgents, discoveredSkills]);
  const activeTeams = useMemo(
    () => (members ? visibleTeams.filter((team) => members.teamIds.has(team.id)) : visibleTeams),
    [visibleTeams, members],
  );
  const agentFilter = useMemo(() => (members ? (agent: SubagentDefinition) => members.agentNames.has(agent.name) : undefined), [members]);
  const scopeOptions = useMemo(() => [
    { value: 'app', label: t.team.appScopeThis },
    { value: 'all', label: t.team.appScopeAll },
  ], [t]);

  // The team whose window is open, as the store holds it now: an edit made elsewhere shows in the
  // open window, and a team that leaves the store takes its window with it.
  const detailTeam = detailTeamId === null ? null : visibleTeams.find((team) => team.id === detailTeamId) ?? null;
  // The detail window keeps showing the team it held while it fades out.
  const [held, setHeld] = useState<Team | null>(null);
  if (detailTeam && detailTeam !== held) setHeld(detailTeam);
  const shown = detailTeam ?? held;
  const shownOwner = shown ? pluginTeamOwner(shown) : undefined;

  const rootRef = useRef<HTMLDivElement>(null);
  // What the handlers read: the team whose window is open, and whether one of the page's windows is open.
  const detailRef = useRef<string | null>(null);
  const windowOpen = useRef(false);
  useLayoutEffect(() => {
    detailRef.current = detailTeam ? detailTeam.id : null;
    windowOpen.current = detailTeam !== null || teamDialog.open;
  });

  // The card whose windows are open (detail, then the edit window). The window that closes last
  // may have opened from a control that is gone: the focus then goes back to the card, or to what
  // took its place once it has gone.
  const opener = useRef<CardPlace | null>(null);
  const openDetail = useCallback((teamId: string) => {
    opener.current = cardPlace(rootRef.current, 'team', teamId);
    setDetailTeamId(teamId);
  }, []);
  const afterWindowClosed = (event: Event) => {
    // Another layer took the focus, or no card opened this window: the control that opened it gets the focus back.
    if (event.defaultPrevented || !opener.current) return;
    event.preventDefault();
    // Another window of the page is open: the focus is its own.
    if (windowOpen.current) return;
    focusTeamCard(rootRef.current, opener.current);
  };

  // The control a new team's window was opened from. The empty shelf's button leaves the page
  // with the first team: the focus then goes to that team's card.
  const editorEntry = useRef<Element | null>(null);
  const openTeamEditor = (team: Team | null) => {
    if (team === null) {
      opener.current = null;
      editorEntry.current = document.activeElement;
    }
    setTeamDialog({ open: true, team });
  };
  const afterEditorClosed = (event: Event) => {
    if (opener.current) { afterWindowClosed(event); return; }
    const from = editorEntry.current;
    editorEntry.current = null;
    if (event.defaultPrevented || windowOpen.current) return;
    if (from instanceof HTMLElement && from !== document.body && from.isConnected) return;
    event.preventDefault();
    focusTeamCard(rootRef.current, null);
  };

  // Prepare a draft; opening an expert never creates an empty history entry.
  const startChatWithTeam = (team: Team, prompt?: string) => {
    // The window stays on the page while it fades out; a key press there starts nothing.
    if (detailRef.current !== team.id) return;
    prepareExpertEntry({ identity: teamIdentity(team), introduction: team.intro }, prompt);
    setDetailTeamId(null);
    closeTeam();
  };

  // Deleting a team cannot be taken back, so it is asked first, naming the team. The question is
  // asked over the open window, which answers it "no" when it goes. The answer acts on the store
  // as it is at that moment: nothing is deleted once the team has left it.
  const requestDelete = async (team: Team) => {
    // The window stays on the page while it fades out; a choice made there asks nothing.
    if (detailRef.current !== team.id) return;
    // An app scene can name one of the user's own teams; deleting it leaves that scene without an owner.
    const usedBy = appsUsing(useAppStore.getState().addedApps, { kind: 'team', id: team.id });
    const confirmed = await confirm({
      title: t.team.deleteTeamTitle,
      message: [
        format(t.team.deleteTeamMessage, { name: team.name }),
        usedBy.length > 0 ? format(t.toolbox.usedByApps, { names: usedBy.map((app) => app.name).join('、') }) : '',
      ].join(''),
      confirmLabel: t.team.deleteTeamAction,
      tone: 'danger',
    });
    if (!confirmed) return;
    if (!useTeamStore.getState().teams.some((candidate) => candidate.id === team.id)) return;
    useTeamStore.getState().deleteTeam(team.id);
    setDetailTeamId(null);
  };

  // The detail window's 「…」 menu. Both entries lead to something that takes the focus, so each
  // runs once the menu has gone; opening the menu forgets a choice its close hook never ran for.
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const pendingMenuAction = useRef<(() => void) | null>(null);

  // `_agents` / `_ready` are unused by value — they exist only to make
  // `discoveredAgents` and `pluginRecordsReady` visible inputs of this derived
  // text, so the subscriptions aren't dead code from the compiler's point of view.
  // The card's leader slot is one segment of a ` · ` summary line, so it takes
  // the short label; the explanatory clause lives in the detail and the editor.
  const cardSummary = (team: Team, _agents: typeof discoveredAgents, _ready: boolean) => {
    const count = team.memberRoleIds.filter((id) => id !== team.leaderRoleId && resolveRoleId(id) !== null).length;
    return format(count === 1 ? t.team.teamRowSummaryOne : t.team.teamRowSummary, {
      leader: resolveRoleId(team.leaderRoleId)?.name ?? t.team.memberInvalidShort,
      count: String(count),
    });
  };

  const navItems = [
    { id: 'members' as TeamTab, label: t.team.tabMembers, icon: AppIcons.agent },
    { id: 'teams' as TeamTab, label: t.team.tabTeams, icon: AppIcons.team },
  ];

  // AI-create for 队员 reuses the toolbox idiom: jump to chat with a crafted prompt.
  const handleAICreateTeam = () => {
    closeTeam();
    startNewConversation();
    setPendingInput(t.team.aiCreateTeamPrompt, { startsTask: true });
  };

  const handleAICreateMember = () => {
    closeTeam();
    startNewConversation();
    setPendingInput(t.toolbox.aiCreateAgentPrompt, { startsTask: true });
  };

  const renderHeaderRight = () => {
    const searchBox = (
      <div className="relative w-52 shrink-0">
        <Icon icon={AppIcons.search} size="sm" className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-label-tertiary" />
        <TextField
          aria-label={t.team.searchPlaceholder}
          placeholder={t.team.searchPlaceholder}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-7"
        />
      </div>
    );

    // The organization's catalog is the administrator's to edit, so the shelf
    // showing it carries no create control.
    const canCreateHere = !(enterpriseBinding && sources[activeTeamTab] === 'market'
      && (activeTeamTab === 'teams' || OrganizationAgents));
    let createControl: ReactNode = null;
    if (canCreateHere && activeTeamTab === 'members') {
      createControl = (
        <ToolboxCreateMenu
          onAICreate={handleAICreateMember}
          onManualCreate={() => setManualCreateTrigger((c) => c + 1)}
          triggerTestId="member-create-trigger"
        />
      );
    } else if (canCreateHere && activeTeamTab === 'teams') {
      createControl = (
        <ToolboxCreateMenu
          onAICreate={handleAICreateTeam}
          onManualCreate={() => openTeamEditor(null)}
          triggerTestId="team-create-trigger"
          menuTestId="team-create-menu"
        />
      );
    }
    return <>{searchBox}{createControl}</>;
  };

  const renderContent = () => {
    switch (activeTeamTab) {
      case 'members': {
        // A bound client's 「市场」 is the organization's expert catalog, the
        // same way it already is for skills, connectors and plugins. The slot
        // is optional, so a build without one falls through to Abu's own
        // shelf.
        if (sources.members === 'market' && OrganizationAgents && enterpriseBinding) {
          return (
            <OrganizationAgents
              binding={enterpriseBinding}
              config={enterpriseConfig}
              searchQuery={search}
              onClose={closeTeam}
            />
          );
        }
        // Single identity source: this IS the toolbox agents surface.
        return <AgentsSection manualCreateTrigger={manualCreateTrigger} searchQuery={search} source={sources.members} filter={agentFilter} />;
      }
      case 'teams': {
        const source = sources.teams;
        // One shelf at a time — which one is the sub-nav's job to say, so the
        // group heading that used to name it here is gone. 「市场」 names
        // whoever is offering: the organization's teams in a bound client, the
        // teams Abu ships otherwise. 「我的」 is the ones this user has:
        // assembled themselves, or brought in by a plugin they installed
        // (badged, read-only).
        const list = source === 'mine'
          ? activeTeams.filter((team) => !isBuiltinTeam(team) && !team.managed)
          : enterpriseBinding
            ? activeTeams.filter((team) => !!team.managed)
            : activeTeams.filter(isBuiltinTeam);
        const card = (team: Team) => {
          const owner = pluginTeamOwner(team);
          return (
            <TeamCard
              key={team.id}
              team={team}
              description={team.description || cardSummary(team, discoveredAgents, pluginRecordsReady)}
              pluginName={owner ? pluginDisplayName(installedPlugins, owner) : undefined}
              onOpen={openDetail}
            />
          );
        };
        const shown = list.filter((team) => matchesTeamSearch(team, search));
        return (
          <div className="h-full overflow-y-scroll overlay-scroll px-8 pt-3 pb-6">
            {source === 'mine' && list.length === 0 ? (
              <div className="py-8">
                <EmptyState
                  icon={AppIcons.team}
                  title={t.team.teamsEmpty}
                  description={t.team.teamsEmptyHint}
                  action={<Button variant="secondary" data-testid="teams-mine-create" onClick={() => openTeamEditor(null)}>{t.team.newTeam}</Button>}
                />
              </div>
            ) : shown.length === 0 && search.trim() ? (
              <div className="py-8"><EmptyState icon={AppIcons.team} title={t.team.teamsNotFound} /></div>
            ) : (
              <div className="max-w-5xl mx-auto">
                <ToolGrid>{shown.map(card)}</ToolGrid>
              </div>
            )}
          </div>
        );
      }
    }
  };

  return (
    // No fill of its own: the page shows the surface of the card the shell puts it on.
    <div ref={rootRef} className="flex h-full flex-col">
      <TopTabNav items={navItems} activeId={activeTeamTab} onSelect={setActiveTeamTab} belowChrome right={renderHeaderRight()} />
      {/* 市场 | 我的 — one row, directly under the tabs and inset to the same
          grid the cards use, exactly as on 扩展. */}
      <div className="px-8"><div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
        <SourceSubNav
          value={sources[activeTeamTab]}
          onChange={(next) => setSource(activeTeamTab, next)}
          marketLabel={t.toolbox.sourceMarket}
          mineLabel={t.toolbox.categoryMine}
          testIdPrefix="team-source"
          panelId={TEAM_PANEL_ID}
        />
        {inApp && (
          <span data-testid="team-app-scope" className="flex shrink-0">
            <SegmentedControl
              label={selectedApp.name}
              value={appScope}
              onValueChange={(next) => setAppScope(next === 'all' ? 'all' : 'app')}
              options={scopeOptions}
            />
          </span>
        )}
      </div></div>
      <div
        id={TEAM_PANEL_ID}
        role="tabpanel"
        aria-labelledby={sourceTabId(sources[activeTeamTab], 'team-source')}
        className="flex-1 overflow-hidden"
      >{renderContent()}</div>
      {/* Team detail — same shell and header grammar as the 队员 detail:
          read-only body, the primary action in the footer, "…" (edit / delete)
          in the header. Opening a team used to jump straight into the edit form,
          which is why 团队 felt unlike every other list in the app. */}
      <ToolDetailModal
        open={!!detailTeam}
        ariaLabel={shown?.name}
        onClose={() => setDetailTeamId(null)}
        onCloseAutoFocus={afterWindowClosed}
        maxWidth="max-w-2xl"
        avatar={shown ? <TeamAvatar avatar={shown.avatar} size="2xl" /> : undefined}
        title={shown?.name}
        subtitle={shown?.description?.trim()}
        // Primary action in the footer — the same place and weight as on the
        // plugin and connector details. The header keeps only the 「…」 menu.
        footer={shown ? (
          <Button
            variant="primary"
            size="sm"
            icon={AppIcons.startChat}
            onClick={() => startChatWithTeam(shown)}
            disabled={shown.managed?.ready === false}
            data-testid="team-detail-start-chat"
          >
            {t.team.detailStartChat}
          </Button>
        ) : undefined}
        headerActions={shown && !isReadOnlyTeam(shown) ? (
          <Menu
            align="end"
            onOpenChange={(open) => { if (open) pendingMenuAction.current = null; }}
            onCloseAutoFocus={(event) => {
              const pending = pendingMenuAction.current;
              pendingMenuAction.current = null;
              if (!pending) return;
              event.preventDefault();
              menuTrigger.current?.focus();
              pending();
            }}
            trigger={(
              <IconButton
                ref={menuTrigger}
                icon={AppIcons.more}
                label={format(t.toolbox.itemMenuLabel, { name: shown.name })}
                data-testid="team-detail-menu"
              />
            )}
          >
            <MenuItem
              icon={AppIcons.rename}
              testId="team-detail-edit"
              onSelect={() => {
                pendingMenuAction.current = () => {
                  // The window stays on the page while it fades out; a choice made there opens nothing.
                  if (detailRef.current !== shown.id) return;
                  // One window at a time: the edit window takes the place of the detail window.
                  openTeamEditor(shown);
                  setDetailTeamId(null);
                };
              }}
            >
              {t.team.detailEdit}
            </MenuItem>
            <MenuItem
              tone="danger"
              icon={AppIcons.delete}
              testId="team-detail-delete"
              onSelect={() => { pendingMenuAction.current = () => { void requestDelete(shown); }; }}
            >
              {t.team.deleteTeamAction}
            </MenuItem>
          </Menu>
        ) : undefined}
      >
        {shown && <TeamDetailBody team={shown} pluginName={shownOwner ? pluginDisplayName(installedPlugins, shownOwner) : undefined} onStartChat={(prompt) => startChatWithTeam(shown, prompt)} />}
      </ToolDetailModal>
      <TeamEditDialog
        open={teamDialog.open}
        team={teamDialog.team}
        onClose={() => setTeamDialog((current) => ({ ...current, open: false }))}
        onSwitchToMembers={() => { setActiveTeamTab('members'); setManualCreateTrigger((c) => c + 1); }}
        // The saved team's card is where the focus goes once the window has closed.
        onSaved={(teamId) => { if (!opener.current) opener.current = { id: teamId, index: -1 }; }}
        onCloseAutoFocus={afterEditorClosed}
      />
    </div>
  );
}

export default memo(TeamView);
