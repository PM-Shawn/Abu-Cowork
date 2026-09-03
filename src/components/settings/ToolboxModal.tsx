import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useSettingsStore, type ToolboxTab } from '@/stores/settingsStore';
import { useChatStore } from '@/stores/chatStore';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useI18n, format } from '@/i18n';
import { Sparkles, Bot, Server, Search, Puzzle } from 'lucide-react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useToastStore } from '@/stores/toastStore';
import { installSkillFromFolder, type InstallResult as SkillInstallResult } from '@/core/skill/installer';
import { installAgentFromFolder, type InstallResult as AgentInstallResult } from '@/core/agent/installer';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import { getEnterpriseMount } from '@/core/enterprise/mounts-registry';
import { useLabsFlag } from '@/core/labs/resolve';
import { LABS_PLUGIN_SYSTEM } from '@/core/labs/registry';
import SkillsSection from '../customize/SkillsSection';
import AgentsSection from '../customize/AgentsSection';
import MCPSection from '../customize/MCPSection';
import TopTabNav from '@/components/toolbox/TopTabNav';
import ToolboxCreateMenu from '@/components/toolbox/ToolboxCreateMenu';
import CapabilityScopeToggle, { type CapabilityScope } from '@/components/toolbox/CapabilityScopeToggle';
import PluginsTab from '@/components/toolbox/plugins/PluginsTab';
import { Input } from '@/components/ui/input';

/**
 * The symlinks an installer refused to copy, or [] when it reports none.
 *
 * Only the skill installer has such a list; the agent one — whose copy walk
 * still follows links — is a separate site with its own fix. Narrowing the
 * shared success value here keeps the one success toast cast-free.
 */
function refusedLinks(result: Extract<SkillInstallResult | AgentInstallResult, { ok: true }>): string[] {
  return 'skippedSymlinks' in result ? result.skippedSymlinks : [];
}

// Tab ids surfaced by the Plugin System IA (labs flag LABS_PLUGIN_SYSTEM).
// 'plugins' has no counterpart in the persisted `ToolboxTab` union — the
// store keeps only 'skills' | 'agents' | 'mcp' (see settingsStore.ts) — so
// it's tracked as local component state (`pluginTab` below) instead of
// widening the store's type.
type PluginIATab = 'plugins' | 'skills' | 'mcp';

// Enterprise skill/MCP tab implementations are registered by the enterprise-modules
// entry point (real impls in the enterprise build, no-op in the OSS build). The
// consumers below read them via getEnterpriseMount(), which returns a NullComponent
// fallback when unregistered — so the OSS build never imports enterprise UI directly.

export default function ToolboxView() {
  const {
    activeToolboxTab,
    closeToolbox,
    setActiveToolboxTab,
    toolboxSearchQuery,
    setToolboxSearchQuery,
  } = useSettingsStore();
  const setPendingInput = useChatStore((s) => s.setPendingInput);
  const startNewConversation = useChatStore((s) => s.startNewConversation);
  const refresh = useDiscoveryStore((s) => s.refresh);
  const { t } = useI18n();
  const enterpriseMode = useEnterpriseStore(s => s.mode);
  const isEnterprise = enterpriseMode.kind !== 'personal';

  // Plugin System IA: flag off → pixel-identical to pre-experiment behavior
  // (skills/agents/mcp tabs, driven entirely by the store's activeToolboxTab,
  // untouched below). Flag on → 3 tabs become plugins/skills/mcp; the Agents
  // tab is dropped (its home moves to the sidebar's Team view once that
  // branch merges — see LABS_PLUGIN_SYSTEM's registry comment).
  const isPluginIA = useLabsFlag(LABS_PLUGIN_SYSTEM);

  // Local tab selection for the Plugin IA only — decoupled from the store's
  // `ToolboxTab` (which has no 'plugins' member). Initialized eagerly from
  // whatever the store's activeToolboxTab already is, so a component that
  // mounts with the flag already on (or flips on mid-session while the
  // stored tab is the now-gone 'agents') never renders a blank tab panel.
  const [pluginTab, setPluginTab] = useState<PluginIATab>(() => (
    activeToolboxTab === 'skills' || activeToolboxTab === 'mcp' ? activeToolboxTab : 'plugins'
  ));

  // Re-derive the safe landing tab every time we enter (or are already in)
  // Plugin IA mode, in case the store's activeToolboxTab changed while the
  // flag was off (e.g. user was on 'agents', flag flips on elsewhere while
  // this view stays mounted) — without this, `pluginTab` could go stale and
  // the switch below would fall through to `null` (a white screen).
  useEffect(() => {
    if (!isPluginIA) return;
    setPluginTab(activeToolboxTab === 'skills' || activeToolboxTab === 'mcp' ? activeToolboxTab : 'plugins');
    // Only re-sync on the flag transition itself (and the tab read at that
    // moment) — once inside Plugin IA, tab switches are owned by
    // pluginTab/setPluginTab below, not the underlying store tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPluginIA]);

  // Unified "what's actually showing" tab id, used for content + header
  // logic below so they never disagree with what the nav highlights.
  const activeTab: ToolboxTab | 'plugins' = isPluginIA ? pluginTab : activeToolboxTab;

  const [mcpAddFormOpen, setMcpAddFormOpen] = useState(false);
  const [skillUploadModalOpen, setSkillUploadModalOpen] = useState(false);
  const [manualCreateTrigger, setManualCreateTrigger] = useState(0);
  const [capabilityScope, setCapabilityScope] = useState<CapabilityScope>('personal');

  // Reset manual-create trigger and clear search when switching tabs
  useEffect(() => {
    setManualCreateTrigger(0);
    setToolboxSearchQuery('');
  }, [activeTab, capabilityScope, setToolboxSearchQuery]);

  useEffect(() => {
    if (!isEnterprise) setCapabilityScope('personal');
  }, [isEnterprise]);

  // Tab-nav selection handler. Under the Plugin IA, 'plugins' has no store
  // representation — it's local-only. Selecting 'skills'/'mcp' still mirrors
  // into the store so the tab lands somewhere sane if the flag turns back off.
  const handleSelectTab = (id: ToolboxTab | 'plugins') => {
    if (isPluginIA) {
      setPluginTab(id as PluginIATab);
      if (id !== 'plugins') setActiveToolboxTab(id);
      return;
    }
    setActiveToolboxTab(id as ToolboxTab);
  };

  // Handler for creating with AI, adapts to active tab
  const handleAICreate = () => {
    startNewConversation();
    const prompt = activeTab === 'agents'
      ? t.toolbox.aiCreateAgentPrompt
      : t.toolbox.aiCreateSkillPrompt;
    setPendingInput(prompt);
    closeToolbox();
  };

  // Handler for uploading a folder (Skills/Agents)
  const handleUploadFile = async () => {
    const isAgent = activeTab === 'agents';
    const addToast = useToastStore.getState().addToast;

    try {
      const folderPath = await openDialog({ directory: true, multiple: false });
      if (!folderPath) return;

      const result = isAgent
        ? await installAgentFromFolder(folderPath as string, { overwrite: true })
        : await installSkillFromFolder(folderPath as string, { overwrite: true });

      if (!result.ok) {
        addToast({
          type: 'error',
          title: t.toolbox.uploadFailed,
          // A folder that is itself a link is a refusal we can explain, and the
          // remedy (pick the folder it points at) only fits in the locale.
          message: result.code === 'SYMLINK_ROOT'
            ? format(t.toolbox.importSymlinkRootRefused, { path: folderPath as string })
            : result.message,
        });
        return;
      }

      // The skill installer refuses to follow symlinks; say so, or this picker
      // is the one install path where the user cannot tell the skill that
      // landed is missing entries the folder appeared to contain.
      const links = refusedLinks(result);

      await refresh();
      addToast({
        type: 'success',
        title: t.toolbox.uploadSuccess,
        message:
          format(t.toolbox.uploadSuccessDetail, { name: result.name, count: String(result.fileCount) }) +
          (links.length > 0
            ? ` · ${format(t.toolbox.importSkippedLinks, {
                n: String(links.length),
                names: links.join(t.toolbox.importSkippedLinksSeparator),
              })}`
            : ''),
      });
    } catch (err) {
      console.error('Upload folder failed:', err);
      addToast({ type: 'error', title: t.toolbox.uploadFailed, message: String(err) });
    }
  };

  // Handler for manual create (opens blank editor in SkillsSection/AgentsSection)
  const handleManualCreate = () => {
    setManualCreateTrigger((c) => c + 1);
  };

  // Flag off: unchanged skills/agents/mcp — pixel-identical to pre-experiment.
  // Flag on: plugins/skills/mcp — 'agents' dropped (see isPluginIA comment above).
  const navItems: { id: ToolboxTab | 'plugins'; label: string; icon: typeof Sparkles }[] = isPluginIA
    ? [
        { id: 'plugins', label: t.toolbox.plugins, icon: Puzzle },
        { id: 'skills', label: t.toolbox.skills, icon: Sparkles },
        { id: 'mcp', label: t.toolbox.connectors, icon: Server },
      ]
    : [
        { id: 'skills', label: t.toolbox.skills, icon: Sparkles },
        { id: 'agents', label: t.toolbox.agents, icon: Bot },
        { id: 'mcp', label: t.toolbox.mcp, icon: Server },
      ];

  const renderContent = () => {
    const binding = enterpriseMode.kind === 'enterprise' || enterpriseMode.kind === 'offline'
      ? enterpriseMode.binding
      : null;
    const config = enterpriseMode.kind === 'enterprise'
      ? enterpriseMode.config
      : enterpriseMode.kind === 'offline'
        ? enterpriseMode.lastConfig
        : null;

    switch (activeTab) {
      // Plugins own their sub-navigation (installed / marketplace) and the
      // install-disclosure flow; the shared header search box feeds both.
      case 'plugins': {
        if (isEnterprise && capabilityScope === 'organization') {
          if (!binding) return null;
          const PluginTab = getEnterpriseMount('pluginTab');
          if (!PluginTab) return null;
          return <PluginTab binding={binding} config={config} searchQuery={toolboxSearchQuery} />;
        }
        return <PluginsTab searchQuery={toolboxSearchQuery} />;
      }
      case 'skills': {
        if (isEnterprise && capabilityScope === 'organization') {
          if (!binding) return null;
          const SkillTab = getEnterpriseMount('skillTab');
          return <SkillTab binding={binding} config={config} searchQuery={toolboxSearchQuery} />;
        }
        return <SkillsSection
          manualCreateTrigger={manualCreateTrigger}
          showUploadModal={skillUploadModalOpen}
          onUploadModalChange={setSkillUploadModalOpen}
        />;
      }
      case 'agents': {
        if (isEnterprise && capabilityScope === 'organization') {
          if (!binding) return null;
          const AgentMarket = getEnterpriseMount('agentMarket');
          if (!AgentMarket) return null;
          return <AgentMarket binding={binding} config={config} searchQuery={toolboxSearchQuery} />;
        }
        return <AgentsSection
          manualCreateTrigger={manualCreateTrigger}
        />;
      }
      case 'mcp': {
        if (isEnterprise && capabilityScope === 'organization') {
          if (!binding) return null;
          const McpTab = getEnterpriseMount('mcpTab');
          return <McpTab binding={binding} config={config} searchQuery={toolboxSearchQuery} />;
        }
        return <MCPSection showAddForm={mcpAddFormOpen} onAddFormChange={setMcpAddFormOpen} />;
      }
      default:
        return null;
    }
  };

  // Header-right control: always a search box, plus a per-tab create control.
  // Organization catalogs reuse the same source toggle and search box, while
  // create/import actions stay personal-only.
  const renderHeaderRight = () => {
    const searchBox = (
      <div className="relative w-52 shrink-0">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--abu-text-tertiary)] pointer-events-none" />
        <Input
          type="text"
          placeholder={t.toolbox.searchPlaceholder}
          value={toolboxSearchQuery}
          onChange={(e) => setToolboxSearchQuery(e.target.value)}
          className="h-8 pl-8 pr-3 text-body"
        />
      </div>
    );

    const scopeControl = isEnterprise ? (
      <CapabilityScopeToggle
        value={capabilityScope}
        onChange={setCapabilityScope}
        personalLabel={t.toolbox.personalSource}
        organizationLabel={t.toolbox.organizationSource}
      />
    ) : null;

    let createControl: ReactNode = null;
    if (activeTab === 'agents' && (!isEnterprise || capabilityScope === 'personal')) {
      createControl = (
        <ToolboxCreateMenu
          onAICreate={handleAICreate}
          onManualCreate={handleManualCreate}
          onUploadFile={handleUploadFile}
          uploadLabel={t.toolbox.uploadFile}
        />
      );
    } else if (activeTab === 'skills' && (!isEnterprise || capabilityScope === 'personal')) {
      createControl = (
        <ToolboxCreateMenu
          onAICreate={handleAICreate}
          onManualCreate={handleManualCreate}
          onUploadFile={() => setSkillUploadModalOpen(true)}
          uploadLabel={t.toolbox.importEntry}
          triggerTestId="skill-create-trigger"
          menuTestId="skill-create-menu"
        />
      );
    } else if (activeTab === 'mcp' && (!isEnterprise || capabilityScope === 'personal')) {
      createControl = <ToolboxCreateMenu onClick={() => setMcpAddFormOpen(true)} />;
    }
    // activeTab === 'plugins' → no header create control: "add marketplace"
    // only makes sense on the marketplace sub-tab, which PluginsTab owns, so
    // the button lives there (and in its empty state) instead of here.

    return <>{scopeControl}{searchBox}{createControl}</>;
  };

  return (
    <div className="h-full bg-[var(--abu-bg-base)] flex flex-col">
      {/* Plugin IA title — only rendered when the flag is on, so the flag-off
          layout stays pixel-identical to pre-experiment (no title bar existed
          here before this experiment). */}
      {/* Content-area header row — tabs left, search + create right. Sits below
          the window's floating title-bar controls (traffic lights / sidebar
          toggle / search / new-task) via belowChrome's top clearance. The
          Plugin IA carries no separate page title: the tabs themselves
          (插件/技能/连接器) are the header, matching the pre-experiment toolbox
          layout exactly. */}
      <TopTabNav
        items={navItems}
        activeId={activeTab}
        onSelect={handleSelectTab}
        belowChrome
        right={renderHeaderRight()}
      />

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {renderContent()}
      </div>
    </div>
  );
}
