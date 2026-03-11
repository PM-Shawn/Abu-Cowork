import { useState, useMemo, useEffect } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import { useMCPStore, type MCPServerEntry } from '@/stores/mcpStore';
import { useI18n } from '@/i18n';
import { mcpTemplates } from '@/data/marketplace/mcp';
import { mcpManager, type MCPServerConfig, type MCPLogEntry } from '@/core/mcp/client';
import { parseArgs } from '@/utils/argsParser';
import { Trash2, Plus, Loader2, Check, X, Plug, PlugZap, ChevronDown, ChevronRight, Wrench, Zap, AlertCircle, ScrollText, Server, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { open } from '@tauri-apps/plugin-shell';

const urlPattern = /https?:\/\/[^\s]+/;

/** Render setupHint text with URLs converted to clickable links */
function renderSetupHint(text: string) {
  const parts = text.split(/(https?:\/\/[^\s]+)/g);
  return parts.map((part, i) =>
    urlPattern.test(part) ? (
      <a
        key={i}
        onClick={(e) => { e.preventDefault(); open(part); }}
        className="underline text-amber-800 hover:text-amber-900 cursor-pointer break-all"
      >
        {part}
      </a>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}

/** Shared tool details list */
function ToolDetailsList({ tools }: { tools: { name: string; description?: string }[] }) {
  return (
    <div className="space-y-1">
      {tools.map((tool) => (
        <div key={tool.name} className="flex items-start gap-2 py-1.5 px-2 rounded bg-[#f5f3ee]">
          <Wrench className="h-3 w-3 text-[#888579] mt-0.5 shrink-0" />
          <div className="min-w-0">
            <span className="text-xs font-medium text-[#29261b]">{tool.name}</span>
            {tool.description && (
              <p className="text-[11px] text-[#888579] truncate">{tool.description}</p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

type SelectedItem =
  | { kind: 'server'; name: string }
  | { kind: 'template'; id: string }
  | null;

interface MCPSectionProps {
  showAddForm?: boolean;
  onAddFormChange?: (open: boolean) => void;
}

export default function MCPSection({ showAddForm: externalShowAddForm, onAddFormChange }: MCPSectionProps = {}) {
  const toolboxSearchQuery = useSettingsStore((s) => s.toolboxSearchQuery);
  const setToolboxSearchQuery = useSettingsStore((s) => s.setToolboxSearchQuery);
  const servers = useMCPStore((s) => s.servers);
  const addServer = useMCPStore((s) => s.addServer);
  const removeServer = useMCPStore((s) => s.removeServer);
  const connectServer = useMCPStore((s) => s.connectServer);
  const disconnectServer = useMCPStore((s) => s.disconnectServer);
  const { t } = useI18n();

  const mcpServers = useMemo(() => Object.values(servers), [servers]);

  // Selection
  const [selected, setSelected] = useState<SelectedItem>(null);

  // Auto-select first item when none selected (initial load or after deletion)
  useEffect(() => {
    if (selected) {
      // Verify the selected item still exists
      if (selected.kind === 'server' && !servers[selected.name]) {
        setSelected(null);
      }
    }
    if (!selected) {
      if (mcpServers.length > 0) {
        setSelected({ kind: 'server', name: mcpServers[0].config.name });
      } else if (mcpTemplates.length > 0) {
        setSelected({ kind: 'template', id: mcpTemplates[0].id });
      }
    }
  }, [mcpServers, selected]);

  // Connection UI state
  const [connectingServer, setConnectingServer] = useState<string | null>(null);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});

  // Tool list expansion
  const [expandedTools, setExpandedTools] = useState(false);

  // Test connection state
  const [testingServer, setTestingServer] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; message: string }>>({});

  // Server logs viewer
  const [showLogs, setShowLogs] = useState(false);

  // Search & create UI
  const [showSearch, setShowSearch] = useState(false);
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());

  // New server form
  const [internalShowAddForm, setInternalShowAddForm] = useState(false);
  const showAddForm = externalShowAddForm ?? internalShowAddForm;
  const setShowAddForm = (open: boolean) => {
    onAddFormChange?.(open);
    setInternalShowAddForm(open);
  };

  const [newServerName, setNewServerName] = useState('');
  const [newTransportType, setNewTransportType] = useState<'stdio' | 'http'>('stdio');
  const [newServerCommand, setNewServerCommand] = useState('');
  const [newServerArgs, setNewServerArgs] = useState('');
  const [newServerUrl, setNewServerUrl] = useState('');
  const [newServerHeaders, setNewServerHeaders] = useState('');

  // Template installation
  const [installingTemplate, setInstallingTemplate] = useState<string | null>(null);
  const [templateArgs, setTemplateArgs] = useState<Record<string, string>>({});

  // Categorize: "我的" = custom (not from templates), "示例" = template-based (installed + uninstalled)
  const searchLower = toolboxSearchQuery.toLowerCase();
  const installedNames = useMemo(() => new Set(mcpServers.map((s) => s.config.name)), [mcpServers]);
  const templateNames = useMemo(() => new Set(mcpTemplates.map((t) => t.name)), []);

  // "我的": user-added custom servers (not matching any template)
  const customServers = useMemo(() => {
    const list = mcpServers.filter((s) => !templateNames.has(s.config.name));
    if (!toolboxSearchQuery) return list;
    return list.filter((s) => s.config.name.toLowerCase().includes(searchLower));
  }, [mcpServers, templateNames, searchLower]);

  // "示例": all templates — installed ones first, then uninstalled
  type ExampleItem = { kind: 'installed'; entry: MCPServerEntry } | { kind: 'template'; template: typeof mcpTemplates[0] };
  const exampleItems = useMemo(() => {
    const items: ExampleItem[] = [];
    for (const tmpl of mcpTemplates) {
      if (toolboxSearchQuery && !tmpl.name.toLowerCase().includes(searchLower) && !tmpl.description.toLowerCase().includes(searchLower)) continue;
      const entry = servers[tmpl.name];
      if (entry) {
        items.push({ kind: 'installed', entry });
      } else {
        items.push({ kind: 'template', template: tmpl });
      }
    }
    return items;
  }, [servers, searchLower]);

  // Add custom server
  const handleAddServer = async () => {
    if (!newServerName.trim()) return;
    const config: MCPServerConfig = {
      name: newServerName.trim(),
      transport: newTransportType,
      enabled: true,
    };
    if (newTransportType === 'stdio') {
      if (!newServerCommand.trim()) return;
      config.command = newServerCommand.trim();
      config.args = newServerArgs.trim() ? parseArgs(newServerArgs.trim()) : [];
    } else {
      if (!newServerUrl.trim()) return;
      config.url = newServerUrl.trim();
      if (newServerHeaders.trim()) {
        try { config.headers = JSON.parse(newServerHeaders.trim()); } catch { /* ignore */ }
      }
    }
    addServer(config);
    setNewServerName(''); setNewTransportType('stdio'); setNewServerCommand('');
    setNewServerArgs(''); setNewServerUrl(''); setNewServerHeaders('');
    setShowAddForm(false);
    setSelected({ kind: 'server', name: config.name });

    setConnectingServer(config.name);
    setServerErrors((prev) => { const next = { ...prev }; delete next[config.name]; return next; });
    try { await connectServer(config.name); }
    catch (err) { setServerErrors((prev) => ({ ...prev, [config.name]: err instanceof Error ? err.message : String(err) })); }
    finally { setConnectingServer(null); }
  };

  useEffect(() => {
    if (!showAddForm) return;
    const handleKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowAddForm(false); };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showAddForm]);

  const handleCloseAddForm = () => {
    setShowAddForm(false);
    setNewServerName(''); setNewTransportType('stdio'); setNewServerCommand('');
    setNewServerArgs(''); setNewServerUrl(''); setNewServerHeaders('');
  };

  // Install from template
  const handleInstallTemplate = async (template: typeof mcpTemplates[0]) => {
    setInstallingTemplate(template.id);
    try {
      let config: MCPServerConfig;
      if (template.transport === 'http' && template.url) {
        config = { name: template.name, url: template.url, enabled: true };
      } else {
        const args = [...(template.defaultArgs ?? [])];
        if (template.configurableArgs) {
          for (const configArg of template.configurableArgs) {
            const value = templateArgs[`${template.id}-${configArg.index}`];
            if (value) args[configArg.index] = value;
          }
        }
        const env: Record<string, string> = {};
        if (template.requiredEnvVars) {
          for (const envVar of template.requiredEnvVars) {
            const value = templateArgs[`${template.id}-env-${envVar.name}`];
            if (value) env[envVar.name] = value;
          }
        }
        config = {
          name: template.name, command: template.command ?? 'npx', args,
          env: Object.keys(env).length > 0 ? env : undefined,
          enabled: true, timeout: template.defaultTimeout,
        };
      }
      addServer(config);
      setSelected({ kind: 'server', name: config.name });
      try { await connectServer(config.name); } catch (err) { console.error('Failed to connect MCP server:', err); }
    } finally {
      setInstallingTemplate(null);
      setTemplateArgs({});
    }
  };

  const handleRemoveServer = (name: string) => {
    removeServer(name);
    if (selected?.kind === 'server' && selected.name === name) setSelected(null);
  };

  const handleToggleConnection = async (entry: MCPServerEntry) => {
    const name = entry.config.name;
    setConnectingServer(name);
    setServerErrors((prev) => { const next = { ...prev }; delete next[name]; return next; });
    try {
      if (entry.status === 'connected') await disconnectServer(name);
      else await connectServer(name);
    } catch (err) {
      setServerErrors((prev) => ({ ...prev, [name]: err instanceof Error ? err.message : String(err) }));
    } finally { setConnectingServer(null); }
  };

  const handleTestConnection = async (entry: MCPServerEntry) => {
    const name = entry.config.name;
    setTestingServer(name);
    setTestResults((prev) => { const next = { ...prev }; delete next[name]; return next; });
    try {
      const result = await mcpManager.testConnection(entry.config);
      const message = result.success
        ? `${t.toolbox.testSuccess} (${result.toolCount ?? 0} tools)`
        : (result.error ?? t.toolbox.testFailed);
      setTestResults((prev) => ({ ...prev, [name]: { success: result.success, message } }));
    } catch (err) {
      setTestResults((prev) => ({ ...prev, [name]: { success: false, message: err instanceof Error ? err.message : String(err) } }));
    } finally { setTestingServer(null); }
  };

  const toggleCategory = (cat: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      return next;
    });
  };

  // Status dot color helper
  const statusDotClass = (entry: MCPServerEntry) => {
    const { status } = entry;
    const isConn = connectingServer === entry.config.name;
    if (status === 'reconnecting') return 'bg-orange-400 animate-pulse';
    if (isConn || status === 'connecting') return 'bg-amber-400 animate-pulse';
    if (status === 'connected') return 'bg-green-500';
    if (status === 'error') return 'bg-red-400';
    return 'bg-[#b5b0a6]';
  };

  // Get selected server entry or template
  const selectedServer = selected?.kind === 'server' ? servers[selected.name] : null;
  const selectedTemplate = selected?.kind === 'template'
    ? mcpTemplates.find((t) => t.id === selected.id) ?? null
    : null;

  // Reset detail state when selection changes
  useEffect(() => {
    setExpandedTools(false);
    setShowLogs(false);
  }, [selected?.kind === 'server' ? selected.name : selected?.kind === 'template' ? selected.id : null]);

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left: Server list */}
      <div className="w-[260px] shrink-0 border-r border-[#e8e4dd]/60 flex flex-col overflow-hidden bg-[#faf8f5]">
        {/* Header */}
        <div className="shrink-0 px-3 pt-3 pb-2 border-b border-[#e8e4dd]/60">
          {showSearch ? (
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[#656358]" />
              <input
                autoFocus type="text" placeholder={t.toolbox.searchPlaceholder}
                value={toolboxSearchQuery}
                onChange={(e) => setToolboxSearchQuery(e.target.value)}
                onBlur={() => { if (!toolboxSearchQuery) setShowSearch(false); }}
                onKeyDown={(e) => { if (e.key === 'Escape') { setToolboxSearchQuery(''); setShowSearch(false); } }}
                className="w-full pl-7 pr-7 py-1 text-sm border border-[#e8e4dd] rounded-md bg-white focus:outline-none focus:ring-1 focus:ring-[#d97757]/30 text-[#29261b]"
              />
              <button onClick={() => { setToolboxSearchQuery(''); setShowSearch(false); }} className="absolute right-2 top-1/2 -translate-y-1/2 text-[#656358] hover:text-[#29261b]">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-[#29261b]">{t.toolbox.mcp}</span>
              <div className="flex items-center gap-1">
                <button onClick={() => setShowSearch(true)} className="p-1 text-[#888579] hover:text-[#29261b] transition-colors">
                  <Search className="h-3.5 w-3.5" />
                </button>
                <button onClick={() => setShowAddForm(true)} className="p-1 text-[#888579] hover:text-[#29261b] transition-colors">
                  <Plus className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto py-1">
          {/* "我的" — user-added custom servers */}
          {customServers.length > 0 && (
            <div>
              <div
                className="flex items-center gap-1.5 px-4 py-2 cursor-pointer text-[#888579] hover:text-[#29261b]"
                onClick={() => toggleCategory('my')}
              >
                {collapsedCategories.has('my') ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                <span className="text-[13px] font-medium">{t.toolbox.myServers}</span>
              </div>
              {!collapsedCategories.has('my') && customServers.map((entry) => {
                const isSelected = selected?.kind === 'server' && selected.name === entry.config.name;
                return (
                  <div
                    key={entry.config.name}
                    className={`flex items-center gap-2.5 pl-7 pr-3 py-2.5 cursor-pointer transition-colors ${
                      isSelected ? 'bg-[#eae7e0]' : 'hover:bg-[#f0ede6]'
                    }`}
                    onClick={() => setSelected({ kind: 'server', name: entry.config.name })}
                  >
                    <div className={cn('h-2 w-2 rounded-full shrink-0', statusDotClass(entry))} />
                    <span className={`text-sm flex-1 truncate ${isSelected ? 'text-[#29261b] font-medium' : 'text-[#656358]'}`}>
                      {entry.config.name}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {/* "示例" — template-based (installed + uninstalled together) */}
          {exampleItems.length > 0 && (
            <div>
              <div
                className="flex items-center gap-1.5 px-4 py-2 cursor-pointer text-[#888579] hover:text-[#29261b]"
                onClick={() => toggleCategory('examples')}
              >
                {collapsedCategories.has('examples') ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                <span className="text-[13px] font-medium">{t.toolbox.exampleServers}</span>
              </div>
              {!collapsedCategories.has('examples') && exampleItems.map((item) => {
                if (item.kind === 'installed') {
                  const { entry } = item;
                  const isSelected = selected?.kind === 'server' && selected.name === entry.config.name;
                  return (
                    <div
                      key={entry.config.name}
                      className={`flex items-center gap-2.5 pl-7 pr-3 py-2.5 cursor-pointer transition-colors ${
                        isSelected ? 'bg-[#eae7e0]' : 'hover:bg-[#f0ede6]'
                      }`}
                      onClick={() => setSelected({ kind: 'server', name: entry.config.name })}
                    >
                      <div className={cn('h-2 w-2 rounded-full shrink-0', statusDotClass(entry))} />
                      <span className={`text-sm flex-1 truncate ${isSelected ? 'text-[#29261b] font-medium' : 'text-[#656358]'}`}>
                        {entry.config.name}
                      </span>
                    </div>
                  );
                } else {
                  const { template: tmpl } = item;
                  const isSelected = selected?.kind === 'template' && selected.id === tmpl.id;
                  return (
                    <div
                      key={tmpl.id}
                      className={`flex items-center gap-2.5 pl-7 pr-3 py-2.5 cursor-pointer transition-colors ${
                        isSelected ? 'bg-[#eae7e0]' : 'hover:bg-[#f0ede6]'
                      }`}
                      onClick={() => setSelected({ kind: 'template', id: tmpl.id })}
                    >
                      <Server className="h-3.5 w-3.5 shrink-0 text-[#b5b0a6]" />
                      <span className={`text-sm flex-1 truncate ${isSelected ? 'text-[#29261b] font-medium' : 'text-[#b5b0a6]'}`}>
                        {tmpl.name}
                      </span>
                    </div>
                  );
                }
              })}
            </div>
          )}

          {customServers.length === 0 && exampleItems.length === 0 && (
            <div className="text-xs text-[#888579] py-8 text-center">{t.toolbox.noServersConnected}</div>
          )}
        </div>
      </div>

      {/* Right: Detail panel */}
      <div className="flex-1 overflow-y-auto bg-white">
        {selectedServer ? (
          <ServerDetail
            entry={selectedServer}
            connectingServer={connectingServer}
            serverErrors={serverErrors}
            testingServer={testingServer}
            testResults={testResults}
            expandedTools={expandedTools}
            showLogs={showLogs}
            onToggleTools={() => setExpandedTools(!expandedTools)}
            onToggleLogs={() => setShowLogs(!showLogs)}
            onToggleConnection={() => handleToggleConnection(selectedServer)}
            onTestConnection={() => handleTestConnection(selectedServer)}
            onRemove={() => handleRemoveServer(selectedServer.config.name)}
          />
        ) : selectedTemplate ? (
          <TemplateDetail
            template={selectedTemplate}
            templateArgs={templateArgs}
            setTemplateArgs={setTemplateArgs}
            installingTemplate={installingTemplate}
            onInstall={() => handleInstallTemplate(selectedTemplate)}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-sm text-[#888579]">
            {t.toolbox.noServersConnected}
          </div>
        )}
      </div>

      {/* Add Server Modal */}
      {showAddForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={handleCloseAddForm}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-[#e8e4dd]/60">
              <div className="flex items-center gap-2">
                <Server className="h-5 w-5 text-[#d97757]" />
                <h2 className="text-base font-semibold text-[#29261b]">{t.toolbox.addCustomServer}</h2>
              </div>
              <button onClick={handleCloseAddForm} className="p-1.5 rounded-lg text-[#888579] hover:text-[#29261b] hover:bg-[#f5f3ee] transition-colors">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="px-5 py-4 space-y-3">
              <div>
                <label className="block text-xs font-medium text-[#29261b]/70 mb-1">{t.toolbox.serverName}</label>
                <input type="text" placeholder={t.toolbox.serverName} value={newServerName} onChange={(e) => setNewServerName(e.target.value)}
                  className="w-full px-3 py-1.5 rounded-lg border border-[#e8e4dd] text-sm text-[#29261b] bg-white focus:outline-none focus:ring-2 focus:ring-[#d97757]/30 focus:border-[#d97757] transition-all" />
              </div>
              <div>
                <label className="block text-xs font-medium text-[#29261b]/70 mb-1">{t.toolbox.transportType}</label>
                <div className="flex gap-1 p-0.5 bg-[#f5f3ee] rounded-md">
                  <button onClick={() => setNewTransportType('stdio')}
                    className={cn('flex-1 py-1.5 text-xs font-medium rounded transition-colors', newTransportType === 'stdio' ? 'bg-white text-[#29261b] shadow-sm' : 'text-[#888579] hover:text-[#29261b]')}>
                    {t.toolbox.transportStdio}
                  </button>
                  <button onClick={() => setNewTransportType('http')}
                    className={cn('flex-1 py-1.5 text-xs font-medium rounded transition-colors', newTransportType === 'http' ? 'bg-white text-[#29261b] shadow-sm' : 'text-[#888579] hover:text-[#29261b]')}>
                    {t.toolbox.transportHttp}
                  </button>
                </div>
              </div>
              {newTransportType === 'stdio' ? (
                <>
                  <div>
                    <label className="block text-xs font-medium text-[#29261b]/70 mb-1">{t.toolbox.serverCommand}</label>
                    <input type="text" placeholder={t.toolbox.serverCommand} value={newServerCommand} onChange={(e) => setNewServerCommand(e.target.value)}
                      className="w-full px-3 py-1.5 rounded-lg border border-[#e8e4dd] text-sm text-[#29261b] bg-white focus:outline-none focus:ring-2 focus:ring-[#d97757]/30 focus:border-[#d97757] transition-all" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-[#29261b]/70 mb-1">{t.toolbox.serverArgs}</label>
                    <input type="text" placeholder={t.toolbox.serverArgs} value={newServerArgs} onChange={(e) => setNewServerArgs(e.target.value)}
                      className="w-full px-3 py-1.5 rounded-lg border border-[#e8e4dd] text-sm text-[#29261b] bg-white focus:outline-none focus:ring-2 focus:ring-[#d97757]/30 focus:border-[#d97757] transition-all" />
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <label className="block text-xs font-medium text-[#29261b]/70 mb-1">URL</label>
                    <input type="text" placeholder={t.toolbox.serverUrlPlaceholder} value={newServerUrl} onChange={(e) => setNewServerUrl(e.target.value)}
                      className="w-full px-3 py-1.5 rounded-lg border border-[#e8e4dd] text-sm text-[#29261b] bg-white focus:outline-none focus:ring-2 focus:ring-[#d97757]/30 focus:border-[#d97757] transition-all" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-[#29261b]/70 mb-1">Headers (JSON)</label>
                    <input type="text" placeholder={t.toolbox.serverHeadersPlaceholder} value={newServerHeaders} onChange={(e) => setNewServerHeaders(e.target.value)}
                      className="w-full px-3 py-1.5 rounded-lg border border-[#e8e4dd] text-sm text-[#29261b] bg-white focus:outline-none focus:ring-2 focus:ring-[#d97757]/30 focus:border-[#d97757] transition-all font-mono" />
                  </div>
                </>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[#e8e4dd]/60">
              <button onClick={handleCloseAddForm} className="px-4 py-1.5 rounded-lg text-sm font-medium text-[#656358] hover:bg-[#f5f3ee] transition-colors">
                {t.common.cancel}
              </button>
              <button onClick={handleAddServer}
                disabled={!newServerName.trim() || (newTransportType === 'stdio' && !newServerCommand.trim()) || (newTransportType === 'http' && !newServerUrl.trim())}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium bg-[#d97757] text-white hover:bg-[#c5664a] disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
                <Check className="h-3.5 w-3.5" />
                {t.toolbox.add}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Server Detail Panel ---

function ServerDetail({
  entry, connectingServer, serverErrors, testingServer, testResults,
  expandedTools, showLogs,
  onToggleTools, onToggleLogs, onToggleConnection, onTestConnection, onRemove,
}: {
  entry: MCPServerEntry;
  connectingServer: string | null;
  serverErrors: Record<string, string>;
  testingServer: string | null;
  testResults: Record<string, { success: boolean; message: string }>;
  expandedTools: boolean;
  showLogs: boolean;
  onToggleTools: () => void;
  onToggleLogs: () => void;
  onToggleConnection: () => void;
  onTestConnection: () => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const { config, status, tools } = entry;
  const isConnected = status === 'connected';
  const isReconnecting = status === 'reconnecting';
  const isConnecting = connectingServer === config.name || status === 'connecting' || isReconnecting;
  const error = serverErrors[config.name] || (status === 'error' ? entry.error : undefined);
  const isTesting = testingServer === config.name;
  const testResult = testResults[config.name];
  const toolDetails = (tools ?? []) as { name: string; description?: string }[];

  const statusLabel = isReconnecting ? t.toolbox.reconnecting
    : isConnecting ? t.toolbox.connecting
    : isConnected ? t.toolbox.connected
    : status === 'error' ? 'Error'
    : t.toolbox.disconnected;

  const statusColor = isReconnecting ? 'text-orange-500'
    : isConnecting ? 'text-amber-500'
    : isConnected ? 'text-green-600'
    : status === 'error' ? 'text-red-500'
    : 'text-[#888579]';

  return (
    <div className="p-6">
      {/* Header: Name + Status + Actions */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <Server className="h-5 w-5 text-[#888579]" />
          <h2 className="text-lg font-semibold text-[#29261b]">{config.name}</h2>
          <span className={cn('text-xs font-medium', statusColor)}>{statusLabel}</span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={onToggleLogs} className="p-1.5 rounded-lg text-[#888579] hover:text-[#29261b] hover:bg-[#f5f3ee] transition-colors" title={t.toolbox.viewLogs}>
            <ScrollText className="h-4 w-4" />
          </button>
          <button onClick={onTestConnection} disabled={isTesting || isConnecting}
            className="p-1.5 rounded-lg text-[#888579] hover:text-blue-600 hover:bg-blue-50 transition-colors disabled:opacity-50" title={t.toolbox.testConnection}>
            {isTesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
          </button>
          <button onClick={onToggleConnection} disabled={isConnecting}
            className={cn('p-1.5 rounded-lg transition-colors',
              isConnecting ? 'text-amber-500 cursor-wait' : isConnected ? 'text-green-600 hover:text-green-700 hover:bg-green-50' : 'text-[#888579] hover:text-[#29261b] hover:bg-[#f5f3ee]'
            )} title={isConnecting ? t.toolbox.connecting : isConnected ? t.toolbox.disconnect : t.toolbox.connect}>
            {isConnecting ? <Loader2 className="h-4 w-4 animate-spin" /> : isConnected ? <PlugZap className="h-4 w-4" /> : <Plug className="h-4 w-4" />}
          </button>
          <button onClick={onRemove} className="p-1.5 rounded-lg text-[#888579] hover:text-red-500 hover:bg-red-50 transition-colors">
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
          <p className="text-xs text-red-600 break-words">{error}</p>
        </div>
      )}

      {/* Test result */}
      {testResult && (
        <div className={cn('mb-4 px-3 py-2 text-xs rounded-lg flex items-center gap-1.5',
          testResult.success ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-600 border border-red-200'
        )}>
          {testResult.success ? <Check className="h-3.5 w-3.5" /> : <AlertCircle className="h-3.5 w-3.5" />}
          {testResult.message}
        </div>
      )}

      {/* Connection info */}
      <div className="mb-5">
        <span className="text-xs text-[#888579]">{config.url ? 'URL' : 'Command'}</span>
        <p className="text-sm text-[#29261b] mt-1 font-mono break-all">
          {config.url ? config.url : `${config.command} ${config.args?.join(' ') ?? ''}`}
        </p>
      </div>

      {/* Tools */}
      {isConnected && toolDetails.length > 0 && (
        <div className="mb-5">
          <button onClick={onToggleTools} className="flex items-center gap-2 text-xs text-[#888579] hover:text-[#29261b] transition-colors mb-2">
            {expandedTools ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <Wrench className="h-3 w-3" />
            <span>{t.toolbox.agentTools} ({toolDetails.length})</span>
          </button>
          {expandedTools && <ToolDetailsList tools={toolDetails} />}
        </div>
      )}

      {/* Logs */}
      {showLogs && <ServerLogsPanel serverName={config.name} />}
    </div>
  );
}

// --- Template Detail Panel ---

function TemplateDetail({
  template, templateArgs, setTemplateArgs, installingTemplate, onInstall,
}: {
  template: typeof mcpTemplates[0];
  templateArgs: Record<string, string>;
  setTemplateArgs: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  installingTemplate: string | null;
  onInstall: () => void;
}) {
  const { t } = useI18n();
  const isInstalling = installingTemplate === template.id;
  const isHttp = template.transport === 'http';
  const hasConfigurableArgs = template.configurableArgs && template.configurableArgs.length > 0;
  const hasEnvVars = template.requiredEnvVars && template.requiredEnvVars.length > 0;
  const hasSetupHint = !!template.setupHint;

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <Server className="h-5 w-5 text-[#b5b0a6]" />
          <h2 className="text-lg font-semibold text-[#29261b]">{template.name}</h2>
          {isHttp && <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-50 text-blue-600">HTTP</span>}
        </div>
        <button onClick={onInstall} disabled={isInstalling}
          className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium bg-[#d97757] text-white hover:bg-[#c5664a] disabled:opacity-50 transition-colors">
          {isInstalling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          {t.toolbox.install}
        </button>
      </div>

      {/* Description */}
      <div className="mb-5">
        <span className="text-xs text-[#888579]">Description</span>
        <p className="text-sm text-[#29261b] mt-1">{template.description}</p>
      </div>

      {/* Setup hint */}
      {hasSetupHint && (
        <div className="mb-5 p-3 rounded-lg bg-amber-50 border border-amber-200/60">
          <p className="text-xs text-amber-700 leading-relaxed whitespace-pre-wrap break-words">
            {renderSetupHint(template.setupHint!)}
          </p>
        </div>
      )}

      {/* Configuration inputs */}
      {(hasConfigurableArgs || hasEnvVars) && (
        <div className="space-y-3">
          <span className="text-xs text-[#888579]">{t.toolbox.serverArgs}</span>
          {template.configurableArgs?.map((arg) => (
            <input key={arg.index} type="text" placeholder={arg.placeholder}
              value={templateArgs[`${template.id}-${arg.index}`] || ''}
              onChange={(e) => setTemplateArgs((prev) => ({ ...prev, [`${template.id}-${arg.index}`]: e.target.value }))}
              className="w-full px-3 py-1.5 rounded-lg border border-[#e8e4dd] text-sm text-[#29261b] bg-white focus:outline-none focus:ring-2 focus:ring-[#d97757]/30 focus:border-[#d97757] transition-all" />
          ))}
          {template.requiredEnvVars?.map((envVar) => (
            <div key={envVar.name}>
              <label className="block text-xs text-[#656358] mb-1">{envVar.label}</label>
              <input type="password" placeholder={envVar.placeholder}
                value={templateArgs[`${template.id}-env-${envVar.name}`] || ''}
                onChange={(e) => setTemplateArgs((prev) => ({ ...prev, [`${template.id}-env-${envVar.name}`]: e.target.value }))}
                className="w-full px-3 py-1.5 rounded-lg border border-[#e8e4dd] text-sm text-[#29261b] bg-white focus:outline-none focus:ring-2 focus:ring-[#d97757]/30 focus:border-[#d97757] transition-all font-mono" />
              {envVar.description && <p className="text-[11px] text-[#888579] mt-0.5">{envVar.description}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Server Logs Panel ---

function ServerLogsPanel({ serverName }: { serverName: string }) {
  const { t } = useI18n();
  const [logs, setLogs] = useState<MCPLogEntry[]>(() => mcpManager.getServerLogs(serverName));

  useEffect(() => {
    const update = () => setLogs([...mcpManager.getServerLogs(serverName)]);
    const unsubscribe = mcpManager.subscribe(update);
    const timer = setInterval(update, 2000);
    return () => { unsubscribe(); clearInterval(timer); };
  }, [serverName]);

  if (logs.length === 0) {
    return (
      <div className="px-3 py-2 text-[11px] text-[#888579] bg-[#faf8f5] rounded-lg border border-[#e8e4dd]">
        {t.toolbox.noLogs}
      </div>
    );
  }

  return (
    <div className="max-h-[200px] overflow-y-auto rounded-lg border border-[#e8e4dd] bg-neutral-900 p-2">
      {logs.map((log, i) => (
        <div key={i} className="flex gap-2 text-[11px] font-mono leading-4">
          <span className="text-neutral-500 shrink-0">
            {new Date(log.timestamp).toLocaleTimeString()}
          </span>
          <span className={cn(
            log.level === 'error' ? 'text-red-400' :
            log.level === 'warn' ? 'text-amber-400' : 'text-neutral-300'
          )}>
            {log.message}
          </span>
        </div>
      ))}
    </div>
  );
}
