import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useExtensionsSearchQuery, useSettingsStore, type ExtensionsTab } from '@/stores/settingsStore';
import { useChatStore } from '@/stores/chatStore';
import { useI18n } from '@/i18n';
import { Sparkles, Server, Search, Puzzle } from 'lucide-react';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import { getEnterpriseMount } from '@/core/enterprise/mounts-registry';
import SkillsSection from '../customize/SkillsSection';
import MCPSection from '../customize/MCPSection';
import TopTabNav, { type TopTabNavItem } from '@/components/toolbox/TopTabNav';
import ToolboxCreateMenu from '@/components/toolbox/ToolboxCreateMenu';
import PluginsTab from '@/components/toolbox/plugins/PluginsTab';
import CapabilityScopeToggle, { type CapabilityScope } from '@/components/toolbox/CapabilityScopeToggle';
import { usePluginAuthorStore } from '@/stores/pluginAuthorStore';
import { useToastStore } from '@/stores/toastStore';
import { Input } from '@/components/ui/input';
import PluginUpdateBadge from '@/components/common/PluginUpdateBadge';
import SourceSubNav from '@/components/toolbox/SourceSubNav';
import { sourceTabId } from '@/components/toolbox/extensionSource';
import { useExtensionSourceStore } from '@/stores/extensionSourceStore';

// Enterprise plugin/skill/MCP tab implementations are registered by the
// enterprise-modules entry point (real impls in the enterprise build, no-op in
// the OSS build). The consumers below read them via getEnterpriseMount(), which
// returns a NullComponent fallback when unregistered — so the OSS build never
// imports enterprise UI directly.

/** The element the source sub-nav switches between — named so the two pills read
 *  as tabs over it. Per tab, since each tab keeps its own mounted panel. */
const sourcePanelId = (tab: ExtensionsTab) => `extensions-panel-${tab}`;

/** Plugins add their own market navigation; skills and connectors retain the released toolbox. */
export default function ExtensionsView() {
  const {
    activeExtensionsTab: activeTab,
    closeExtensions,
    setActiveExtensionsTab,
    setExtensionsSearchQuery,
    pendingExtensionsSource,
    clearPendingExtensionsSource,
    pendingExtensionsFilter,
    clearPendingExtensionsFilter,
  } = useSettingsStore();
  // Per tab: 插件's words survive a trip to 技能 and are still there on return.
  const extensionsSearchQuery = useExtensionsSearchQuery(activeTab);
  const pluginSearchQuery = useExtensionsSearchQuery('plugins');
  const [visitedTabs, setVisitedTabs] = useState<ExtensionsTab[]>([activeTab]);
  if (!visitedTabs.includes(activeTab)) setVisitedTabs([...visitedTabs, activeTab]);
  const setPendingInput = useChatStore((s) => s.setPendingInput);
  const startNewConversation = useChatStore((s) => s.startNewConversation);
  const { t } = useI18n();
  const enterpriseMode = useEnterpriseStore(s => s.mode);
  const isEnterprise = enterpriseMode.kind !== 'personal';

  // 市场 | 我的 per tab, remembered across restarts.
  const sources = useExtensionSourceStore(s => s.sources);
  const setSource = useExtensionSourceStore(s => s.setSource);

  const creatingPlugin = usePluginAuthorStore(s => s.creating);
  const [pluginAddTrigger, setPluginAddTrigger] = useState(0);
  const [mcpAddFormOpen, setMcpAddFormOpen] = useState(false);
  const [capabilityScope, setCapabilityScope] = useState<CapabilityScope>('personal');
  const [skillUploadModalOpen, setSkillUploadModalOpen] = useState(false);
  const [manualCreateTrigger, setManualCreateTrigger] = useState(0);
  // Consume existing deep links without leaving an accepted skill behind a catalog.
  useEffect(() => {
    if (!pendingExtensionsSource) return;
    setCapabilityScope(pendingExtensionsSource === 'mine' ? 'personal' : 'organization');
    // …and the same word now also names a shelf inside 个人: a deep link to a
    // skill the user just accepted must land on the shelf that skill is on,
    // not on whichever one they last looked at.
    useExtensionSourceStore.getState().setSource(activeTab, pendingExtensionsSource);
    clearPendingExtensionsSource();
  }, [pendingExtensionsSource, activeTab, clearPendingExtensionsSource]);

  const lastView = useRef({ activeTab, capabilityScope });
  useEffect(() => {
    if (lastView.current.activeTab === activeTab && lastView.current.capabilityScope === capabilityScope) return;
    lastView.current = { activeTab, capabilityScope };
    setManualCreateTrigger(0);
  }, [activeTab, capabilityScope]);

  // Handler for creating a skill with AI (the only tab with an AI-create entry)
  const handleAICreate = () => {
    startNewConversation();
    setPendingInput(t.toolbox.aiCreateSkillPrompt, { startsTask: true });
    closeExtensions();
  };

  // Handler for manual create (opens blank editor in SkillsSection)
  const handleManualCreate = () => {
    setManualCreateTrigger((c) => c + 1);
  };

  const navItems: TopTabNavItem<ExtensionsTab>[] = [
    // 插件 carries the update badge: the count is about installed plugins, and
    // this tab is where the market that offers the newer versions lives.
    {
      id: 'plugins',
      label: t.toolbox.plugins,
      icon: Puzzle,
      badge: <PluginUpdateBadge testId="plugins-tab-update-badge" />,
    },
    { id: 'skills', label: t.toolbox.skills, icon: Sparkles },
    { id: 'mcp', label: t.toolbox.connectors, icon: Server },
  ];

  const renderContent = (tab: ExtensionsTab = activeTab) => {
    const binding = enterpriseMode.kind === 'enterprise' || enterpriseMode.kind === 'offline'
      ? enterpriseMode.binding
      : null;
    const config = enterpriseMode.kind === 'enterprise'
      ? enterpriseMode.config
      : enterpriseMode.kind === 'offline'
        ? enterpriseMode.lastConfig
        : null;

    // A bound client's 「市场」 is the organization catalog: what IT offers you
    // is the offer that matters. `pluginTab` is an optional slot, so an
    // enterprise build without one falls through to Abu's own market rather
    // than showing a blank panel.
    const mount = isEnterprise && binding
      ? { plugins: getEnterpriseMount('pluginTab'), skills: getEnterpriseMount('skillTab'), mcp: getEnterpriseMount('mcpTab') }[tab]
      : null;
    const showOrganization = capabilityScope === 'organization';
    if (showOrganization && mount && binding) {
      const Market = mount;
      return <Market binding={binding} config={config} searchQuery={extensionsSearchQuery} />;
    }

    switch (tab) {
      // Plugins own the install-disclosure flow and, inside 「市场」, the
      // add-marketplace entry; the shared header search box feeds both halves.
      case 'plugins':
        return <PluginsTab searchQuery={pluginSearchQuery} addTrigger={pluginAddTrigger} source={sources.plugins} initialFilter={pendingExtensionsFilter} onFilterConsumed={clearPendingExtensionsFilter} />;
      case 'skills':
        return <SkillsSection
          manualCreateTrigger={manualCreateTrigger}
          showUploadModal={skillUploadModalOpen}
          onUploadModalChange={setSkillUploadModalOpen}
          source={sources.skills}
        />;
      case 'mcp':
        return <MCPSection showAddForm={mcpAddFormOpen} onAddFormChange={setMcpAddFormOpen} source={sources.mcp} />;
      default:
        return null;
    }
  };

  // Header-right control: always a search box, plus a per-tab create control.
  // Local creation stays with the released personal capability view.
  const renderHeaderRight = () => {
    const searchBox = (
      <div className="relative w-52 shrink-0">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--abu-text-tertiary)] pointer-events-none" />
        <Input
          type="text"
          placeholder={t.toolbox.searchPlaceholder}
          value={extensionsSearchQuery}
          onChange={(e) => setExtensionsSearchQuery(activeTab, e.target.value)}
          className="h-8 pl-8 pr-3 text-body"
        />
      </div>
    );

    let createControl: ReactNode = null;
    if (activeTab === 'skills' && (!isEnterprise || capabilityScope === 'personal')) {
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
    if (activeTab === 'plugins' && (!isEnterprise || capabilityScope === 'personal')) {
      createControl = <ToolboxCreateMenu triggerTestId="plugin-create-trigger" menuTestId="plugin-create-menu" items={[
        // The new package lands under 「我的」 — go there, or the create reads
        // as a create that did nothing.
        { label: t.toolbox.pluginsCreate, disabled: creatingPlugin, onSelect: () => { void usePluginAuthorStore.getState().create().then(() => setSource('plugins', 'mine')).catch(error => useToastStore.getState().addToast({ type: 'error', title: t.toolbox.plugins, message: String(error) })); } },
        { label: t.toolbox.pluginsCreateApp, disabled: creatingPlugin, onSelect: () => { void usePluginAuthorStore.getState().create('app').then(() => setSource('plugins', 'mine')).catch(error => useToastStore.getState().addToast({ type: 'error', title: t.toolbox.plugins, message: String(error) })); } },
        { label: t.toolbox.pluginsAddMarketplace, onSelect: () => setPluginAddTrigger(value => value + 1) },
      ]} />;
    }

    return <>
      {isEnterprise && <CapabilityScopeToggle
        value={capabilityScope}
        onChange={setCapabilityScope}
        personalLabel={t.toolbox.personalSource}
        organizationLabel={t.toolbox.organizationSource}
      />}
      {searchBox}{createControl}
    </>;
  };

  return (
    <div className="h-full bg-[var(--abu-bg-base)] flex flex-col">
      {/* Content-area header row — tabs left, search + create right. Sits below
          the window's floating title-bar controls (traffic lights / sidebar
          toggle / search / new-task) via belowChrome's top clearance. There is
          no separate page title: the tabs themselves (插件/技能/连接器) are
          the header. */}
      <TopTabNav
        items={navItems}
        activeId={activeTab}
        onSelect={setActiveExtensionsTab}
        belowChrome
        right={renderHeaderRight()}
      />

      {/* 市场 | 我的 — one row, directly under the tabs and inset to the same
          grid the cards use. The organization catalog IS the enterprise market,
          so it carries no shelf of its own. */}
      {!(isEnterprise && capabilityScope === 'organization') && (
        <div className="px-8"><div className="max-w-5xl mx-auto">
          <SourceSubNav
            value={sources[activeTab]}
            onChange={(next) => setSource(activeTab, next)}
            marketLabel={t.toolbox.sourceMarket}
            mineLabel={t.toolbox.categoryMine}
            panelId={sourcePanelId(activeTab)}
          />
        </div></div>
      )}

      <div tabIndex={0} className="flex-1 overflow-hidden">
        {capabilityScope === 'organization' ? renderContent() : visitedTabs.map(tab => (
          <div
            key={tab}
            id={sourcePanelId(tab)}
            role="tabpanel"
            aria-labelledby={sourceTabId(sources[tab])}
            hidden={tab !== activeTab}
            className="h-full"
            data-extension-panel={tab}
          >
            {renderContent(tab)}
          </div>
        ))}
      </div>
    </div>
  );
}
