import { memo, useCallback, useState, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useExtensionsSearchQuery, useSettingsStore } from '@/stores/settingsStore';
import { prepareExpertEntry } from '@/core/team/expertEntry';
import { expertIdentity } from '@/core/team/expertContact';
import { useI18n, format } from '@/i18n';
import { agentRegistry } from '@/core/agent/registry';
import AgentEditor from './AgentEditor';
import { Button, IconButton } from '@/components/ds/button';
import { useConfirm } from '@/components/ds/confirm-context';
import { EmptyState } from '@/components/ds/empty-state';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Menu, MenuItem } from '@/components/ds/menu';
import { Pressable } from '@/components/ds/pressable';
import { Switch } from '@/components/ds/switch';
import { Tag } from '@/components/ds/tag';
import AgentAvatar from '@/components/common/AgentAvatar';
import { remove } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import { getParentDir } from '@/utils/pathUtils';
import type { SubagentDefinition } from '@/types';
import MarkdownRenderer from '@/components/chat/MarkdownRenderer';
import { getAgentToolSummary } from '@/utils/agentToolPresentation';
import { isPluginOwnedAgent } from '@/utils/agentSource';
import { isBuiltinAgentPath } from '@/core/agent/builtinAgent';
import { pluginDisplayName } from '@/core/plugin/installedStore';
import { usePluginStore } from '@/stores/pluginStore';
import SourceBadge from '@/components/toolbox/SourceBadge';
import { getAllTools } from '@/core/tools/registry';
import ToolCard from '@/components/toolbox/ToolCard';
import ToolGrid from '@/components/toolbox/ToolGrid';
import ToolDetailModal from '@/components/toolbox/ToolDetailModal';
import { cardOrNeighbour, cardPlace, cardProps, focusByTestId, focusIsOnWindow, type CardPlace } from '@/components/toolbox/cardFocus';
import { useTeamStore } from '@/stores/teamStore';
import { effectiveRoleId } from '@/core/team/roleIdentity';
import type { ExtensionSource } from '@/components/toolbox/extensionSource';
import { useExtensionSourceStore } from '@/stores/extensionSourceStore';

/** 市场 = shipped with the app. Everything else — the user's own experts and the ones their plugins brought — is 「我的」. */
function isSystemAgent(agent: SubagentDefinition): boolean {
  return isBuiltinAgentPath(agent.filePath);
}

/**
 * Editable = the user's own file. A plugin's expert sits under 「我的」 with a
 * provenance badge, but an edit would be overwritten by the next plugin
 * update and removing it belongs to uninstalling the plugin.
 */
function isEditableAgent(agent: SubagentDefinition): boolean {
  return !isSystemAgent(agent) && !isPluginOwnedAgent(agent);
}


/** Display name: locale-aware. Falls back to canonical `name` if no override. */
function displayName(agent: SubagentDefinition, locale: 'zh-CN' | 'en-US'): string {
  if (agent.name === 'abu') return 'Abu';
  return agent.displayNames?.[locale] ?? agent.name;
}

/** Locale-aware accessor for any field that has a `*I18n` companion. */
function localizedDescription(agent: SubagentDefinition, locale: 'zh-CN' | 'en-US'): string {
  return agent.descriptions?.[locale] ?? agent.description;
}
function localizedIntro(agent: SubagentDefinition, locale: 'zh-CN' | 'en-US'): string | undefined {
  return agent.intros?.[locale] ?? agent.intro;
}
function localizedExpertise(agent: SubagentDefinition, locale: 'zh-CN' | 'en-US'): string[] | undefined {
  return agent.expertiseI18n?.[locale] ?? agent.expertise;
}
function localizedSamplePrompts(agent: SubagentDefinition, locale: 'zh-CN' | 'en-US'): string[] | undefined {
  return agent.samplePromptsI18n?.[locale] ?? agent.samplePrompts;
}

/**
 * Puts the focus on the expert's card; once that card has gone, on the card that took its place,
 * else the one before it, else the empty shelf's own button, else the page's 「添加」 button.
 */
function focusExpertCard(root: ParentNode | null, place: CardPlace | null): void {
  const card = root && place ? cardOrNeighbour(root, 'expert', place.id, place.index) : null;
  if (card) card.focus();
  else if (!root || !focusByTestId('agents-mine-create', root)) focusByTestId('member-create-trigger');
}

const SECTION_LABEL = 'text-ui-sm text-label-tertiary';

/**
 * One card of the shelf. `memo` with stable props: the page renders for every window it opens
 * and every character typed in its search box, and the cards do not render with it.
 *
 * The card carries no tool count or source line — both live in the detail
 * view — so the name keeps the row's width at four columns. What is left is
 * reporting: a tools field Abu could not read, and — since the switch moved
 * into the detail — a quiet tag when Abu may not hand this expert work on
 * its own. No switch here: on the card it read as a kill switch, which is
 * not what it does.
 */
const ExpertCard = memo(function ExpertCard({ agent, name, description, offAutoDispatch, invalidTools, pluginName, onOpen }: {
  agent: SubagentDefinition;
  name: string;
  description: string;
  /** Abu may not hand this expert work on its own. */
  offAutoDispatch: boolean;
  /** The expert's tools field could not be read. */
  invalidTools: boolean;
  /** The display name of the plugin that brought the expert in, when one did. */
  pluginName: string | undefined;
  onOpen: (name: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="h-full" {...cardProps('expert', agent.name)}>
      <ToolCard
        item={{
          id: agent.name,
          name,
          description,
          avatar: <AgentAvatar agent={agent} size="xl" />,
          badge: offAutoDispatch || invalidTools || pluginName !== undefined ? (
            // Chips wrap rather than clip: the badge box is the slot that yields
            // width (ToolCard row 1), and a clipped 「工具配置无效」 would hide the one
            // chip the user has to act on.
            <span className="flex flex-wrap items-center justify-end gap-1">
              {pluginName !== undefined && <SourceBadge source={{ kind: 'plugin', plugin: pluginName }} />}
              {offAutoDispatch && (
                <span className="flex" title={t.toolbox.agentAutoDispatchHint} data-testid="agent-auto-dispatch-off">
                  <Tag>{t.toolbox.agentAutoDispatchOff}</Tag>
                </span>
              )}
              {invalidTools && (
                <span className="flex" title={t.toolbox.agentInvalidTools}>
                  <Tag tone="warning">{t.toolbox.agentInvalidTools}</Tag>
                </span>
              )}
            </span>
          ) : undefined,
        }}
        onClick={() => onOpen(agent.name)}
      />
    </div>
  );
});

interface AgentsSectionProps {
  manualCreateTrigger?: number;
  /** Overrides the Extensions store query when a host view owns the search box. */
  searchQuery?: string;
  /** Which shelf this render is showing — the sub-nav's current pick.
   *  Defaults to 市场, the shelf a fresh install has something on. */
  source?: ExtensionSource;
  /** Narrows both shelves — the 团队 view's 「本应用」 scope inside an app. */
  filter?: (agent: SubagentDefinition) => boolean;
}

export default function AgentsSection({ manualCreateTrigger, searchQuery, source = 'market', filter }: AgentsSectionProps) {
  const agents = useDiscoveryStore((s) => s.agents);
  const refresh = useDiscoveryStore((s) => s.refresh);
  const installedPlugins = usePluginStore((s) => s.installed);
  const refreshInstalled = usePluginStore((s) => s.refreshInstalled);
  const disabledAgents = useSettingsStore((s) => s.disabledAgents);
  const toggleAgentEnabled = useSettingsStore((s) => s.toggleAgentEnabled);
  const closeExtensions = useSettingsStore((s) => s.closeExtensions);
  // Inside Extensions there is no 代理 tab, so the store query follows whichever
  // tab is active. A host that owns its own search box (the 团队 view's 队员 tab)
  // passes it instead, rather than writing into another view's state.
  const storeSearchQuery = useExtensionsSearchQuery();
  const extensionsSearchQuery = searchQuery ?? storeSearchQuery;
  // An expert the user just saved is on the other shelf: land them where it
  // actually is, or the save reads as a save that did nothing.
  const setSource = useExtensionSourceStore((s) => s.setSource);
  const { t, locale } = useI18n();
  const confirm = useConfirm();

  const [installedAgents, setInstalledAgents] = useState<SubagentDefinition[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  // The editor window of one expert, or of a new one. It stays on the page, closed, while it
  // fades out; each opening mounts a fresh editor.
  const [editor, setEditor] = useState<{ target: SubagentDefinition | 'new'; open: boolean; opening: number } | null>(null);
  const [contentViewMode, setContentViewMode] = useState<'preview' | 'source'>('preview');
  const teams = useTeamStore((s) => s.teams);
  // Deleting an agent that a team lists leaves that team with a roleId no
  // agent answers to. Ask first and say which teams — the user decides.
  // `leads` is the subset it captains. Losing a member leaves a team one short;
  // losing the leader stops the team altogether, so the two say different things.
  const teamsReferencing = (agent: SubagentDefinition): { teams: string[]; leads: string[] } => {
    const roleId = effectiveRoleId(agent);
    if (!roleId) return { teams: [], leads: [] };
    const referencing = teams.filter((team) => team.memberRoleIds.includes(roleId));
    return {
      teams: referencing.map((team) => team.name),
      leads: referencing.filter((team) => team.leaderRoleId === roleId).map((team) => team.name),
    };
  };
  const knownToolNames = getAllTools().map((tool) => tool.name);

  const rootRef = useRef<HTMLDivElement>(null);
  // What the handlers read: the expert whose window is open, and whether one of the page's
  // windows is open. Both are set further down, once the expert the window shows is known.
  const selectedRef = useRef<string | null>(null);
  const windowOpen = useRef(false);

  // The card whose windows are open (detail, then editor). The window that closes last may have
  // opened from a control that is gone: the focus then goes back to the card, or to what took its
  // place once it has gone.
  const opener = useRef<CardPlace | null>(null);
  const openDetail = useCallback((name: string) => {
    opener.current = cardPlace(rootRef.current, 'expert', name);
    setSelectedAgent(name);
  }, []);
  const afterWindowClosed = (event: Event) => {
    // Another layer took the focus, or no card opened this window: the control that opened it gets the focus back.
    if (event.defaultPrevented || !opener.current) return;
    event.preventDefault();
    // Another window of the page is open: the focus is its own.
    if (windowOpen.current) return;
    focusExpertCard(rootRef.current, opener.current);
  };

  // The control a new expert's editor was opened from. The empty shelf's button leaves the page
  // with the first expert: the focus then goes to a card, else to the page's 「添加」 button.
  const editorEntry = useRef<Element | null>(null);
  // Counts the openings, so each one gets an editor of its own: one that is reopened in the
  // moment the last one has gone must not find the fields that one held.
  const openings = useRef(0);
  const openEditor = useCallback((target: SubagentDefinition | 'new') => {
    if (target === 'new') {
      opener.current = null;
      editorEntry.current = document.activeElement;
    }
    openings.current += 1;
    setEditor({ target, open: true, opening: openings.current });
  }, []);
  const afterEditorClosed = (event: Event) => {
    setEditor((current) => (current && !current.open ? null : current));
    if (opener.current) { afterWindowClosed(event); return; }
    const from = editorEntry.current;
    editorEntry.current = null;
    if (event.defaultPrevented || windowOpen.current) return;
    if (from instanceof HTMLElement && from !== document.body && from.isConnected) return;
    event.preventDefault();
    const first = rootRef.current?.querySelector<HTMLElement>('[data-expert-card] [role="button"]');
    if (first) first.focus();
    else focusExpertCard(rootRef.current, null);
  };

  // Open blank editor when manual create is triggered from parent
  useEffect(() => {
    if (manualCreateTrigger && manualCreateTrigger > 0) openEditor('new');
  }, [manualCreateTrigger, openEditor]);

  // Hydrate the installed-plugin set. `pluginDisplayName` needs the record to
  // turn `weather@official` into 「Weather Pack」; the only other hydrate today
  // is the 插件 tab's mount, so without this the provenance row shows the raw
  // key unless the user happened to open that tab first. Idempotent — mirrors
  // PluginsTab's mount-time hydrate (it also re-arms the MCP approval gate).
  useEffect(() => {
    let cancelled = false;
    homeDir()
      .then((dir) => {
        if (cancelled) return undefined;
        return refreshInstalled(dir);
      })
      .catch((err) => console.error('Agents: failed to hydrate installed plugins', err));
    return () => {
      cancelled = true;
    };
  }, [refreshInstalled]);

  // Load full agent details. No auto-selection: the detail is a modal now, so
  // it stays closed until the user clicks a card.
  useEffect(() => {
    const loadAgentDetails = async () => {
      const fullAgents: SubagentDefinition[] = [];
      for (const meta of agents) {
        const full = agentRegistry.getAgent(meta.name, { includeDisabledPlugins: true });
        if (!full) continue;
        // The store's `meta.source` is the only authority on provenance, so it
        // replaces the registry's copy outright rather than merely filling a
        // gap. The registry echoes back whatever the AGENT.md frontmatter said;
        // `applyPluginAgentSources` is what turns that into a fact — it drops a
        // `source:` no `installed.json` record backs and overwrites a claimed
        // one with the owning record's key. Preferring the raw value whenever
        // it exists would hand a forged `source: plugin:x` (writable via the
        // `save_agent` tool or a hand edit) the read-only treatment, locking
        // the user out of editing and deleting their own agent.
        const { source: _rawSource, ...withoutSource } = full;
        fullAgents.push(meta.source ? { ...withoutSource, source: meta.source } : withoutSource);
      }
      setInstalledAgents(fullAgents);
    };
    loadAgentDetails();
  }, [agents]);

  const disabledSet = useMemo(() => new Set(disabledAgents), [disabledAgents]);

  // Selectable agents, before search. Excludes the 'abu' default agent — it's
  // the fallback, not a selectable agent.
  const visibleAgents = useMemo(
    () => installedAgents.filter((a) => a.name !== 'abu' && !a.managed && (filter === undefined || filter(a))),
    [installedAgents, filter],
  );
  // Nothing of the user's own at all ("还没有你创建的专家") reads differently
  // from "your experts, none matching" — so the empty state asks the
  // UNFILTERED 我的 bucket, the way SkillsSection does.
  const mineTotal = useMemo(() => visibleAgents.filter((a) => !isSystemAgent(a)).length, [visibleAgents]);

  // Filter by search across both visible names (zh + en) + description.
  const filteredAgents = useMemo(() => {
    const visible = visibleAgents;
    if (!extensionsSearchQuery) return visible;
    const q = extensionsSearchQuery.toLowerCase();
    return visible.filter((a) => {
      const haystack = [
        a.name,
        a.description,
        ...Object.values(a.displayNames ?? {}),
        ...Object.values(a.descriptions ?? {}),
        ...(a.tags ?? []),
        ...Object.values(a.tagsI18n ?? {}).flat(),
      ];
      return haystack.some((s) => s && s.toLowerCase().includes(q));
    });
  }, [visibleAgents, extensionsSearchQuery]);

  // Split into the two shelves: 「我的」 is what the user has (their own
  // experts and the ones their plugins brought), 「市场」 what shipped with Abu.
  const userAgents = filteredAgents
    .filter((a) => !isSystemAgent(a))
    // Newest first (user feedback 2026-08-31); agents predating the created
    // stamp sort after dated ones, alphabetically.
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || a.name.localeCompare(b.name));
  const systemAgents = filteredAgents.filter(isSystemAgent);

  const selected = installedAgents.find((a) => a.name === selectedAgent) ?? null;
  // The detail window keeps showing the expert it held while it fades out.
  const [held, setHeld] = useState<SubagentDefinition | null>(null);
  if (selected && selected !== held) setHeld(selected);
  const shown = selected ?? held;
  // The window is open while the chosen expert is on the list: once the expert has left it, the
  // window fades out although the choice still names it.
  useLayoutEffect(() => {
    selectedRef.current = selected ? selected.name : null;
    windowOpen.current = selected !== null || editor?.open === true;
  });
  // A plugin owns this agent's file: editing it would be overwritten by the
  // next plugin update, and removing it belongs to uninstalling the plugin.
  const shownPluginSource = shown && isPluginOwnedAgent(shown) ? shown.source : undefined;

  // Delete a user-installed agent
  const handleDelete = async (agent: SubagentDefinition) => {
    if (isBuiltinAgentPath(agent.filePath)) return;
    // A plugin owns this file: removing it belongs to uninstalling the plugin,
    // and the next refresh would bring it back anyway. The menu entry is
    // withheld for the same reason — this keeps the invariant local to the
    // handler rather than resting on the menu alone.
    if (isPluginOwnedAgent(agent)) return;
    try {
      const agentDir = getParentDir(agent.filePath);
      await remove(agentDir, { recursive: true });
      // Close the detail modal after deleting the currently-open agent
      if (selectedRef.current === agent.name) setSelectedAgent(null);
      await refresh();
    } catch (err) {
      console.error('Failed to delete agent:', err);
    }
  };

  // The expert a delete is removing, and where its card sat: once it has gone the focus goes to
  // the card that took its place, else the one before it, else the page's 「添加」 button.
  const leaving = useRef<CardPlace | null>(null);
  const deleting = useRef(false);
  useLayoutEffect(() => {
    const gone = leaving.current;
    if (!gone || installedAgents.some((a) => a.name === gone.id)) return;
    leaving.current = null;
    opener.current = gone;
    if (!windowOpen.current && focusIsOnWindow()) focusExpertCard(rootRef.current, gone);
  }, [installedAgents]);

  // 删除 removes the expert's folder for good, so it is asked first, naming the expert: one
  // question per delete. An expert a team lists gets the question that names those teams. The
  // question is asked over the open window, which answers it "no" when it goes. The answer acts
  // on the expert as it is at that moment: nothing is removed when the name no longer leads to
  // the same file.
  const requestDelete = async (agent: SubagentDefinition) => {
    // The window stays on the page while it fades out; a key press there removes nothing.
    if (selectedRef.current !== agent.name || deleting.current) return;
    const stillThatExpert = () => agentRegistry.getAgent(agent.name, { includeDisabledPlugins: true })?.filePath === agent.filePath;
    const using = teamsReferencing(agent);
    const confirmed = await confirm(using.teams.length > 0 ? {
      title: format(t.toolbox.agentDeleteInTeamsTitle, { name: agent.name }),
      message: using.leads.length
        ? format(t.toolbox.agentDeleteLeaderInTeamsMessage, { count: String(using.leads.length), teams: using.leads.join('、') })
        : format(t.toolbox.agentDeleteInTeamsMessage, { count: String(using.teams.length), teams: using.teams.join('、') }),
      confirmLabel: t.toolbox.agentDeleteAnyway,
      tone: 'danger',
    } : {
      title: t.toolbox.deleteItem,
      message: displayName(agent, locale),
      confirmLabel: t.common.delete,
      tone: 'danger',
    });
    if (!confirmed || deleting.current) return;
    if (!stillThatExpert()) return;
    deleting.current = true;
    leaving.current = cardPlace(rootRef.current, 'expert', agent.name);
    try {
      await handleDelete(agent);
    } finally {
      deleting.current = false;
      // The delete failed and the expert is still there: its card keeps its place.
      if (stillThatExpert()) leaving.current = null;
    }
  };

  // The detail window's 「…」 menu. Both entries lead to something that takes the focus, so each
  // runs once the menu has gone; opening the menu forgets a choice its close hook never ran for.
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const pendingMenuAction = useRef<(() => void) | null>(null);

  const renderAgentCard = (agent: SubagentDefinition) => {
    const toolSummary = getAgentToolSummary(agent.tools, agent.disallowedTools, knownToolNames);
    const pluginKey = isPluginOwnedAgent(agent) ? agent.source?.plugin : undefined;
    return (
      <ExpertCard
        key={agent.name}
        agent={agent}
        name={displayName(agent, locale)}
        description={localizedDescription(agent, locale)}
        offAutoDispatch={disabledSet.has(agent.name)}
        invalidTools={Boolean(toolSummary.invalidField)}
        pluginName={pluginKey ? pluginDisplayName(installedPlugins, pluginKey) : undefined}
        onOpen={openDetail}
      />
    );
  };

  /** Start a chat with this agent — sets pendingInput so the @mention is
   *  picked up automatically, and pendingAgent so the welcome screen renders
   *  the agent persona. Optional promptText pre-fills the textarea for the
   *  one-click "Try asking" flow. */
  const startChatWithAgent = (agent: SubagentDefinition, promptText?: string) => {
    // The window stays on the page while it fades out; a key press there starts nothing.
    if (selectedRef.current !== agent.name) return;
    prepareExpertEntry({ identity: expertIdentity(agent, locale), introduction: localizedIntro(agent, locale) }, promptText);
    closeExtensions();
  };

  const notFound = <div className="py-8"><EmptyState icon={AppIcons.agent} title={t.toolbox.noAgentsFound} /></div>;

  return (
    <div ref={rootRef} className="flex h-full flex-col overflow-hidden">
      {/* Card grid — horizontally inset to match the header row above (ToolboxModal's
          TopTabNav), with a centered max-width so cards don't stretch edge-to-edge. */}
      <div className="flex-1 overflow-y-scroll overlay-scroll px-8 pt-3 pb-6">
        {/* One shelf at a time — which one is the sub-nav's job to say, so the
            group heading that used to name it here is gone. */}
        {source === 'mine' ? (
          userAgents.length === 0 ? (
            mineTotal === 0 ? (
              <div className="py-8">
                <EmptyState
                  icon={AppIcons.agent}
                  title={t.toolbox.agentsMineEmpty}
                  description={t.toolbox.agentsMineEmptyHint}
                  action={<Button variant="secondary" data-testid="agents-mine-create" onClick={() => openEditor('new')}>{t.toolbox.createAgent}</Button>}
                />
              </div>
            ) : notFound
          ) : (
            <div className="max-w-5xl mx-auto">
              <ToolGrid>{userAgents.map((agent) => renderAgentCard(agent))}</ToolGrid>
            </div>
          )
        ) : systemAgents.length === 0 ? notFound : (
          <div className="max-w-5xl mx-auto">
            <ToolGrid>{systemAgents.map((agent) => renderAgentCard(agent))}</ToolGrid>
          </div>
        )}
      </div>

      {/* Detail window */}
      <ToolDetailModal
        open={!!selected}
        ariaLabel={shown ? displayName(shown, locale) : undefined}
        onClose={() => setSelectedAgent(null)}
        onCloseAutoFocus={afterWindowClosed}
        maxWidth="max-w-2xl"
        avatar={shown ? <AgentAvatar agent={shown} size="2xl" /> : undefined}
        title={shown ? displayName(shown, locale) : undefined}
        // Primary action in the footer, exactly where the plugin and connector
        // details put theirs — the header keeps only the 「…」 menu. Always live:
        // an expert Abu may not hand work to on its own is still an expert you
        // can talk to.
        footer={shown && shown.name !== 'abu' ? (
          <Button variant="primary" size="sm" icon={AppIcons.startChat} onClick={() => startChatWithAgent(shown)} data-testid="agent-detail-start-chat">
            {t.toolbox.agentStartChat}
          </Button>
        ) : undefined}
        // "..." menu — edit / delete, for the user's own experts only.
        // Built-ins and a plugin's experts have nothing to offer here: there
        // is no file of the user's to edit, and removing a plugin's expert is
        // uninstalling that plugin (the detail says so). Showing the menu
        // greyed out only invited clicks, so it is withheld.
        headerActions={shown && shown.name !== 'abu' && isEditableAgent(shown) ? (
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
                label={format(t.toolbox.itemMenuLabel, { name: displayName(shown, locale) })}
              />
            )}
          >
            <MenuItem
              icon={AppIcons.rename}
              onSelect={() => {
                pendingMenuAction.current = () => {
                  // The window stays on the page while it fades out; a choice made there opens nothing.
                  if (selectedRef.current !== shown.name) return;
                  // One window at a time: the editor takes the place of the detail window.
                  openEditor(shown);
                  setSelectedAgent(null);
                };
              }}
            >
              {t.toolbox.agentEdit}
            </MenuItem>
            <MenuItem tone="danger" icon={AppIcons.delete} onSelect={() => { pendingMenuAction.current = () => { void requestDelete(shown); }; }}>
              {t.toolbox.deleteItem}
            </MenuItem>
          </Menu>
        ) : undefined}
      >
        {shown && (
          <div className="space-y-5">
            {/* Added by */}
            <div>
              <div className={SECTION_LABEL}>{t.toolbox.skillAddedBy}</div>
              <div className="mt-1 text-ui font-medium text-label" data-testid="agent-added-by">
                {shownPluginSource
                  ? format(t.toolbox.agentFromPluginRemoveHint, { plugin: pluginDisplayName(installedPlugins, shownPluginSource.plugin) })
                  : isSystemAgent(shown) ? t.toolbox.sourceBuiltin : t.toolbox.sourceUser}
              </div>
            </div>

            {/* Auto-dispatch — the one setting this detail owns. It governs
                whether Abu picks this expert by itself; @ mentions and expert
                teams reach it either way, which is what the hint says. */}
            <div className="flex items-start justify-between gap-4" data-testid="agent-auto-dispatch-setting">
              <div className="min-w-0">
                <div className={SECTION_LABEL}>{t.toolbox.agentAutoDispatch}</div>
                <p className="mt-1 text-caption text-label-tertiary">{t.toolbox.agentAutoDispatchHint}</p>
              </div>
              <Switch
                checked={!disabledSet.has(shown.name)}
                onCheckedChange={() => toggleAgentEnabled(shown.name)}
                aria-label={t.toolbox.agentAutoDispatch}
              />
            </div>

            {/* Description */}
            <div>
              <div className={SECTION_LABEL}>{t.toolbox.detailDescription}</div>
              <p className="mt-1 text-ui text-label">{localizedDescription(shown, locale)}</p>
            </div>

            {/* Tool access — the card's badge summarizes this; the detail view lists it. */}
            {(() => {
              const toolSummary = getAgentToolSummary(
                shown.tools,
                shown.disallowedTools,
                knownToolNames,
              );
              return (
                <div>
                  <div className={SECTION_LABEL}>{t.toolbox.agentTools}</div>
                  {toolSummary.invalidField ? (
                    <div className="mt-2 flex"><Tag tone="danger">{t.toolbox.agentInvalidTools}</Tag></div>
                  ) : toolSummary.isUnrestricted ? (
                    <p className="mt-1 text-ui text-label" title={toolSummary.toolNames.join(', ')}>
                      {t.toolbox.agentAllTools}
                    </p>
                  ) : (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {toolSummary.toolNames.map((toolName) => <Tag key={toolName}>{toolName}</Tag>)}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Expertise — bullet list of what the agent is good at */}
            {(() => {
              const expertise = localizedExpertise(shown, locale);
              if (!expertise || expertise.length === 0) return null;
              return (
                <div>
                  <div className={SECTION_LABEL}>{t.toolbox.agentExpertise}</div>
                  <ul className="mt-2 space-y-1">
                    {expertise.map((item) => (
                      <li key={item} className="flex items-start gap-2 text-ui text-label">
                        <span className="flex h-5 shrink-0 items-center"><Icon icon={AppIcons.done} size="sm" className="text-label-tertiary" /></span>
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })()}

            {/* Sample Prompts — clickable buttons, each opens a new conv with @agent + prompt */}
            {(() => {
              const prompts = localizedSamplePrompts(shown, locale);
              if (!prompts || prompts.length === 0) return null;
              return (
                <div>
                  <div className={SECTION_LABEL}>{t.toolbox.agentSamplePrompts}</div>
                  <ul className="mt-2 space-y-2">
                    {prompts.map((prompt) => (
                      <li key={prompt}>
                        <Pressable
                          onClick={() => startChatWithAgent(shown, prompt)}
                          className="flex w-full items-center gap-2 rounded-control border border-separator px-3 py-2 text-left text-ui text-label-secondary hover:bg-fill-hover"
                        >
                          <span className="shrink-0 text-label-tertiary">›</span>
                          <span className="italic">&ldquo;{prompt}&rdquo;</span>
                        </Pressable>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })()}

            {/* System Prompt content area (hidden for abu — internal prompt) */}
            {shown.systemPrompt && shown.name !== 'abu' && (
              <div className="overflow-hidden rounded-control border border-separator">
                {/* Preview or source */}
                <div className="flex items-center justify-end gap-1 border-b border-separator px-3 py-2">
                  <IconButton
                    size="sm"
                    icon={AppIcons.preview}
                    label={t.panel.previewMode}
                    aria-pressed={contentViewMode === 'preview'}
                    onClick={() => setContentViewMode('preview')}
                  />
                  <IconButton
                    size="sm"
                    icon={AppIcons.viewSource}
                    label={t.panel.sourceMode}
                    aria-pressed={contentViewMode === 'source'}
                    onClick={() => setContentViewMode('source')}
                  />
                </div>
                <div className="p-4">
                  {contentViewMode === 'preview' ? (
                    <MarkdownRenderer content={shown.systemPrompt} />
                  ) : (
                    <pre className="whitespace-pre-wrap break-words font-code text-ui-sm text-label">{shown.systemPrompt}</pre>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </ToolDetailModal>

      {/* Editor window — over the list, mounted from the moment it is opened until it has gone. */}
      {editor && (
        <AgentEditor
          key={editor.opening}
          open={editor.open}
          agent={editor.target === 'new' ? null : editor.target}
          onClose={() => setEditor((current) => (current ? { ...current, open: false } : current))}
          onSave={async () => {
            await refresh();
            setEditor((current) => (current ? { ...current, open: false } : current));
            setSource('members', 'mine');
          }}
          onCloseAutoFocus={afterEditorClosed}
        />
      )}
    </div>
  );
}
