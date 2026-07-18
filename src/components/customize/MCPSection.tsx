import { useState, useMemo, useEffect } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import { useMCPStore, type MCPServerEntry } from '@/stores/mcpStore';
import { useI18n } from '@/i18n';
import { mcpTemplates } from '@/data/marketplace/mcp';
import { mcpManager, type MCPServerConfig, type MCPLogEntry } from '@/core/mcp/client';
import { parseArgs } from '@/utils/argsParser';
import { Trash2, Plus, Loader2, Check, X, Plug, PlugZap, ChevronDown, ChevronRight, Wrench, Zap, AlertCircle, ScrollText, Server, Pencil } from 'lucide-react';
import { cn } from '@/lib/utils';
import { open } from '@tauri-apps/plugin-shell';
import ToolCard from '@/components/toolbox/ToolCard';
import ToolGrid from '@/components/toolbox/ToolGrid';
import ToolDetailModal from '@/components/toolbox/ToolDetailModal';

const urlPattern = /https?:\/\/[^\s]+/;

/** Render setupHint text with URLs converted to clickable links */
function renderSetupHint(text: string) {
  const parts = text.split(/(https?:\/\/[^\s]+)/g);
  return parts.map((part, i) =>
    urlPattern.test(part) ? (
      <a
        key={i}
        onClick={(e) => { e.preventDefault(); open(part); }}
        className="underline text-[var(--abu-warning)] hover:text-[var(--abu-warning)] cursor-pointer break-all"
      >
        {part}
      </a>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}

/** Locale-aware pick between zh (default) and en fields. */
function pickLocale(locale: string, zh: string, en?: string): string {
  return locale.startsWith('zh') ? zh : (en ?? zh);
}

/** Shared tool details list */
function ToolDetailsList({ tools }: { tools: { name: string; description?: string }[] }) {
  return (
    <div className="space-y-1">
      {tools.map((tool) => (
        <div key={tool.name} className="flex items-start gap-2 py-1.5 px-2 rounded bg-[var(--abu-bg-muted)]">
          <Wrench className="h-3 w-3 text-[var(--abu-text-muted)] mt-0.5 shrink-0" />
          <div className="min-w-0">
            <span className="text-minor font-medium text-[var(--abu-text-primary)]">{tool.name}</span>
            {tool.description && (
              <p className="text-caption text-[var(--abu-text-muted)] truncate">{tool.description}</p>
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
  const servers = useMCPStore((s) => s.servers);
  const addServer = useMCPStore((s) => s.addServer);
  const removeServer = useMCPStore((s) => s.removeServer);
  const connectServer = useMCPStore((s) => s.connectServer);
  const disconnectServer = useMCPStore((s) => s.disconnectServer);
  const clearServerError = useMCPStore((s) => s.clearServerError);
  const { t, locale } = useI18n();

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
    if (!searchLower) return list;
    return list.filter((s) => s.config.name.toLowerCase().includes(searchLower));
  }, [mcpServers, templateNames, searchLower]);

  // "示例": all templates — installed ones first, then uninstalled
  type ExampleItem = { kind: 'installed'; entry: MCPServerEntry } | { kind: 'template'; template: typeof mcpTemplates[0] };
  const exampleItems = useMemo(() => {
    const items: ExampleItem[] = [];
    for (const tmpl of mcpTemplates) {
      if (searchLower && !tmpl.name.toLowerCase().includes(searchLower) && !tmpl.description.toLowerCase().includes(searchLower)) continue;
      const entry = servers[tmpl.name];
      if (entry) {
        items.push({ kind: 'installed', entry });
      } else {
        items.push({ kind: 'template', template: tmpl });
      }
    }
    return items;
  }, [servers, searchLower]);

  // The detail is a modal now, so it stays closed until the user clicks a card
  // — no auto-select on load. Still guard against a dangling selection: if the
  // currently-selected server disappears (removed elsewhere), fall back to its
  // template view (or close the modal).
  useEffect(() => {
    if (selected?.kind === 'server' && !servers[selected.name]) {
      const tmpl = mcpTemplates.find((t) => t.name === selected.name);
      setSelected(tmpl ? { kind: 'template', id: tmpl.id } : null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- servers omitted: it's an object ref that changes on every store update, would cause frequent re-runs; mcpServers is the memoized array form
  }, [mcpServers, selected]);

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
  // eslint-disable-next-line react-hooks/exhaustive-deps -- setShowAddForm is recreated each render (wraps onAddFormChange prop), adding it would cause infinite re-runs
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
    // Keep selection in context after removal
    if (selected?.kind === 'server' && selected.name === name) {
      // If it's a template MCP, switch to template view (stays on same item)
      const tmpl = mcpTemplates.find((t) => t.name === name);
      if (tmpl) {
        setSelected({ kind: 'template', id: tmpl.id });
      } else {
        // Custom server: select adjacent item
        const idx = customServers.findIndex((s) => s.config.name === name);
        const nextName = customServers[idx - 1]?.config.name ?? customServers[idx + 1]?.config.name;
        setSelected(nextName ? { kind: 'server', name: nextName } : null);
      }
    }
    // Disconnect before removing to avoid stale connected state
    try { await disconnectServer(name); } catch { /* ignore */ }
    removeServer(name);
  };

  const handleToggleConnection = async (entry: MCPServerEntry) => {
    const name = entry.config.name;
    setConnectingServer(name);
    // Connect/disconnect is the authoritative action — clear any stale test result.
    setServerErrors((prev) => { const next = { ...prev }; delete next[name]; return next; });
    setTestResults((prev) => { const next = { ...prev }; delete next[name]; return next; });
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
    // Clear both stale test result and stale connect error — test is a fresh probe.
    setTestResults((prev) => { const next = { ...prev }; delete next[name]; return next; });
    setServerErrors((prev) => { const next = { ...prev }; delete next[name]; return next; });
    try {
      const result = await mcpManager.testConnection(entry.config);
      const message = result.success
        ? `${t.toolbox.testSuccess} (${result.toolCount ?? 0} tools)`
        : (result.error ?? t.toolbox.testFailed);
      setTestResults((prev) => ({ ...prev, [name]: { success: result.success, message } }));
      // A successful test invalidates any prior connect-time error.
      if (result.success) clearServerError(name);
    } catch (err) {
      setTestResults((prev) => ({ ...prev, [name]: { success: false, message: err instanceof Error ? err.message : String(err) } }));
    } finally { setTestingServer(null); }
  };

  // Connection-status indicator dot (card top-right) — the icon itself stays a
  // neutral colour so it doesn't flicker green/red as the connection changes.
  const statusDotClass = (entry: MCPServerEntry) => {
    const { status } = entry;
    const isConn = connectingServer === entry.config.name;
    if (status === 'reconnecting') return 'bg-[var(--abu-warning-solid)] animate-pulse';
    if (isConn || status === 'connecting') return 'bg-[var(--abu-warning-solid)] animate-pulse';
    if (status === 'connected') return 'bg-[var(--abu-success-solid)]';
    if (status === 'error') return 'bg-[var(--abu-danger-solid)]';
    return 'bg-[var(--abu-text-placeholder)]';
  };

  // Get selected server entry or template
  const selectedServer = selected?.kind === 'server' ? servers[selected.name] : null;
  const selectedTemplate = selected?.kind === 'template'
    ? mcpTemplates.find((t) => t.id === selected.id) ?? null
    : null;

  // Reset detail state when selection changes
  const selectedKey = selected?.kind === 'server' ? selected.name : selected?.kind === 'template' ? selected.id : null;
  useEffect(() => {
    setExpandedTools(false);
    setShowLogs(false);
  }, [selectedKey]);

  const renderServerCard = (entry: MCPServerEntry) => {
    const c = entry.config;
    const isHttp = !!(c.url || c.transport === 'http');
    const description = isHttp ? c.url : [c.command, ...(c.args ?? [])].filter(Boolean).join(' ');
    return (
      <ToolCard
        key={c.name}
        item={{
          id: c.name,
          name: c.name,
          description,
          avatar: <Server className="h-6 w-6 text-[var(--abu-text-muted)]" />,
          badge: <span className={cn('block w-2 h-2 rounded-full', statusDotClass(entry))} title={entry.status} />,
        }}
        onClick={() => setSelected({ kind: 'server', name: c.name })}
      />
    );
  };

  const renderTemplateCard = (tmpl: typeof mcpTemplates[0]) => (
    <ToolCard
      key={tmpl.id}
      item={{
        id: tmpl.id,
        name: pickLocale(locale, tmpl.name, tmpl.nameEn),
        description: pickLocale(locale, tmpl.description, tmpl.descriptionEn),
        avatar: <Server className="h-6 w-6 text-[var(--abu-text-placeholder)]" />,
      }}
      onClick={() => setSelected({ kind: 'template', id: tmpl.id })}
    />
  );

  return (
    <div className="flex flex-col h-full overflow-hidden bg-[var(--abu-bg-base)]">
      {/* Card grid — horizontally inset to match the header row above (ToolboxModal's
          TopTabNav), with a centered max-width so cards don't stretch edge-to-edge. */}
      <div className="flex-1 overflow-y-scroll overlay-scroll px-8 pb-6">
        {customServers.length === 0 && exampleItems.length === 0 ? (
          <div className="text-body text-[var(--abu-text-muted)] py-16 text-center">{t.toolbox.noServersConnected}</div>
        ) : (
          <div className="max-w-5xl mx-auto space-y-6">
            {/* "我的" — user-added custom servers */}
            {customServers.length > 0 && (
              <div>
                <div className="mb-3 text-body font-medium text-[var(--abu-text-muted)]">{t.toolbox.myServers}</div>
                <ToolGrid>{customServers.map((entry) => renderServerCard(entry))}</ToolGrid>
              </div>
            )}
            {/* "示例" — template-based (installed + uninstalled together) */}
            {exampleItems.length > 0 && (
              <div>
                <div className="mb-3 text-body font-medium text-[var(--abu-text-muted)]">{t.toolbox.exampleServers}</div>
                <ToolGrid>
                  {exampleItems.map((item) => item.kind === 'installed' ? renderServerCard(item.entry) : renderTemplateCard(item.template))}
                </ToolGrid>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Detail modal */}
      <ToolDetailModal
        open={!!selected}
        onClose={() => setSelected(null)}
        maxWidth="max-w-2xl"
        avatar={selected ? <Server className="h-6 w-6 text-[var(--abu-text-muted)]" /> : undefined}
        title={
          selectedServer ? selectedServer.config.name
          : selectedTemplate ? (
              <span className="inline-flex items-center gap-2">
                {pickLocale(locale, selectedTemplate.name, selectedTemplate.nameEn)}
                {selectedTemplate.transport === 'http' && (
                  <span className="px-1.5 py-0.5 rounded text-caption font-medium bg-[var(--abu-info-bg)] text-[var(--abu-info)]">HTTP</span>
                )}
              </span>
            )
          : undefined
        }
        subtitle={selectedServer ? (
          <span className={cn('font-medium', serverStatusMeta(selectedServer, connectingServer, testingServer, t).statusColor)}>
            {serverStatusMeta(selectedServer, connectingServer, testingServer, t).statusLabel}
          </span>
        ) : undefined}
        headerActions={
          selectedServer ? (
            <ServerHeaderActions
              entry={selectedServer}
              connectingServer={connectingServer}
              testingServer={testingServer}
              onToggleLogs={() => setShowLogs(!showLogs)}
              onToggleConnection={() => handleToggleConnection(selectedServer)}
              onTestConnection={() => handleTestConnection(selectedServer)}
              onRemove={() => handleRemoveServer(selectedServer.config.name)}
              onEdit={() => handleEditServer(selectedServer)}
            />
          ) : selectedTemplate ? (
            <button onClick={() => handleInstallTemplate(selectedTemplate)} disabled={installingTemplate === selectedTemplate.id}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-body font-medium bg-[var(--abu-clay)] text-white hover:bg-[var(--abu-clay-hover)] disabled:opacity-50 transition-colors">
              {installingTemplate === selectedTemplate.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              {t.toolbox.install}
            </button>
          ) : undefined
        }
      >
        {selectedServer ? (
          <ServerDetail
            entry={selectedServer}
            serverErrors={serverErrors}
            testResults={testResults}
            expandedTools={expandedTools}
            showLogs={showLogs}
            onToggleTools={() => setExpandedTools(!expandedTools)}
          />
        ) : selectedTemplate ? (
          <TemplateDetail
            template={selectedTemplate}
            templateArgs={templateArgs}
            setTemplateArgs={setTemplateArgs}
          />
        ) : null}
      </ToolDetailModal>

      {/* Add / Edit Server Modal */}
      {showAddForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onMouseDown={(e) => { if (e.target === e.currentTarget) handleCloseAddForm(); }}>
          <div className="bg-[var(--abu-bg-base)] rounded-2xl shadow-xl w-full max-w-md flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--abu-border)]">
              <div className="flex items-center gap-2">
                <Server className="h-5 w-5 text-[var(--abu-clay)]" />
                <h2 className="text-h-sm font-semibold text-[var(--abu-text-primary)]">
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
                  className={cn('flex-1 py-1.5 text-minor font-medium rounded transition-colors', addMode === 'form' ? 'bg-[var(--abu-bg-base)] text-[var(--abu-text-primary)] shadow-sm ring-1 ring-[var(--abu-border)]' : 'text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)]')}>
                  {t.toolbox.formMode}
                </button>
                <button onClick={() => setAddMode('json')}
                  className={cn('flex-1 py-1.5 text-minor font-medium rounded transition-colors', addMode === 'json' ? 'bg-[var(--abu-bg-base)] text-[var(--abu-text-primary)] shadow-sm ring-1 ring-[var(--abu-border)]' : 'text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)]')}>
                  {t.toolbox.jsonMode}
                </button>
              </div>
            </div>

            {addMode === 'json' ? (
              <div className="px-5 py-4 space-y-3">
                <div>
                  <label className="block text-minor font-medium text-[var(--abu-text-secondary)] mb-1">{t.toolbox.jsonConfigLabel}</label>
                  <textarea
                    value={jsonInput}
                    onChange={(e) => { setJsonInput(e.target.value); setJsonError(''); }}
                    placeholder={t.toolbox.jsonConfigPlaceholder}
                    rows={10}
                    className="w-full px-3 py-2 rounded-lg border border-[var(--abu-border)] text-minor text-[var(--abu-text-primary)] bg-[var(--abu-bg-base)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] transition-all font-mono resize-none"
                  />
                  <p className="text-caption text-[var(--abu-text-muted)] mt-1.5">{t.toolbox.jsonConfigHint}</p>
                  {jsonError && <p className="text-minor text-[var(--abu-danger)] mt-1">{jsonError}</p>}
                </div>
              </div>
            ) : (
              <div className="px-5 py-4 space-y-3">
                <div>
                  <label className="block text-minor font-medium text-[var(--abu-text-secondary)] mb-1">{t.toolbox.serverName}</label>
                  <input type="text" placeholder={t.toolbox.serverName} value={newServerName}
                    onChange={(e) => setNewServerName(e.target.value)}
                    disabled={!!editingServerName}
                    className={cn('w-full px-3 py-1.5 rounded-lg border border-[var(--abu-border)] text-body text-[var(--abu-text-primary)] bg-[var(--abu-bg-base)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] transition-all',
                      editingServerName && 'opacity-60 cursor-not-allowed')} />
                </div>
                <div>
                  <label className="block text-minor font-medium text-[var(--abu-text-secondary)] mb-1">{t.toolbox.transportType}</label>
                  <div className="flex gap-1 p-0.5 bg-[var(--abu-bg-muted)] rounded-md">
                    <button onClick={() => setNewTransportType('stdio')}
                      className={cn('flex-1 py-1.5 text-minor font-medium rounded transition-colors', newTransportType === 'stdio' ? 'bg-[var(--abu-bg-base)] text-[var(--abu-text-primary)] shadow-sm ring-1 ring-[var(--abu-border)]' : 'text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)]')}>
                      {t.toolbox.transportStdio}
                    </button>
                    <button onClick={() => setNewTransportType('http')}
                      className={cn('flex-1 py-1.5 text-minor font-medium rounded transition-colors', newTransportType === 'http' ? 'bg-[var(--abu-bg-base)] text-[var(--abu-text-primary)] shadow-sm ring-1 ring-[var(--abu-border)]' : 'text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)]')}>
                      {t.toolbox.transportHttp}
                    </button>
                  </div>
                </div>
                {newTransportType === 'stdio' ? (
                  <>
                    <div>
                      <label className="block text-minor font-medium text-[var(--abu-text-secondary)] mb-1">{t.toolbox.serverCommand}</label>
                      <input type="text" placeholder={t.toolbox.serverCommand} value={newServerCommand} onChange={(e) => setNewServerCommand(e.target.value)}
                        className="w-full px-3 py-1.5 rounded-lg border border-[var(--abu-border)] text-body text-[var(--abu-text-primary)] bg-[var(--abu-bg-base)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] transition-all" />
                    </div>
                    <div>
                      <label className="block text-minor font-medium text-[var(--abu-text-secondary)] mb-1">{t.toolbox.serverArgs}</label>
                      <input type="text" placeholder={t.toolbox.serverArgs} value={newServerArgs} onChange={(e) => setNewServerArgs(e.target.value)}
                        className="w-full px-3 py-1.5 rounded-lg border border-[var(--abu-border)] text-body text-[var(--abu-text-primary)] bg-[var(--abu-bg-base)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] transition-all" />
                    </div>
                    <div>
                      <label className="block text-minor font-medium text-[var(--abu-text-secondary)] mb-1">Env (JSON)</label>
                      <input type="text" placeholder='{"API_KEY": "..."}' value={newServerEnv} onChange={(e) => setNewServerEnv(e.target.value)}
                        className="w-full px-3 py-1.5 rounded-lg border border-[var(--abu-border)] text-body text-[var(--abu-text-primary)] bg-[var(--abu-bg-base)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] transition-all font-mono" />
                    </div>
                  </>
                ) : (
                  <>
                    <div>
                      <label className="block text-minor font-medium text-[var(--abu-text-secondary)] mb-1">URL</label>
                      <input type="text" placeholder={t.toolbox.serverUrlPlaceholder} value={newServerUrl} onChange={(e) => setNewServerUrl(e.target.value)}
                        className="w-full px-3 py-1.5 rounded-lg border border-[var(--abu-border)] text-body text-[var(--abu-text-primary)] bg-[var(--abu-bg-base)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] transition-all" />
                    </div>
                    <div>
                      <label className="block text-minor font-medium text-[var(--abu-text-secondary)] mb-1">Headers (JSON)</label>
                      <input type="text" placeholder={t.toolbox.serverHeadersPlaceholder} value={newServerHeaders} onChange={(e) => setNewServerHeaders(e.target.value)}
                        className="w-full px-3 py-1.5 rounded-lg border border-[var(--abu-border)] text-body text-[var(--abu-text-primary)] bg-[var(--abu-bg-base)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] transition-all font-mono" />
                    </div>
                  </>
                )}
              </div>
            )}
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[var(--abu-border)]">
              <button onClick={handleCloseAddForm} className="px-4 py-1.5 rounded-lg text-body font-medium text-[var(--abu-text-tertiary)] hover:bg-[var(--abu-bg-muted)] transition-colors">
                {t.common.cancel}
              </button>
              <button onClick={addMode === 'json' ? handleAddFromJSON : handleAddServer}
                disabled={addMode === 'json' ? !jsonInput.trim() : (!newServerName.trim() || (newTransportType === 'stdio' && !newServerCommand.trim()) || (newTransportType === 'http' && !newServerUrl.trim()))}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-body font-medium bg-[var(--abu-clay)] text-white hover:bg-[var(--abu-clay-hover)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
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

/** Shared connection-status meta so the (hoisted) modal header and the detail
 *  body describe a server's state consistently. */
function serverStatusMeta(
  entry: MCPServerEntry,
  connectingServer: string | null,
  testingServer: string | null,
  t: ReturnType<typeof useI18n>['t'],
) {
  const { config, status } = entry;
  const isConnected = status === 'connected';
  const isReconnecting = status === 'reconnecting';
  const isConnecting = connectingServer === config.name || status === 'connecting' || isReconnecting;
  const isTesting = testingServer === config.name;
  const statusLabel = isReconnecting ? t.toolbox.reconnecting
    : isConnecting ? t.toolbox.connecting
    : isConnected ? t.toolbox.connected
    : status === 'error' ? 'Error'
    : t.toolbox.disconnected;
  const statusColor = isReconnecting ? 'text-[var(--abu-warning)]'
    : isConnecting ? 'text-[var(--abu-warning)]'
    : isConnected ? 'text-[var(--abu-success)]'
    : status === 'error' ? 'text-[var(--abu-danger)]'
    : 'text-[var(--abu-text-muted)]';
  return { isConnected, isConnecting, isTesting, statusLabel, statusColor };
}

/** Header action buttons for a server, hoisted into ToolDetailModal.headerActions. */
function ServerHeaderActions({
  entry, connectingServer, testingServer,
  onToggleLogs, onToggleConnection, onTestConnection, onRemove, onEdit,
}: {
  entry: MCPServerEntry;
  connectingServer: string | null;
  testingServer: string | null;
  onToggleLogs: () => void;
  onToggleConnection: () => void;
  onTestConnection: () => void;
  onRemove: () => void;
  onEdit: () => void;
}) {
  const { t } = useI18n();
  const { isConnected, isConnecting, isTesting } = serverStatusMeta(entry, connectingServer, testingServer, t);
  return (
    <>
      <button onClick={onToggleLogs} className="p-1.5 rounded-lg text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-muted)] transition-colors" title={t.toolbox.viewLogs}>
        <ScrollText className="h-4 w-4" />
      </button>
      <button onClick={onEdit} className="p-1.5 rounded-lg text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-muted)] transition-colors" title={t.toolbox.skillEdit}>
        <Pencil className="h-4 w-4" />
      </button>
      <button onClick={onTestConnection} disabled={isTesting || isConnecting}
        className="p-1.5 rounded-lg text-[var(--abu-text-muted)] hover:text-[var(--abu-info)] hover:bg-[var(--abu-info-bg)] transition-colors disabled:opacity-50" title={t.toolbox.testConnection}>
        {isTesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
      </button>
      <button onClick={onToggleConnection} disabled={isConnecting}
        className={cn('p-1.5 rounded-lg transition-colors',
          isConnecting ? 'text-[var(--abu-warning)] cursor-wait' : isConnected ? 'text-[var(--abu-success)] hover:text-[var(--abu-success)] hover:bg-[var(--abu-success-bg)]' : 'text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-muted)]'
        )} title={isConnecting ? t.toolbox.connecting : isConnected ? t.toolbox.disconnect : t.toolbox.connect}>
        {isConnecting ? <Loader2 className="h-4 w-4 animate-spin" /> : isConnected ? <PlugZap className="h-4 w-4" /> : <Plug className="h-4 w-4" />}
      </button>
      <button onClick={onRemove} className="p-1.5 rounded-lg text-[var(--abu-text-muted)] hover:text-[var(--abu-danger)] hover:bg-[var(--abu-danger-bg)] transition-colors">
        <Trash2 className="h-4 w-4" />
      </button>
    </>
  );
}

function ServerDetail({
  entry, serverErrors, testResults,
  expandedTools, showLogs,
  onToggleTools,
}: {
  entry: MCPServerEntry;
  serverErrors: Record<string, string>;
  testResults: Record<string, { success: boolean; message: string }>;
  expandedTools: boolean;
  showLogs: boolean;
  onToggleTools: () => void;
}) {
  const { t } = useI18n();
  const { config, status, tools } = entry;
  const isConnected = status === 'connected';
  const error = serverErrors[config.name] || (status === 'error' ? entry.error : undefined);
  const testResult = testResults[config.name];
  const toolDetails = (tools ?? []) as { name: string; description?: string }[];
  const isHttp = !!(config.url || config.transport === 'http');

  return (
    <>
      {/* Error */}
      {error && (
        <div className="mb-4 p-3 rounded-lg bg-[var(--abu-danger-bg)] border border-[var(--abu-danger)] flex items-start gap-2">
          <AlertCircle className="h-4 w-4 text-[var(--abu-danger)] shrink-0 mt-0.5" />
          <p className="text-minor text-[var(--abu-danger)] break-words">{error}</p>
        </div>
      )}

      {/* Test result */}
      {testResult && (
        <div className={cn('mb-4 px-3 py-2 text-minor rounded-lg flex items-center gap-1.5',
          testResult.success ? 'bg-[var(--abu-success-bg)] text-[var(--abu-success)] border border-[var(--abu-success)]' : 'bg-[var(--abu-danger-bg)] text-[var(--abu-danger)] border border-[var(--abu-danger)]'
        )}>
          {testResult.success ? <Check className="h-3.5 w-3.5" /> : <AlertCircle className="h-3.5 w-3.5" />}
          {testResult.message}
        </div>
      )}

      {/* Connection info */}
      <div className="mb-5">
        <span className="text-minor text-[var(--abu-text-muted)]">{isHttp ? 'URL' : 'Command'}</span>
        <p className="text-body text-[var(--abu-text-primary)] mt-1 font-mono break-all">
          {config.url ? config.url : `${config.command} ${config.args?.join(' ') ?? ''}`}
        </p>
        {isHttp && config.headers && Object.keys(config.headers).length > 0 && (
          <div className="mt-2">
            <span className="text-minor text-[var(--abu-text-muted)]">Headers</span>
            <p className="text-minor text-[var(--abu-text-primary)] mt-0.5 font-mono break-all">{JSON.stringify(config.headers)}</p>
          </div>
        )}
        {!isHttp && config.env && Object.keys(config.env).length > 0 && (
          <div className="mt-2">
            <span className="text-minor text-[var(--abu-text-muted)]">Env</span>
            <p className="text-minor text-[var(--abu-text-primary)] mt-0.5 font-mono break-all">{JSON.stringify(config.env)}</p>
          </div>
        )}
      </div>

      {/* Tools */}
      {isConnected && toolDetails.length > 0 && (
        <div className="mb-5">
          <button onClick={onToggleTools} className="flex items-center gap-2 text-minor text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)] transition-colors mb-2">
            {expandedTools ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            <Wrench className="h-3 w-3" />
            <span>{t.toolbox.agentTools} ({toolDetails.length})</span>
          </button>
          {expandedTools && <ToolDetailsList tools={toolDetails} />}
        </div>
      )}

      {/* Logs */}
      {showLogs && <ServerLogsPanel serverName={config.name} />}
    </>
  );
}

// --- Template Detail Panel ---

function TemplateDetail({
  template, templateArgs, setTemplateArgs,
}: {
  template: typeof mcpTemplates[0];
  templateArgs: Record<string, string>;
  setTemplateArgs: React.Dispatch<React.SetStateAction<Record<string, string>>>;
}) {
  const { t, locale } = useI18n();
  const hasConfigurableArgs = template.configurableArgs && template.configurableArgs.length > 0;
  const hasEnvVars = template.requiredEnvVars && template.requiredEnvVars.length > 0;
  const hasSetupHint = !!template.setupHint;

  return (
    <>
      {/* Description */}
      <div className="mb-5">
        <span className="text-minor text-[var(--abu-text-muted)]">Description</span>
        <p className="text-body text-[var(--abu-text-primary)] mt-1">{pickLocale(locale, template.description, template.descriptionEn)}</p>
      </div>

      {/* Setup hint */}
      {hasSetupHint && (
        <div className="mb-5 p-3 rounded-lg bg-[var(--abu-warning-bg)] border border-[var(--abu-warning)]">
          <p className="text-minor text-[var(--abu-warning)] leading-relaxed whitespace-pre-wrap break-words">
            {renderSetupHint(pickLocale(locale, template.setupHint!, template.setupHintEn))}
          </p>
        </div>
      )}

      {/* Configuration inputs */}
      {(hasConfigurableArgs || hasEnvVars) && (
        <div className="space-y-3">
          <span className="text-minor text-[var(--abu-text-muted)]">{t.toolbox.serverArgs}</span>
          {template.configurableArgs?.map((arg) => (
            <input key={arg.index} type="text" placeholder={pickLocale(locale, arg.placeholder, arg.placeholderEn)}
              value={templateArgs[`${template.id}-${arg.index}`] || ''}
              onChange={(e) => setTemplateArgs((prev) => ({ ...prev, [`${template.id}-${arg.index}`]: e.target.value }))}
              className="w-full px-3 py-1.5 rounded-lg border border-[var(--abu-border)] text-body text-[var(--abu-text-primary)] bg-[var(--abu-bg-base)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] transition-all" />
          ))}
          {template.requiredEnvVars?.map((envVar) => (
            <div key={envVar.name}>
              <label className="block text-minor text-[var(--abu-text-tertiary)] mb-1">{pickLocale(locale, envVar.label, envVar.labelEn)}</label>
              <input type="password" placeholder={pickLocale(locale, envVar.placeholder, envVar.placeholderEn)}
                value={templateArgs[`${template.id}-env-${envVar.name}`] || ''}
                onChange={(e) => setTemplateArgs((prev) => ({ ...prev, [`${template.id}-env-${envVar.name}`]: e.target.value }))}
                className="w-full px-3 py-1.5 rounded-lg border border-[var(--abu-border)] text-body text-[var(--abu-text-primary)] bg-[var(--abu-bg-base)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] transition-all font-mono" />
              {envVar.description && <p className="text-caption text-[var(--abu-text-muted)] mt-0.5">{pickLocale(locale, envVar.description, envVar.descriptionEn)}</p>}
            </div>
          ))}
        </div>
      )}
    </>
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
      <div className="px-3 py-2 text-caption text-[var(--abu-text-muted)] bg-[var(--abu-bg-base)] rounded-lg border border-[var(--abu-border)]">
        {t.toolbox.noLogs}
      </div>
    );
  }

  return (
    <div className="max-h-[200px] overflow-y-auto rounded-lg border border-[var(--abu-border)] bg-neutral-900 p-2">
      {logs.map((log, i) => (
        <div key={i} className="flex gap-2 text-caption font-mono leading-4">
          <span className="text-[var(--abu-text-tertiary)] shrink-0">
            {new Date(log.timestamp).toLocaleTimeString()}
          </span>
          <span className={cn(
            log.level === 'error' ? 'text-[var(--abu-danger-solid)]' :
            log.level === 'warn' ? 'text-[var(--abu-warning-solid)]' : 'text-neutral-300'
          )}>
            {log.message}
          </span>
        </div>
      ))}
    </div>
  );
}
