import { useEffect } from 'react';
import { useCustomizeStore } from '@/stores/customizeStore';
import { APP_VERSION } from '@/utils/version';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useI18n, format } from '@/i18n';
import { X, Sparkles, Bot, Server, Cpu, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { installSkillFromFolder } from '@/core/skill/installer';
import { installAgentFromFolder } from '@/core/agent/installer';
import { useToastStore } from '@/stores/toastStore';
import SkillsSection from './SkillsSection';
import AgentsSection from './AgentsSection';
import MCPSection from './MCPSection';
import ModelsSection from './ModelsSection';

type TabId = 'skills' | 'agents' | 'mcp' | 'models';

export default function CustomizePanel() {
  const { showCustomize, activeTab, setActiveTab, closeCustomize, searchQuery, setSearchQuery } =
    useCustomizeStore();
  const refresh = useDiscoveryStore((s) => s.refresh);
  const { t } = useI18n();

  const tabs: { id: TabId; label: string; icon: typeof Sparkles }[] = [
    { id: 'skills', label: t.toolbox.skills, icon: Sparkles },
    { id: 'agents', label: t.toolbox.agents, icon: Bot },
    { id: 'mcp', label: t.toolbox.mcp, icon: Server },
    { id: 'models', label: t.toolbox.models, icon: Cpu },
  ];

  // Refresh skills/agents when panel opens
  useEffect(() => {
    if (showCustomize) {
      refresh();
    }
  }, [showCustomize, refresh]);

  const handleUploadFolder = async (type: 'skills' | 'agents') => {
    const addToast = useToastStore.getState().addToast;
    try {
      const folderPath = await openDialog({ directory: true, multiple: false });
      if (!folderPath) return;

      const result = type === 'agents'
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

  if (!showCustomize) return null;

  const renderContent = () => {
    switch (activeTab) {
      case 'skills':
        return <SkillsSection onUploadFile={() => handleUploadFolder('skills')} />;
      case 'agents':
        return <AgentsSection onUploadFile={() => handleUploadFolder('agents')} />;
      case 'mcp':
        return <MCPSection />;
      case 'models':
        return <ModelsSection />;
      default:
        return null;
    }
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/20 z-40 backdrop-blur-sm"
        onClick={closeCustomize}
      />

      {/* Panel */}
      <div className="fixed right-0 top-0 bottom-0 w-[420px] bg-[#faf9f7] shadow-2xl z-50 flex flex-col animate-slide-in-right">
        {/* Header */}
        <div className="shrink-0 px-5 pt-5 pb-4 border-b border-neutral-200">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-[#d97757]/10 flex items-center justify-center">
                <Sparkles className="h-4 w-4 text-[#d97757]" />
              </div>
              <h2 className="text-lg font-semibold text-neutral-900">{t.toolbox.customize}</h2>
            </div>
            <button
              onClick={closeCustomize}
              className="p-1.5 text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 rounded-md transition-colors"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Tabs */}
          <div className="flex gap-1 p-1 bg-neutral-100/80 rounded-lg">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    'flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-md text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-white text-neutral-900 shadow-sm'
                      : 'text-neutral-500 hover:text-neutral-700'
                  )}
                >
                  <Icon className="h-4 w-4" />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </div>

          {/* Search */}
          {(activeTab === 'skills' || activeTab === 'agents' || activeTab === 'mcp') && (
            <div className="relative mt-3">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-400" />
              <input
                type="text"
                placeholder={t.toolbox.searchPlaceholder}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-3 py-2 text-sm border border-neutral-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-[#d97757]/30 focus:border-[#d97757]"
              />
            </div>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 min-h-0 overflow-hidden">{renderContent()}</div>

        {/* Footer */}
        <div className="shrink-0 px-5 py-3 border-t border-neutral-200 bg-neutral-50/50">
          <div className="flex items-center justify-between text-xs text-neutral-400">
            <span>{t.toolbox.customizeFooter}</span>
            <span>v{APP_VERSION}</span>
          </div>
        </div>
      </div>

    </>
  );
}
