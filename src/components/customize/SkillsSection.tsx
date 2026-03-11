import { useState, useEffect, useMemo } from 'react';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useChatStore } from '@/stores/chatStore';
import { useI18n } from '@/i18n';
import { skillTemplates } from '@/data/marketplace/skills';
import { skillLoader } from '@/core/skill/loader';
import SkillEditor from './SkillEditor';
import { Toggle } from '@/components/ui/toggle';
import { Trash2, File, Folder, ChevronDown, ChevronRight, Pencil, MoreHorizontal, Eye, Code, Info, MessageCircle, Search, Plus, X, Wand2, PenLine, Upload, Download } from 'lucide-react';
import { remove } from '@tauri-apps/plugin-fs';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import { packSkill } from '@/core/skill/packager';
import { useToastStore } from '@/stores/toastStore';
import { getParentDir } from '@/utils/pathUtils';
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
  const basePl = 42 + depth * 16;

  if (node.isDir) {
    return (
      <div>
        <div
          className="flex items-center gap-2 py-1.5 cursor-pointer hover:bg-[#f0ede6] text-[#888579] hover:text-[#29261b] text-[13px]"
          style={{ paddingLeft: basePl }}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
          <Folder className="h-3.5 w-3.5 shrink-0 text-[#d97757]/70" />
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
      className={`flex items-center gap-2 py-1.5 cursor-pointer text-[13px] transition-colors ${
        isActive ? 'bg-[#eae7e0] text-[#29261b]' : 'text-[#888579] hover:bg-[#f0ede6] hover:text-[#29261b]'
      }`}
      style={{ paddingLeft: basePl + 16 }}
      onClick={() => onFileClick?.(node.path)}
    >
      <File className="h-3.5 w-3.5 shrink-0 opacity-50" />
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

  // Load supporting files when a skill is expanded
  const toggleExpanded = async (skillName: string) => {
    const next = new Set(expandedSkills);
    if (next.has(skillName)) {
      next.delete(skillName);
    } else {
      next.add(skillName);
      if (!supportingFiles[skillName]) {
        const files = await skillLoader.listSupportingFiles(skillName);
        setSupportingFiles((prev) => ({ ...prev, [skillName]: files }));
      }
    }
    setExpandedSkills(next);
  };

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
      <div key={skill.name}>
        <div
          className={`flex items-center gap-2.5 pl-7 pr-3 py-2.5 cursor-pointer transition-colors ${
            isRowActive ? 'bg-[#eae7e0]' : 'hover:bg-[#f0ede6]'
          }`}
          onClick={() => handleSkillClick(skill.name)}
        >
          <File className={`h-4 w-4 shrink-0 ${!isEnabled ? 'text-[#b5b0a6]' : 'text-[#888579]'}`} />
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
          <div className="pb-1">
            <div
              className={`flex items-center gap-2 py-1.5 cursor-pointer text-[13px] transition-colors ${
                selectedSkill === skill.name && !selectedFile
                  ? 'bg-[#eae7e0] text-[#29261b]'
                  : 'text-[#888579] hover:bg-[#f0ede6] hover:text-[#29261b]'
              }`}
              style={{ paddingLeft: 56 }}
              onClick={() => handleFileClick(skill.name, 'SKILL.md')}
            >
              <File className="h-3.5 w-3.5 shrink-0 opacity-50" />
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
      <div className="w-[260px] shrink-0 border-r border-[#e8e4dd]/60 flex flex-col overflow-hidden bg-[#faf8f5]">
        {/* Header: Title + Search + Create */}
        <div className="shrink-0 px-3 pt-3 pb-2 border-b border-[#e8e4dd]/60">
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
              <span className="text-sm font-semibold text-[#29261b]">{t.toolbox.skills}</span>
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
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {filteredSkills.length === 0 ? (
            <div className="text-xs text-[#888579] py-8 text-center">{t.toolbox.noSkillsFound}</div>
          ) : (
            <>
              {/* My skills */}
              {userSkills.length > 0 && (
                <div>
                  <div
                    className="flex items-center gap-1.5 px-4 py-2 cursor-pointer text-[#888579] hover:text-[#29261b]"
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
                    className="flex items-center gap-1.5 px-4 py-2 cursor-pointer text-[#888579] hover:text-[#29261b]"
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
      <div className="flex-1 overflow-y-auto bg-white">
        {selected ? (
          selectedFile ? (
            /* Show selected file content */
            <div className="p-6">
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
            <div className="p-6">
              {/* Row 1: Name + Toggle + Menu */}
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-lg font-semibold text-[#29261b]">{selected.name}</h2>
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
              <div className="mb-4">
                <div className="text-xs text-[#888579]">{t.toolbox.skillAddedBy}</div>
                <div className="text-sm text-[#29261b]">{isSystemSkill(selected) ? 'Anthropic' : 'User'}</div>
              </div>

              {/* Description */}
              <div className="flex items-center gap-1 mb-1">
                <span className="text-xs text-[#888579]">Description</span>
                <Info className="h-3 w-3 text-[#888579]/60" />
              </div>
              <p className="text-sm text-[#29261b] mb-5">{selected.description}</p>

              {/* Content area: License + SKILL.md with preview/source toggle */}
              <div className="border border-[#e8e4dd] rounded-lg overflow-hidden">
                {/* Toggle bar */}
                <div className="flex items-center justify-end gap-1 px-3 py-2 bg-[#faf8f5] border-b border-[#e8e4dd]/60">
                  <button
                    onClick={() => setContentViewMode('preview')}
                    className={`p-1 rounded transition-colors ${contentViewMode === 'preview' ? 'text-[#29261b] bg-[#eae7e0]' : 'text-[#888579] hover:text-[#29261b]'}`}
                    title="Preview"
                  >
                    <Eye className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => setContentViewMode('source')}
                    className={`p-1 rounded transition-colors ${contentViewMode === 'source' ? 'text-[#29261b] bg-[#eae7e0]' : 'text-[#888579] hover:text-[#29261b]'}`}
                    title="Source"
                  >
                    <Code className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="px-5 py-4 bg-[#faf8f5]">
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
    </div>
  );
}
