import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useSettingsStore, type ExtensionsTab } from '@/stores/settingsStore';
import { useChatStore } from '@/stores/chatStore';
import { useI18n } from '@/i18n';
import { Sparkles, Server, Search, Puzzle } from 'lucide-react';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import { getEnterpriseMount } from '@/core/enterprise/mounts-registry';
import SkillsSection from '../customize/SkillsSection';
import MCPSection from '../customize/MCPSection';
import TopTabNav from '@/components/toolbox/TopTabNav';
import ToolboxCreateMenu from '@/components/toolbox/ToolboxCreateMenu';
import SourceSubNav, { type ExtensionSource } from '@/components/toolbox/SourceSubNav';
import PluginsTab from '@/components/toolbox/plugins/PluginsTab';
import ExternalSkillsPanel from '@/components/toolbox/skills/ExternalSkillsPanel';
import ConnectorCatalog from '@/components/toolbox/connectors/ConnectorCatalog';
import type { ConnectorPrefill } from '@/components/toolbox/connectors/connectorPrefill';
import { Input } from '@/components/ui/input';

// Enterprise plugin/skill/MCP tab implementations are registered by the
// enterprise-modules entry point (real impls in the enterprise build, no-op in
// the OSS build). The consumers below read them via getEnterpriseMount(), which
// returns a NullComponent fallback when unregistered — so the OSS build never
// imports enterprise UI directly.

/** The element the source sub-nav switches between — named so the two pills read as tabs over it. */
const SOURCE_PANEL_ID = 'extensions-source-panel';

/**
 * The Extensions view (sidebar 「扩展」): 插件 / 技能 / 连接器, driven directly by
 * the settings store's `activeExtensionsTab`. Agents are not managed here —
 * they belong to the Team view's 「队员」 tab.
 *
 * Every tab is split the same way, by SOURCE: 「市场」 is what is on offer,
 * 「我的」 is what this user has. That replaced the old 个人/组织 scope toggle,
 * which asked a question only bound enterprise clients could answer and put
 * personal content behind the same control as an organization catalog. A bound
 * client's organization catalog IS the 「市场」 panel now; an unbound one gets
 * Abu's own catalog there. 「我的」 means the same thing either way.
 */
export default function ExtensionsView() {
  const {
    activeExtensionsTab: activeTab,
    closeExtensions,
    setActiveExtensionsTab,
    extensionsSearchQuery,
    setExtensionsSearchQuery,
  } = useSettingsStore();
  const setPendingInput = useChatStore((s) => s.setPendingInput);
  const startNewConversation = useChatStore((s) => s.startNewConversation);
  const { t } = useI18n();
  const enterpriseMode = useEnterpriseStore(s => s.mode);
  const isEnterprise = enterpriseMode.kind !== 'personal';

  const [mcpAddFormOpen, setMcpAddFormOpen] = useState(false);
  const [mcpPrefill, setMcpPrefill] = useState<ConnectorPrefill | null>(null);
  const [mcpFocusServer, setMcpFocusServer] = useState<string | null>(null);
  const [skillUploadModalOpen, setSkillUploadModalOpen] = useState(false);
  const [manualCreateTrigger, setManualCreateTrigger] = useState(0);
  // Per-tab, so 插件 staying on 我的 does not drag 技能 there too. Deliberately
  // not persisted: the view opens on what is on offer, every time.
  const [sourceByTab, setSourceByTab] = useState<Record<ExtensionsTab, ExtensionSource>>({
    plugins: 'market', skills: 'market', mcp: 'market',
  });
  const source = sourceByTab[activeTab];
  const setSource = (tab: ExtensionsTab, next: ExtensionSource) =>
    setSourceByTab((prev) => ({ ...prev, [tab]: next }));

  // Reset manual-create trigger, clear search and spend the pending 「管理」
  // target when the tab or source CHANGES — not on first paint. A deep link
  // (SkillProposalCard → openExtensions('skills') + setExtensionsSearchQuery(name))
  // sets the query right before this view mounts; clearing on mount would wipe it.
  const lastTabSource = useRef<{ tab: ExtensionsTab; source: ExtensionSource }>({ tab: activeTab, source });
  useEffect(() => {
    const last = lastTabSource.current;
    if (last.tab === activeTab && last.source === source) return;
    lastTabSource.current = { tab: activeTab, source };
    setManualCreateTrigger(0);
    setExtensionsSearchQuery('');
    // `focusServer` is a one-shot instruction, but as a prop it would stay
    // armed and then fail to re-fire the second time the same server is
    // managed. MCPSection has already consumed it by now (a child's effect
    // runs before its parent's), so withdrawing it here costs nothing and
    // leaves the next 「管理」 free to offer the same name again.
    setMcpFocusServer(null);
  }, [activeTab, source, setExtensionsSearchQuery]);

  // Handler for creating a skill with AI (the only tab with an AI-create entry)
  const handleAICreate = () => {
    startNewConversation();
    setPendingInput(t.toolbox.aiCreateSkillPrompt);
    closeExtensions();
  };

  // Handler for manual create (opens blank editor in SkillsSection)
  const handleManualCreate = () => {
    setManualCreateTrigger((c) => c + 1);
  };

  const navItems: { id: ExtensionsTab; label: string; icon: typeof Sparkles }[] = [
    { id: 'plugins', label: t.toolbox.plugins, icon: Puzzle },
    { id: 'skills', label: t.toolbox.skills, icon: Sparkles },
    { id: 'mcp', label: t.toolbox.connectors, icon: Server },
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

    // A bound client's 「市场」 is the organization catalog: what IT offers you
    // is the offer that matters. `pluginTab` is an optional slot, so an
    // enterprise build without one falls through to Abu's own market rather
    // than showing a blank panel.
    const mount = isEnterprise && binding
      ? { plugins: getEnterpriseMount('pluginTab'), skills: getEnterpriseMount('skillTab'), mcp: getEnterpriseMount('mcpTab') }[activeTab]
      : null;
    if (source === 'market' && mount && binding) {
      const Market = mount;
      return <Market binding={binding} config={config} searchQuery={extensionsSearchQuery} />;
    }

    switch (activeTab) {
      // Plugins own the install-disclosure flow and, inside 「市场」, the
      // add-marketplace entry; the shared header search box feeds both halves.
      case 'plugins':
        return <PluginsTab searchQuery={extensionsSearchQuery} source={source} />;
      case 'skills':
        return source === 'market'
          ? <ExternalSkillsPanel searchQuery={extensionsSearchQuery} />
          : <SkillsSection
              sourceFilter="mine"
              manualCreateTrigger={manualCreateTrigger}
              showUploadModal={skillUploadModalOpen}
              onUploadModalChange={setSkillUploadModalOpen}
            />;
      case 'mcp':
        return source === 'market'
          ? <ConnectorCatalog
              searchQuery={extensionsSearchQuery}
              // 「添加」 does not add: a catalog entry's env carries key names
              // with empty values, so it hands the config to 「我的」's form for
              // the user to complete.
              onPrefillAdd={(entry) => {
                setMcpPrefill(entry);
                setSource('mcp', 'mine');
                setMcpAddFormOpen(true);
              }}
              // 「管理」 lands in the per-server editor, which lives in 「我的」.
              onManage={(name) => {
                setMcpFocusServer(name);
                setSource('mcp', 'mine');
              }}
            />
          : <MCPSection
              sourceFilter="mine"
              showAddForm={mcpAddFormOpen}
              onAddFormChange={(open) => {
                setMcpAddFormOpen(open);
                // Withdraw the offer with the form it filled: a template-sourced
                // connector closes this form and opens its own installer, and a
                // stale prefill would re-fire on the next 「添加」.
                if (!open) setMcpPrefill(null);
              }}
              prefill={mcpPrefill}
              focusServer={mcpFocusServer}
            />;
      default:
        return null;
    }
  };

  // Header-right control: always a search box, plus a per-tab create control.
  // 「市场」 is somebody else's catalog on every tab — Abu's or the
  // organization's — so 创建/导入 belongs to 「我的」 and only there.
  const renderHeaderRight = () => {
    const searchBox = (
      <div className="relative w-52 shrink-0">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--abu-text-tertiary)] pointer-events-none" />
        <Input
          type="text"
          placeholder={t.toolbox.searchPlaceholder}
          value={extensionsSearchQuery}
          onChange={(e) => setExtensionsSearchQuery(e.target.value)}
          className="h-8 pl-8 pr-3 text-body"
        />
      </div>
    );

    let createControl: ReactNode = null;
    if (source === 'mine' && activeTab === 'skills') {
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
    } else if (source === 'mine' && activeTab === 'mcp') {
      createControl = <ToolboxCreateMenu onClick={() => setMcpAddFormOpen(true)} />;
    }
    // activeTab === 'plugins' → no header create control: what you add there is
    // a marketplace, not a plugin, and that entry lives inside 「市场」 (and in
    // its empty state) where the markets themselves are listed.

    return <>{searchBox}{createControl}</>;
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

      {/* 市场 | 我的 — the same split on every tab, so it sits above the panel
          rather than inside any one of them. Padded like TopTabNav's row and
          the panels below so all three left edges line up. */}
      <div className="shrink-0 px-8">
        <div className="mx-auto max-w-5xl">
          <SourceSubNav
            value={source}
            onChange={(next) => setSource(activeTab, next)}
            marketLabel={t.toolbox.sourceMarket}
            mineLabel={t.toolbox.sourceMine}
            panelId={SOURCE_PANEL_ID}
          />
        </div>
      </div>

      {/* Content */}
      <div id={SOURCE_PANEL_ID} role="tabpanel" className="flex-1 overflow-hidden">
        {renderContent()}
      </div>
    </div>
  );
}
