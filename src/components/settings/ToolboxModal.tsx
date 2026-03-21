import { useEffect, useState } from 'react';
import { useSettingsStore, type ToolboxTab } from '@/stores/settingsStore';
import { useChatStore } from '@/stores/chatStore';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useI18n, format } from '@/i18n';
import { Sparkles, Bot, Server, ArrowLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useToastStore } from '@/stores/toastStore';
import { installSkillFromFolder } from '@/core/skill/installer';
import { installAgentFromFolder } from '@/core/agent/installer';
import SkillsSection from '../customize/SkillsSection';
import AgentsSection from '../customize/AgentsSection';
import MCPSection from '../customize/MCPSection';

export default function ToolboxView() {
  const {
    activeToolboxTab,
    closeToolbox,
    setActiveToolboxTab,
    setToolboxSearchQuery,
  } = useSettingsStore();
  const setPendingInput = useChatStore((s) => s.setPendingInput);
  const startNewConversation = useChatStore((s) => s.startNewConversation);
  const refresh = useDiscoveryStore((s) => s.refresh);
  const { t } = useI18n();

  const [mcpAddFormOpen, setMcpAddFormOpen] = useState(false);
  const [manualCreateTrigger, setManualCreateTrigger] = useState(0);

  // Reset manual-create trigger and clear search when switching tabs
  useEffect(() => {
    setManualCreateTrigger(0);
    setToolboxSearchQuery('');
  }, [activeToolboxTab]);

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
    switch (activeToolboxTab) {
      case 'skills':
        return <SkillsSection
          manualCreateTrigger={manualCreateTrigger}
          onAICreate={handleAICreate}
          onManualCreate={handleManualCreate}
          onUploadFile={handleUploadFile}
        />;
      case 'agents':
        return <AgentsSection
          manualCreateTrigger={manualCreateTrigger}
          onAICreate={handleAICreate}
          onManualCreate={handleManualCreate}
          onUploadFile={handleUploadFile}
        />;
      case 'mcp':
        return <MCPSection showAddForm={mcpAddFormOpen} onAddFormChange={setMcpAddFormOpen} />;
      default:
        return null;
    }
  };

  return (
    <div className="h-full bg-[#faf8f5] flex">
      {/* Left Navigation - includes back button */}
      <nav className="w-[260px] shrink-0 border-r border-[#e8e4dd] flex flex-col">
        {/* Back button + Title */}
        <div className="px-5 pt-5 pb-4">
          <button
            onClick={closeToolbox}
            className="flex items-center gap-2.5 text-sm text-[#29261b] hover:text-[#656358] transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            <span className="text-base font-semibold">{t.toolbox.title}</span>
          </button>
        </div>
        {/* Nav items */}
        <div className="px-3 space-y-0.5">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeToolboxTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveToolboxTab(item.id)}
                className={cn(
                  'w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-colors text-left',
                  isActive
                    ? 'bg-white text-[#29261b] shadow-sm'
                    : 'text-[#656358] hover:text-[#29261b] hover:bg-white/50'
                )}
              >
                <Icon className={cn(
                  'h-[18px] w-[18px] shrink-0',
                  isActive ? 'text-[#d97757]' : 'text-[#888579]'
                )} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* Right Content */}
      <div className="flex-1 overflow-hidden">
        {renderContent()}
      </div>
    </div>
  );
}
