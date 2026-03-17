import { useState, useEffect, useMemo } from 'react';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useChatStore } from '@/stores/chatStore';
import { useI18n } from '@/i18n';
import { skillTemplates } from '@/data/marketplace/skills';
import { skillLoader } from '@/core/skill/loader';
import SkillEditor from './SkillEditor';
import { Toggle } from '@/components/ui/toggle';
import { Trash2, FileText, Folder, ChevronDown, ChevronRight, Pencil, MoreHorizontal, Eye, Code, Info, MessageCircle, Search, Plus, X, Wand2, PenLine, Upload, Download, Package, Loader2, Check, AlertCircle } from 'lucide-react';
import { remove } from '@tauri-apps/plugin-fs';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import { packSkill } from '@/core/skill/packager';
import { installSkillFromNpm, NpmInstallError } from '@/core/skill/npmInstaller';
import type { InstallStep } from '@/core/skill/npmInstaller';
import { useToastStore } from '@/stores/toastStore';
import { getParentDir } from '@/utils/pathUtils';
import { Input } from '@/components/ui/input';
import { format } from '@/i18n';
import type { Skill } from '@/types';
import MarkdownRenderer from '@/components/chat/MarkdownRenderer';

// Build a set of system skill names from marketplace templates
const systemSkillNames = new Set(
  skillTemplates.filter((t) => t.isBuiltin).map((t) => t.name)
);

function isSystemSkill(skill: Skill): boolean {
  return skill.filePath.includes('builtin-skills') || systemSkillNames.has(skill.name);
}

/** Build a tree structure from flat file paths */
interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
  children: FileNode[];
}

function buildFileTree(files: string[]): FileNode[] {
  const root: FileNode[] = [];

  for (const filePath of files) {
    const parts = filePath.split('/');
    let current = root;
    let accPath = '';

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      accPath = accPath ? `${accPath}/${part}` : part;
      const isLast = i === parts.length - 1;

      let existing = current.find((n) => n.name === part);
      if (!existing) {
        existing = { name: part, path: accPath, isDir: !isLast, children: [] };
        current.push(existing);
      }
      current = existing.children;
    }
  }

  // Sort: directories first, then files, alphabetically within each group
  const sortNodes = (nodes: FileNode[]) => {
    nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    nodes.forEach((n) => { if (n.children.length) sortNodes(n.children); });
  };
  sortNodes(root);

  return root;
}

/** Recursive file tree item */
function FileTreeItem({
  node, depth = 0, selectedFile, onFileClick,
}: {
  node: FileNode; depth?: number;
  selectedFile?: string | null;
  onFileClick?: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const ml = 52 + depth * 16;

  if (node.isDir) {
    return (
      <div className="mb-0.5">
        <div
          className="flex items-center gap-2 py-1.5 mx-2 px-3 rounded-md cursor-pointer hover:bg-[#f0ede6]/60 text-[#888579] hover:text-[#29261b] text-[13px] transition-colors"
          style={{ marginLeft: ml }}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
          <Folder className="h-3.5 w-3.5 shrink-0 text-[#888579]" />
          <span className="truncate">{node.name}</span>
        </div>
        {expanded && node.children.map((child) => (
          <FileTreeItem key={child.path} node={child} depth={depth + 1} selectedFile={selectedFile} onFileClick={onFileClick} />
        ))}
      </div>
    );
  }

  const isActive = selectedFile === node.path;
  return (
    <div
      className={`flex items-center gap-2 py-1.5 mx-2 px-3 mb-0.5 rounded-md cursor-pointer text-[13px] transition-colors ${
        isActive ? 'bg-[#f0ede6] text-[#29261b]' : 'text-[#888579] hover:bg-[#f0ede6]/60 hover:text-[#29261b]'
      }`}
      style={{ marginLeft: ml }}
      onClick={() => onFileClick?.(node.path)}
    >
      <span className="truncate">{node.name}</span>
    </div>
  );
}

interface SkillsSectionProps {
  manualCreateTrigger?: number;
  onAICreate?: () => void;
  onManualCreate?: () => void;
  onUploadFile?: () => void;
}

export default function SkillsSection({ manualCreateTrigger, onAICreate, onManualCreate, onUploadFile }: SkillsSectionProps) {
  const { skills, refresh } = useDiscoveryStore();
  const { toolboxSearchQuery, setToolboxSearchQuery, disabledSkills, toggleSkillEnabled, closeToolbox } = useSettingsStore();
  const startNewConversation = useChatStore((s) => s.startNewConversation);
  const setPendingInput = useChatStore((s) => s.setPendingInput);
  const { t } = useI18n();

  const [installedSkills, setInstalledSkills] = useState<Skill[]>([]);
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
  const [expandedSkills, setExpandedSkills] = useState<Set<string>>(new Set());
  const [supportingFiles, setSupportingFiles] = useState<Record<string, string[]>>({});
  const [editorSkill, setEditorSkill] = useState<Skill | 'new' | null>(null);
  const [menuSkill, setMenuSkill] = useState<string | null>(null);
  // Selected file within skill tree: null = show skill detail, string = show file content
  const [selectedFile, setSelectedFile] = useState<{ skillName: string; path: string } | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  // Category collapse state
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  // Search & create UI state
  const [showSearch, setShowSearch] = useState(false);
  const [showCreateMenu, setShowCreateMenu] = useState(false);
  // Content view mode: preview (rendered) or source (raw)
  const [contentViewMode, setContentViewMode] = useState<'preview' | 'source'>('preview');
  // npm install dialog state
  const [showNpmInstall, setShowNpmInstall] = useState(false);
  const [npmPackageName, setNpmPackageName] = useState('');
  const [npmRegistry, setNpmRegistry] = useState('');
  const [npmInstalling, setNpmInstalling] = useState(false);
  const [npmStep, setNpmStep] = useState<InstallStep | null>(null);
  const [npmStepDetail, setNpmStepDetail] = useState('');
  const [npmError, setNpmError] = useState('');
  const [npmSuccess, setNpmSuccess] = useState('');
  const skillRegistryDefault = useSettingsStore((s) => s.skillRegistry);

  // Open blank editor when manual create is triggered from parent
  useEffect(() => {
    if (manualCreateTrigger && manualCreateTrigger > 0) {
      setEditorSkill('new');
    }
  }, [manualCreateTrigger]);

  // Load full skill details
  useEffect(() => {
    const loadSkillDetails = async () => {
      const fullSkills: Skill[] = [];
      for (const meta of skills) {
        const full = skillLoader.getSkill(meta.name);
        if (full) fullSkills.push(full);
      }
      setInstalledSkills(fullSkills);
      // Auto-select first skill if none selected
      if (!selectedSkill && fullSkills.length > 0) {
        setSelectedSkill(fullSkills[0].name);
      }
    };
    loadSkillDetails();
  }, [skills]);

  const disabledSet = useMemo(() => new Set(disabledSkills), [disabledSkills]);

  // Filter by search
  const searchLower = toolboxSearchQuery.toLowerCase();
  const filteredSkills = useMemo(() => {
    if (!toolboxSearchQuery) return installedSkills;
    return installedSkills.filter((s) => {
      const tagStr = (s.tags ?? []).join(' ').toLowerCase();
      return s.name.toLowerCase().includes(searchLower) ||
        s.description.toLowerCase().includes(searchLower) ||
        tagStr.includes(searchLower);
    });
  }, [installedSkills, searchLower]);

  // Group into "My skills" (user-created) and "Examples" (system builtin)
  const { userSkills, exampleSkills } = useMemo(() => {
    const user: Skill[] = [];
    const examples: Skill[] = [];
    for (const s of filteredSkills) {
      if (isSystemSkill(s)) {
        examples.push(s);
      } else {
        user.push(s);
      }
    }
    return { userSkills: user, exampleSkills: examples };
  }, [filteredSkills]);

  const toggleCategory = (cat: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      return next;
    });
  };

  const selected = installedSkills.find((s) => s.name === selectedSkill) ?? null;

  // Delete a user-installed skill
  const handleDelete = async (skill: Skill) => {
    if (skill.filePath.includes('builtin-skills')) return;
    try {
      const skillDir = getParentDir(skill.filePath);
      await remove(skillDir, { recursive: true });
      if (selectedSkill === skill.name) setSelectedSkill(null);
      await refresh();
    } catch (err) {
      console.error('Failed to delete skill:', err);
    }
  };

  // Export a skill as .askill package
  const handleExport = async (skill: Skill) => {
    const addToast = useToastStore.getState().addToast;
    try {
      const filePath = await saveDialog({
        defaultPath: `${skill.name}.askill`,
        filters: [{ name: 'Skill Package', extensions: ['askill'] }],
      });
      if (!filePath) return;

      const bytes = await packSkill(skill.skillDir);
      await writeFile(filePath, bytes);
      addToast({ type: 'success', title: t.toolbox.exportSuccess, message: `"${skill.name}"` });
    } catch (err) {
      console.error('Export skill failed:', err);
      addToast({ type: 'error', title: t.toolbox.exportFailed, message: String(err) });
    }
  };

  // Handle file click in tree: load content
  const handleFileClick = async (skillName: string, filePath: string) => {
    // If it's SKILL.md, just show the skill detail
    if (filePath === 'SKILL.md') {
      setSelectedFile(null);
      setFileContent(null);
      setSelectedSkill(skillName);
      return;
    }
    setSelectedSkill(skillName);
    setSelectedFile({ skillName, path: filePath });
    const content = await skillLoader.loadSupportingFile(skillName, filePath);
    setFileContent(content);
  };

  // Select skill, toggle its expand, and collapse all others
  const handleSkillClick = (skillName: string) => {
    setSelectedSkill(skillName);
    setSelectedFile(null);
    setFileContent(null);
    setExpandedSkills((prev) => {
      // If already expanded, collapse it; otherwise expand it and collapse others
      if (prev.has(skillName)) {
        return new Set<string>();
      }
      // Load supporting files if needed
      if (!supportingFiles[skillName]) {
        skillLoader.listSupportingFiles(skillName).then((files) => {
          setSupportingFiles((p) => ({ ...p, [skillName]: files }));
        });
      }
      return new Set([skillName]);
    });
  };

  // npm install handler
  const handleNpmInstall = async (overwrite = false) => {
    if (!npmPackageName.trim()) return;
    setNpmInstalling(true);
    setNpmError('');
    setNpmSuccess('');
    setNpmStep(null);

    const registry = npmRegistry.trim() || skillRegistryDefault || undefined;
    const addToast = useToastStore.getState().addToast;

    try {
      const result = await installSkillFromNpm(
        npmPackageName.trim(),
        registry,
        {
          overwrite,
          onProgress: (step: InstallStep, detail?: string) => {
            setNpmStep(step);
            setNpmStepDetail(detail ?? '');
          },
        },
      );
      await refresh();
      setNpmSuccess(result.skillName);
      setSelectedSkill(result.skillName);
      addToast({ type: 'success', title: format(t.toolbox.npmInstallSuccess, { name: result.skillName }) });
    } catch (err) {
      if (err instanceof NpmInstallError && err.code === 'ALREADY_EXISTS') {
        setNpmError('ALREADY_EXISTS');
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        setNpmError(msg);
        addToast({ type: 'error', title: t.toolbox.npmInstallFailed, message: msg });
      }
    } finally {
      setNpmInstalling(false);
    }
  };

  const resetNpmDialog = () => {
    setShowNpmInstall(false);
    setNpmPackageName('');
    setNpmRegistry('');
    setNpmError('');
    setNpmSuccess('');
    setNpmStep(null);
    setNpmInstalling(false);
  };

  // Close menus when clicking outside
  useEffect(() => {
    if (!menuSkill && !showCreateMenu) return;
    const handleClick = () => { setMenuSkill(null); setShowCreateMenu(false); };
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [menuSkill, showCreateMenu]);

  const renderSkillRow = (skill: Skill) => {
    const isSelected = selectedSkill === skill.name;
    const isExpanded = expandedSkills.has(skill.name);
    const files = supportingFiles[skill.name] ?? [];
    const fileTree = isExpanded ? buildFileTree(files) : [];
    const isEnabled = !disabledSet.has(skill.name);
    // Skill row only highlights when selected AND not drilling into child files
    const isRowActive = isSelected && !selectedFile && !isExpanded;

    return (
      <div key={skill.name} className="mb-0.5">
        <div
          className={`flex items-center gap-3 mx-2 pl-7 pr-3 py-2.5 rounded-lg cursor-pointer transition-colors ${
            isRowActive ? 'bg-[#f0ede6]' : 'hover:bg-[#f0ede6]/60'
          }`}
          onClick={() => handleSkillClick(skill.name)}
        >
          <FileText className={`h-4 w-4 shrink-0 ${!isEnabled ? 'text-[#b5b0a6]' : 'text-[#888579]'}`} />
          <span className={`text-sm flex-1 truncate ${
            !isEnabled ? 'text-[#b5b0a6]' : isSelected ? 'text-[#29261b] font-medium' : 'text-[#656358]'
          }`}>
            {skill.name}
          </span>
          <div className="p-0.5 text-[#888579]">
            {isExpanded
              ? <ChevronDown className="h-3.5 w-3.5" />
              : <ChevronRight className="h-3.5 w-3.5" />
            }
          </div>
        </div>
        {isExpanded && (
          <div className="py-0.5">
            <div
              className={`flex items-center gap-2 py-1.5 mx-2 px-3 mb-0.5 rounded-md cursor-pointer text-[13px] transition-colors ${
                selectedSkill === skill.name && !selectedFile
                  ? 'bg-[#f0ede6] text-[#29261b]'
                  : 'text-[#888579] hover:bg-[#f0ede6]/60 hover:text-[#29261b]'
              }`}
              style={{ marginLeft: 52 }}
              onClick={() => handleFileClick(skill.name, 'SKILL.md')}
            >
              <span>SKILL.md</span>
            </div>
            {fileTree.map((node) => (
              <FileTreeItem
                key={node.path}
                node={node}
                selectedFile={selectedFile?.skillName === skill.name ? selectedFile.path : null}
                onFileClick={(path) => handleFileClick(skill.name, path)}
              />
            ))}
          </div>
        )}
      </div>
    );
  };

  // If editor is open, show editor full-width
  if (editorSkill !== null) {
    return (
      <SkillEditor
        skill={editorSkill === 'new' ? null : editorSkill}
        onClose={() => setEditorSkill(null)}
        onSave={async () => { await refresh(); setEditorSkill(null); }}
      />
    );
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left: Skill list with file trees */}
      <div className="w-[340px] shrink-0 border-r border-[#e8e4dd]/60 flex flex-col overflow-hidden bg-[#faf8f5]">
        {/* Header: Title + Search + Create */}
        <div className="shrink-0 px-4 pt-4 pb-3 border-b border-[#e8e4dd]/60">
          {showSearch ? (
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[#656358]" />
              <input
                autoFocus
                type="text"
                placeholder={t.toolbox.searchPlaceholder}
                value={toolboxSearchQuery}
                onChange={(e) => setToolboxSearchQuery(e.target.value)}
                onBlur={() => { if (!toolboxSearchQuery) setShowSearch(false); }}
                onKeyDown={(e) => { if (e.key === 'Escape') { setToolboxSearchQuery(''); setShowSearch(false); } }}
                className="w-full pl-7 pr-7 py-1 text-sm border border-[#e8e4dd] rounded-md bg-white focus:outline-none focus:ring-1 focus:ring-[#d97757]/30 text-[#29261b]"
              />
              <button
                onClick={() => { setToolboxSearchQuery(''); setShowSearch(false); }}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[#656358] hover:text-[#29261b]"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <span className="text-base font-semibold text-[#29261b]">{t.toolbox.skills}</span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setShowSearch(true)}
                  className="p-1 text-[#888579] hover:text-[#29261b] transition-colors"
                >
                  <Search className="h-3.5 w-3.5" />
                </button>
                <div className="relative">
                  <button
                    onClick={(e) => { e.stopPropagation(); setShowCreateMenu(!showCreateMenu); }}
                    className="p-1 text-[#888579] hover:text-[#29261b] transition-colors"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                  {showCreateMenu && (
                    <div className="absolute z-50 top-full right-0 mt-1 w-44 bg-white rounded-lg shadow-lg border border-[#e8e4dd] py-1">
                      {onAICreate && (
                        <button
                          onClick={() => { setShowCreateMenu(false); onAICreate(); }}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[#29261b] hover:bg-[#f0ede6] transition-colors"
                        >
                          <Wand2 className="h-3.5 w-3.5 text-[#d97757]" />
                          <span>{t.toolbox.createWithAbu}</span>
                        </button>
                      )}
                      {onManualCreate && (
                        <button
                          onClick={() => { setShowCreateMenu(false); onManualCreate(); }}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[#29261b] hover:bg-[#f0ede6] transition-colors"
                        >
                          <PenLine className="h-3.5 w-3.5 text-[#888579]" />
                          <span>{t.toolbox.createManually}</span>
                        </button>
                      )}
                      {onUploadFile && (
                        <button
                          onClick={() => { setShowCreateMenu(false); onUploadFile(); }}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[#29261b] hover:bg-[#f0ede6] transition-colors"
                        >
                          <Upload className="h-3.5 w-3.5 text-[#888579]" />
                          <span>{t.toolbox.uploadFile}</span>
                        </button>
                      )}
                      <button
                        onClick={() => { setShowCreateMenu(false); setShowNpmInstall(true); }}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[#29261b] hover:bg-[#f0ede6] transition-colors"
                      >
                        <Package className="h-3.5 w-3.5 text-[#888579]" />
                        <span>{t.toolbox.installFromNpm}</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
        <div className="flex-1 overflow-y-auto overlay-scroll py-2">
          {filteredSkills.length === 0 ? (
            <div className="text-xs text-[#888579] py-8 text-center">{t.toolbox.noSkillsFound}</div>
          ) : (
            <>
              {/* My skills */}
              {userSkills.length > 0 && (
                <div>
                  <div
                    className="flex items-center gap-1.5 px-5 py-2.5 cursor-pointer text-[#888579] hover:text-[#29261b]"
                    onClick={() => toggleCategory('my')}
                  >
                    {collapsedCategories.has('my')
                      ? <ChevronRight className="h-3 w-3" />
                      : <ChevronDown className="h-3 w-3" />
                    }
                    <span className="text-[13px] font-medium">{t.toolbox.mySkills}</span>
                  </div>
                  {!collapsedCategories.has('my') && userSkills.map((skill) => renderSkillRow(skill))}
                </div>
              )}
              {/* Examples (system builtin) */}
              {exampleSkills.length > 0 && (
                <div>
                  <div
                    className="flex items-center gap-1.5 px-5 py-2.5 cursor-pointer text-[#888579] hover:text-[#29261b]"
                    onClick={() => toggleCategory('examples')}
                  >
                    {collapsedCategories.has('examples')
                      ? <ChevronRight className="h-3 w-3" />
                      : <ChevronDown className="h-3 w-3" />
                    }
                    <span className="text-[13px] font-medium">{t.toolbox.exampleSkills}</span>
                  </div>
                  {!collapsedCategories.has('examples') && exampleSkills.map((skill) => renderSkillRow(skill))}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Right: Skill detail or file content */}
      <div className="flex-1 overflow-y-auto overlay-scroll bg-white">
        {selected ? (
          selectedFile ? (
            /* Show selected file content */
            <div className="px-6 py-6">
              <div className="flex items-center gap-2 mb-4">
                <button
                  className="text-xs text-[#888579] hover:text-[#29261b] transition-colors"
                  onClick={() => { setSelectedFile(null); setFileContent(null); }}
                >
                  {selected.name}
                </button>
                <span className="text-xs text-[#888579]">/</span>
                <span className="text-sm font-medium text-[#29261b]">{selectedFile.path}</span>
              </div>
              <div className="border border-[#e8e4dd] rounded-lg overflow-hidden">
                <div className="px-5 py-4 bg-[#faf8f5]">
                  {fileContent !== null ? (
                    selectedFile.path.endsWith('.md') ? (
                      <MarkdownRenderer content={fileContent} />
                    ) : (
                      <pre className="text-xs text-[#29261b] whitespace-pre-wrap break-all font-mono leading-relaxed">{fileContent}</pre>
                    )
                  ) : (
                    <div className="text-sm text-[#888579]">Loading...</div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            /* Show skill detail */
            <div className="px-6 py-6">
              {/* Row 1: Name + Toggle + Menu */}
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-semibold text-[#29261b]">{selected.name}</h2>
                <div className="flex items-center gap-2">
                  <Toggle
                    checked={!disabledSet.has(selected.name)}
                    onChange={() => toggleSkillEnabled(selected.name)}
                  />
                  {/* "..." menu: export always available; user skills also have edit/delete */}
                  <div className="relative">
                      <button
                        onClick={(e) => { e.stopPropagation(); setMenuSkill(menuSkill === selected.name ? null : selected.name); }}
                        className="p-1.5 rounded-lg text-[#656358] hover:text-[#29261b] hover:bg-[#f5f3ee] transition-colors"
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </button>
                      {menuSkill === selected.name && (
                        <div className="absolute right-0 top-8 z-10 bg-white border border-[#e8e4dd] rounded-lg shadow-lg py-1 min-w-[140px]">
                          {/* Try in chat - only when enabled */}
                          {!disabledSet.has(selected.name) && (
                            <button
                              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[#29261b] hover:bg-[#f5f3ee] transition-colors"
                              onClick={() => {
                                setMenuSkill(null);
                                startNewConversation();
                                setPendingInput(`/${selected.name} `);
                                closeToolbox();
                              }}
                            >
                              <MessageCircle className="h-3 w-3" />
                              {t.toolbox.skillTryInChat}
                            </button>
                          )}
                          {/* Export - available for all skills */}
                          <button
                            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[#29261b] hover:bg-[#f5f3ee] transition-colors"
                            onClick={() => { handleExport(selected); setMenuSkill(null); }}
                          >
                            <Download className="h-3 w-3" />
                            {t.toolbox.exportSkill}
                          </button>
                          {/* Edit & Delete - only for user skills */}
                          {!isSystemSkill(selected) && (
                            <>
                              <button
                                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[#29261b] hover:bg-[#f5f3ee] transition-colors"
                                onClick={() => { setEditorSkill(selected); setMenuSkill(null); }}
                              >
                                <Pencil className="h-3 w-3" />
                                {t.toolbox.skillEdit}
                              </button>
                              <button
                                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 transition-colors"
                                onClick={() => { handleDelete(selected); setMenuSkill(null); }}
                              >
                                <Trash2 className="h-3 w-3" />
                                {t.toolbox.uninstall}
                              </button>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                </div>
              </div>

              {/* Row 2: Added by */}
              <div className="mb-5">
                <div className="text-xs text-[#888579] mb-0.5">{t.toolbox.skillAddedBy}</div>
                <div className="text-sm font-medium text-[#29261b]">{isSystemSkill(selected) ? 'Anthropic' : 'User'}</div>
              </div>

              {/* Description */}
              <div className="flex items-center gap-1 mb-1.5">
                <span className="text-xs text-[#888579]">Description</span>
                <Info className="h-3 w-3 text-[#888579]/60" />
              </div>
              <p className="text-sm text-[#29261b] leading-relaxed mb-7">{selected.description}</p>

              {/* Content area: License + SKILL.md with preview/source toggle */}
              <div className="border border-[#e8e4dd] rounded-lg overflow-hidden">
                {/* Toggle bar */}
                <div className="flex items-center justify-end gap-1.5 px-4 py-2.5 bg-[#faf8f5] border-b border-[#e8e4dd]/60">
                  <button
                    onClick={() => setContentViewMode('preview')}
                    className={`p-1.5 rounded transition-colors ${contentViewMode === 'preview' ? 'text-[#29261b] bg-[#eae7e0]' : 'text-[#888579] hover:text-[#29261b]'}`}
                    title="Preview"
                  >
                    <Eye className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => setContentViewMode('source')}
                    className={`p-1.5 rounded transition-colors ${contentViewMode === 'source' ? 'text-[#29261b] bg-[#eae7e0]' : 'text-[#888579] hover:text-[#29261b]'}`}
                    title="Source"
                  >
                    <Code className="h-4 w-4" />
                  </button>
                </div>
                <div className="px-6 py-5 bg-[#faf8f5]">
                  {contentViewMode === 'preview' ? (
                    <MarkdownRenderer content={selected.content} />
                  ) : (
                    <pre className="text-xs text-[#29261b] whitespace-pre-wrap break-words font-mono leading-relaxed">{selected.content}</pre>
                  )}
                </div>
              </div>
            </div>
          )
        ) : (
          <div className="flex items-center justify-center h-full text-sm text-[#888579]">
            {t.toolbox.noSkillsFound}
          </div>
        )}
      </div>

      {/* npm install dialog */}
      {showNpmInstall && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
          <div className="w-[420px] bg-white rounded-xl shadow-xl border border-[#e8e4dd] overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-[#e8e4dd]/60">
              <div className="flex items-center gap-2">
                <Package className="h-4 w-4 text-[#d97757]" />
                <h2 className="text-sm font-semibold text-[#29261b]">{t.toolbox.installFromNpm}</h2>
              </div>
              <button onClick={resetNpmDialog} className="p-1.5 rounded-lg text-[#888579] hover:text-[#29261b] hover:bg-[#f5f3ee] transition-colors">
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Body */}
            <div className="px-5 py-4 space-y-3">
              {/* Package name */}
              <div>
                <label className="block text-xs font-medium text-[#29261b]/70 mb-1">{t.toolbox.npmPackageName}</label>
                <Input
                  type="text"
                  placeholder={t.toolbox.npmPackagePlaceholder}
                  value={npmPackageName}
                  onChange={(e) => { setNpmPackageName(e.target.value); setNpmError(''); setNpmSuccess(''); }}
                  disabled={npmInstalling}
                />
              </div>

              {/* Registry (optional) */}
              <div>
                <label className="block text-xs font-medium text-[#29261b]/70 mb-1">{t.toolbox.npmRegistry}</label>
                <Input
                  type="text"
                  placeholder={skillRegistryDefault || t.toolbox.npmRegistryPlaceholder}
                  value={npmRegistry}
                  onChange={(e) => setNpmRegistry(e.target.value)}
                  disabled={npmInstalling}
                />
                <p className="text-[11px] text-[#888579] mt-1">{t.toolbox.npmRegistryHint}</p>
              </div>

              {/* Progress */}
              {npmInstalling && npmStep && (
                <div className="flex items-center gap-2 py-2 px-3 bg-[#faf8f5] rounded-lg">
                  <Loader2 className="h-3.5 w-3.5 text-[#d97757] animate-spin shrink-0" />
                  <span className="text-xs text-[#656358]">
                    {npmStep === 'fetching_metadata' && t.toolbox.npmStepFetchingMetadata}
                    {npmStep === 'downloading' && format(t.toolbox.npmStepDownloading, { version: npmStepDetail })}
                    {npmStep === 'extracting' && t.toolbox.npmStepExtracting}
                    {npmStep === 'installing' && format(t.toolbox.npmStepInstalling, { name: npmStepDetail })}
                  </span>
                </div>
              )}

              {/* Success */}
              {npmSuccess && (
                <div className="flex items-center gap-2 py-2 px-3 bg-green-50 rounded-lg">
                  <Check className="h-3.5 w-3.5 text-green-600 shrink-0" />
                  <span className="text-xs text-green-700">{format(t.toolbox.npmInstallSuccess, { name: npmSuccess })}</span>
                </div>
              )}

              {/* Error */}
              {npmError && npmError !== 'ALREADY_EXISTS' && (
                <div className="flex items-start gap-2 py-2 px-3 bg-red-50 rounded-lg">
                  <AlertCircle className="h-3.5 w-3.5 text-red-500 shrink-0 mt-0.5" />
                  <span className="text-xs text-red-600">{npmError}</span>
                </div>
              )}

              {/* Already exists — offer overwrite */}
              {npmError === 'ALREADY_EXISTS' && (
                <div className="flex items-center justify-between py-2 px-3 bg-amber-50 rounded-lg">
                  <div className="flex items-center gap-2">
                    <AlertCircle className="h-3.5 w-3.5 text-amber-600 shrink-0" />
                    <span className="text-xs text-amber-700">{format(t.toolbox.npmAlreadyExists, { name: npmPackageName.trim() })}</span>
                  </div>
                  <button
                    onClick={() => { setNpmError(''); handleNpmInstall(true); }}
                    className="text-xs font-medium text-[#d97757] hover:text-[#c5664a] transition-colors"
                  >
                    {t.toolbox.npmOverwrite}
                  </button>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[#e8e4dd]/60">
              <button onClick={resetNpmDialog} className="px-4 py-1.5 rounded-lg text-sm font-medium text-[#656358] hover:bg-[#f5f3ee] transition-colors">
                {npmSuccess ? t.common.close : t.common.cancel}
              </button>
              {!npmSuccess && (
                <button
                  onClick={() => handleNpmInstall()}
                  disabled={!npmPackageName.trim() || npmInstalling}
                  className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium bg-[#d97757] text-white hover:bg-[#c5664a] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {npmInstalling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Package className="h-3.5 w-3.5" />}
                  {t.toolbox.npmFindAndInstall}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
