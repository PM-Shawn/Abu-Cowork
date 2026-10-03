import { memo, useCallback, useState, useMemo, useEffect, useLayoutEffect, useRef } from 'react';
import { useExtensionsSearchQuery } from '@/stores/settingsStore';
import { useMCPStore, type MCPServerEntry } from '@/stores/mcpStore';
import { useToastStore } from '@/stores/toastStore';
import { usePluginStore } from '@/stores/pluginStore';
import { pluginServerOwners } from '@/core/plugin/pluginMcpBridge';
import { useChatStore } from '@/stores/chatStore';
import { useProjectStore } from '@/stores/projectStore';
import { useI18n, format } from '@/i18n';
import { toolCountLabel } from './toolCountLabel';
import { getMCPTemplates, getMCPTemplatesForHost } from '@/data/marketplace/mcp';
import { mcpManager, type MCPServerConfig, type MCPLogEntry } from '@/core/mcp/client';
import { parseArgs } from '@/utils/argsParser';
import type { ConnectorPrefill } from '@/components/toolbox/connectors/connectorPrefill';
import type { MCPTemplate } from '@/types/marketplace';
import { open } from '@tauri-apps/plugin-shell';
import { Button, IconButton } from '@/components/ds/button';
import { useConfirm } from '@/components/ds/confirm-context';
import { Disclosure } from '@/components/ds/disclosure';
import { EmptyState } from '@/components/ds/empty-state';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { InlineMessage } from '@/components/ds/inline-message';
import { Link } from '@/components/ds/link';
import { Spinner } from '@/components/ds/spinner';
import { StatusIcon, type StatusTone } from '@/components/ds/status-icon';
import { Switch } from '@/components/ds/switch';
import { Tag } from '@/components/ds/tag';
import { TextField } from '@/components/ds/text-field';
import InstalledItemMenu from '@/components/toolbox/InstalledItemMenu';
import ToolCard from '@/components/toolbox/ToolCard';
import ToolGrid from '@/components/toolbox/ToolGrid';
import ToolDetailModal from '@/components/toolbox/ToolDetailModal';
import { cardOrNeighbour, cardPlace, cardProps, focusByTestId, focusIsOnWindow, type CardPlace } from '@/components/toolbox/cardFocus';
import { DETAIL_WINDOW_CONTENT_HEIGHT } from '@/components/toolbox/windowHeight';
import type { ExtensionSource } from '@/components/toolbox/extensionSource';
import { useExtensionSourceStore } from '@/stores/extensionSourceStore';
import MCPServerFormDialog, { type MCPServerFormValues } from './MCPServerFormDialog';

const urlPattern = /https?:\/\/[^\s]+/;

/** Render setupHint text with URLs converted to clickable links */
function renderSetupHint(text: string) {
  const parts = text.split(/(https?:\/\/[^\s]+)/g);
  return parts.map((part, i) =>
    urlPattern.test(part) ? (
      <Link
        key={i}
        href={part}
        onClick={(e) => { e.preventDefault(); open(part); }}
        className="break-all"
      >
        {part}
      </Link>
    ) : (
      <span key={i}>{part}</span>
    )
  );
}

/** Locale-aware pick between zh (default) and en fields. */
function pickLocale(locale: string, zh: string, en?: string): string {
  return locale.startsWith('zh') ? zh : (en ?? zh);
}

/** The form key a template's configurable slot / secret is typed under. */
const templateArgKey = (template: MCPTemplate, index: number) => `${template.id}-${index}`;
const templateEnvKey = (template: MCPTemplate, name: string) => `${template.id}-env-${name}`;

/**
 * Whether every field the template asks for has been typed. A template's
 * configurable slots and required env vars are not optional: the agent-side
 * install (`installMCPServer`) refuses to write a config with an empty slot,
 * and the UI must not be laxer. A blank slot would be written as `args: […, '']`
 * — a server that cannot start — and a blank secret would be dropped by the
 * `Object.keys(env).length > 0` guard, so even the editor would show no field
 * left to fix it in. Whitespace counts as blank: it is what a stray space in a
 * pasted key looks like, and neither the args array nor the env map wants it.
 */
function templateRequiredFilled(template: MCPTemplate, templateArgs: Record<string, string>): boolean {
  const filled = (key: string) => (templateArgs[key] ?? '').trim().length > 0;
  return (template.configurableArgs ?? []).every((arg) => filled(templateArgKey(template, arg.index)))
    && (template.requiredEnvVars ?? []).every((envVar) => filled(templateEnvKey(template, envVar.name)));
}

/** Shared tool details list */
function ToolDetailsList({ tools }: { tools: { name: string; description?: string }[] }) {
  return (
    <div className="space-y-1">
      {tools.map((tool) => (
        <div key={tool.name} className="flex items-start gap-2 rounded-control bg-fill px-2 py-1">
          <span className="flex h-5 shrink-0 items-center">
            <Icon icon={AppIcons.tool} size="sm" className="text-label-tertiary" />
          </span>
          <div className="min-w-0">
            <span className="text-ui-sm font-medium text-label">{tool.name}</span>
            {tool.description && (
              <p className="truncate text-caption text-label-tertiary">{tool.description}</p>
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

/** What the detail window shows: the chosen item, and the server's entry while it is one. */
interface DetailSubject {
  item: NonNullable<SelectedItem>;
  server: MCPServerEntry | null;
}

/**
 * Puts the focus on the connector's card; once that card has gone, on the card that took its
 * place, else the one before it, else the empty shelf's own button, else the page's 「添加」 button.
 */
function focusConnectorCard(root: ParentNode | null, place: CardPlace | null): void {
  const card = root && place ? cardOrNeighbour(root, 'connector', place.id, place.index) : null;
  if (card) card.focus();
  else if (!root || !focusByTestId('connectors-mine-add', root)) focusByTestId('connector-create-trigger');
}

/**
 * A configured server's card. `memo` with stable props: the page renders for every character
 * typed into its add window, and each card holds a switch.
 */
const ServerCard = memo(function ServerCard({ entry, owner, connecting, locked, onOpen, onToggle }: {
  entry: MCPServerEntry;
  /** The plugin that brought the server in, when one did. */
  owner: string | undefined;
  /** This server's connection is being switched from this page. */
  connecting: boolean;
  /** Some connection is being switched from this page: no other switch takes a press. */
  locked: boolean;
  onOpen: (name: string) => void;
  onToggle: (entry: MCPServerEntry) => void;
}) {
  const { t } = useI18n();
  const c = entry.config;
  const isHttp = !!(c.url || c.transport === 'http');
  const baseDescription = isHttp ? c.url : [c.command, ...(c.args ?? [])].filter(Boolean).join(' ');
  const description = owner
    ? `${format(t.toolbox.mcpFromPlugin, { name: owner })} · ${baseDescription ?? ''}`
    : baseDescription;
  // The state comes from `serverStatusMeta`, the same function the detail window uses, so the
  // card and the window can never disagree. A shape, no visible text: the badge box is the slot
  // that yields width, and a label like 「Connection error」 would squeeze the name. The label is
  // the shape's name and the tooltip.
  const { statusLabel, tone } = serverStatusMeta(entry, connecting ? c.name : null, null, t);
  return (
    <div className="h-full" {...cardProps('connector', c.name)}>
      <ToolCard
        item={{
          id: c.name,
          testId: `mcp-card-${c.name}`,
          name: c.name,
          description,
          avatar: <Icon icon={AppIcons.connector} size="lg" className="text-label-tertiary" />,
          badge: (
            <span className="flex items-center" title={entry.error || statusLabel} data-testid={`mcp-status-${c.name}`}>
              {tone
                ? <StatusIcon tone={tone} size="sm" label={statusLabel} />
                : <Icon icon={AppIcons.notChecked} size="sm" label={statusLabel} className="text-label-tertiary" />}
            </span>
          ),
          toggle: (
            <span className="flex" title={entry.error || (entry.status === 'connected' ? t.toolbox.disconnect : t.toolbox.connect)} onClick={event => event.stopPropagation()}>
              <Switch
                checked={entry.status === 'connected'}
                busy={locked || entry.status === 'connecting' || entry.status === 'reconnecting'}
                onCheckedChange={() => onToggle(entry)}
                aria-label={c.name}
              />
            </span>
          ),
        }}
        onClick={() => onOpen(c.name)}
      />
    </div>
  );
});

/** A catalog entry the user has not added. Its place among the cards is the server it would add. */
const TemplateCard = memo(function TemplateCard({ id, serverName, name, description, onOpen }: {
  id: string;
  serverName: string;
  name: string;
  description: string;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="h-full" {...cardProps('connector', serverName)}>
      <ToolCard
        item={{
          id,
          testId: `mcp-card-${serverName}`,
          name,
          description,
          avatar: <Icon icon={AppIcons.connector} size="lg" className="text-label-tertiary" />,
        }}
        onClick={() => onOpen(id)}
      />
    </div>
  );
});

interface MCPSectionProps {
  showAddForm?: boolean;
  onAddFormChange?: (open: boolean) => void;
  /** Which shelf this render is showing — the sub-nav's current pick.
   *  Defaults to 市场, the shelf a fresh install has something on. */
  source?: ExtensionSource;
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

export default function MCPSection({ showAddForm: externalShowAddForm, onAddFormChange, source = 'market', prefill, focusServer }: MCPSectionProps = {}) {
  const extensionsSearchQuery = useExtensionsSearchQuery('mcp');
  // A connector the user just added is on the other shelf: land them where it
  // actually is, or the add reads as an add that did nothing.
  const setSource = useExtensionSourceStore((s) => s.setSource);
  const servers = useMCPStore((s) => s.servers);
  const addServer = useMCPStore((s) => s.addServer);
  const removeServer = useMCPStore((s) => s.removeServer);
  const updateServer = useMCPStore((s) => s.updateServer);
  const renameServer = useMCPStore((s) => s.renameServer);
  const connectServer = useMCPStore((s) => s.connectServer);
  const disconnectServer = useMCPStore((s) => s.disconnectServer);
  const clearServerError = useMCPStore((s) => s.clearServerError);
  const { t, locale } = useI18n();
  const confirm = useConfirm();

  const mcpServers = useMemo(() => Object.values(servers), [servers]);
  const installedPlugins = usePluginStore((s) => s.installed);
  // server name → owning plugin, so a plugin-contributed connector is
  // distinguishable from one the user configured by hand.
  const serverOwners = useMemo(() => pluginServerOwners(installedPlugins), [installedPlugins]);
  const availableTemplates = useMemo(() => getMCPTemplatesForHost(), []);

  // Selection
  const [selected, setSelected] = useState<SelectedItem>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  // What the handlers read: the item whose window is open (null once it is closing).
  const selectedRef = useRef<SelectedItem>(null);
  useLayoutEffect(() => { selectedRef.current = selected; });
  // The card the detail window belongs to, and the control it was opened from. That control can
  // be gone when the window closes (the add window, a deleted server's card): the focus then
  // goes to the card, or to what took its place.
  const opener = useRef<CardPlace | null>(null);
  const openedFrom = useRef<Element | null>(null);
  const openDetail = useCallback((item: NonNullable<SelectedItem>) => {
    const id = item.kind === 'server' ? item.name : availableTemplates.find((tmpl) => tmpl.id === item.id)?.name ?? item.id;
    if (selectedRef.current === null) openedFrom.current = document.activeElement;
    opener.current = cardPlace(rootRef.current, 'connector', id);
    setSelected(item);
  }, [availableTemplates]);
  const openServer = useCallback((name: string) => openDetail({ kind: 'server', name }), [openDetail]);
  const openTemplate = useCallback((id: string) => openDetail({ kind: 'template', id }), [openDetail]);

  // Connection UI state
  const [connectingServer, setConnectingServer] = useState<string | null>(null);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});

  // Tool list expansion
  const [expandedTools, setExpandedTools] = useState(true);

  // Test connection state
  const [testingServer, setTestingServer] = useState<string | null>(null);

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
  // Counts the catalog entries this page filled the open form with: what the form then holds is
  // where it starts, so closing it loses nothing the user typed.
  const [formStartingPoint, setFormStartingPoint] = useState(0);

  // Open form in edit mode with existing config pre-filled
  const handleEditServer = (entry: MCPServerEntry) => {
    // The window stays on the page while it fades out; nothing is opened from there.
    if (selectedRef.current === null) return;
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
  const editingNameLocked = !!editingServerName && (templateNames.has(editingServerName) || !!serverOwners[editingServerName]);

  const validateServerName = (requestedName: string, oldName?: string): string | null => {
    const name = requestedName.trim();
    if (!name) return t.toolbox.serverNameRequired;
    if (name === oldName) return null;
    if (oldName && serverOwners[oldName]) return format(t.toolbox.mcpFromPlugin, { name: serverOwners[oldName] });
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
    handleCloseAddForm();
    openDetail({ kind: 'server', name: newName });
    setConnectingServer(newName);
    try { await connectServer(newName); }
    catch (err) {
      setServerErrors((prev) => ({ ...prev, [newName]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setConnectingServer(null);
    }
    return true;
  }

  // 「我的」 = the servers the user added by hand: no plugin owns them and no
  // catalog entry names them. A catalog server the user installed (memory,
  // sequential-thinking) stays on 市场 with its switch, as an installed skill
  // does — listing it here too showed the same server on both shelves. Scope
  // by source first, search second: the empty state needs them apart —
  // nothing of the user's own at all ("还没有你添加的连接器") reads differently
  // from "your servers, none matching".
  const scopedServers = useMemo(
    () => mcpServers.filter((s) => !serverOwners[s.config.name] && !templateNames.has(s.config.name)),
    [mcpServers, serverOwners, templateNames],
  );

  const mineServers = useMemo(() => {
    if (!searchLower) return scopedServers;
    return scopedServers.filter((s) => s.config.name.toLowerCase().includes(searchLower));
  }, [scopedServers, searchLower]);

  // 「市场」 catalog: every registry entry, an installed one as its server card
  // and the rest as install cards. The walk is over the FULL registry, not the
  // host's offer list: Electron provisions `abu-browser-bridge` itself and so
  // never offers it to install — but once provisioned it is a shipped server
  // and belongs on this shelf, not under 「我的」 as if the user had added it.
  type ExampleItem = { kind: 'installed'; entry: MCPServerEntry } | { kind: 'template'; template: MCPTemplate };
  const offeredTemplateIds = useMemo(() => new Set(availableTemplates.map((tmpl) => tmpl.id)), [availableTemplates]);
  const exampleItems = useMemo(() => {
    const added: ExampleItem[] = [];
    const rest: ExampleItem[] = [];
    for (const tmpl of getMCPTemplates()) {
      if (searchLower && !tmpl.name.toLowerCase().includes(searchLower) && !tmpl.description.toLowerCase().includes(searchLower)) continue;
      const entry = servers[tmpl.name];
      if (entry) added.push({ kind: 'installed', entry });
      else if (offeredTemplateIds.has(tmpl.id)) rest.push({ kind: 'template', template: tmpl });
    }
    // Added first, catalog order kept inside each group: ordering is half the
    // signal that tells the two kinds of card apart, the status dot the other.
    return [...added, ...rest];
  }, [offeredTemplateIds, servers, searchLower]);

  // 「市场」 = 内置 / 官方 / 插件提供 (ruling 2026-09-13): a plugin's server is
  // someone else's package — read-only here, removed by uninstalling the
  // plugin — the same rule plugin skills and plugin experts follow. It is
  // exactly the set 「我的」 drops, minus any name the catalog above already
  // carded, so a plugin-owned template is not shown twice. Search matches the
  // name, as it does under 「我的」.
  const pluginServers = useMemo(() => {
    const carded = new Set(exampleItems.map((item) => item.kind === 'installed' ? item.entry.config.name : item.template.name));
    return mcpServers.filter((s) =>
      !!serverOwners[s.config.name]
      && !carded.has(s.config.name)
      && (!searchLower || s.config.name.toLowerCase().includes(searchLower)));
  }, [mcpServers, serverOwners, exampleItems, searchLower]);

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
    setSource('mcp', 'mine');
    openDetail({ kind: 'server', name: config.name });

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
        setSource('mcp', 'mine');
        openDetail({ kind: 'server', name: firstName });
      }
    } catch {
      setJsonError(t.toolbox.jsonConfigInvalid);
    }
  };

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
      openDetail({ kind: 'template', id: template.id });
      // The add form was opened for a connector that does not use it.
      setShowAddForm(false);
      return;
    }
    const env: Record<string, string> = {};
    for (const key of Object.keys(entry.env)) env[key] = '';
    // The catalog produces only stdio connectors today; the HTTP branch is
    // reserved for the remote entries deferred until Abu can carry OAuth and
    // request headers. The offer says which transport it wants, so a future
    // remote row cannot open the form on the wrong one.
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
    setFormStartingPoint((count) => count + 1);
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
    openDetail({ kind: 'server', name: focusServer });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- servers omitted: an object ref that changes on every store update, and re-opening a detail the user just closed would fight them
  }, [focusServer]);

  // Install from template
  const handleInstallTemplate = async (template: MCPTemplate) => {
    // The window stays on the page while it fades out; a key press there installs nothing.
    if (selectedRef.current === null) return;
    // The button is disabled in this state; this guards the paths that never
    // consult it (Enter on the form, a keyboard activation racing a change).
    if (!templateRequiredFilled(template, templateArgs)) return;
    setInstallingTemplate(template.id);
    try {
      let config: MCPServerConfig;
      if (template.transport === 'http' && template.url) {
        config = { name: template.name, url: template.url, enabled: true };
      } else {
        const args = [...(template.defaultArgs ?? [])];
        if (template.configurableArgs) {
          for (const configArg of template.configurableArgs) {
            const value = templateArgs[templateArgKey(template, configArg.index)];
            if (value) args[configArg.index] = value;
          }
        }
        const env: Record<string, string> = {};
        if (template.requiredEnvVars) {
          for (const envVar of template.requiredEnvVars) {
            const value = templateArgs[templateEnvKey(template, envVar.name)];
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
      // Installing from the catalog configures a server of the user's own —
      // the same jump the two hand-add paths make, so 「添加」 always lands
      // where the new connector actually is.
      setSource('mcp', 'mine');
      openDetail({ kind: 'server', name: config.name });
      try { await connectServer(config.name); } catch (err) { console.error('Failed to connect MCP server:', err); }
    } finally {
      setInstallingTemplate(null);
      setTemplateArgs({});
    }
  };

  // Removing a connector drops its configuration, so it is asked first, naming the server. The
  // question is asked over the open window, which answers it "no" when it goes. The answer acts
  // on the server as it is at that moment: nothing is removed once it has left the store.
  const removing = useRef(false);
  const handleRemoveServer = async (name: string) => {
    // The window stays on the page while it fades out; a key press there asks nothing.
    const shown = selectedRef.current;
    if (shown?.kind !== 'server' || shown.name !== name || removing.current) return;
    const ok = await confirm({ title: t.common.delete, message: name, confirmLabel: t.common.delete, tone: 'danger' });
    if (!ok || removing.current) return;
    if (!useMCPStore.getState().servers[name]) return;
    removing.current = true;
    // Where the card sits now: once it has gone the focus goes to the card that took its place.
    opener.current = cardPlace(rootRef.current, 'connector', name);
    try {
      // Disconnect before removing to avoid stale connected state
      try { await disconnectServer(name); } catch { /* ignore */ }
      removeServer(name);
      setSelected(null);
    } finally {
      removing.current = false;
    }
  };

  const handleToggleConnection = useCallback(async (entry: MCPServerEntry) => {
    const name = entry.config.name;
    setConnectingServer(name);
    // Connect/disconnect is the authoritative action — clear any stale test result.
    setServerErrors((prev) => { const next = { ...prev }; delete next[name]; return next; });
    try {
      if (entry.status === 'connected') {
        // Record the intent, not just the current state: without this the
        // startup pass (`connectAllEnabled`) reconnects every server the user
        // switched off, so the switch was only ever good until the next
        // launch. `provisionFirstPartyMCPServers` deliberately leaves
        // `enabled` alone when it refreshes the bridge's command, so an off
        // switch survives upgrades too.
        await disconnectServer(name);
        updateServer(name, { enabled: false });
      } else {
        updateServer(name, { enabled: true });
        await connectServer(name);
      }
    } catch (err) {
      setServerErrors((prev) => ({ ...prev, [name]: err instanceof Error ? err.message : String(err) }));
    } finally { setConnectingServer(null); }
  }, [connectServer, disconnectServer, updateServer]);

  const handleTestConnection = async (entry: MCPServerEntry) => {
    // The window stays on the page while it fades out; a key press there probes nothing.
    if (selectedRef.current === null) return;
    const name = entry.config.name;
    setTestingServer(name);
    // Clear both stale test result and stale connect error — test is a fresh probe.
    setServerErrors((prev) => { const next = { ...prev }; delete next[name]; return next; });
    try {
      const result = await mcpManager.testConnection(entry.config);
      const message = result.success
        ? `${t.toolbox.testSuccess} · ${toolCountLabel(t, result.toolCount, result.appToolCount)}`
        : (result.error ?? t.toolbox.testFailed);
      useToastStore.getState().addToast({ type: result.success ? 'success' : 'error', title: name, message });
      // A successful test invalidates any prior connect-time error.
      if (result.success) clearServerError(name);
    } catch (err) {
      useToastStore.getState().addToast({ type: 'error', title: name, message: err instanceof Error ? err.message : String(err) });
    } finally { setTestingServer(null); }
  };

  // The detail window keeps showing what it held while it fades out. A server's entry carries its
  // environment and headers, so what is held is dropped once the window has gone.
  const liveServer = selected?.kind === 'server' ? servers[selected.name] ?? null : null;
  const [held, setHeld] = useState<DetailSubject | null>(null);
  if (selected && (held?.item !== selected || held.server !== liveServer)) setHeld({ item: selected, server: liveServer });
  const shown: DetailSubject | null = selected ? { item: selected, server: liveServer } : held;

  // Get selected server entry or template
  const selectedServer = shown?.item.kind === 'server' ? shown.server : null;
  const shownTemplateId = shown?.item.kind === 'template' ? shown.item.id : null;
  const selectedTemplate = shownTemplateId
    ? availableTemplates.find((t) => t.id === shownTemplateId) ?? null
    : null;
  const detailName = selectedServer?.config.name
    ?? (selectedTemplate ? pickLocale(locale, selectedTemplate.name, selectedTemplate.nameEn) : '');

  // Reset detail state when selection changes
  const selectedKey = selected?.kind === 'server' ? selected.name : selected?.kind === 'template' ? selected.id : null;
  useEffect(() => {
    // A window that is closing keeps the page it showed.
    if (selectedKey === null) return;
    setExpandedTools(true);
    setShowLogs(false);
  }, [selectedKey]);

  // The logs page takes the place of the details and the header's controls: the focus moves to
  // its way back, and on the way back to the menu button that opened it.
  const logsShown = useRef(false);
  useLayoutEffect(() => {
    const was = logsShown.current;
    logsShown.current = showLogs;
    if (was === showLogs || selectedRef.current === null || !focusIsOnWindow()) return;
    document.querySelector<HTMLElement>(showLogs ? '[data-connector-logs-back]' : '[data-testid="mcp-detail-menu"]')?.focus();
  }, [showLogs]);

  const afterDetailClosed = (event: Event) => {
    // The window has gone: the entry it held, with its environment and headers, is dropped.
    setHeld(null);
    const from = openedFrom.current;
    // Another layer took the focus, or the control the window was opened from is still there and gets it back.
    if (event.defaultPrevented || (from instanceof HTMLElement && from !== document.body && from.isConnected)) return;
    event.preventDefault();
    focusConnectorCard(rootRef.current, opener.current);
  };

  // The add window closed because a connector was added: its own window is open by now and has the focus.
  const afterAddFormClosed = (event: Event) => {
    if (!event.defaultPrevented && selectedRef.current !== null) event.preventDefault();
  };

  const formValues: MCPServerFormValues = {
    name: newServerName,
    transport: newTransportType,
    command: newServerCommand,
    args: newServerArgs,
    env: newServerEnv,
    url: newServerUrl,
    headers: newServerHeaders,
  };
  const changeForm = (patch: Partial<MCPServerFormValues>) => {
    if (patch.name !== undefined) { setNewServerName(patch.name); setServerNameError(''); }
    if (patch.transport !== undefined) setNewTransportType(patch.transport);
    if (patch.command !== undefined) setNewServerCommand(patch.command);
    if (patch.args !== undefined) setNewServerArgs(patch.args);
    if (patch.env !== undefined) setNewServerEnv(patch.env);
    if (patch.url !== undefined) setNewServerUrl(patch.url);
    if (patch.headers !== undefined) setNewServerHeaders(patch.headers);
  };
  // Adding opens from the page; editing opens over the window of the connector it edits, which
  // stays under it and gets the focus back.
  const formWindow = (over: 'page' | 'detail') => (
    <MCPServerFormDialog
      open={showAddForm && (over === 'detail') === (editingServerName !== null)}
      mode={editingServerName ? 'edit' : 'add'}
      editingServerName={editingServerName}
      values={formValues}
      onChange={changeForm}
      addMode={addMode}
      onAddModeChange={setAddMode}
      jsonInput={jsonInput}
      onJsonInputChange={(value) => { setJsonInput(value); setJsonError(''); }}
      serverNameError={serverNameError}
      jsonError={jsonError}
      nameLockedHint={editingNameLocked
        ? (editingServerName && serverOwners[editingServerName] ? format(t.toolbox.mcpFromPlugin, { name: serverOwners[editingServerName] }) : t.toolbox.serverNameLockedHint)
        : undefined}
      startingPoint={formStartingPoint}
      onSubmit={addMode === 'json' ? handleAddFromJSON : handleAddServer}
      onClose={handleCloseAddForm}
      onCloseAutoFocus={over === 'page' ? afterAddFormClosed : undefined}
    />
  );

  const renderServerCard = (entry: MCPServerEntry) => (
    <ServerCard
      key={entry.config.name}
      entry={entry}
      owner={serverOwners[entry.config.name]}
      connecting={connectingServer === entry.config.name}
      locked={connectingServer !== null}
      onOpen={openServer}
      onToggle={handleToggleConnection}
    />
  );

  const renderTemplateCard = (tmpl: MCPTemplate) => (
    <TemplateCard
      key={tmpl.id}
      id={tmpl.id}
      serverName={tmpl.name}
      name={pickLocale(locale, tmpl.name, tmpl.nameEn)}
      description={pickLocale(locale, tmpl.description, tmpl.descriptionEn)}
      onOpen={openTemplate}
    />
  );

  const logsView = showLogs && selectedServer !== null;
  const serverBusy = selectedServer !== null
    && (connectingServer !== null || selectedServer.status === 'connecting' || selectedServer.status === 'reconnecting');

  return (
    <div ref={rootRef} className="flex h-full flex-col overflow-hidden">
      {/* One shelf at a time: 「我的」 lists the servers this user configured,
          「市场」 the curated catalog (installed entries first). */}
      <div className="flex-1 overflow-y-scroll overlay-scroll px-8 pt-3 pb-6">
        {source === 'mine' ? (
          mineServers.length === 0 ? (
            <div className="py-8">
              {scopedServers.length === 0 ? (
                <EmptyState
                  icon={AppIcons.connector}
                  title={t.toolbox.connectorsMineEmptyTitle}
                  description={t.toolbox.connectorsMineEmptyHint}
                  action={<Button variant="secondary" data-testid="connectors-mine-add" onClick={() => setShowAddForm(true)}>{t.toolbox.addServer}</Button>}
                />
              ) : (
                <EmptyState icon={AppIcons.connector} title={t.toolbox.noServersConnected} />
              )}
            </div>
          ) : (
            <div className="max-w-5xl mx-auto">
              <ToolGrid>{mineServers.map((entry) => renderServerCard(entry))}</ToolGrid>
            </div>
          )
        ) : exampleItems.length === 0 && pluginServers.length === 0 ? (
          <div className="py-8"><EmptyState icon={AppIcons.connector} title={t.toolbox.noServersConnected} /></div>
        ) : (
          /* 「市场」 — the curated catalog (installed entries first), then the
             servers plugins brought in. One grid: which shelf this is is the
             sub-nav's job to say, so the group heading that used to name it
             here is gone. */
          <div className="max-w-5xl mx-auto">
            <ToolGrid>
              {exampleItems.map((item) => item.kind === 'installed' ? renderServerCard(item.entry) : renderTemplateCard(item.template))}
              {pluginServers.map((entry) => renderServerCard(entry))}
            </ToolGrid>
          </div>
        )}
      </div>

      {/* Detail modal */}
      <ToolDetailModal
        open={!!selected}
        ariaLabel={detailName}
        onClose={() => setSelected(null)}
        onCloseAutoFocus={afterDetailClosed}
        maxWidth="max-w-2xl"
        avatar={logsView
          ? <IconButton icon={AppIcons.back} label={t.toolbox.backToDetails} onClick={() => setShowLogs(false)} data-connector-logs-back="" />
          : shown ? <Icon icon={AppIcons.connector} size="lg" className="text-label-tertiary" /> : undefined}
        stackedHeader
        panelClassName={DETAIL_WINDOW_CONTENT_HEIGHT}
        footer={selectedServer && !showLogs ? (
          <div className="flex w-full items-center justify-between gap-3">
            {/* The reason sits on the element around the button: a disabled button shows no title of its own. */}
            <span className="flex" title={serverOwners[selectedServer.config.name] ? format(t.toolbox.mcpFromPlugin, { name: serverOwners[selectedServer.config.name] }) : undefined}>
              <Button variant="danger" size="sm" icon={AppIcons.delete}
                disabled={!!serverOwners[selectedServer.config.name]}
                onClick={() => void handleRemoveServer(selectedServer.config.name)}>
                {t.common.delete}
              </Button>
            </span>
            <Button variant="primary" size="sm"
              busy={testingServer === selectedServer.config.name}
              disabled={serverBusy || (testingServer !== null && testingServer !== selectedServer.config.name)}
              onClick={() => void handleTestConnection(selectedServer)}>
              {t.toolbox.testConnection}
            </Button>
          </div>
        ) : selectedTemplate ? (
          <Button variant="primary" size="sm" icon={AppIcons.add}
            busy={installingTemplate === selectedTemplate.id}
            disabled={!templateRequiredFilled(selectedTemplate, templateArgs)}
            onClick={() => void handleInstallTemplate(selectedTemplate)}>
            {t.toolbox.install}
          </Button>
        ) : undefined}
        headerActions={showLogs ? undefined :
          selectedServer ? (
            <ServerHeaderActions
              entry={selectedServer}
              connectingServer={connectingServer}
              onToggleLogs={() => { if (selectedRef.current !== null) setShowLogs(!showLogs); }}
              onToggleConnection={() => { if (selectedRef.current !== null) void handleToggleConnection(selectedServer); }}
              onEdit={() => handleEditServer(selectedServer)}
            />
          ) : undefined
        }
      >
        {logsView && selectedServer ? <div data-testid="mcp-logs-view" className="space-y-4">
          <h2 className="text-title text-label">{t.toolbox.viewLogs}</h2>
          <p className="text-ui text-label-secondary">{selectedServer.config.name}</p>
          <ServerLogsPanel serverName={selectedServer.config.name} />
        </div> : <>
        <div className="mb-5 flex items-center justify-between gap-4">
          <h2 className="min-w-0 break-words text-title text-label">
            {detailName}{' '}
            <span className="font-normal text-label-tertiary">{t.toolbox.connectors}</span>
          </h2>
          {selectedServer && <ServerStatus entry={selectedServer} connectingServer={connectingServer} testingServer={testingServer} />}
        </div>
        {selectedServer ? (
          <ServerDetail
            entry={selectedServer}
            serverErrors={serverErrors}
            expandedTools={expandedTools}
            onToggleTools={setExpandedTools}
          />
        ) : selectedTemplate ? (
          <TemplateDetail
            template={selectedTemplate}
            templateArgs={templateArgs}
            setTemplateArgs={setTemplateArgs}
          />
        ) : null}
        </>}
        {formWindow('detail')}
      </ToolDetailModal>

      {/* Add window. Editing opens the same form over the detail window, above. */}
      {formWindow('page')}
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
    : status === 'error' ? t.toolbox.connectionError
    : t.toolbox.disconnected;
  // The same five states as a status tone, for the card badge and the window's status line.
  // 「未连接」 is no status: it has no tone and shows a neutral shape.
  const tone: StatusTone | null = isReconnecting ? 'warning'
    : isConnecting ? 'warning'
    : isConnected ? 'success'
    : status === 'error' ? 'danger'
    : null;
  return { isConnected, isConnecting, isTesting, statusLabel, tone };
}

/** The status line of the detail window: the one place that spins while the server connects. */
function ServerStatus({ entry, connectingServer, testingServer }: {
  entry: MCPServerEntry;
  connectingServer: string | null;
  testingServer: string | null;
}) {
  const { t } = useI18n();
  const { isConnecting, statusLabel, tone } = serverStatusMeta(entry, connectingServer, testingServer, t);
  return (
    <span data-testid="mcp-detail-status" className="flex shrink-0">
      {isConnecting ? <Spinner size="sm" label={statusLabel} /> : <Tag tone={tone ?? 'neutral'}>{statusLabel}</Tag>}
    </span>
  );
}

/** Connection control and secondary actions share the extension detail header. */
function ServerHeaderActions({
  entry, connectingServer,
  onToggleLogs, onToggleConnection, onEdit,
}: {
  entry: MCPServerEntry;
  connectingServer: string | null;
  onToggleLogs: () => void;
  onToggleConnection: () => void;
  onEdit: () => void;
}) {
  const { t } = useI18n();
  const { isConnected, isConnecting } = serverStatusMeta(entry, connectingServer, null, t);
  const busy = isConnecting || entry.status === 'reconnecting' || connectingServer !== null;
  // What a press does, as the tooltip and as the switch's name.
  const action = busy ? t.toolbox.connecting : isConnected ? t.toolbox.disconnect : t.toolbox.connect;
  return (
    <>
      <span className="flex items-center" data-testid="mcp-server-toggle-connection" data-connected={isConnected ? 'true' : 'false'}
        title={action}>
        <Switch checked={isConnected} busy={busy} onCheckedChange={onToggleConnection} aria-label={action} />
      </span>
      <InstalledItemMenu testId="mcp-detail-menu"
        ariaLabel={format(t.toolbox.itemMenuLabel, { name: entry.config.name })}
        actions={[
          { id: 'edit', label: t.toolbox.skillEdit, onSelect: onEdit },
          { id: 'view', label: t.toolbox.viewLogs, onSelect: onToggleLogs },
        ]}
      />
    </>
  );
}

function ServerDetail({
  entry, serverErrors,
  expandedTools,
  onToggleTools,
}: {
  entry: MCPServerEntry;
  serverErrors: Record<string, string>;
  expandedTools: boolean;
  onToggleTools: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const { config, status, tools } = entry;
  const isConnected = status === 'connected';
  const error = serverErrors[config.name] || (status === 'error' ? entry.error : undefined);
  const toolDetails = (tools ?? []) as { name: string; description?: string }[];

  return (
    <>
      {/* Error */}
      {error && (
        <div className="mb-4">
          <InlineMessage tone="danger"><p className="break-words">{error}</p></InlineMessage>
        </div>
      )}

      {/* Tools */}
      {isConnected && toolDetails.length > 0 && (
        <div className="mb-5">
          <Disclosure title={`${t.toolbox.agentTools} (${toolDetails.length})`} open={expandedTools} onOpenChange={onToggleTools}>
            <ToolDetailsList tools={toolDetails} />
          </Disclosure>
        </div>
      )}
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
        <span className="text-ui-sm text-label-tertiary">{t.toolbox.detailDescription}</span>
        <p className="mt-1 text-ui text-label">{pickLocale(locale, template.description, template.descriptionEn)}</p>
      </div>

      {/* Setup hint */}
      {hasSetupHint && (
        <div className="mb-5">
          <InlineMessage tone="warning">
            <p className="whitespace-pre-wrap break-words">
              {renderSetupHint(pickLocale(locale, template.setupHint!, template.setupHintEn))}
            </p>
          </InlineMessage>
        </div>
      )}

      {/* Configuration inputs */}
      {(hasConfigurableArgs || hasEnvVars) && (
        <div className="space-y-3">
          <span className="text-ui-sm text-label-tertiary">{t.toolbox.serverArgs}</span>
          {template.configurableArgs?.map((arg) => (
            // Labeled like the secret below it: the placeholder is the only
            // thing naming this field, and it vanishes the moment the user
            // types — leaving a bare box next to a labeled one.
            <div key={arg.index}>
              <label htmlFor={`${template.id}-arg-${arg.index}`} className="mb-1 block text-ui-sm font-medium text-label-secondary">{pickLocale(locale, arg.label, arg.labelEn)}</label>
              <TextField id={`${template.id}-arg-${arg.index}`} placeholder={pickLocale(locale, arg.placeholder, arg.placeholderEn)}
                value={templateArgs[`${template.id}-${arg.index}`] || ''}
                onChange={(e) => setTemplateArgs((prev) => ({ ...prev, [`${template.id}-${arg.index}`]: e.target.value }))} />
            </div>
          ))}
          {template.requiredEnvVars?.map((envVar) => (
            <div key={envVar.name}>
              <label htmlFor={`${template.id}-env-${envVar.name}`} className="mb-1 block text-ui-sm font-medium text-label-secondary">{pickLocale(locale, envVar.label, envVar.labelEn)}</label>
              {/* Masked, with no way to show it: what is typed here is usually a key. */}
              <TextField id={`${template.id}-env-${envVar.name}`} type="password" className="font-code" placeholder={pickLocale(locale, envVar.placeholder, envVar.placeholderEn)}
                value={templateArgs[`${template.id}-env-${envVar.name}`] || ''}
                onChange={(e) => setTemplateArgs((prev) => ({ ...prev, [`${template.id}-env-${envVar.name}`]: e.target.value }))} />
              {envVar.description && <p className="mt-1 text-caption text-label-tertiary">{pickLocale(locale, envVar.description, envVar.descriptionEn)}</p>}
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
      <div className="rounded-control border border-separator px-3 py-2 text-caption text-label-tertiary">
        {t.toolbox.noLogs}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-control bg-code p-2">
      {logs.map((log, i) => (
        <div key={i} className="flex gap-2 font-code text-ui-sm">
          <span className="shrink-0 text-label-tertiary">
            {new Date(log.timestamp).toLocaleTimeString()}
          </span>
          <span className={
            log.level === 'error' ? 'text-danger' :
            log.level === 'warn' ? 'text-warning' : 'text-label-secondary'
          }>
            {log.message}
          </span>
        </div>
      ))}
    </div>
  );
}
