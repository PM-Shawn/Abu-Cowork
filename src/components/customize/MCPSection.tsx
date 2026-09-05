import { useState, useMemo, useEffect, useRef } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import { useMCPStore, type MCPServerEntry } from '@/stores/mcpStore';
import { usePluginStore } from '@/stores/pluginStore';
import { pluginServerOwners } from '@/core/plugin/pluginMcpBridge';
import { useChatStore } from '@/stores/chatStore';
import { useProjectStore } from '@/stores/projectStore';
import { useI18n, format } from '@/i18n';
import { getMCPTemplates, getMCPTemplatesForHost } from '@/data/marketplace/mcp';
import { mcpManager, type MCPServerConfig, type MCPLogEntry } from '@/core/mcp/client';
import { parseArgs } from '@/utils/argsParser';
import type { ConnectorPrefill } from '@/components/toolbox/connectors/connectorPrefill';
import type { MCPTemplate } from '@/types/marketplace';
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
  /** `'mine'` narrows the list to the servers the user configured by hand — the
   *  「我的」 half of the Extensions source sub-nav. A plugin's server belongs to
   *  the package that brought it, and un-installed catalog cards are offers
   *  「市场」 (ConnectorCatalog) makes, so both are absent here. What is left is
   *  rendered as ONE ungrouped list: the 我的/市场 split describes where a config
   *  came from, and here the answer is always "the user". Omitted = every
   *  source, grouped as before. */
  sourceFilter?: 'mine';
  /** A connector to pre-fill the add-server form with, applied when the form
   *  is open. 「市场」's 「添加」 routes through here rather than adding a server
   *  itself: a catalog entry's `env` carries key names with empty values, so a
   *  silent add would persist a config that cannot connect. The user fills in
   *  the secrets and saves. An offer is spent once: it is ignored while the form
   *  is editing a server, and a re-open of the form does not re-apply it. Pass
   *  `null` to withdraw the offer — the same name may then be offered again. */
  prefill?: ConnectorPrefill | null;
  /** Open this server's detail on mount/prop change — how 「市场」's 「管理」 lands
   *  in the editor that lives here. Ignored when no such server is configured. */
  focusServer?: string | null;
}

export default function MCPSection({ showAddForm: externalShowAddForm, onAddFormChange, sourceFilter, prefill, focusServer }: MCPSectionProps = {}) {
  const extensionsSearchQuery = useSettingsStore((s) => s.extensionsSearchQuery);
  const servers = useMCPStore((s) => s.servers);
  const addServer = useMCPStore((s) => s.addServer);
  const removeServer = useMCPStore((s) => s.removeServer);
  const updateServer = useMCPStore((s) => s.updateServer);
  const renameServer = useMCPStore((s) => s.renameServer);
  const connectServer = useMCPStore((s) => s.connectServer);
  const disconnectServer = useMCPStore((s) => s.disconnectServer);
  const clearServerError = useMCPStore((s) => s.clearServerError);
  const { t, locale } = useI18n();

  const mcpServers = useMemo(() => Object.values(servers), [servers]);
  const installedPlugins = usePluginStore((s) => s.installed);
  // server name → owning plugin, so a plugin-contributed connector is
  // distinguishable from one the user configured by hand.
  const serverOwners = useMemo(() => pluginServerOwners(installedPlugins), [installedPlugins]);
  const availableTemplates = useMemo(() => getMCPTemplatesForHost(), []);

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
  const [serverNameError, setServerNameError] = useState('');

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
    setServerNameError('');
    setAddMode('form');
    setShowAddForm(true);
  };

  // Template installation
  const [installingTemplate, setInstallingTemplate] = useState<string | null>(null);
  const [templateArgs, setTemplateArgs] = useState<Record<string, string>>({});

  // Categorize: "我的" = custom (not from templates), "示例" = template-based (installed + uninstalled)
  const searchLower = extensionsSearchQuery.toLowerCase();
  const templateNames = useMemo(() => new Set(getMCPTemplates().map((t) => t.name)), []);
  const editingNameLocked = !!editingServerName && templateNames.has(editingServerName);

  const validateServerName = (requestedName: string, oldName?: string): string | null => {
    const name = requestedName.trim();
    if (!name) return t.toolbox.serverNameRequired;
    if (name === oldName) return null;
    if (servers[name]) return format(t.toolbox.serverNameExists, { name });
    // Importing a known marketplace config by its canonical name is valid.
    // Only a rename may not claim another template's identity.
    if (oldName && templateNames.has(name)) return format(t.toolbox.serverNameReserved, { name });
    return null;
  };

  async function saveEditedServer(config: MCPServerConfig, reportNameError: (message: string) => void): Promise<boolean> {
    if (!editingServerName) return false;
    const oldName = editingServerName;
    const newName = config.name.trim();
    const nameError = validateServerName(newName, oldName);
    if (nameError) {
      reportNameError(nameError);
      return false;
    }

    try { await disconnectServer(oldName); } catch { /* store rename still remains safe */ }

    if (newName !== oldName) {
      if (!renameServer(oldName, newName)) {
        reportNameError(t.toolbox.serverRenameFailed);
        return false;
      }
      useChatStore.getState().renameMCPServerReferences(oldName, newName);
      useProjectStore.getState().renameMCPServerReferences(oldName, newName);
      // Old-name logs are no longer addressable from the renamed detail page.
      mcpManager.clearServerLogs(oldName);
    }

    updateServer(newName, { ...config, name: newName });
    setServerErrors((prev) => {
      const next = { ...prev };
      delete next[oldName];
      delete next[newName];
      return next;
    });
    setTestResults((prev) => {
      const next = { ...prev };
      delete next[oldName];
      delete next[newName];
      return next;
    });
    handleCloseAddForm();
    setSelected({ kind: 'server', name: newName });
    setConnectingServer(newName);
    try { await connectServer(newName); }
    catch (err) {
      setServerErrors((prev) => ({ ...prev, [newName]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setConnectingServer(null);
    }
    return true;
  }

  // 「我的」 = every configured server no plugin owns. Scope by source first,
  // search second — the two answer different questions, and the empty state
  // needs them apart: nothing of the user's own at all ("还没有你添加的连接器")
  // reads differently from "your servers, none matching".
  const scopedServers = useMemo(
    () => mcpServers.filter((s) => !serverOwners[s.config.name]),
    [mcpServers, serverOwners],
  );

  // One ungrouped list. The custom/template split is a statement about where a
  // config *came from*, and under 「我的」 the answer is always "the user" — so
  // filing a configured `github` under 「市场」 would contradict the tab it sits
  // in. It also silently lost `abu-browser-bridge`, which is a template name
  // (never "custom") that the Electron host drops from the template list
  // (never an "example") — a server in neither group at all.
  const mineServers = useMemo(() => {
    if (!searchLower) return scopedServers;
    return scopedServers.filter((s) => s.config.name.toLowerCase().includes(searchLower));
  }, [scopedServers, searchLower]);

  // "我的": user-added custom servers (not matching any template)
  const customServers = useMemo(() => {
    const list = mcpServers.filter((s) => !templateNames.has(s.config.name));
    if (!searchLower) return list;
    return list.filter((s) => s.config.name.toLowerCase().includes(searchLower));
  }, [mcpServers, templateNames, searchLower]);

  // "示例": all templates — installed ones first, then uninstalled
  type ExampleItem = { kind: 'installed'; entry: MCPServerEntry } | { kind: 'template'; template: MCPTemplate };
  const exampleItems = useMemo(() => {
    const items: ExampleItem[] = [];
    for (const tmpl of availableTemplates) {
      if (searchLower && !tmpl.name.toLowerCase().includes(searchLower) && !tmpl.description.toLowerCase().includes(searchLower)) continue;
      const entry = servers[tmpl.name];
      items.push(entry ? { kind: 'installed', entry } : { kind: 'template', template: tmpl });
    }
    return items;
  }, [availableTemplates, servers, searchLower]);

  // The detail is a modal now, so it stays closed until the user clicks a card
  // — no auto-select on load. Still guard against a dangling selection: if the
  // currently-selected server disappears (removed elsewhere), fall back to its
  // template view (or close the modal).
  useEffect(() => {
    if (selected?.kind === 'server' && !servers[selected.name]) {
      const tmpl = availableTemplates.find((t) => t.name === selected.name);
      setSelected(tmpl ? { kind: 'template', id: tmpl.id } : null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- servers omitted: it's an object ref that changes on every store update, would cause frequent re-runs; mcpServers is the memoized array form
  }, [availableTemplates, mcpServers, selected]);

  // Add or update custom server
  const handleAddServer = async () => {
    const nameError = validateServerName(newServerName, editingServerName ?? undefined);
    if (nameError) {
      setServerNameError(nameError);
      return;
    }
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
      await saveEditedServer(config, setServerNameError);
      return;
    }

    addServer(config);

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
        // Custom servers may rename by changing the JSON key. Marketplace /
        // built-in entries keep their fixed identity even in JSON mode.
        const [entryName, serverDef] = entries.find(([n]) => n === editingServerName) ?? entries[0];
        const def = serverDef as Record<string, unknown>;
        const config: MCPServerConfig = {
          name: editingNameLocked ? editingServerName! : entryName.trim(),
          enabled: true,
        };

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

        await saveEditedServer(config, setJsonError);
      } else {
        let firstName = '';
        for (const [name, serverDef] of entries) {
          const nameError = validateServerName(name);
          if (nameError) {
            setJsonError(nameError);
            return;
          }
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
    setAddMode('form'); setJsonInput(''); setJsonError(''); setServerNameError('');
  };

  // 「市场」's 「添加」 lands here. The form opens describing the catalog entry, with
  // every env var reduced to its key and an empty value: a registry entry ships
  // slots, not secrets, so the user supplies those and saves. Adding the server
  // outright instead would persist a config that cannot connect.
  const prefillRef = useRef(prefill);
  prefillRef.current = prefill;
  // The name of the prefill already spent on this form. An offer applies exactly
  // once: the add form is also the *edit* form, so an offer left armed would
  // re-fire on the next false→true of `showAddForm` and rewrite 「编辑 postgres」
  // into 「添加 github」 — dropping the edit target with it.
  const consumedPrefillRef = useRef<string | null>(null);
  useEffect(() => {
    const entry = prefillRef.current;
    // The host withdrew the offer: a later re-offer of the same name is new.
    if (!entry) { consumedPrefillRef.current = null; return; }
    // Never overwrite an edit in progress, and never apply the same offer twice.
    if (!showAddForm || editingServerName) return;
    if (consumedPrefillRef.current === entry.name) return;
    consumedPrefillRef.current = entry.name;
    // A template-sourced connector goes through the template's own install
    // flow — the one 「安装」 has always used — because the plain form has
    // nowhere to put what a template knows: a labeled secret field with a hint,
    // a configurable argument with a placeholder, a setup note, a longer
    // default timeout. Prefilling the raw arg and an env JSON blob would strip
    // every one of those and leave the user guessing what to type where.
    // A template the host filtered out resolves to nothing; the plain form is
    // then still better than no way to add the connector at all.
    const template = entry.templateId
      ? availableTemplates.find((tmpl) => tmpl.id === entry.templateId)
      : undefined;
    if (template) {
      setTemplateArgs({});
      setSelected({ kind: 'template', id: template.id });
      // The add form was opened for a connector that does not use it.
      setShowAddForm(false);
      return;
    }
    const env: Record<string, string> = {};
    for (const key of Object.keys(entry.env)) env[key] = '';
    // The catalog unions two sources and one of them can be an HTTP endpoint;
    // the offer says which, so the form does not open on the wrong transport.
    const isHttp = entry.transport === 'http';
    setEditingServerName(null);
    setNewServerName(entry.name);
    setNewTransportType(isHttp ? 'http' : 'stdio');
    setNewServerCommand(isHttp ? '' : entry.command);
    setNewServerArgs(isHttp ? '' : entry.args.join(' '));
    setNewServerUrl(isHttp ? (entry.url ?? '') : '');
    setNewServerHeaders('');
    setNewServerEnv(!isHttp && Object.keys(env).length > 0 ? JSON.stringify(env) : '');
    setJsonInput(JSON.stringify({
      [entry.name]: isHttp
        ? { url: entry.url ?? '' }
        : { command: entry.command, args: entry.args, env },
    }, null, 2));
    setAddMode('form');
    setJsonError('');
    setServerNameError('');
  // Keyed on the entry's identity (its name) via the ref, not the object
  // reference: a host that rebuilds the entry object each render would otherwise
  // wipe a form the user has already started editing.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- setShowAddForm is recreated each render (it wraps the onAddFormChange prop); availableTemplates is a mount-time memo
  }, [prefill?.name, showAddForm, editingServerName, availableTemplates]);

  // 「市场」's 「管理」 lands here — the per-server editor lives in this section, so
  // the host only has to name the server. A server that is not configured is
  // ignored rather than opening an empty detail.
  useEffect(() => {
    if (!focusServer || !servers[focusServer]) return;
    setSelected({ kind: 'server', name: focusServer });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- servers omitted: an object ref that changes on every store update, and re-opening a detail the user just closed would fight them
  }, [focusServer]);

  // Install from template
  const handleInstallTemplate = async (template: MCPTemplate) => {
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
      const tmpl = availableTemplates.find((t) => t.name === name);
      if (tmpl) {
        setSelected({ kind: 'template', id: tmpl.id });
      } else {
        // Custom server: select adjacent item in whichever list is on screen
        const siblings = sourceFilter === 'mine' ? mineServers : customServers;
        const idx = siblings.findIndex((s) => s.config.name === name);
        const nextName = siblings[idx - 1]?.config.name ?? siblings[idx + 1]?.config.name;
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
      else {
        updateServer(name, { enabled: true });
        await connectServer(name);
      }
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
    ? availableTemplates.find((t) => t.id === selected.id) ?? null
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
    const baseDescription = isHttp ? c.url : [c.command, ...(c.args ?? [])].filter(Boolean).join(' ');
    const owner = serverOwners[c.name];
    const description = owner
      ? `${format(t.toolbox.mcpFromPlugin, { name: owner })} · ${baseDescription ?? ''}`
      : baseDescription;
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

  const renderTemplateCard = (tmpl: MCPTemplate) => (
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
        {sourceFilter === 'mine' ? (
          mineServers.length === 0 ? (
            scopedServers.length === 0 ? (
              <div className="py-16 text-center">
                <p className="text-h-sm text-[var(--abu-text-primary)]">{t.toolbox.connectorsMineEmptyTitle}</p>
              </div>
            ) : (
              <div className="text-body text-[var(--abu-text-muted)] py-16 text-center">{t.toolbox.noServersConnected}</div>
            )
          ) : (
            <div className="max-w-5xl mx-auto">
              <ToolGrid>{mineServers.map((entry) => renderServerCard(entry))}</ToolGrid>
            </div>
          )
        ) : customServers.length === 0 && exampleItems.length === 0 ? (
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
        <div data-electron-no-drag className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onMouseDown={(e) => { if (e.target === e.currentTarget) handleCloseAddForm(); }}>
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
                    onChange={(e) => { setNewServerName(e.target.value); setServerNameError(''); }}
                    disabled={editingNameLocked}
                    className={cn('w-full px-3 py-1.5 rounded-lg border border-[var(--abu-border)] text-body text-[var(--abu-text-primary)] bg-[var(--abu-bg-base)] focus:outline-none focus:ring-2 focus:ring-[var(--abu-clay-ring)] focus:border-[var(--abu-clay)] transition-all',
                      editingNameLocked && 'opacity-60 cursor-not-allowed')} />
                  {serverNameError && <p className="text-minor text-[var(--abu-danger)] mt-1">{serverNameError}</p>}
                  {editingNameLocked && <p className="text-caption text-[var(--abu-text-muted)] mt-1">{t.toolbox.serverNameLockedHint}</p>}
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
  template: MCPTemplate;
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
