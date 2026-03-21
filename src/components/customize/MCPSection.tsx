import { useState, useMemo, useEffect } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import { useMCPStore, type MCPServerEntry } from '@/stores/mcpStore';
import { useI18n } from '@/i18n';
import { mcpTemplates } from '@/data/marketplace/mcp';
import { mcpManager, type MCPServerConfig, type MCPLogEntry } from '@/core/mcp/client';
import { parseArgs } from '@/utils/argsParser';
import { Trash2, Plus, Loader2, Check, X, Plug, PlugZap, ChevronDown, ChevronRight, Wrench, Zap, AlertCircle, ScrollText, Server, Search, Pencil } from 'lucide-react';
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
        <div key={tool.name} className="flex items-start gap-2 py-1.5 px-2 rounded bg-[var(--abu-bg-muted)]">
          <Wrench className="h-3 w-3 text-[var(--abu-text-muted)] mt-0.5 shrink-0" />
          <div className="min-w-0">
            <span className="text-xs font-medium text-[var(--abu-text-primary)]">{tool.name}</span>
            {tool.description && (
              <p className="text-[11px] text-[var(--abu-text-muted)] truncate">{tool.description}</p>
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

  // New/Edit server form
  const [internalShowAddForm, setInternalShowAddForm] = useState(false);
  const showAddForm = externalShowAddForm ?? internalShowAddForm;
  const setShowAddForm = (open: boolean) => {
    onAddFormChange?.(open);
    setInternalShowAddForm(open);
  };

  const [editingServerName, setEditingServerName] = useState<string | null>(null); // non-null = edit mode
  const [newServerName, setNewServerName] = useState('');
  const [newTransportType, setNewTransportType] = useState<'stdio' | 'http'>('stdio');
  const [newServerCommand, setNewServerCommand] = useState('');
  const [newServerArgs, setNewServerArgs] = useState('');
  const [newServerUrl, setNewServerUrl] = useState('');
  const [newServerHeaders, setNewServerHeaders] = useState('');
  const [newServerEnv, setNewServerEnv] = useState('');

  // JSON import mode
  const [addMode, setAddMode] = useState<'form' | 'json'>('form');
  const [jsonInput, setJsonInput] = useState('');
  const [jsonError, setJsonError] = useState('');

  // Open form in edit mode with existing config pre-filled
  const handleEditServer = (entry: MCPServerEntry) => {
    const c = entry.config;
    const isHttp = !!(c.url || c.transport === 'http');
    setEditingServerName(c.name);
    setNewServerName(c.name);
    setNewTransportType(isHttp ? 'http' : 'stdio');
    setNewServerCommand(c.command ?? '');
    setNewServerArgs(c.args?.join(' ') ?? '');
    setNewServerUrl(c.url ?? '');
    setNewServerHeaders(c.headers ? JSON.stringify(c.headers) : '');
    setNewServerEnv(c.env ? JSON.stringify(c.env) : '');
    // Pre-fill JSON view with current config
    const jsonObj: Record<string, unknown> = {};
    if (isHttp) {
      jsonObj.url = c.url;
      if (c.headers && Object.keys(c.headers).length > 0) jsonObj.headers = c.headers;
    } else {
      if (c.command) jsonObj.command = c.command;
      if (c.args && c.args.length > 0) jsonObj.args = c.args;
      if (c.env && Object.keys(c.env).length > 0) jsonObj.env = c.env;
    }
    setJsonInput(JSON.stringify({ [c.name]: jsonObj }, null, 2));
    setJsonError('');
    setAddMode('form');
    setShowAddForm(true);
  };

  // Template installation
  const [installingTemplate, setInstallingTemplate] = useState<string | null>(null);
  const [templateArgs, setTemplateArgs] = useState<Record<string, string>>({});

  // Categorize: "我的" = custom (not from templates), "示例" = template-based (installed + uninstalled)
  const searchLower = toolboxSearchQuery.toLowerCase();
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

  // Auto-select first visible item when none selected (initial load or after deletion)
  useEffect(() => {
    if (selected) {
      // Verify the selected item still exists
      if (selected.kind === 'server' && !servers[selected.name]) {
        setSelected(null);
      }
      return;
    }
    // Follow UI order: customServers first, then exampleItems
    if (customServers.length > 0) {
      setSelected({ kind: 'server', name: customServers[0].config.name });
    } else if (exampleItems.length > 0) {
      const first = exampleItems[0];
      if (first.kind === 'installed') {
        setSelected({ kind: 'server', name: first.entry.config.name });
      } else {
        setSelected({ kind: 'template', id: first.template.id });
      }
    }
  }, [mcpServers, customServers, exampleItems, selected]);

  // Add or update custom server
  const handleAddServer = async () => {
    if (!newServerName.trim()) return;
    const isEdit = !!editingServerName;
    const config: MCPServerConfig = {
      name: newServerName.trim(),
      transport: newTransportType,
      enabled: true,
    };
    if (newTransportType === 'stdio') {
      if (!newServerCommand.trim()) return;
      config.command = newServerCommand.trim();
      config.args = newServerArgs.trim() ? parseArgs(newServerArgs.trim()) : [];
      if (newServerEnv.trim()) {
        try { config.env = JSON.parse(newServerEnv.trim()); } catch { /* ignore */ }
      }
    } else {
      if (!newServerUrl.trim()) return;
      config.url = newServerUrl.trim();
      if (newServerHeaders.trim()) {
        try { config.headers = JSON.parse(newServerHeaders.trim()); } catch { /* ignore */ }
      }
    }

    if (isEdit) {
      // Disconnect old connection first
      try { await disconnectServer(config.name); } catch { /* ignore */ }
      // Update config via store
      const updateServer = useMCPStore.getState().updateServer;
      updateServer(config.name, config);
    } else {
      addServer(config);
    }

    handleCloseAddForm();
    setSelected({ kind: 'server', name: config.name });

    // Connect (or reconnect)
    setConnectingServer(config.name);
    setServerErrors((prev) => { const next = { ...prev }; delete next[config.name]; return next; });
    try { await connectServer(config.name); }
    catch (err) { setServerErrors((prev) => ({ ...prev, [config.name]: err instanceof Error ? err.message : String(err) })); }
    finally { setConnectingServer(null); }
  };

  // Add/update server(s) from JSON config
  const handleAddFromJSON = async () => {
    try {
      const parsed = JSON.parse(jsonInput.trim());
      // Support both { "name": { ... } } and { "mcpServers": { "name": { ... } } }
      const serverMap = (parsed.mcpServers ?? parsed) as Record<string, Record<string, unknown>>;
      const entries = Object.entries(serverMap);
      if (entries.length === 0) {
        setJsonError(t.toolbox.jsonConfigEmpty);
        return;
      }

      const isEdit = !!editingServerName;

      if (isEdit) {
        // In edit mode, use the first entry (or the entry matching editingServerName)
        const [, serverDef] = entries.find(([n]) => n === editingServerName) ?? entries[0];
        const def = serverDef as Record<string, unknown>;
        const config: MCPServerConfig = { name: editingServerName!, enabled: true };

        if (def.url && typeof def.url === 'string') {
          config.transport = 'http';
          config.url = def.url;
          if (def.headers && typeof def.headers === 'object') config.headers = def.headers as Record<string, string>;
        } else {
          config.transport = 'stdio';
          config.command = (typeof def.command === 'string' ? def.command : undefined) ?? 'npx';
          config.args = (Array.isArray(def.args) ? def.args : undefined) ?? [];
          if (def.env && typeof def.env === 'object') config.env = def.env as Record<string, string>;
        }

        try { await disconnectServer(config.name); } catch { /* ignore */ }
        const updateServer = useMCPStore.getState().updateServer;
        updateServer(config.name, config);
        handleCloseAddForm();
        setSelected({ kind: 'server', name: config.name });
        setConnectingServer(config.name);
        setServerErrors((prev) => { const next = { ...prev }; delete next[config.name]; return next; });
        try { await connectServer(config.name); }
        catch (err) { setServerErrors((prev) => ({ ...prev, [config.name]: err instanceof Error ? err.message : String(err) })); }
        finally { setConnectingServer(null); }
      } else {
        let firstName = '';
        for (const [name, serverDef] of entries) {
          if (!firstName) firstName = name;
          const config: MCPServerConfig = { name, enabled: true };

          if (serverDef.url && typeof serverDef.url === 'string') {
            config.transport = 'http';
            config.url = serverDef.url;
            if (serverDef.headers && typeof serverDef.headers === 'object') config.headers = serverDef.headers as Record<string, string>;
          } else {
            config.transport = 'stdio';
            config.command = (typeof serverDef.command === 'string' ? serverDef.command : undefined) ?? 'npx';
            config.args = (Array.isArray(serverDef.args) ? serverDef.args as string[] : undefined) ?? [];
            if (serverDef.env && typeof serverDef.env === 'object') config.env = serverDef.env as Record<string, string>;
          }

          addServer(config);
          connectServer(name).catch((err) => {
            setServerErrors((prev) => ({ ...prev, [name]: err instanceof Error ? err.message : String(err) }));
          });
        }

        setJsonInput('');
        setJsonError('');
        setShowAddForm(false);
        setSelected({ kind: 'server', name: firstName });
      }
    } catch {
      setJsonError(t.toolbox.jsonConfigInvalid);
    }
  };

  useEffect(() => {
    if (!showAddForm) return;
    const handleKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowAddForm(false); };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showAddForm]);

  const handleCloseAddForm = () => {
    setShowAddForm(false);
    setEditingServerName(null);
    setNewServerName(''); setNewTransportType('stdio'); setNewServerCommand('');
    setNewServerArgs(''); setNewServerUrl(''); setNewServerHeaders(''); setNewServerEnv('');
    setAddMode('form'); setJsonInput(''); setJsonError('');
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

  const handleRemoveServer = async (name: string) => {
    // Clear selection first so the right panel stops showing stale data
    if (selected?.kind === 'server' && selected.name === name) setSelected(null);
    // Disconnect before removing to avoid stale connected state
    try { await disconnectServer(name); } catch { /* ignore */ }
    removeServer(name);
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

  // Status icon color helper
  const statusIconClass = (entry: MCPServerEntry) => {
    const { status } = entry;
    const isConn = connectingServer === entry.config.name;
    if (status === 'reconnecting') return 'text-orange-400 animate-pulse';
    if (isConn || status === 'connecting') return 'text-amber-400 animate-pulse';
    if (status === 'connected') return 'text-green-500';
    if (status === 'error') return 'text-red-400';
    return 'text-[var(--abu-text-muted)]';
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
      <div className="w-[340px] shrink-0 border-r border-[var(--abu-border)] flex flex-col overflow-hidden bg-[var(--abu-bg-base)]">
        {/* Header */}
        <div className="shrink-0 px-4 pt-4 pb-3 border-b border-[var(--abu-border)]">
          {showSearch ? (
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--abu-text-tertiary)]" />
              <input
                autoFocus type="text" placeholder={t.toolbox.searchPlaceholder}
                value={toolboxSearchQuery}
                onChange={(e) => setToolboxSearchQuery(e.target.value)}
                onBlur={() => { if (!toolboxSearchQuery) setShowSearch(false); }}
                onKeyDown={(e) => { if (e.key === 'Escape') { setToolboxSearchQuery(''); setShowSearch(false); } }}
                className="w-full pl-7 pr-7 py-1 text-sm border border-[var(--abu-border)] rounded-md bg-[var(--abu-bg-base)] focus:outline-none focus:ring-1 focus:ring-[var(--abu-clay-ring)] text-[var(--abu-text-primary)]"
              />
              <button onClick={() => { setToolboxSearchQuery(''); setShowSearch(false); }} className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)]">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <span className="text-base font-semibold text-[var(--abu-text-primary)]">{t.toolbox.mcp}</span>
              <div className="flex items-center gap-1">
                <button onClick={() => setShowSearch(true)} className="p-1 text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)] transition-colors">
                  <Search className="h-3.5 w-3.5" />
                </button>
                <button onClick={() => setShowAddForm(true)} className="p-1 text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)] transition-colors">
                  <Plus className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto overlay-scroll py-2">
          {/* "我的" — user-added custom servers */}
          {customServers.length > 0 && (
            <div>
              <div
                className="flex items-center gap-1.5 px-5 py-2.5 cursor-pointer text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)]"
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
                    className={`flex items-center gap-3 mx-2 pl-7 pr-3 py-2.5 mb-0.5 rounded-lg cursor-pointer transition-colors ${
                      isSelected ? 'bg-[var(--abu-bg-active)]' : 'hover:bg-[var(--abu-bg-active)]/60'
                    }`}
                    onClick={() => setSelected({ kind: 'server', name: entry.config.name })}
                  >
                    <Server className={cn('h-4 w-4 shrink-0', statusIconClass(entry))} />
                    <span className={`text-sm flex-1 truncate ${isSelected ? 'text-[var(--abu-text-primary)] font-medium' : 'text-[var(--abu-text-tertiary)]'}`}>
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
                className="flex items-center gap-1.5 px-5 py-2.5 cursor-pointer text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)]"
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
                      className={`flex items-center gap-3 mx-2 pl-7 pr-3 py-2.5 mb-0.5 rounded-lg cursor-pointer transition-colors ${
                        isSelected ? 'bg-[var(--abu-bg-active)]' : 'hover:bg-[var(--abu-bg-active)]/60'
                      }`}
                      onClick={() => setSelected({ kind: 'server', name: entry.config.name })}
                    >
                      <Server className={cn('h-4 w-4 shrink-0', statusIconClass(entry))} />
                      <span className={`text-sm flex-1 truncate ${isSelected ? 'text-[var(--abu-text-primary)] font-medium' : 'text-[var(--abu-text-tertiary)]'}`}>
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
                      className={`flex items-center gap-3 mx-2 pl-7 pr-3 py-2.5 mb-0.5 rounded-lg cursor-pointer transition-colors ${
                        isSelected ? 'bg-[var(--abu-bg-active)]' : 'hover:bg-[var(--abu-bg-active)]/60'
                      }`}
                      onClick={() => setSelected({ kind: 'template', id: tmpl.id })}
                    >
                      <Server className="h-4 w-4 shrink-0 text-[var(--abu-text-placeholder)]" />
                      <span className={`text-sm flex-1 truncate ${isSelected ? 'text-[var(--abu-text-primary)] font-medium' : 'text-[var(--abu-text-placeholder)]'}`}>
                        {tmpl.name}
                      </span>
                    </div>
                  );
                }
              })}
            </div>
          )}

          {customServers.length === 0 && exampleItems.length === 0 && (
            <div className="text-xs text-[var(--abu-text-muted)] py-8 text-center">{t.toolbox.noServersConnected}</div>
          )}
        </div>
      </div>

      {/* Right: Detail panel */}
      <div className="flex-1 overflow-y-auto overlay-scroll bg-[var(--abu-bg-base)]">
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
            onEdit={() => handleEditServer(selectedServer)}
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
          <div className="flex items-center justify-center h-full text-sm text-[var(--abu-text-muted)]">
            {t.toolbox.noServersConnected}
          </div>
        )}
      </div>

      {/* Add / Edit Server Modal */}
      {showAddForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={handleCloseAddForm}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--abu-border)]">
              <div className="flex items-center gap-2">
                <Server className="h-5 w-5 text-[var(--abu-clay)]" />
                <h2 className="text-base font-semibold text-[var(--abu-text-primary)]">
                  {editingServerName ? t.toolbox.skillEdit : t.toolbox.addCustomServer}
                </h2>
              </div>
              <button onClick={handleCloseAddForm} className="p-1.5 rounded-lg text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-muted)] transition-colors">
                <X className="h-4 w-4" />
              </button>
            </div>
            {/* Form / JSON mode toggle */}
            <div className="px-5 pt-3 pb-0">
              <div className="flex gap-1 p-0.5 bg-[var(--abu-bg-muted)] rounded-md">
                <button onClick={() => setAddMode('form')}
                  className={cn('flex-1 py-1.5 text-xs font-medium rounded transition-colors', addMode === 'form' ? 'bg-white text-[var(--abu-text-primary)]' : 'text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)]')}>
                  {t.toolbox.formMode}
                </button>
                <button onClick={() => setAddMode('json')}
                  className={cn('flex-1 py-1.5 text-xs font-medium rounded transition-colors', addMode === 'json' ? 'bg-white text-[var(--abu-text-primary)]' : 'text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)]')}>
                  {t.toolbox.jsonMode}
                </button>
              </div>
            </div>

            {addMode === 'json' ? (
              <div className="px-5 py-4 space-y-3">
                <div>
                  <label className="block text-xs font-medium text-[var(--abu-text-secondary)] mb-1">{t.toolbox.jsonConfigLabel}</label>
                  <textarea
                    value={jsonInput}
                    onChange={(e) => { setJsonInput(e.target.value); setJsonError(''); }}
                    placeholder={t.toolbox.jsonConfigPlaceholder}
                    rows={10}
                    className="w-full px-3 py-2 rounded-lg border border-[var(--abu-border)] text-xs text-[var(--abu-text-primary)] bg-[var(--abu-bg-base)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] transition-all font-mono resize-none"
                  />
                  <p className="text-[11px] text-[var(--abu-text-muted)] mt-1.5">{t.toolbox.jsonConfigHint}</p>
                  {jsonError && <p className="text-xs text-red-500 mt-1">{jsonError}</p>}
                </div>
              </div>
            ) : (
              <div className="px-5 py-4 space-y-3">
                <div>
                  <label className="block text-xs font-medium text-[var(--abu-text-secondary)] mb-1">{t.toolbox.serverName}</label>
                  <input type="text" placeholder={t.toolbox.serverName} value={newServerName}
                    onChange={(e) => setNewServerName(e.target.value)}
                    disabled={!!editingServerName}
                    className={cn('w-full px-3 py-1.5 rounded-lg border border-[var(--abu-border)] text-sm text-[var(--abu-text-primary)] bg-[var(--abu-bg-base)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] transition-all',
                      editingServerName && 'opacity-60 cursor-not-allowed')} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--abu-text-secondary)] mb-1">{t.toolbox.transportType}</label>
                  <div className="flex gap-1 p-0.5 bg-[var(--abu-bg-muted)] rounded-md">
                    <button onClick={() => setNewTransportType('stdio')}
                      className={cn('flex-1 py-1.5 text-xs font-medium rounded transition-colors', newTransportType === 'stdio' ? 'bg-white text-[var(--abu-text-primary)]' : 'text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)]')}>
                      {t.toolbox.transportStdio}
                    </button>
                    <button onClick={() => setNewTransportType('http')}
                      className={cn('flex-1 py-1.5 text-xs font-medium rounded transition-colors', newTransportType === 'http' ? 'bg-white text-[var(--abu-text-primary)]' : 'text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)]')}>
                      {t.toolbox.transportHttp}
                    </button>
                  </div>
                </div>
                {newTransportType === 'stdio' ? (
                  <>
                    <div>
                      <label className="block text-xs font-medium text-[var(--abu-text-secondary)] mb-1">{t.toolbox.serverCommand}</label>
                      <input type="text" placeholder={t.toolbox.serverCommand} value={newServerCommand} onChange={(e) => setNewServerCommand(e.target.value)}
                        className="w-full px-3 py-1.5 rounded-lg border border-[var(--abu-border)] text-sm text-[var(--abu-text-primary)] bg-[var(--abu-bg-base)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] transition-all" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-[var(--abu-text-secondary)] mb-1">{t.toolbox.serverArgs}</label>
                      <input type="text" placeholder={t.toolbox.serverArgs} value={newServerArgs} onChange={(e) => setNewServerArgs(e.target.value)}
                        className="w-full px-3 py-1.5 rounded-lg border border-[var(--abu-border)] text-sm text-[var(--abu-text-primary)] bg-[var(--abu-bg-base)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] transition-all" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-[var(--abu-text-secondary)] mb-1">Env (JSON)</label>
                      <input type="text" placeholder='{"API_KEY": "..."}' value={newServerEnv} onChange={(e) => setNewServerEnv(e.target.value)}
                        className="w-full px-3 py-1.5 rounded-lg border border-[var(--abu-border)] text-sm text-[var(--abu-text-primary)] bg-[var(--abu-bg-base)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] transition-all font-mono" />
                    </div>
                  </>
                ) : (
                  <>
                    <div>
                      <label className="block text-xs font-medium text-[var(--abu-text-secondary)] mb-1">URL</label>
                      <input type="text" placeholder={t.toolbox.serverUrlPlaceholder} value={newServerUrl} onChange={(e) => setNewServerUrl(e.target.value)}
                        className="w-full px-3 py-1.5 rounded-lg border border-[var(--abu-border)] text-sm text-[var(--abu-text-primary)] bg-[var(--abu-bg-base)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] transition-all" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-[var(--abu-text-secondary)] mb-1">Headers (JSON)</label>
                      <input type="text" placeholder={t.toolbox.serverHeadersPlaceholder} value={newServerHeaders} onChange={(e) => setNewServerHeaders(e.target.value)}
                        className="w-full px-3 py-1.5 rounded-lg border border-[var(--abu-border)] text-sm text-[var(--abu-text-primary)] bg-[var(--abu-bg-base)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] transition-all font-mono" />
                    </div>
                  </>
                )}
              </div>
            )}
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[var(--abu-border)]">
              <button onClick={handleCloseAddForm} className="px-4 py-1.5 rounded-lg text-sm font-medium text-[var(--abu-text-tertiary)] hover:bg-[var(--abu-bg-muted)] transition-colors">
                {t.common.cancel}
              </button>
              <button onClick={addMode === 'json' ? handleAddFromJSON : handleAddServer}
                disabled={addMode === 'json' ? !jsonInput.trim() : (!newServerName.trim() || (newTransportType === 'stdio' && !newServerCommand.trim()) || (newTransportType === 'http' && !newServerUrl.trim()))}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium bg-[var(--abu-clay)] text-white hover:bg-[var(--abu-clay-hover)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
                <Check className="h-3.5 w-3.5" />
                {editingServerName ? t.common.save : t.toolbox.add}
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
  onToggleTools, onToggleLogs, onToggleConnection, onTestConnection, onRemove, onEdit,
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
  onEdit: () => void;
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
  const isHttp = !!(config.url || config.transport === 'http');

  const statusLabel = isReconnecting ? t.toolbox.reconnecting
    : isConnecting ? t.toolbox.connecting
    : isConnected ? t.toolbox.connected
    : status === 'error' ? 'Error'
    : t.toolbox.disconnected;

  const statusColor = isReconnecting ? 'text-orange-500'
    : isConnecting ? 'text-amber-500'
    : isConnected ? 'text-green-600'
    : status === 'error' ? 'text-red-500'
    : 'text-[var(--abu-text-muted)]';

  return (
    <div className="px-6 py-6">
      {/* Header: Name + Status + Actions */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <Server className="h-5 w-5 text-[var(--abu-text-muted)]" />
          <h2 className="text-xl font-semibold text-[var(--abu-text-primary)]">{config.name}</h2>
          <span className={cn('text-xs font-medium', statusColor)}>{statusLabel}</span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={onToggleLogs} className="p-1.5 rounded-lg text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-muted)] transition-colors" title={t.toolbox.viewLogs}>
            <ScrollText className="h-4 w-4" />
          </button>
          <button onClick={onEdit} className="p-1.5 rounded-lg text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-muted)] transition-colors" title={t.toolbox.skillEdit}>
            <Pencil className="h-4 w-4" />
          </button>
          <button onClick={onTestConnection} disabled={isTesting || isConnecting}
            className="p-1.5 rounded-lg text-[var(--abu-text-muted)] hover:text-blue-600 hover:bg-blue-50 transition-colors disabled:opacity-50" title={t.toolbox.testConnection}>
            {isTesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
          </button>
          <button onClick={onToggleConnection} disabled={isConnecting}
            className={cn('p-1.5 rounded-lg transition-colors',
              isConnecting ? 'text-amber-500 cursor-wait' : isConnected ? 'text-green-600 hover:text-green-700 hover:bg-green-50' : 'text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-muted)]'
            )} title={isConnecting ? t.toolbox.connecting : isConnected ? t.toolbox.disconnect : t.toolbox.connect}>
            {isConnecting ? <Loader2 className="h-4 w-4 animate-spin" /> : isConnected ? <PlugZap className="h-4 w-4" /> : <Plug className="h-4 w-4" />}
          </button>
          <button onClick={onRemove} className="p-1.5 rounded-lg text-[var(--abu-text-muted)] hover:text-red-500 hover:bg-red-50 transition-colors">
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
        <span className="text-xs text-[var(--abu-text-muted)]">{isHttp ? 'URL' : 'Command'}</span>
        <p className="text-sm text-[var(--abu-text-primary)] mt-1 font-mono break-all">
          {config.url ? config.url : `${config.command} ${config.args?.join(' ') ?? ''}`}
        </p>
        {isHttp && config.headers && Object.keys(config.headers).length > 0 && (
          <div className="mt-2">
            <span className="text-xs text-[var(--abu-text-muted)]">Headers</span>
            <p className="text-xs text-[var(--abu-text-primary)] mt-0.5 font-mono break-all">{JSON.stringify(config.headers)}</p>
          </div>
        )}
        {!isHttp && config.env && Object.keys(config.env).length > 0 && (
          <div className="mt-2">
            <span className="text-xs text-[var(--abu-text-muted)]">Env</span>
            <p className="text-xs text-[var(--abu-text-primary)] mt-0.5 font-mono break-all">{JSON.stringify(config.env)}</p>
          </div>
        )}
      </div>

      {/* Tools */}
      {isConnected && toolDetails.length > 0 && (
        <div className="mb-5">
          <button onClick={onToggleTools} className="flex items-center gap-2 text-xs text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)] transition-colors mb-2">
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
    <div className="px-6 py-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <Server className="h-5 w-5 text-[var(--abu-text-placeholder)]" />
          <h2 className="text-xl font-semibold text-[var(--abu-text-primary)]">{template.name}</h2>
          {isHttp && <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-50 text-blue-600">HTTP</span>}
        </div>
        <button onClick={onInstall} disabled={isInstalling}
          className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium bg-[var(--abu-clay)] text-white hover:bg-[var(--abu-clay-hover)] disabled:opacity-50 transition-colors">
          {isInstalling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          {t.toolbox.install}
        </button>
      </div>

      {/* Description */}
      <div className="mb-5">
        <span className="text-xs text-[var(--abu-text-muted)]">Description</span>
        <p className="text-sm text-[var(--abu-text-primary)] mt-1">{template.description}</p>
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
          <span className="text-xs text-[var(--abu-text-muted)]">{t.toolbox.serverArgs}</span>
          {template.configurableArgs?.map((arg) => (
            <input key={arg.index} type="text" placeholder={arg.placeholder}
              value={templateArgs[`${template.id}-${arg.index}`] || ''}
              onChange={(e) => setTemplateArgs((prev) => ({ ...prev, [`${template.id}-${arg.index}`]: e.target.value }))}
              className="w-full px-3 py-1.5 rounded-lg border border-[var(--abu-border)] text-sm text-[var(--abu-text-primary)] bg-[var(--abu-bg-base)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] transition-all" />
          ))}
          {template.requiredEnvVars?.map((envVar) => (
            <div key={envVar.name}>
              <label className="block text-xs text-[var(--abu-text-tertiary)] mb-1">{envVar.label}</label>
              <input type="password" placeholder={envVar.placeholder}
                value={templateArgs[`${template.id}-env-${envVar.name}`] || ''}
                onChange={(e) => setTemplateArgs((prev) => ({ ...prev, [`${template.id}-env-${envVar.name}`]: e.target.value }))}
                className="w-full px-3 py-1.5 rounded-lg border border-[var(--abu-border)] text-sm text-[var(--abu-text-primary)] bg-[var(--abu-bg-base)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] transition-all font-mono" />
              {envVar.description && <p className="text-[11px] text-[var(--abu-text-muted)] mt-0.5">{envVar.description}</p>}
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
      <div className="px-3 py-2 text-[11px] text-[var(--abu-text-muted)] bg-[var(--abu-bg-base)] rounded-lg border border-[var(--abu-border)]">
        {t.toolbox.noLogs}
      </div>
    );
  }

  return (
    <div className="max-h-[200px] overflow-y-auto rounded-lg border border-[var(--abu-border)] bg-neutral-900 p-2">
      {logs.map((log, i) => (
        <div key={i} className="flex gap-2 text-[11px] font-mono leading-4">
          <span className="text-[var(--abu-text-tertiary)] shrink-0">
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
