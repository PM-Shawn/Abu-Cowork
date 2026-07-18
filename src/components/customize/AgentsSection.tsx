import { useState, useEffect, useMemo } from 'react';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useChatStore } from '@/stores/chatStore';
import { useI18n } from '@/i18n';
import { agentRegistry } from '@/core/agent/registry';
import AgentEditor from './AgentEditor';
import { Toggle } from '@/components/ui/toggle';
import { MoreHorizontal, Pencil, Trash2, MessageCircle, Eye, Code, Check, Bot } from 'lucide-react';
import { remove } from '@tauri-apps/plugin-fs';
import { getParentDir } from '@/utils/pathUtils';
import type { SubagentDefinition } from '@/types';
import MarkdownRenderer from '@/components/chat/MarkdownRenderer';
import ToolCard from '@/components/toolbox/ToolCard';
import ToolGrid from '@/components/toolbox/ToolGrid';
import ToolDetailModal from '@/components/toolbox/ToolDetailModal';
import abuAvatar from '@/assets/abu-avatar.png';

function isSystemAgent(agent: SubagentDefinition): boolean {
  // System / builtin agents ship with the app (registered in registry.ts) —
  // they live under "Examples" and can't be edited or deleted. Everything
  // discovered from user / project directories is a user agent.
  return agent.filePath === '__builtin__';
}

/** Render agent avatar: real image for abu (brand mascot), otherwise a single
 *  uniform robot icon — keeps the agent grid clean and tidy (matches the
 *  connectors' Server-icon style). */
function AgentAvatar({ agent, size = 'md' }: { agent: SubagentDefinition; size?: 'sm' | 'md' }) {
  const cls = size === 'sm' ? 'h-5 w-5' : 'h-6 w-6';
  if (agent.name === 'abu') {
    return <img src={abuAvatar} alt="Abu" className={`${cls} rounded-full object-cover`} />;
  }
  return <Bot className={`${cls} text-[var(--abu-text-muted)]`} />;
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
}

export default function AgentsSection({ manualCreateTrigger }: AgentsSectionProps) {
  const { agents, refresh } = useDiscoveryStore();
  const { toolboxSearchQuery, disabledAgents, toggleAgentEnabled, closeToolbox } = useSettingsStore();
  const startNewConversation = useChatStore((s) => s.startNewConversation);
  const setPendingInput = useChatStore((s) => s.setPendingInput);
  const setPendingAgent = useChatStore((s) => s.setPendingAgent);
  const { t, locale } = useI18n();

  const [installedAgents, setInstalledAgents] = useState<SubagentDefinition[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [editorAgent, setEditorAgent] = useState<SubagentDefinition | 'new' | null>(null);
  const [menuAgent, setMenuAgent] = useState<string | null>(null);
  const [contentViewMode, setContentViewMode] = useState<'preview' | 'source'>('preview');

  // Open blank editor when manual create is triggered from parent
  useEffect(() => {
    if (manualCreateTrigger && manualCreateTrigger > 0) {
      setEditorAgent('new');
    }
  }, [manualCreateTrigger]);

  // Load full agent details. No auto-selection: the detail is a modal now, so
  // it stays closed until the user clicks a card.
  useEffect(() => {
    const loadAgentDetails = async () => {
      const fullAgents: SubagentDefinition[] = [];
      for (const meta of agents) {
        const full = agentRegistry.getAgent(meta.name);
        if (full) fullAgents.push(full);
      }
      setInstalledAgents(fullAgents);
    };
    loadAgentDetails();
  }, [agents]);

  const disabledSet = useMemo(() => new Set(disabledAgents), [disabledAgents]);

  // Filter by search across both visible names (zh + en) + description.
  // Excludes the 'abu' default agent — it's the fallback, not a selectable agent.
  const filteredAgents = useMemo(() => {
    const visible = installedAgents.filter((a) => a.name !== 'abu');
    if (!toolboxSearchQuery) return visible;
    const q = toolboxSearchQuery.toLowerCase();
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
  }, [installedAgents, toolboxSearchQuery]);

  // Split into user-defined vs builtin/system agents. Builtins go under the
  // "Examples" section, user agents under "My agents".
  const userAgents = filteredAgents.filter((a) => !isSystemAgent(a));
  const systemAgents = filteredAgents.filter(isSystemAgent);

  const selected = installedAgents.find((a) => a.name === selectedAgent) ?? null;

  // Delete a user-installed agent
  const handleDelete = async (agent: SubagentDefinition) => {
    if (agent.filePath === '__builtin__' || agent.filePath.includes('builtin-agents')) return;
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

  const renderAgentCard = (agent: SubagentDefinition) => (
    <ToolCard
      key={agent.name}
      item={{
        id: agent.name,
        name: displayName(agent, locale),
        description: localizedDescription(agent, locale),
        avatar: <AgentAvatar agent={agent} />,
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

  /** Start a chat with this agent — sets pendingInput so the @mention is
   *  picked up automatically, and pendingAgent so the welcome screen renders
   *  the agent persona. Optional promptText pre-fills the textarea for the
   *  one-click "Try asking" flow. */
  const startChatWithAgent = (agent: SubagentDefinition, promptText?: string) => {
    const input = promptText ? `@${agent.name} ${promptText}` : `@${agent.name} `;
    startNewConversation();
    setPendingInput(input);
    setPendingAgent(agent.name);
    closeToolbox();
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
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-minor text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-muted)] transition-colors"
                      onClick={() => { setEditorAgent(selected); setMenuAgent(null); setSelectedAgent(null); }}
                    >
                      <Pencil className="h-3 w-3" />
                      {t.toolbox.agentEdit}
                    </button>
                    <button
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-minor text-[var(--abu-danger)] hover:bg-[var(--abu-danger-bg)] transition-colors"
                      onClick={() => { handleDelete(selected); setMenuAgent(null); }}
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
              <div className="text-body font-medium text-[var(--abu-text-primary)]">{isSystemAgent(selected) ? 'System' : 'User'}</div>
            </div>

            {/* Description */}
            <div>
              <span className="text-minor text-[var(--abu-text-muted)]">Description</span>
              <p className="text-body text-[var(--abu-text-primary)] leading-relaxed mt-1.5">{localizedDescription(selected, locale)}</p>
            </div>

            {/* Intro — agent self-introduction shown when there's an intro paragraph */}
            {localizedIntro(selected, locale) && (
              <div>
                <span className="text-minor text-[var(--abu-text-muted)]">{t.toolbox.agentIntro}</span>
                <p className="text-body text-[var(--abu-text-primary)] leading-relaxed mt-1.5">
                  {localizedIntro(selected, locale)}
                </p>
              </div>
            )}

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
                    title="Preview"
                  >
                    <Eye className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => setContentViewMode('source')}
                    className={`p-1.5 rounded transition-colors ${contentViewMode === 'source' ? 'text-[var(--abu-text-primary)] bg-[var(--abu-bg-hover)]' : 'text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)]'}`}
                    title="Source"
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
    </div>
  );
}
