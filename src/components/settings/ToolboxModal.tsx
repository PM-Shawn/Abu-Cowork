import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useSettingsStore, type ToolboxTab } from '@/stores/settingsStore';
import { useChatStore } from '@/stores/chatStore';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useI18n, format } from '@/i18n';
import { Sparkles, Bot, Server, Search } from 'lucide-react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useToastStore } from '@/stores/toastStore';
import { installSkillFromFolder } from '@/core/skill/installer';
import { installAgentFromFolder } from '@/core/agent/installer';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import { getEnterpriseMount } from '@/core/enterprise/mounts-registry';
import SkillsSection from '../customize/SkillsSection';
import AgentsSection from '../customize/AgentsSection';
import MCPSection from '../customize/MCPSection';
import TopTabNav from '@/components/toolbox/TopTabNav';
import ToolboxCreateMenu from '@/components/toolbox/ToolboxCreateMenu';
import CapabilityScopeToggle, { type CapabilityScope } from '@/components/toolbox/CapabilityScopeToggle';
import { Input } from '@/components/ui/input';
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

  const [mcpAddFormOpen, setMcpAddFormOpen] = useState(false);
  const [skillUploadModalOpen, setSkillUploadModalOpen] = useState(false);
  const [manualCreateTrigger, setManualCreateTrigger] = useState(0);
  const [capabilityScope, setCapabilityScope] = useState<CapabilityScope>('personal');

  // Reset manual-create trigger and clear search when switching tabs
  useEffect(() => {
    setManualCreateTrigger(0);
    setToolboxSearchQuery('');
  }, [activeToolboxTab, capabilityScope, setToolboxSearchQuery]);

  useEffect(() => {
    if (!isEnterprise) setCapabilityScope('personal');
  }, [isEnterprise]);

  // Handler for creating with AI, adapts to active tab
  const handleAICreate = () => {
    startNewConversation();
    const prompt = activeToolboxTab === 'agents'
      ? t.toolbox.aiCreateAgentPrompt
      : t.toolbox.aiCreateSkillPrompt;
    setPendingInput(prompt);
    closeToolbox();
  };

  // Handler for uploading a folder (Skills/Agents)
  const handleUploadFile = async () => {
    const isAgent = activeToolboxTab === 'agents';
    const addToast = useToastStore.getState().addToast;

    try {
      const folderPath = await openDialog({ directory: true, multiple: false });
      if (!folderPath) return;

      const result = isAgent
        ? await installAgentFromFolder(folderPath as string, { overwrite: true })
        : await installSkillFromFolder(folderPath as string, { overwrite: true });

      if (!result.ok) {
        addToast({ type: 'error', title: t.toolbox.uploadFailed, message: result.message });
        return;
      }

      await refresh();
      addToast({
        type: 'success',
        title: t.toolbox.uploadSuccess,
        message: format(t.toolbox.uploadSuccessDetail, { name: result.name, count: String(result.fileCount) }),
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

  const navItems: { id: ToolboxTab; label: string; icon: typeof Sparkles }[] = [
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

    switch (activeToolboxTab) {
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
    if (activeToolboxTab === 'agents' && (!isEnterprise || capabilityScope === 'personal')) {
      createControl = (
        <ToolboxCreateMenu
          onAICreate={handleAICreate}
          onManualCreate={handleManualCreate}
          onUploadFile={handleUploadFile}
          uploadLabel={t.toolbox.uploadFile}
        />
      );
    } else if (activeToolboxTab === 'skills' && (!isEnterprise || capabilityScope === 'personal')) {
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
    } else if (activeToolboxTab === 'mcp' && (!isEnterprise || capabilityScope === 'personal')) {
      createControl = <ToolboxCreateMenu onClick={() => setMcpAddFormOpen(true)} />;
    }

    return <>{scopeControl}{searchBox}{createControl}</>;
  };

  return (
    <div className="h-full bg-[var(--abu-bg-base)] flex flex-col">
      {/* Content-area header row — tabs left, search + create right. Sits below
          the window's floating title-bar controls (traffic lights / sidebar
          toggle / search / new-task), so it no longer needs the sidebarCollapsed
          horizontal-clearance hack (see TopTabNav's `belowChrome` mode). */}
      <TopTabNav
        items={navItems}
        activeId={activeToolboxTab}
        onSelect={setActiveToolboxTab}
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
