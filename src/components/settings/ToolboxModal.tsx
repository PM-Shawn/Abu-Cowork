import { useEffect, useState } from 'react';
import { useSettingsStore, type ToolboxTab } from '@/stores/settingsStore';
import { useChatStore } from '@/stores/chatStore';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useI18n } from '@/i18n';
import { Sparkles, Bot, Server, ArrowLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { readTextFile, readFile, writeTextFile, mkdir } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import { joinPath, normalizeSeparators } from '@/utils/pathUtils';
import { ITEM_NAME_RE } from '@/utils/validation';
import { validateArchive, unpackSkill, ConflictError } from '@/core/skill/packager';
import { useToastStore } from '@/stores/toastStore';
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

  // Handler for uploading a file (Skills/Agents)
  const handleUploadFile = async () => {
    const isAgent = activeToolboxTab === 'agents';
    const expectedFileName = isAgent ? 'AGENT.md' : 'SKILL.md';
    const targetFolder = isAgent ? 'agents' : 'skills';
    const addToast = useToastStore.getState().addToast;

    try {
      const filters = isAgent
        ? [{ name: 'Markdown', extensions: ['md'] }]
        : [
            { name: 'Skill Package', extensions: ['askill', 'zip'] },
            { name: 'Markdown', extensions: ['md'] },
          ];

      const filePath = await openDialog({ filters, multiple: false });

      if (!filePath) return;
      const pathStr = filePath as string;

      // ── .askill / .zip package mode (skills only) ──
      if (!isAgent && (pathStr.endsWith('.askill') || pathStr.endsWith('.zip'))) {
        const bytes = await readFile(pathStr);
        const archiveBytes = new Uint8Array(bytes);

        // Validate
        const error = validateArchive(archiveBytes);
        if (error) {
          addToast({ type: 'error', title: t.toolbox.uploadFailed, message: error.message });
          return;
        }

        // Unpack
        const home = await homeDir();
        const baseDir = joinPath(home, '.abu', targetFolder);
        await mkdir(baseDir, { recursive: true });

        try {
          const result = await unpackSkill(archiveBytes, baseDir);
          await refresh();
          addToast({
            type: 'success',
            title: t.toolbox.uploadSuccess,
            message: `"${result.name}" (${result.files.length} ${t.toolbox.uploadFileCount})`,
          });
        } catch (err) {
          if (err instanceof ConflictError) {
            // Overwrite on conflict (could add a confirm dialog later)
            const result = await unpackSkill(archiveBytes, baseDir, { overwrite: true });
            await refresh();
            addToast({
              type: 'success',
              title: t.toolbox.uploadSuccess,
              message: `"${result.name}" (${result.files.length} ${t.toolbox.uploadFileCount})`,
            });
          } else {
            throw err;
          }
        }
        return;
      }

      // ── Single .md file mode (original logic) ──
      const content = await readTextFile(pathStr);

      // Extract name from parent directory or filename
      const parts = normalizeSeparators(pathStr).split('/');
      const fileName = parts[parts.length - 1];
      let rawName: string;

      if (fileName.toUpperCase() === expectedFileName) {
        rawName = parts[parts.length - 2] || fileName.replace(/\.md$/i, '');
      } else {
        rawName = fileName.replace(/\.md$/i, '');
      }

      // Normalize: lowercase, spaces/underscores → hyphens, strip invalid chars
      const name = rawName
        .toLowerCase()
        .replace(/[\s_]+/g, '-')
        .replace(/[^a-z0-9-]/g, '')
        .replace(/^-+|-+$/g, '');

      if (!name || !ITEM_NAME_RE.test(name)) {
        addToast({ type: 'error', title: t.toolbox.uploadFailed, message: `Invalid skill name: "${rawName}"` });
        return;
      }

      // Write to ~/.abu/{skills|agents}/{name}/{SKILL|AGENT}.md
      const home = await homeDir();
      const targetDir = joinPath(home, '.abu', targetFolder, name);

      await mkdir(targetDir, { recursive: true });

      const targetPath = joinPath(targetDir, expectedFileName);
      await writeTextFile(targetPath, content);

      await refresh();
      addToast({ type: 'success', title: t.toolbox.uploadSuccess, message: `"${name}"` });
    } catch (err) {
      console.error('Upload file failed:', err);
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
      <nav className="w-[180px] shrink-0 border-r border-[#e8e4dd] flex flex-col">
        {/* Back button + Title */}
        <div className="px-4 pt-4 pb-3">
          <button
            onClick={closeToolbox}
            className="flex items-center gap-2 text-sm text-[#29261b] hover:text-[#656358] transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            <span className="text-base font-semibold">{t.toolbox.title}</span>
          </button>
        </div>
        {/* Nav items */}
        <div className="px-3 space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeToolboxTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveToolboxTab(item.id)}
                className={cn(
                  'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors text-left',
                  isActive
                    ? 'bg-white text-[#29261b] shadow-sm'
                    : 'text-[#656358] hover:text-[#29261b] hover:bg-white/50'
                )}
              >
                <Icon className={cn(
                  'h-4 w-4 shrink-0',
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
