import { useState, useEffect, useMemo } from 'react';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useExtensionsSearchQuery, useSettingsStore } from '@/stores/settingsStore';
import { prepareExpertEntry } from '@/core/team/expertEntry';
import { expertIdentity } from '@/core/team/expertContact';
import { useI18n, format } from '@/i18n';
import { agentRegistry } from '@/core/agent/registry';
import AgentEditor from './AgentEditor';
import { Toggle } from '@/components/ui/toggle';
import { MoreHorizontal, Pencil, Trash2, MessageCircle, Eye, Code, Check } from 'lucide-react';
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
import { getAllTools } from '@/core/tools/registry';
import ToolCard from '@/components/toolbox/ToolCard';
import ToolGrid from '@/components/toolbox/ToolGrid';
import ToolDetailModal from '@/components/toolbox/ToolDetailModal';
import ConfirmDialog from '@/components/common/ConfirmDialog';
import { useTeamStore } from '@/stores/teamStore';
import { effectiveRoleId } from '@/core/team/roleIdentity';

function isSystemAgent(agent: SubagentDefinition): boolean {
  // System / builtin agents ship with the app (registered in registry.ts) —
  // they live under "Examples" and can't be edited or deleted. Everything
  // discovered from user / project directories is a user agent.
  return agent.filePath === '__builtin__';
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
interface AgentsSectionProps {
  manualCreateTrigger?: number;
  /** Overrides the Extensions store query when a host view owns the search box. */
  searchQuery?: string;
}

export default function AgentsSection({ manualCreateTrigger, searchQuery }: AgentsSectionProps) {
  const { agents, refresh } = useDiscoveryStore();
  const installedPlugins = usePluginStore((s) => s.installed);
  const refreshInstalled = usePluginStore((s) => s.refreshInstalled);
  const { disabledAgents, toggleAgentEnabled, closeExtensions } = useSettingsStore();
  // Inside Extensions there is no 代理 tab, so the store query follows whichever
  // tab is active. A host that owns its own search box (the 团队 view's 队员 tab)
  // passes it instead, rather than writing into another view's state.
  const storeSearchQuery = useExtensionsSearchQuery();
  const extensionsSearchQuery = searchQuery ?? storeSearchQuery;
  const { t, locale } = useI18n();

  const [installedAgents, setInstalledAgents] = useState<SubagentDefinition[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [editorAgent, setEditorAgent] = useState<SubagentDefinition | 'new' | null>(null);
  const [menuAgent, setMenuAgent] = useState<string | null>(null);
  const [contentViewMode, setContentViewMode] = useState<'preview' | 'source'>('preview');
  const teams = useTeamStore((s) => s.teams);
  // Deleting an agent that a team lists leaves that team with a roleId no
  // agent answers to. Ask first and say which teams — the user decides.
  const [confirmDeleteAgent, setConfirmDeleteAgent] = useState<{ agent: SubagentDefinition; teams: string[]; leads: string[] } | null>(null);
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

  // Open blank editor when manual create is triggered from parent
  useEffect(() => {
    if (manualCreateTrigger && manualCreateTrigger > 0) {
      setEditorAgent('new');
    }
  }, [manualCreateTrigger]);

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

  // Filter by search across both visible names (zh + en) + description.
  // Excludes the 'abu' default agent — it's the fallback, not a selectable agent.
  const filteredAgents = useMemo(() => {
    const visible = installedAgents.filter((a) => a.name !== 'abu' && !a.managed);
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
  }, [installedAgents, extensionsSearchQuery]);

  // Split into user-defined vs builtin/system agents. Builtins go under the
  // "Examples" section, user agents under "My agents".
  const userAgents = filteredAgents
    .filter((a) => !isSystemAgent(a))
    // Newest first (user feedback 2026-08-31); agents predating the created
    // stamp sort after dated ones, alphabetically.
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || a.name.localeCompare(b.name));
  const systemAgents = filteredAgents.filter(isSystemAgent);

  const selected = installedAgents.find((a) => a.name === selectedAgent) ?? null;
  // A plugin owns this agent's file: editing it would be overwritten by the
  // next plugin update, and removing it belongs to uninstalling the plugin.
  const selectedPluginSource = selected && isPluginOwnedAgent(selected) ? selected.source : undefined;

  // Delete a user-installed agent
  const handleDelete = async (agent: SubagentDefinition) => {
    if (isBuiltinAgentPath(agent.filePath)) return;
    // A plugin owns this file: removing it belongs to uninstalling the plugin,
    // and the next refresh would bring it back anyway. The menu entry is
    // disabled for the same reason — this keeps the invariant local to the
    // handler rather than resting on the button's `disabled` alone.
    if (isPluginOwnedAgent(agent)) return;
    try {
      const agentDir = getParentDir(agent.filePath);
      await remove(agentDir, { recursive: true });
      // Close the detail modal after deleting the currently-open agent
      if (selectedAgent === agent.name) setSelectedAgent(null);
      await refresh();
    } catch (err) {
      console.error('Failed to delete agent:', err);
    }
  };

  // Close the "..." menu when clicking outside
  useEffect(() => {
    if (!menuAgent) return;
    const handleClick = () => setMenuAgent(null);
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [menuAgent]);

  const renderAgentCard = (agent: SubagentDefinition) => {
    const toolSummary = getAgentToolSummary(agent.tools, agent.disallowedTools, knownToolNames);
    const toolLabel = toolSummary.invalidField
      ? t.toolbox.agentInvalidTools
      : toolSummary.isUnrestricted
        ? t.toolbox.agentAllTools
        : format(t.toolbox.toolCount, { count: toolSummary.toolNames.length });

    return (
      <ToolCard
        key={agent.name}
        item={{
        id: agent.name,
        name: displayName(agent, locale),
        description: localizedDescription(agent, locale),
        avatar: <AgentAvatar agent={agent} />,
        badge: (
          <span
            className="rounded-full bg-[var(--abu-bg-active)] px-1.5 py-0.5 text-caption text-[var(--abu-text-tertiary)]"
            title={toolSummary.invalidField ? t.toolbox.agentInvalidTools : toolSummary.toolNames.join(', ')}
          >
            {toolLabel}
          </span>
        ),
        toggle: (
          <span onClick={(e) => e.stopPropagation()}>
            <Toggle
              checked={!disabledSet.has(agent.name)}
              onChange={() => toggleAgentEnabled(agent.name)}
              size="sm"
              tone="green"
            />
          </span>
        ),
      }}
      onClick={() => setSelectedAgent(agent.name)}
      />
    );
  };

  /** Start a chat with this agent — sets pendingInput so the @mention is
   *  picked up automatically, and pendingAgent so the welcome screen renders
   *  the agent persona. Optional promptText pre-fills the textarea for the
   *  one-click "Try asking" flow. */
  const startChatWithAgent = (agent: SubagentDefinition, promptText?: string) => {
    prepareExpertEntry({ identity: expertIdentity(agent, locale), introduction: localizedIntro(agent, locale) }, promptText);
    closeExtensions();
  };

  // If editor is open, show editor full-width
  if (editorAgent !== null) {
    return (
      <AgentEditor
        agent={editorAgent === 'new' ? null : editorAgent}
        onClose={() => setEditorAgent(null)}
        onSave={async () => { await refresh(); setEditorAgent(null); }}
      />
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden bg-[var(--abu-bg-base)]">
      {/* Card grid — horizontally inset to match the header row above (ToolboxModal's
          TopTabNav), with a centered max-width so cards don't stretch edge-to-edge. */}
      <div className="flex-1 overflow-y-scroll overlay-scroll px-8 pb-6">
        {filteredAgents.length === 0 ? (
          <div className="text-body text-[var(--abu-text-muted)] py-16 text-center">{t.toolbox.noAgentsFound}</div>
        ) : (
          <div className="max-w-5xl mx-auto space-y-6">
            {/* My agents (user-created) */}
            {userAgents.length > 0 && (
              <div>
                <div className="mb-3 text-body font-medium text-[var(--abu-text-muted)]">{t.toolbox.myAgents}</div>
                <ToolGrid>{userAgents.map((agent) => renderAgentCard(agent))}</ToolGrid>
              </div>
            )}
            {/* System agents (builtin/marketplace) */}
            {systemAgents.length > 0 && (
              <div>
                <div className="mb-3 text-body font-medium text-[var(--abu-text-muted)]">{t.toolbox.exampleAgents}</div>
                <ToolGrid>{systemAgents.map((agent) => renderAgentCard(agent))}</ToolGrid>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Detail modal */}
      <ToolDetailModal
        open={!!selected}
        onClose={() => { setSelectedAgent(null); setMenuAgent(null); }}
        // The delete confirm is stacked on top; it owns Escape while it is up,
        // otherwise one press dismisses both it and the detail behind it.
        disableEscape={!!confirmDeleteAgent}
        maxWidth="max-w-2xl"
        avatar={selected ? <AgentAvatar agent={selected} /> : undefined}
        title={selected ? displayName(selected, locale) : undefined}
        headerActions={selected && selected.name !== 'abu' ? (
          <>
            {/* Start Chat — clay-tinted pill primary CTA, hidden when disabled. */}
            {!disabledSet.has(selected.name) && (
              <button
                onClick={() => startChatWithAgent(selected)}
                className="flex items-center gap-1.5 px-2.5 h-7 rounded-md text-minor font-medium text-[var(--abu-clay)] bg-[var(--abu-clay-bg)] hover:bg-[var(--abu-clay-bg-15)] border border-[var(--abu-clay-40)] hover:border-[var(--abu-clay)] transition-colors"
                title={t.toolbox.agentStartChat}
              >
                <MessageCircle className="h-3.5 w-3.5" />
                <span>{t.toolbox.agentStartChat}</span>
              </button>
            )}
            <Toggle
              checked={!disabledSet.has(selected.name)}
              onChange={() => toggleAgentEnabled(selected.name)}
              tone="green"
            />
            {/* "..." menu — only for user agents (edit / delete). */}
            {!isSystemAgent(selected) && (
              <div className="relative">
                <button
                  onClick={(e) => { e.stopPropagation(); setMenuAgent(menuAgent === selected.name ? null : selected.name); }}
                  className="p-1.5 rounded-lg text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-muted)] transition-colors"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>
                {menuAgent === selected.name && (
                  <div className="absolute right-0 top-8 z-10 bg-[var(--abu-bg-base)] border border-[var(--abu-border)] rounded-lg shadow-lg py-1 min-w-[140px]">
                    <button
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-minor text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-muted)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                      disabled={!!selectedPluginSource}
                      title={selectedPluginSource ? t.toolbox.agentFromPluginEditDisabled : undefined}
                      onClick={() => { setEditorAgent(selected); setMenuAgent(null); setSelectedAgent(null); }}
                    >
                      <Pencil className="h-3 w-3" />
                      {t.toolbox.agentEdit}
                    </button>
                    <button
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-minor text-[var(--abu-danger)] hover:bg-[var(--abu-danger-bg)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                      disabled={!!selectedPluginSource}
                      title={selectedPluginSource ? t.toolbox.agentFromPluginDeleteDisabled : undefined}
                      onClick={() => {
                        const using = teamsReferencing(selected);
                        if (using.teams.length > 0) setConfirmDeleteAgent({ agent: selected, ...using });
                        else handleDelete(selected);
                        setMenuAgent(null);
                      }}
                    >
                      <Trash2 className="h-3 w-3" />
                      {t.toolbox.uninstall}
                    </button>
                  </div>
                )}
              </div>
            )}
          </>
        ) : undefined}
      >
        {selected && (
          <div className="space-y-5">
            {/* Added by */}
            <div>
              <div className="text-minor text-[var(--abu-text-muted)] mb-0.5">{t.toolbox.skillAddedBy}</div>
              <div className="text-body font-medium text-[var(--abu-text-primary)]" data-testid="agent-added-by">
                {selectedPluginSource
                  ? format(t.toolbox.agentFromPlugin, { plugin: pluginDisplayName(installedPlugins, selectedPluginSource.plugin) })
                  : isSystemAgent(selected) ? t.toolbox.sourceBuiltin : t.toolbox.sourceUser}
              </div>
            </div>

            {/* Description */}
            <div>
              <span className="text-minor text-[var(--abu-text-muted)]">{t.toolbox.detailDescription}</span>
              <p className="text-body text-[var(--abu-text-primary)] leading-relaxed mt-1.5">{localizedDescription(selected, locale)}</p>
            </div>

            {/* Tool access — the card's badge summarizes this; the detail view lists it. */}
            {(() => {
              const toolSummary = getAgentToolSummary(
                selected.tools,
                selected.disallowedTools,
                knownToolNames,
              );
              return (
                <div>
                  <span className="text-minor text-[var(--abu-text-muted)]">{t.toolbox.agentTools}</span>
                  {toolSummary.invalidField ? (
                    <p className="text-body text-[var(--abu-danger)] mt-1.5">{t.toolbox.agentInvalidTools}</p>
                  ) : toolSummary.isUnrestricted ? (
                    <p
                      className="text-body text-[var(--abu-text-primary)] mt-1.5"
                      title={toolSummary.toolNames.join(', ')}
                    >
                      {t.toolbox.agentAllTools}
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {toolSummary.toolNames.map((toolName) => (
                        <span
                          key={toolName}
                          className="rounded-full bg-[var(--abu-bg-active)] px-2 py-1 text-caption text-[var(--abu-text-secondary)]"
                        >
                          {toolName}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Expertise — bullet list of what the agent is good at */}
            {(() => {
              const expertise = localizedExpertise(selected, locale);
              if (!expertise || expertise.length === 0) return null;
              return (
                <div>
                  <span className="text-minor text-[var(--abu-text-muted)]">{t.toolbox.agentExpertise}</span>
                  <ul className="space-y-1.5 mt-1.5">
                    {expertise.map((item) => (
                      <li key={item} className="flex items-start gap-2 text-body text-[var(--abu-text-primary)] leading-relaxed">
                        <Check className="h-3.5 w-3.5 text-[var(--abu-clay)] shrink-0 mt-0.5" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })()}

            {/* Sample Prompts — clickable buttons, each opens a new conv with @agent + prompt */}
            {(() => {
              const prompts = localizedSamplePrompts(selected, locale);
              if (!prompts || prompts.length === 0) return null;
              return (
                <div>
                  <span className="text-minor text-[var(--abu-text-muted)]">{t.toolbox.agentSamplePrompts}</span>
                  <ul className="space-y-1.5 mt-1.5">
                    {prompts.map((prompt) => (
                      <li key={prompt}>
                        <button
                          onClick={() => startChatWithAgent(selected, prompt)}
                          className="w-full text-left flex items-center gap-2 text-body text-[var(--abu-text-secondary)] bg-[var(--abu-bg-subtle)] hover:bg-[var(--abu-bg-active)] hover:text-[var(--abu-text-primary)] border border-[var(--abu-border)] rounded-lg px-3 py-2 transition-colors cursor-pointer"
                        >
                          <span className="text-[var(--abu-clay)] shrink-0">›</span>
                          <span className="italic">&ldquo;{prompt}&rdquo;</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })()}

            {/* System Prompt content area (hidden for abu — internal prompt) */}
            {selected.systemPrompt && selected.name !== 'abu' && (
              <div className="border border-[var(--abu-border)] rounded-lg overflow-hidden">
                {/* Toggle bar */}
                <div className="flex items-center justify-end gap-1.5 px-4 py-2.5 bg-[var(--abu-bg-base)] border-b border-[var(--abu-border)]">
                  <button
                    onClick={() => setContentViewMode('preview')}
                    className={`p-1.5 rounded transition-colors ${contentViewMode === 'preview' ? 'text-[var(--abu-text-primary)] bg-[var(--abu-bg-hover)]' : 'text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)]'}`}
                    title={t.panel.previewMode}
                  >
                    <Eye className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => setContentViewMode('source')}
                    className={`p-1.5 rounded transition-colors ${contentViewMode === 'source' ? 'text-[var(--abu-text-primary)] bg-[var(--abu-bg-hover)]' : 'text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)]'}`}
                    title={t.panel.sourceMode}
                  >
                    <Code className="h-4 w-4" />
                  </button>
                </div>
                <div className="px-4 py-4 bg-[var(--abu-bg-base)]">
                  {contentViewMode === 'preview' ? (
                    <MarkdownRenderer content={selected.systemPrompt} />
                  ) : (
                    <pre className="text-minor text-[var(--abu-text-primary)] whitespace-pre-wrap break-words font-mono leading-relaxed">{selected.systemPrompt}</pre>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </ToolDetailModal>
      <ConfirmDialog
        open={!!confirmDeleteAgent}
        title={format(t.toolbox.agentDeleteInTeamsTitle, { name: confirmDeleteAgent?.agent.name ?? '' })}
        message={confirmDeleteAgent?.leads.length
          ? format(t.toolbox.agentDeleteLeaderInTeamsMessage, {
              count: String(confirmDeleteAgent.leads.length),
              teams: confirmDeleteAgent.leads.join('、'),
            })
          : format(t.toolbox.agentDeleteInTeamsMessage, {
              count: String(confirmDeleteAgent?.teams.length ?? 0),
              teams: (confirmDeleteAgent?.teams ?? []).join('、'),
            })}
        confirmText={t.toolbox.agentDeleteAnyway}
        cancelText={t.common.cancel}
        variant="danger"
        onCancel={() => setConfirmDeleteAgent(null)}
        onConfirm={() => {
          if (confirmDeleteAgent) handleDelete(confirmDeleteAgent.agent);
          setConfirmDeleteAgent(null);
        }}
      />
    </div>
  );
}
