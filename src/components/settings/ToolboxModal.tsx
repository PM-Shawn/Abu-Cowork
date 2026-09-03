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
import CapabilityScopeToggle, { type CapabilityScope } from '@/components/toolbox/CapabilityScopeToggle';
import PluginsTab from '@/components/toolbox/plugins/PluginsTab';
import { Input } from '@/components/ui/input';

// Enterprise plugin/skill/MCP tab implementations are registered by the
// enterprise-modules entry point (real impls in the enterprise build, no-op in
// the OSS build). The consumers below read them via getEnterpriseMount(), which
// returns a NullComponent fallback when unregistered — so the OSS build never
// imports enterprise UI directly.

/**
 * The Extensions view (sidebar 「扩展」): 插件 / 技能 / 连接器, driven directly by
 * the settings store's `activeExtensionsTab`. Agents are not managed here —
 * they belong to the Team view's 「队员」 tab.
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
  const [skillUploadModalOpen, setSkillUploadModalOpen] = useState(false);
  const [manualCreateTrigger, setManualCreateTrigger] = useState(0);
  const [capabilityScope, setCapabilityScope] = useState<CapabilityScope>('personal');

  // Reset manual-create trigger and clear search when the tab or scope
  // CHANGES — not on first paint. A deep link (SkillProposalCard →
  // openExtensions('skills') + setExtensionsSearchQuery(name)) sets the query
  // right before this view mounts; clearing on mount would wipe it.
  const lastTabScope = useRef<{ tab: ExtensionsTab; scope: CapabilityScope }>({ tab: activeTab, scope: capabilityScope });
  useEffect(() => {
    const last = lastTabScope.current;
    if (last.tab === activeTab && last.scope === capabilityScope) return;
    lastTabScope.current = { tab: activeTab, scope: capabilityScope };
    setManualCreateTrigger(0);
    setExtensionsSearchQuery('');
  }, [activeTab, capabilityScope, setExtensionsSearchQuery]);

  useEffect(() => {
    if (!isEnterprise) setCapabilityScope('personal');
  }, [isEnterprise]);

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

    switch (activeTab) {
      // Plugins own their sub-navigation (installed / marketplace) and the
      // install-disclosure flow; the shared header search box feeds both.
      case 'plugins': {
        if (isEnterprise && capabilityScope === 'organization') {
          if (!binding) return null;
          const PluginTab = getEnterpriseMount('pluginTab');
          if (!PluginTab) return null;
          return <PluginTab binding={binding} config={config} searchQuery={extensionsSearchQuery} />;
        }
        return <PluginsTab searchQuery={extensionsSearchQuery} />;
      }
      case 'skills': {
        if (isEnterprise && capabilityScope === 'organization') {
          if (!binding) return null;
          const SkillTab = getEnterpriseMount('skillTab');
          return <SkillTab binding={binding} config={config} searchQuery={extensionsSearchQuery} />;
        }
        return <SkillsSection
          manualCreateTrigger={manualCreateTrigger}
          showUploadModal={skillUploadModalOpen}
          onUploadModalChange={setSkillUploadModalOpen}
        />;
      }
      case 'mcp': {
        if (isEnterprise && capabilityScope === 'organization') {
          if (!binding) return null;
          const McpTab = getEnterpriseMount('mcpTab');
          return <McpTab binding={binding} config={config} searchQuery={extensionsSearchQuery} />;
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
          value={extensionsSearchQuery}
          onChange={(e) => setExtensionsSearchQuery(e.target.value)}
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
    // activeTab === 'plugins' → no header create control: "add marketplace"
    // only makes sense on the marketplace sub-tab, which PluginsTab owns, so
    // the button lives there (and in its empty state) instead of here.

    return <>{scopeControl}{searchBox}{createControl}</>;
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

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {renderContent()}
      </div>
    </div>
  );
}
