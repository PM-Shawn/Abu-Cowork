import { useState, useEffect, useMemo } from 'react';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useChatStore } from '@/stores/chatStore';
import { useI18n } from '@/i18n';
import { agentRegistry } from '@/core/agent/registry';
import AgentEditor from './AgentEditor';
import { Toggle } from '@/components/ui/toggle';
import { ChevronDown, ChevronRight, MoreHorizontal, Pencil, Trash2, MessageCircle, Eye, Code, Search, Plus, X, Wand2, PenLine, Upload } from 'lucide-react';
import { remove } from '@tauri-apps/plugin-fs';
import { getParentDir } from '@/utils/pathUtils';
import type { SubagentDefinition } from '@/types';
import MarkdownRenderer from '@/components/chat/MarkdownRenderer';
import abuAvatar from '@/assets/abu-avatar.png';

function isSystemAgent(agent: SubagentDefinition): boolean {
  // Only 'abu' is a system agent — all others (including marketplace-installed) are user agents
  return agent.name === 'abu';
}

/** Render agent avatar: use real image for abu, emoji for others */
function AgentAvatar({ agent, size = 'md' }: { agent: SubagentDefinition; size?: 'sm' | 'md' }) {
  const cls = size === 'sm' ? 'h-5 w-5' : 'h-6 w-6';
  if (agent.name === 'abu') {
    return <img src={abuAvatar} alt="Abu" className={`${cls} rounded-full object-cover`} />;
  }
  return <span className={size === 'sm' ? 'text-base' : 'text-xl'}>{agent.avatar || '🤖'}</span>;
}

/** Display name: capitalize first letter for abu */
function displayName(agent: SubagentDefinition): string {
  if (agent.name === 'abu') return 'Abu';
  return agent.name;
}

interface AgentsSectionProps {
  manualCreateTrigger?: number;
  onAICreate?: () => void;
  onManualCreate?: () => void;
  onUploadFile?: () => void;
}

export default function AgentsSection({ manualCreateTrigger, onAICreate, onManualCreate, onUploadFile }: AgentsSectionProps) {
  const { agents, refresh } = useDiscoveryStore();
  const { toolboxSearchQuery, setToolboxSearchQuery, disabledAgents, toggleAgentEnabled, closeToolbox } = useSettingsStore();
  const startNewConversation = useChatStore((s) => s.startNewConversation);
  const setPendingInput = useChatStore((s) => s.setPendingInput);
  const { t } = useI18n();

  const [installedAgents, setInstalledAgents] = useState<SubagentDefinition[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [editorAgent, setEditorAgent] = useState<SubagentDefinition | 'new' | null>(null);
  const [menuAgent, setMenuAgent] = useState<string | null>(null);
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  const [showSearch, setShowSearch] = useState(false);
  const [showCreateMenu, setShowCreateMenu] = useState(false);
  const [contentViewMode, setContentViewMode] = useState<'preview' | 'source'>('preview');

  // Open blank editor when manual create is triggered from parent
  useEffect(() => {
    if (manualCreateTrigger && manualCreateTrigger > 0) {
      setEditorAgent('new');
    }
  }, [manualCreateTrigger]);

  // Load full agent details
  useEffect(() => {
    const loadAgentDetails = async () => {
      const fullAgents: SubagentDefinition[] = [];
      for (const meta of agents) {
        const full = agentRegistry.getAgent(meta.name);
        if (full) fullAgents.push(full);
      }
      setInstalledAgents(fullAgents);
      if (!selectedAgent && fullAgents.length > 0) {
        // Select first visible: user agents first, then system agents (matching UI order)
        const userFirst = fullAgents.find((a) => !isSystemAgent(a));
        setSelectedAgent((userFirst ?? fullAgents[0]).name);
      }
    };
    loadAgentDetails();
  }, [agents]);

  const disabledSet = useMemo(() => new Set(disabledAgents), [disabledAgents]);

  // Filter by search, exclude system agents (abu) from display
  const filteredAgents = useMemo(() => {
    const visible = installedAgents.filter((a) => !isSystemAgent(a));
    if (!toolboxSearchQuery) return visible;
    const q = toolboxSearchQuery.toLowerCase();
    return visible.filter((a) =>
      a.name.toLowerCase().includes(q) ||
      a.description.toLowerCase().includes(q)
    );
  }, [installedAgents, toolboxSearchQuery]);

  // All visible agents are user agents (system agents like 'abu' are filtered out above)
  const userAgents = filteredAgents;
  const systemAgents: SubagentDefinition[] = [];

  const toggleCategory = (cat: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      return next;
    });
  };

  const selected = installedAgents.find((a) => a.name === selectedAgent) ?? null;

  // Delete a user-installed agent
  const handleDelete = async (agent: SubagentDefinition) => {
    if (agent.filePath === '__builtin__' || agent.filePath.includes('builtin-agents')) return;
    try {
      const agentDir = getParentDir(agent.filePath);
      await remove(agentDir, { recursive: true });
      if (selectedAgent === agent.name) setSelectedAgent(null);
      await refresh();
    } catch (err) {
      console.error('Failed to delete agent:', err);
    }
  };

  // Close menus when clicking outside
  useEffect(() => {
    if (!menuAgent && !showCreateMenu) return;
    const handleClick = () => { setMenuAgent(null); setShowCreateMenu(false); };
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [menuAgent, showCreateMenu]);

  const renderAgentRow = (agent: SubagentDefinition) => {
    const isSelected = selectedAgent === agent.name;
    const isEnabled = !disabledSet.has(agent.name);

    return (
      <div key={agent.name} className="mb-0.5">
        <div
          className={`flex items-center gap-3 mx-2 pl-7 pr-3 py-2.5 rounded-lg cursor-pointer transition-colors ${
            isSelected ? 'bg-[var(--abu-bg-active)]' : 'hover:bg-[var(--abu-bg-active)]/60'
          }`}
          onClick={() => setSelectedAgent(agent.name)}
        >
          <AgentAvatar agent={agent} size="sm" />
          <span className={`text-sm flex-1 truncate ${
            !isEnabled && agent.name !== 'abu' ? 'text-[var(--abu-text-placeholder)]' : isSelected ? 'text-[var(--abu-text-primary)] font-medium' : 'text-[var(--abu-text-tertiary)]'
          }`}>
            {displayName(agent)}
          </span>
        </div>
      </div>
    );
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
    <div className="flex h-full overflow-hidden">
      {/* Left: Agent list */}
      <div className="w-[340px] shrink-0 border-r border-[var(--abu-border)] flex flex-col overflow-hidden bg-[var(--abu-bg-base)]">
        {/* Header: Title + Search + Create */}
        <div className="shrink-0 px-4 pt-4 pb-3 border-b border-[var(--abu-border)]">
          {showSearch ? (
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--abu-text-tertiary)]" />
              <input
                autoFocus
                type="text"
                placeholder={t.toolbox.searchPlaceholder}
                value={toolboxSearchQuery}
                onChange={(e) => setToolboxSearchQuery(e.target.value)}
                onBlur={() => { if (!toolboxSearchQuery) setShowSearch(false); }}
                onKeyDown={(e) => { if (e.key === 'Escape') { setToolboxSearchQuery(''); setShowSearch(false); } }}
                className="w-full pl-7 pr-7 py-1 text-sm border border-[var(--abu-border)] rounded-md bg-[var(--abu-bg-base)] focus:outline-none focus:ring-1 focus:ring-[var(--abu-clay-ring)] text-[var(--abu-text-primary)]"
              />
              <button
                onClick={() => { setToolboxSearchQuery(''); setShowSearch(false); }}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)]"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <span className="text-base font-semibold text-[var(--abu-text-primary)]">{t.toolbox.agents}</span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setShowSearch(true)}
                  className="p-1 text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)] transition-colors"
                >
                  <Search className="h-3.5 w-3.5" />
                </button>
                <div className="relative">
                  <button
                    onClick={(e) => { e.stopPropagation(); setShowCreateMenu(!showCreateMenu); }}
                    className="p-1 text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)] transition-colors"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                  {showCreateMenu && (
                    <div className="absolute z-50 top-full right-0 mt-1 w-44 bg-white rounded-lg shadow-lg border border-[var(--abu-border)] py-1">
                      {onAICreate && (
                        <button
                          onClick={() => { setShowCreateMenu(false); onAICreate(); }}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-active)] transition-colors"
                        >
                          <Wand2 className="h-3.5 w-3.5 text-[var(--abu-clay)]" />
                          <span>{t.toolbox.createWithAbu}</span>
                        </button>
                      )}
                      {onManualCreate && (
                        <button
                          onClick={() => { setShowCreateMenu(false); onManualCreate(); }}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-active)] transition-colors"
                        >
                          <PenLine className="h-3.5 w-3.5 text-[var(--abu-text-muted)]" />
                          <span>{t.toolbox.createManually}</span>
                        </button>
                      )}
                      {onUploadFile && (
                        <button
                          onClick={() => { setShowCreateMenu(false); onUploadFile(); }}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-active)] transition-colors"
                        >
                          <Upload className="h-3.5 w-3.5 text-[var(--abu-text-muted)]" />
                          <span>{t.toolbox.uploadFile}</span>
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
        <div className="flex-1 overflow-y-auto overlay-scroll py-2">
          {filteredAgents.length === 0 ? (
            <div className="text-xs text-[var(--abu-text-muted)] py-8 text-center">{t.toolbox.noAgentsFound}</div>
          ) : (
            <>
              {/* My agents (user-created) */}
              {userAgents.length > 0 && (
                <div>
                  <div
                    className="flex items-center gap-1.5 px-5 py-2.5 cursor-pointer text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)]"
                    onClick={() => toggleCategory('my')}
                  >
                    {collapsedCategories.has('my')
                      ? <ChevronRight className="h-3 w-3" />
                      : <ChevronDown className="h-3 w-3" />
                    }
                    <span className="text-[13px] font-medium">{t.toolbox.myAgents}</span>
                  </div>
                  {!collapsedCategories.has('my') && userAgents.map((agent) => renderAgentRow(agent))}
                </div>
              )}
              {/* System agents (builtin/marketplace) */}
              {systemAgents.length > 0 && (
                <div>
                  <div
                    className="flex items-center gap-1.5 px-5 py-2.5 cursor-pointer text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)]"
                    onClick={() => toggleCategory('system')}
                  >
                    {collapsedCategories.has('system')
                      ? <ChevronRight className="h-3 w-3" />
                      : <ChevronDown className="h-3 w-3" />
                    }
                    <span className="text-[13px] font-medium">{t.toolbox.exampleAgents}</span>
                  </div>
                  {!collapsedCategories.has('system') && systemAgents.map((agent) => renderAgentRow(agent))}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Right: Agent detail */}
      <div className="flex-1 overflow-y-auto overlay-scroll bg-[var(--abu-bg-base)]">
        {selected ? (
          <div className="px-6 py-6">
            {/* Row 1: Name + Toggle + Menu */}
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <AgentAvatar agent={selected} />
                <h2 className="text-xl font-semibold text-[var(--abu-text-primary)]">{displayName(selected)}</h2>
              </div>
              <div className="flex items-center gap-2">
                {selected.name !== 'abu' && (
                  <>
                    <Toggle
                      checked={!disabledSet.has(selected.name)}
                      onChange={() => toggleAgentEnabled(selected.name)}
                    />
                    {/* Show "..." menu only when there are items: user agents always have edit/delete; system agents only when enabled (try in chat) */}
                    {(!isSystemAgent(selected) || !disabledSet.has(selected.name)) && (
                      <div className="relative">
                        <button
                          onClick={(e) => { e.stopPropagation(); setMenuAgent(menuAgent === selected.name ? null : selected.name); }}
                          className="p-1.5 rounded-lg text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-muted)] transition-colors"
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </button>
                        {menuAgent === selected.name && (
                          <div className="absolute right-0 top-8 z-10 bg-white border border-[var(--abu-border)] rounded-lg shadow-lg py-1 min-w-[140px]">
                            {/* Try in chat - only when enabled */}
                            {!disabledSet.has(selected.name) && (
                              <button
                                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-muted)] transition-colors"
                                onClick={() => {
                                  setMenuAgent(null);
                                  startNewConversation();
                                  setPendingInput(`@${selected.name} `);
                                  closeToolbox();
                                }}
                              >
                                <MessageCircle className="h-3 w-3" />
                                {t.toolbox.skillTryInChat}
                              </button>
                            )}
                            {/* Edit & Delete - only for user agents */}
                            {!isSystemAgent(selected) && (
                              <>
                                <button
                                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-muted)] transition-colors"
                                  onClick={() => { setEditorAgent(selected); setMenuAgent(null); }}
                                >
                                  <Pencil className="h-3 w-3" />
                                  {t.toolbox.agentEdit}
                                </button>
                                <button
                                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 transition-colors"
                                  onClick={() => { handleDelete(selected); setMenuAgent(null); }}
                                >
                                  <Trash2 className="h-3 w-3" />
                                  {t.toolbox.uninstall}
                                </button>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* Row 2: Added by */}
            <div className="mb-5">
              <div className="text-xs text-[var(--abu-text-muted)] mb-0.5">{t.toolbox.skillAddedBy}</div>
              <div className="text-sm font-medium text-[var(--abu-text-primary)]">{isSystemAgent(selected) ? 'System' : 'User'}</div>
            </div>

            {/* Description */}
            <div className="mb-7">
              <span className="text-xs text-[var(--abu-text-muted)]">Description</span>
              <p className="text-sm text-[var(--abu-text-primary)] leading-relaxed mt-1.5">{selected.description}</p>
            </div>

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
                <div className="px-6 py-5 bg-[var(--abu-bg-base)]">
                  {contentViewMode === 'preview' ? (
                    <MarkdownRenderer content={selected.systemPrompt} />
                  ) : (
                    <pre className="text-xs text-[var(--abu-text-primary)] whitespace-pre-wrap break-words font-mono leading-relaxed">{selected.systemPrompt}</pre>
                  )}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-sm text-[var(--abu-text-muted)]">
            {t.toolbox.noAgentsFound}
          </div>
        )}
      </div>
    </div>
  );
}
