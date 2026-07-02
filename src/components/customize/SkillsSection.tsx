import { useState, useEffect, useMemo } from 'react';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import { useSkillDraftsStore } from '@/stores/skillDraftsStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useChatStore } from '@/stores/chatStore';
import { useI18n } from '@/i18n';
import { skillTemplates } from '@/data/marketplace/skills';
import { skillLoader } from '@/core/skill/loader';
import SkillEditor from './SkillEditor';
import SkillDraftsPanel from './SkillDraftsPanel';
import SkillCategoryBlocksPanel from './SkillCategoryBlocksPanel';
import SkillHistoryModal from './SkillHistoryModal';
import { Toggle } from '@/components/ui/toggle';
import { Trash2, FileText, Folder, ChevronDown, ChevronRight, Pencil, MoreHorizontal, Eye, Code, Info, MessageCircle, Search, Plus, X, Wand2, PenLine, Upload, Download, Package, Loader2, Check, AlertCircle, Globe, Clock } from 'lucide-react';
import { remove } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { save as saveDialog, open as openDialog } from '@tauri-apps/plugin-dialog';
import { writeFile, readFile } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import { packSkill, unpackSkill, validateArchive, ConflictError } from '@/core/skill/packager';
import { installSkillFromNpm, NpmInstallError } from '@/core/skill/npmInstaller';
import type { InstallStep } from '@/core/skill/npmInstaller';
import { useToastStore } from '@/stores/toastStore';
import { getParentDir } from '@/utils/pathUtils';
import { Input } from '@/components/ui/input';
import { format } from '@/i18n';
import type { Skill, SkillUXCategory } from '@/types';
import { sourceToUXCategory } from '@/core/skill/uxCategory';
import MarkdownRenderer from '@/components/chat/MarkdownRenderer';
import ConfirmDialog from '@/components/common/ConfirmDialog';

// Build a set of system skill names from marketplace templates
/**
 * Map a skill source to its visual badge (Task #22). User-scope skills
 * get no badge — that's the "my skills" default and adding a pill there
 * would be pure noise. Only surface sources where the distinction matters:
 *   - builtin         → "内置" (comes with Abu)
 *   - workspace-auto  → "本项目自治" (agent-written, accepted via card)
 *   - project*        → "项目" (workspace's own .abu/skills git-tracked)
 *   - standard        → "标准" (~/.agents/skills cross-client)
 */
type SourceBadge = { labelKey: 'skillSourceBuiltin' | 'skillSourceWorkspaceAuto' | 'skillSourceProject' | 'skillSourceStandard'; tone: 'neutral' | 'clay' | 'blue' | 'slate' } | null;
function sourceBadge(skill: Skill): SourceBadge {
  if (skill.source === 'builtin') return { labelKey: 'skillSourceBuiltin', tone: 'neutral' };
  if (skill.source === 'workspace-auto') return { labelKey: 'skillSourceWorkspaceAuto', tone: 'clay' };
  if (skill.source === 'project' || skill.source === 'project-standard') return { labelKey: 'skillSourceProject', tone: 'blue' };
  if (skill.source === 'standard') return { labelKey: 'skillSourceStandard', tone: 'slate' };
  return null;  // 'user' — default, no badge
}

const SOURCE_BADGE_TONE: Record<'neutral' | 'clay' | 'blue' | 'slate', string> = {
  neutral: 'bg-[var(--abu-bg-muted)] text-[var(--abu-text-muted)]',
  clay: 'bg-[var(--abu-clay-tint)] text-[var(--abu-clay)]',
  blue: 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400',
  slate: 'bg-slate-100 dark:bg-[var(--abu-bg-muted)] text-slate-600 dark:text-[var(--abu-text-secondary)]',
};

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
          className="flex items-center gap-2 py-1.5 mx-2 px-3 rounded-md cursor-pointer hover:bg-[var(--abu-bg-active)]/60 text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)] text-[13px] transition-colors"
          style={{ marginLeft: ml }}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
          <Folder className="h-3.5 w-3.5 shrink-0 text-[var(--abu-text-muted)]" />
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
        isActive ? 'bg-[var(--abu-bg-active)] text-[var(--abu-text-primary)]' : 'text-[var(--abu-text-muted)] hover:bg-[var(--abu-bg-active)]/60 hover:text-[var(--abu-text-primary)]'
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
  // We subscribe to drafts count here (not SkillDraftsPanel itself) so
  // the 阿布沉淀 category's visibility condition accounts for pending
  // drafts even when there are no workspace-auto skills yet.
  const draftsCount = useSkillDraftsStore((s) => s.drafts.length);
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
  const [historySkill, setHistorySkill] = useState<Skill | null>(null);
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
  // Agent Skills install dialog state (npx skills add)
  const [showAgentSkillsInstall, setShowAgentSkillsInstall] = useState(false);
  const [agentSkillsRepo, setAgentSkillsRepo] = useState('');
  const [agentSkillsInstalling, setAgentSkillsInstalling] = useState(false);
  const [agentSkillsError, setAgentSkillsError] = useState('');
  const [agentSkillsSuccess, setAgentSkillsSuccess] = useState('');

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
  // eslint-disable-next-line react-hooks/exhaustive-deps -- selectedSkill omitted: adding it would reload all skill details on every selection change
  }, [skills]);

  const disabledSet = useMemo(() => new Set(disabledSkills), [disabledSkills]);

  // Filter by search
  const searchLower = toolboxSearchQuery.toLowerCase();
  const filteredSkills = useMemo(() => {
    if (!searchLower) return installedSkills;
    return installedSkills.filter((s) => {
      const tagStr = (s.tags ?? []).join(' ').toLowerCase();
      return s.name.toLowerCase().includes(searchLower) ||
        s.description.toLowerCase().includes(searchLower) ||
        tagStr.includes(searchLower);
    });
  }, [installedSkills, searchLower]);

  // Group skills by source for display
  // Group skills by UX category — 4 top-level buckets that match the
  // user's mental model (mine / agent-evolved / third-party / builtin)
  // rather than the raw on-disk source enum. See uxCategory.ts for
  // the mapping; unknown sources are dropped with a console.warn so
  // they don't silently land in "mine" (pre-refactor bug where
  // workspace-auto skills looked like user-created ones).
  const skillGroups = useMemo(() => {
    const groups: Record<SkillUXCategory, Skill[]> = {
      mine: [],
      'agent-evolved': [],
      builtin: [],
    };
    for (const s of filteredSkills) {
      const cat = sourceToUXCategory(s.source);
      if (cat) groups[cat].push(s);
    }
    return groups;
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
      // Select adjacent item so the user stays in context after deletion
      if (selectedSkill === skill.name) {
        const names = filteredSkills.map((s) => s.name);
        const idx = names.indexOf(skill.name);
        setSelectedSkill(names[idx - 1] ?? names[idx + 1] ?? null);
      }
      await refresh();
    } catch (err) {
      console.error('Failed to delete skill:', err);
    }
  };

  // Confirm dialog for overwriting an existing skill during import.
  // State lives here (rather than inline) so the confirm flow can
  // survive React's render cycle between "user picks file" and "user
  // confirms overwrite".
  const [importConflict, setImportConflict] = useState<{
    bytes: Uint8Array;
    baseDir: string;
    skillName: string;
  } | null>(null);
  const [importInProgress, setImportInProgress] = useState(false);

  // Import a .askill package → unpack into user scope (~/.abu/skills/).
  // Reuses the existing packager's validation + unpack pipeline. On
  // name conflict we stash state and pop a ConfirmDialog; everything
  // else surfaces as a toast.
  const handleImport = async () => {
    const addToast = useToastStore.getState().addToast;
    try {
      setShowCreateMenu(false);
      const picked = await openDialog({
        filters: [{ name: 'Skill Package', extensions: ['askill', 'zip'] }],
        multiple: false,
      });
      if (!picked || typeof picked !== 'string') return;

      setImportInProgress(true);
      const bytes = await readFile(picked);
      const archiveBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

      const validationError = validateArchive(archiveBytes);
      if (validationError) {
        addToast({ type: 'error', title: t.toolbox.importFailed, message: validationError.message });
        return;
      }

      // user scope: global skills live under ~/.abu/skills/, which is
      // where hand-imported skills naturally belong. The app's own
      // SkillLoader picks this path up automatically.
      const home = await homeDir();
      const baseDir = `${home}/.abu/skills`;

      try {
        const result = await unpackSkill(archiveBytes, baseDir);
        addToast({
          type: 'success',
          title: t.toolbox.importSuccess,
          message: `"${result.name}"`,
        });
        await refresh();
      } catch (err) {
        if (err instanceof ConflictError) {
          setImportConflict({ bytes: archiveBytes, baseDir, skillName: err.skillName });
          return; // ConfirmDialog takes over from here
        }
        throw err;
      }
    } catch (err) {
      console.error('Import skill failed:', err);
      addToast({
        type: 'error',
        title: t.toolbox.importFailed,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setImportInProgress(false);
    }
  };

  // Overwrite branch from the ConflictError confirmation above.
  const handleImportOverwrite = async () => {
    if (!importConflict) return;
    const addToast = useToastStore.getState().addToast;
    setImportInProgress(true);
    try {
      const result = await unpackSkill(importConflict.bytes, importConflict.baseDir, { overwrite: true });
      addToast({ type: 'success', title: t.toolbox.importSuccess, message: `"${result.name}"` });
      await refresh();
    } catch (err) {
      addToast({
        type: 'error',
        title: t.toolbox.importFailed,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setImportConflict(null);
      setImportInProgress(false);
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

  // Agent Skills install handler (npx skills add <repo> -g)
  const handleAgentSkillsInstall = async () => {
    const repo = agentSkillsRepo.trim();
    if (!repo) return;
    setAgentSkillsInstalling(true);
    setAgentSkillsError('');
    setAgentSkillsSuccess('');
    const addToast = useToastStore.getState().addToast;

    try {
      const result = await invoke<{ stdout: string; stderr: string; exitCode: number }>('run_shell_command', {
        command: `npx -y skills add ${repo} -y -g`,
        cwd: null,
        background: false,
        timeout: 60,
      });

      if (result.exitCode !== 0) {
        throw new Error(result.stderr || `Exit code ${result.exitCode}`);
      }

      await refresh();
      setAgentSkillsSuccess(repo);
      addToast({ type: 'success', title: format(t.toolbox.npmInstallSuccess, { name: repo }) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setAgentSkillsError(msg);
      addToast({ type: 'error', title: t.toolbox.npmInstallFailed, message: msg });
    } finally {
      setAgentSkillsInstalling(false);
    }
  };

  const resetAgentSkillsDialog = () => {
    setShowAgentSkillsInstall(false);
    setAgentSkillsRepo('');
    setAgentSkillsError('');
    setAgentSkillsSuccess('');
    setAgentSkillsInstalling(false);
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
            isRowActive ? 'bg-[var(--abu-bg-active)]' : 'hover:bg-[var(--abu-bg-active)]/60'
          }`}
          onClick={() => handleSkillClick(skill.name)}
        >
          <FileText className={`h-4 w-4 shrink-0 ${!isEnabled ? 'text-[var(--abu-text-placeholder)]' : 'text-[var(--abu-text-muted)]'}`} />
          <span className={`text-sm flex-1 truncate ${
            !isEnabled ? 'text-[var(--abu-text-placeholder)]' : isSelected ? 'text-[var(--abu-text-primary)] font-medium' : 'text-[var(--abu-text-tertiary)]'
          }`}>
            {skill.name}
          </span>
          {(() => {
            const badge = sourceBadge(skill);
            if (!badge) return null;
            return (
              <span
                className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium ${SOURCE_BADGE_TONE[badge.tone]}`}
              >
                {t.toolbox[badge.labelKey]}
              </span>
            );
          })()}
          <div className="p-0.5 text-[var(--abu-text-muted)]">
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
                  ? 'bg-[var(--abu-bg-active)] text-[var(--abu-text-primary)]'
                  : 'text-[var(--abu-text-muted)] hover:bg-[var(--abu-bg-active)]/60 hover:text-[var(--abu-text-primary)]'
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
      <div className="w-[340px] shrink-0 border-r border-[var(--abu-border)] flex flex-col overflow-hidden bg-[var(--abu-bg-base)]">
        {/* Header: Title + Search + Create */}
        <div className="shrink-0 px-4 pt-4 pb-3 border-b border-[var(--abu-border)]">
          {showSearch ? (
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--abu-text-tertiary)]" />
              <input
                autoFocus
                type="text"
                placeholder={t.toolbox.searchPlaceholder}
                value={toolboxSearchQuery}
                onChange={(e) => setToolboxSearchQuery(e.target.value)}
                onBlur={() => { if (!toolboxSearchQuery) setShowSearch(false); }}
                onKeyDown={(e) => { if (e.key === 'Escape') { setToolboxSearchQuery(''); setShowSearch(false); } }}
                className="w-full pl-7 pr-7 py-1 text-sm border border-[var(--abu-border)] rounded-md bg-[var(--abu-bg-base)] focus:outline-none focus:ring-1 focus:ring-[var(--abu-clay-ring)] text-[var(--abu-text-primary)]"
              />
              <button
                onClick={() => { setToolboxSearchQuery(''); setShowSearch(false); }}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)]"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <span className="text-base font-semibold text-[var(--abu-text-primary)]">{t.toolbox.skills}</span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setShowSearch(true)}
                  className="p-1 text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)] transition-colors"
                >
                  <Search className="h-3.5 w-3.5" />
                </button>
                <div className="relative">
                  <button
                    onClick={(e) => { e.stopPropagation(); setShowCreateMenu(!showCreateMenu); }}
                    className="p-1 text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)] transition-colors"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                  {showCreateMenu && (
                    <div className="absolute z-50 top-full right-0 mt-1 w-44 bg-[var(--abu-bg-base)] rounded-lg shadow-lg border border-[var(--abu-border)] py-1">
                      {onAICreate && (
                        <button
                          onClick={() => { setShowCreateMenu(false); onAICreate(); }}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)] transition-colors"
                        >
                          <Wand2 className="h-3.5 w-3.5 text-[var(--abu-clay)]" />
                          <span>{t.toolbox.createWithAbu}</span>
                        </button>
                      )}
                      {onManualCreate && (
                        <button
                          onClick={() => { setShowCreateMenu(false); onManualCreate(); }}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)] transition-colors"
                        >
                          <PenLine className="h-3.5 w-3.5 text-[var(--abu-text-muted)]" />
                          <span>{t.toolbox.createManually}</span>
                        </button>
                      )}
                      {onUploadFile && (
                        <button
                          onClick={() => { setShowCreateMenu(false); onUploadFile(); }}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)] transition-colors"
                        >
                          <Upload className="h-3.5 w-3.5 text-[var(--abu-text-muted)]" />
                          <span>{t.toolbox.uploadFile}</span>
                        </button>
                      )}
                      <button
                        onClick={handleImport}
                        disabled={importInProgress}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-active)] transition-colors disabled:opacity-50"
                      >
                        <Upload className="h-3.5 w-3.5 text-[var(--abu-text-muted)]" />
                        <span>{t.toolbox.importSkill}</span>
                      </button>
                      <button
                        onClick={() => { setShowCreateMenu(false); setShowNpmInstall(true); }}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)] transition-colors"
                      >
                        <Package className="h-3.5 w-3.5 text-[var(--abu-text-muted)]" />
                        <span>{t.toolbox.installFromNpm}</span>
                      </button>
                      <button
                        onClick={() => { setShowCreateMenu(false); setShowAgentSkillsInstall(true); }}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)] transition-colors"
                      >
                        <Globe className="h-3.5 w-3.5 text-[var(--abu-text-muted)]" />
                        <span>{t.toolbox.installAgentSkills}</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
        {/* Category blocks manager (Task #45 · reject-category undo) —
            hidden when the workspace has no blocks. Kept at the top
            because it's a global "management" surface (not tied to any
            one skill), and doesn't belong inside the 阿布沉淀 category. */}
        <SkillCategoryBlocksPanel />
        <div className="flex-1 overflow-y-auto overlay-scroll py-2">
          {filteredSkills.length === 0 ? (
            <div className="text-xs text-[var(--abu-text-muted)] py-8 text-center">{t.toolbox.noSkillsFound}</div>
          ) : (
            <>
              {/* Category · Mine — user's own or team-shipped skills.
                  Groups user/standard/project/project-standard into one
                  bucket matching the user's mental model ("I or my
                  team put this on disk"), instead of splitting by the
                  implementation-level SkillSource enum. */}
              {skillGroups.mine.length > 0 && (
                <div>
                  <div
                    className="flex items-center gap-1.5 px-5 py-2.5 cursor-pointer text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)]"
                    onClick={() => toggleCategory('mine')}
                  >
                    {collapsedCategories.has('mine')
                      ? <ChevronRight className="h-3 w-3" />
                      : <ChevronDown className="h-3 w-3" />
                    }
                    <span className="text-[13px] font-medium">{t.toolbox.categoryMine}</span>
                    <span className="text-[11px] text-[var(--abu-text-placeholder)] ml-1">{skillGroups.mine.length}</span>
                  </div>
                  {!collapsedCategories.has('mine') && skillGroups.mine.map((skill) => renderSkillRow(skill))}
                </div>
              )}

              {/* Category · Agent-evolved — pending drafts awaiting
                  user review. workspace-auto skills (accepted) now
                  live in "mine" with a per-row "自进化" badge.
                  Section only appears when there are active drafts. */}
              {draftsCount > 0 && (
                <div>
                  <div
                    className="flex items-center gap-1.5 px-5 py-2.5 cursor-pointer text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)]"
                    onClick={() => toggleCategory('agent-evolved')}
                  >
                    {collapsedCategories.has('agent-evolved')
                      ? <ChevronRight className="h-3 w-3" />
                      : <ChevronDown className="h-3 w-3" />
                    }
                    <span className="text-[13px] font-medium">{t.toolbox.categoryAgentEvolved}</span>
                    <span className="ml-1.5 px-1.5 py-0.5 text-[10px] rounded bg-purple-100 text-purple-700">{t.toolbox.categoryAgentEvolvedBadge}</span>
                    <span className="text-[11px] text-[var(--abu-text-placeholder)] ml-1">{draftsCount}</span>
                  </div>
                  {!collapsedCategories.has('agent-evolved') && <SkillDraftsPanel />}
                </div>
              )}

              {/* Category · Built-in — bundled with Abu. Read-only. */}
              {skillGroups.builtin.length > 0 && (
                <div>
                  <div
                    className="flex items-center gap-1.5 px-5 py-2.5 cursor-pointer text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)]"
                    onClick={() => toggleCategory('builtin')}
                  >
                    {collapsedCategories.has('builtin')
                      ? <ChevronRight className="h-3 w-3" />
                      : <ChevronDown className="h-3 w-3" />
                    }
                    <span className="text-[13px] font-medium">{t.toolbox.categoryBuiltin}</span>
                  </div>
                  {!collapsedCategories.has('builtin') && skillGroups.builtin.map((skill) => renderSkillRow(skill))}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Right: Skill detail or file content */}
      <div className="flex-1 overflow-y-auto overlay-scroll bg-[var(--abu-bg-base)]">
        {selected ? (
          selectedFile ? (
            /* Show selected file content */
            <div className="px-6 py-6">
              <div className="flex items-center gap-2 mb-4">
                <button
                  className="text-xs text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)] transition-colors"
                  onClick={() => { setSelectedFile(null); setFileContent(null); }}
                >
                  {selected.name}
                </button>
                <span className="text-xs text-[var(--abu-text-muted)]">/</span>
                <span className="text-sm font-medium text-[var(--abu-text-primary)]">{selectedFile.path}</span>
              </div>
              <div className="border border-[var(--abu-border)] rounded-lg overflow-hidden">
                <div className="px-5 py-4 bg-[var(--abu-bg-base)]">
                  {fileContent !== null ? (
                    selectedFile.path.endsWith('.md') ? (
                      <MarkdownRenderer content={fileContent} />
                    ) : (
                      <pre className="text-xs text-[var(--abu-text-primary)] whitespace-pre-wrap break-all font-mono leading-relaxed">{fileContent}</pre>
                    )
                  ) : (
                    <div className="text-sm text-[var(--abu-text-muted)]">Loading...</div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            /* Show skill detail */
            <div className="px-6 py-6">
              {/* Row 1: Name + Toggle + Menu */}
              <div className="flex items-center justify-between gap-3 mb-4">
                <h2 className="text-xl font-semibold text-[var(--abu-text-primary)] truncate min-w-0" title={selected.name}>{selected.name}</h2>
                <div className="flex items-center gap-2 shrink-0">
                  <Toggle
                    checked={!disabledSet.has(selected.name)}
                    onChange={() => toggleSkillEnabled(selected.name)}
                  />
                  {/* "..." menu: export always available; user skills also have edit/delete */}
                  <div className="relative">
                      <button
                        onClick={(e) => { e.stopPropagation(); setMenuSkill(menuSkill === selected.name ? null : selected.name); }}
                        className="p-1.5 rounded-lg text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-muted)] transition-colors"
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </button>
                      {menuSkill === selected.name && (
                        <div className="absolute right-0 top-8 z-10 bg-[var(--abu-bg-base)] border border-[var(--abu-border)] rounded-lg shadow-lg py-1 min-w-[140px]">
                          {/* Try in chat - only when enabled */}
                          {!disabledSet.has(selected.name) && (
                            <button
                              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-muted)] transition-colors"
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
                            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-muted)] transition-colors"
                            onClick={() => { handleExport(selected); setMenuSkill(null); }}
                          >
                            <Download className="h-3 w-3" />
                            {t.toolbox.exportSkill}
                          </button>
                          {/* History (Task #24) — available for all skills;
                              builtin skills typically have no history, so
                              the modal's empty state explains this. */}
                          <button
                            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-muted)] transition-colors"
                            onClick={() => { setHistorySkill(selected); setMenuSkill(null); }}
                          >
                            <Clock className="h-3 w-3" />
                            {t.toolbox.historyMenuLabel}
                          </button>
                          {/* Edit & Delete - available for non-builtin skills */}
                          {selected.source !== 'builtin' && !isSystemSkill(selected) && (
                            <>
                              <button
                                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-muted)] transition-colors"
                                onClick={() => { setEditorSkill(selected); setMenuSkill(null); }}
                              >
                                <Pencil className="h-3 w-3" />
                                {t.toolbox.skillEdit}
                              </button>
                              <button
                                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
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

              {/* Row 2: Source */}
              <div className="mb-5">
                <div className="text-xs text-[var(--abu-text-muted)] mb-0.5">{t.toolbox.skillAddedBy}</div>
                <div className="text-sm font-medium text-[var(--abu-text-primary)]">{
                  selected.source === 'builtin' ? t.toolbox.skillSourceBuiltin :
                  selected.source === 'user' ? t.toolbox.skillSourceUser :
                  selected.source === 'standard' ? t.toolbox.skillSourceStandard :
                  (selected.source === 'project' || selected.source === 'project-standard') ? t.toolbox.skillSourceProject :
                  (isSystemSkill(selected) ? t.toolbox.skillSourceBuiltin : t.toolbox.skillSourceUser)
                }</div>
              </div>

              {/* Description */}
              <div className="flex items-center gap-1 mb-1.5">
                <span className="text-xs text-[var(--abu-text-muted)]">Description</span>
                <Info className="h-3 w-3 text-[var(--abu-text-muted)]" />
              </div>
              <p className="text-sm text-[var(--abu-text-primary)] leading-relaxed mb-7">{selected.description}</p>

              {/* Content area: License + SKILL.md with preview/source toggle */}
              <div className="border border-[var(--abu-border)] rounded-lg overflow-hidden">
                {/* Toggle bar */}
                <div className="flex items-center justify-end gap-1.5 px-4 py-2.5 bg-[var(--abu-bg-base)] border-b border-[var(--abu-border)]">
                  <button
                    onClick={() => setContentViewMode('preview')}
                    className={`p-1.5 rounded transition-colors ${contentViewMode === 'preview' ? 'text-[var(--abu-text-primary)] bg-[var(--abu-bg-hover)]' : 'text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)]'}`}
                    title="Preview"
                  >
                    <Eye className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => setContentViewMode('source')}
                    className={`p-1.5 rounded transition-colors ${contentViewMode === 'source' ? 'text-[var(--abu-text-primary)] bg-[var(--abu-bg-hover)]' : 'text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)]'}`}
                    title="Source"
                  >
                    <Code className="h-4 w-4" />
                  </button>
                </div>
                <div className="px-6 py-5 bg-[var(--abu-bg-base)]">
                  {contentViewMode === 'preview' ? (
                    <MarkdownRenderer content={selected.content} />
                  ) : (
                    <pre className="text-xs text-[var(--abu-text-primary)] whitespace-pre-wrap break-words font-mono leading-relaxed">{selected.content}</pre>
                  )}
                </div>
              </div>
            </div>
          )
        ) : (
          <div className="flex items-center justify-center h-full text-sm text-[var(--abu-text-muted)]">
            {t.toolbox.noSkillsFound}
          </div>
        )}
      </div>

      {/* npm install dialog */}
      {showNpmInstall && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
          <div className="w-[420px] bg-[var(--abu-bg-base)] rounded-xl shadow-xl border border-[var(--abu-border)] overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-[var(--abu-border)]">
              <div className="flex items-center gap-2">
                <Package className="h-4 w-4 text-[var(--abu-clay)]" />
                <h2 className="text-sm font-semibold text-[var(--abu-text-primary)]">{t.toolbox.installFromNpm}</h2>
              </div>
              <button onClick={resetNpmDialog} className="p-1.5 rounded-lg text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-muted)] transition-colors">
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Body */}
            <div className="px-5 py-4 space-y-3">
              {/* Package name */}
              <div>
                <label className="block text-xs font-medium text-[var(--abu-text-secondary)] mb-1">{t.toolbox.npmPackageName}</label>
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
                <label className="block text-xs font-medium text-[var(--abu-text-secondary)] mb-1">{t.toolbox.npmRegistry}</label>
                <Input
                  type="text"
                  placeholder={skillRegistryDefault || t.toolbox.npmRegistryPlaceholder}
                  value={npmRegistry}
                  onChange={(e) => setNpmRegistry(e.target.value)}
                  disabled={npmInstalling}
                />
                <p className="text-[11px] text-[var(--abu-text-muted)] mt-1">{t.toolbox.npmRegistryHint}</p>
              </div>

              {/* Progress */}
              {npmInstalling && npmStep && (
                <div className="flex items-center gap-2 py-2 px-3 bg-[var(--abu-bg-base)] rounded-lg">
                  <Loader2 className="h-3.5 w-3.5 text-[var(--abu-clay)] animate-spin shrink-0" />
                  <span className="text-xs text-[var(--abu-text-tertiary)]">
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
                    className="text-xs font-medium text-[var(--abu-clay)] hover:text-[var(--abu-clay-hover)] transition-colors"
                  >
                    {t.toolbox.npmOverwrite}
                  </button>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[var(--abu-border)]">
              <button onClick={resetNpmDialog} className="px-4 py-1.5 rounded-lg text-sm font-medium text-[var(--abu-text-tertiary)] hover:bg-[var(--abu-bg-muted)] transition-colors">
                {npmSuccess ? t.common.close : t.common.cancel}
              </button>
              {!npmSuccess && (
                <button
                  onClick={() => handleNpmInstall()}
                  disabled={!npmPackageName.trim() || npmInstalling}
                  className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium bg-[var(--abu-clay)] text-white hover:bg-[var(--abu-clay-hover)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {npmInstalling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Package className="h-3.5 w-3.5" />}
                  {t.toolbox.npmFindAndInstall}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Agent Skills install dialog (npx skills add) */}
      {showAgentSkillsInstall && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
          <div className="w-[420px] bg-[var(--abu-bg-base)] rounded-xl shadow-xl border border-[var(--abu-border)] overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-[var(--abu-border)]">
              <div className="flex items-center gap-2">
                <Globe className="h-4 w-4 text-[var(--abu-clay)]" />
                <h2 className="text-sm font-semibold text-[var(--abu-text-primary)]">{t.toolbox.installAgentSkills}</h2>
              </div>
              <button onClick={resetAgentSkillsDialog} className="p-1.5 rounded-lg text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-muted)] transition-colors">
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Body */}
            <div className="px-5 py-4 space-y-3">
              <div>
                <label className="block text-xs font-medium text-[var(--abu-text-secondary)] mb-1">GitHub</label>
                <Input
                  type="text"
                  placeholder={t.toolbox.installAgentSkillsPlaceholder}
                  value={agentSkillsRepo}
                  onChange={(e) => { setAgentSkillsRepo(e.target.value); setAgentSkillsError(''); setAgentSkillsSuccess(''); }}
                  disabled={agentSkillsInstalling}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleAgentSkillsInstall(); }}
                />
                <p className="text-[11px] text-[var(--abu-text-muted)] mt-1">{t.toolbox.installAgentSkillsHint}</p>
              </div>

              {/* Recommended repos */}
              <div>
                <div className="text-[11px] font-medium text-[var(--abu-text-muted)] mb-1.5">{t.toolbox.recommendedSkills}</div>
                <div className="flex flex-wrap gap-1.5">
                  {['larksuite/cli', 'anthropics/skills', 'vercel-labs/agent-skills'].map((repo) => (
                    <button
                      key={repo}
                      onClick={() => setAgentSkillsRepo(repo)}
                      className="px-2 py-1 text-[11px] rounded-md bg-[var(--abu-bg-muted)] text-[var(--abu-text-tertiary)] hover:bg-[var(--abu-bg-active)] hover:text-[var(--abu-text-primary)] transition-colors"
                    >
                      {repo}
                    </button>
                  ))}
                </div>
              </div>

              {/* Progress */}
              {agentSkillsInstalling && (
                <div className="flex items-center gap-2 py-2 px-3 bg-[var(--abu-bg-base)] rounded-lg">
                  <Loader2 className="h-3.5 w-3.5 text-[var(--abu-clay)] animate-spin shrink-0" />
                  <span className="text-xs text-[var(--abu-text-tertiary)]">Installing...</span>
                </div>
              )}

              {/* Success */}
              {agentSkillsSuccess && (
                <div className="flex items-center gap-2 py-2 px-3 bg-green-50 rounded-lg">
                  <Check className="h-3.5 w-3.5 text-green-600 shrink-0" />
                  <span className="text-xs text-green-700">{format(t.toolbox.npmInstallSuccess, { name: agentSkillsSuccess })}</span>
                </div>
              )}

              {/* Error */}
              {agentSkillsError && (
                <div className="flex items-start gap-2 py-2 px-3 bg-red-50 rounded-lg">
                  <AlertCircle className="h-3.5 w-3.5 text-red-500 shrink-0 mt-0.5" />
                  <span className="text-xs text-red-600">{agentSkillsError}</span>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[var(--abu-border)]">
              <button onClick={resetAgentSkillsDialog} className="px-4 py-1.5 rounded-lg text-sm font-medium text-[var(--abu-text-tertiary)] hover:bg-[var(--abu-bg-muted)] transition-colors">
                {agentSkillsSuccess ? t.common.close : t.common.cancel}
              </button>
              {!agentSkillsSuccess && (
                <button
                  onClick={handleAgentSkillsInstall}
                  disabled={!agentSkillsRepo.trim() || agentSkillsInstalling}
                  className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-sm font-medium bg-[var(--abu-clay)] text-white hover:bg-[var(--abu-clay-hover)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {agentSkillsInstalling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Globe className="h-3.5 w-3.5" />}
                  {t.toolbox.installAgentSkillsButton}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Skill history modal (Task #24) — mounted only when opened. */}
      {historySkill && (
        <SkillHistoryModal
          skillDir={historySkill.skillDir}
          skillName={historySkill.name}
          onClose={() => setHistorySkill(null)}
        />
      )}

      {/* Import conflict confirm — pops when `.askill` import finds an
          existing skill with the same name. User can overwrite (which
          wipes the old skillDir and unpacks the new archive) or cancel. */}
      <ConfirmDialog
        open={!!importConflict}
        title={t.toolbox.importConflictTitle}
        message={importConflict
          ? format(t.toolbox.importConflictMessage, { name: importConflict.skillName })
          : ''}
        confirmText={t.toolbox.importConflictOverwrite}
        cancelText={t.common.cancel}
        variant="danger"
        onConfirm={handleImportOverwrite}
        onCancel={() => setImportConflict(null)}
      />
    </div>
  );
}
