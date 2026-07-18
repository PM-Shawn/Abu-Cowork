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
import SkillUploadModal from './SkillUploadModal';
import { Toggle } from '@/components/ui/toggle';
import { Trash2, FileText, Pencil, MoreHorizontal, Eye, Code, Info, MessageCircle, Download, Clock, ChevronDown, ChevronRight, Folder } from 'lucide-react';
import { remove } from '@tauri-apps/plugin-fs';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import { packSkill } from '@/core/skill/packager';
import { useToastStore } from '@/stores/toastStore';
import { getParentDir } from '@/utils/pathUtils';
import type { Skill, SkillUXCategory } from '@/types';
import { sourceToUXCategory } from '@/core/skill/uxCategory';
import MarkdownRenderer from '@/components/chat/MarkdownRenderer';
import ToolCard from '@/components/toolbox/ToolCard';
import ToolGrid from '@/components/toolbox/ToolGrid';
import ToolDetailModal from '@/components/toolbox/ToolDetailModal';

// Build a set of system skill names from marketplace templates
/**
 * Map a skill source to its visual badge (Task #22). User-scope skills
 * get no badge — that's the "my skills" default and adding a pill there
 * would be pure noise. Only surface sources where the distinction matters:
 *   - workspace-auto  → "本项目自治" (agent-written, accepted via card)
 *   - project*        → "项目" (workspace's own .abu/skills git-tracked)
 *   - standard        → "标准" (~/.agents/skills cross-client)
 * builtin gets NO badge — those cards already sit under the "市场" category
 * group, so a per-card source pill there is redundant.
 */
type SourceBadge = { labelKey: 'skillSourceWorkspaceAuto' | 'skillSourceProject' | 'skillSourceStandard'; tone: 'clay' | 'blue' | 'slate' } | null;
function sourceBadge(skill: Skill): SourceBadge {
  if (skill.source === 'workspace-auto') return { labelKey: 'skillSourceWorkspaceAuto', tone: 'clay' };
  if (skill.source === 'project' || skill.source === 'project-standard') return { labelKey: 'skillSourceProject', tone: 'blue' };
  if (skill.source === 'standard') return { labelKey: 'skillSourceStandard', tone: 'slate' };
  return null;  // 'user' — default, no badge
}

const SOURCE_BADGE_TONE: Record<'neutral' | 'clay' | 'blue' | 'slate', string> = {
  neutral: 'bg-[var(--abu-bg-muted)] text-[var(--abu-text-muted)]',
  clay: 'bg-[var(--abu-clay-tint)] text-[var(--abu-clay)]',
  blue: 'bg-[var(--abu-info-bg)] text-[var(--abu-info)]',
  slate: 'bg-slate-100 dark:bg-[var(--abu-bg-muted)] text-slate-600 dark:text-[var(--abu-text-secondary)]',
};

const systemSkillNames = new Set(
  skillTemplates.filter((t) => t.isBuiltin).map((t) => t.name)
);

function isSystemSkill(skill: Skill): boolean {
  return skill.filePath.includes('builtin-skills') || systemSkillNames.has(skill.name);
}

// ── Supporting-file tree (restored from the pre-modal list-panel version and
// adapted to render inside the detail modal). ───────────────────────────────
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

/** Recursive file tree row — indent adapted for the modal (no list-panel base offset). */
function FileTreeItem({
  node, depth = 0, selectedFile, onFileClick,
}: {
  node: FileNode; depth?: number;
  selectedFile?: string | null;
  onFileClick?: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const ml = depth * 16;

  if (node.isDir) {
    return (
      <div>
        <div
          className="flex items-center gap-2 py-1 px-2 rounded-md cursor-pointer hover:bg-[var(--abu-bg-active)]/60 text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)] text-body transition-colors"
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
      className={`flex items-center gap-2 py-1 px-2 rounded-md cursor-pointer text-body transition-colors ${
        isActive ? 'bg-[var(--abu-bg-active)] text-[var(--abu-text-primary)]' : 'text-[var(--abu-text-muted)] hover:bg-[var(--abu-bg-active)]/60 hover:text-[var(--abu-text-primary)]'
      }`}
      style={{ marginLeft: ml }}
      onClick={() => onFileClick?.(node.path)}
    >
      <FileText className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{node.name}</span>
    </div>
  );
}

interface SkillsSectionProps {
  manualCreateTrigger?: number;
  /** Unified upload dialog (folder / .askill / .zip) — opened from ToolboxModal's
   *  header create-menu ("导入技能"). Controlled from outside like MCPSection's
   *  showAddForm, with an internal fallback so the component still works standalone. */
  showUploadModal?: boolean;
  onUploadModalChange?: (open: boolean) => void;
}

export default function SkillsSection({ manualCreateTrigger, showUploadModal: externalShowUploadModal, onUploadModalChange }: SkillsSectionProps) {
  const { skills, refresh } = useDiscoveryStore();
  // We subscribe to drafts count here (not SkillDraftsPanel itself) so
  // the 阿布沉淀 category's visibility condition accounts for pending
  // drafts even when there are no workspace-auto skills yet.
  const draftsCount = useSkillDraftsStore((s) => s.drafts.length);
  const { toolboxSearchQuery, disabledSkills, toggleSkillEnabled, closeToolbox } = useSettingsStore();
  const startNewConversation = useChatStore((s) => s.startNewConversation);
  const setPendingInput = useChatStore((s) => s.setPendingInput);
  const { t } = useI18n();

  const [installedSkills, setInstalledSkills] = useState<Skill[]>([]);
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
  const [editorSkill, setEditorSkill] = useState<Skill | 'new' | null>(null);
  const [menuSkill, setMenuSkill] = useState<string | null>(null);
  const [historySkill, setHistorySkill] = useState<Skill | null>(null);
  // Content view mode: preview (rendered) or source (raw)
  const [contentViewMode, setContentViewMode] = useState<'preview' | 'source'>('preview');
  // Supporting-file browsing inside the detail modal. `activeFilePath` = 'SKILL.md'
  // shows selected.content; any other path loads via skillLoader on demand.
  const [modalFiles, setModalFiles] = useState<string[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string>('SKILL.md');
  const [activeFileContent, setActiveFileContent] = useState<string | null>(null);
  // Unified upload dialog (folder / .askill / .zip via click or drag-drop)
  const [internalShowUploadModal, setInternalShowUploadModal] = useState(false);
  const showUploadModal = externalShowUploadModal ?? internalShowUploadModal;
  const setShowUploadModal = (open: boolean) => {
    onUploadModalChange?.(open);
    setInternalShowUploadModal(open);
  };

  // Open blank editor when manual create is triggered from parent
  useEffect(() => {
    if (manualCreateTrigger && manualCreateTrigger > 0) {
      setEditorSkill('new');
    }
  }, [manualCreateTrigger]);

  // Load full skill details. No auto-selection: the detail is a modal now,
  // so it stays closed until the user clicks a card.
  useEffect(() => {
    const loadSkillDetails = async () => {
      const fullSkills: Skill[] = [];
      for (const meta of skills) {
        const full = skillLoader.getSkill(meta.name);
        if (full) fullSkills.push(full);
      }
      setInstalledSkills(fullSkills);
    };
    loadSkillDetails();
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

  const selected = installedSkills.find((s) => s.name === selectedSkill) ?? null;

  // Load the open skill's supporting files; reset the viewer to SKILL.md.
  useEffect(() => {
    setActiveFilePath('SKILL.md');
    setActiveFileContent(null);
    if (!selectedSkill) { setModalFiles([]); return; }
    let cancelled = false;
    skillLoader.listSupportingFiles(selectedSkill)
      .then((files) => { if (!cancelled) setModalFiles(files); })
      .catch(() => { if (!cancelled) setModalFiles([]); });
    return () => { cancelled = true; };
  }, [selectedSkill]);

  // Load a supporting file's content on demand (SKILL.md uses selected.content).
  useEffect(() => {
    if (!selectedSkill || activeFilePath === 'SKILL.md') { setActiveFileContent(null); return; }
    let cancelled = false;
    setActiveFileContent(null);
    skillLoader.loadSupportingFile(selectedSkill, activeFilePath)
      .then((content) => { if (!cancelled) setActiveFileContent(content ?? ''); })
      .catch(() => { if (!cancelled) setActiveFileContent(''); });
    return () => { cancelled = true; };
  }, [selectedSkill, activeFilePath]);

  // Delete a user-installed skill. With the detail now a modal (not a
  // list panel), there's no natural "adjacent" item to select after
  // deletion — mirror AgentsSection and just close the modal.
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

  // Close the "..." menu when clicking outside
  useEffect(() => {
    if (!menuSkill) return;
    const handleClick = () => setMenuSkill(null);
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [menuSkill]);

  const renderSkillCard = (skill: Skill) => {
    const isEnabled = !disabledSet.has(skill.name);
    const badge = sourceBadge(skill);
    return (
      <ToolCard
        key={skill.name}
        item={{
          id: skill.name,
          name: skill.name,
          description: skill.description,
          avatar: <FileText className="h-6 w-6 text-[var(--abu-text-muted)]" />,
          badge: badge ? (
            <span className={`shrink-0 px-1.5 py-0.5 rounded text-caption font-medium ${SOURCE_BADGE_TONE[badge.tone]}`}>
              {t.toolbox[badge.labelKey]}
            </span>
          ) : undefined,
          toggle: (
            <span onClick={(e) => e.stopPropagation()}>
              <Toggle checked={isEnabled} onChange={() => toggleSkillEnabled(skill.name)} size="sm" tone="green" />
            </span>
          ),
        }}
        onClick={() => setSelectedSkill(skill.name)}
      />
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
    <div className="flex flex-col h-full overflow-hidden bg-[var(--abu-bg-base)]">
      {/* Category blocks manager (Task #45 · reject-category undo) —
          hidden when the workspace has no blocks. Kept at the top
          because it's a global "management" surface (not tied to any
          one skill), and doesn't belong inside the 阿布沉淀 category. */}
      <SkillCategoryBlocksPanel />

      {/* Card grid — horizontally inset to match the header row above (ToolboxModal's
          TopTabNav), with a centered max-width so cards don't stretch edge-to-edge. */}
      <div className="flex-1 overflow-y-scroll overlay-scroll px-8 pb-6">
        {filteredSkills.length === 0 ? (
          <div className="text-body text-[var(--abu-text-muted)] py-16 text-center">{t.toolbox.noSkillsFound}</div>
        ) : (
          <div className="max-w-5xl mx-auto space-y-6">
            {/* Category · Mine — user's own or team-shipped skills.
                Groups user/standard/project/project-standard into one
                bucket matching the user's mental model ("I or my
                team put this on disk"), instead of splitting by the
                implementation-level SkillSource enum. */}
            {skillGroups.mine.length > 0 && (
              <div>
                <div className="mb-3 text-body font-medium text-[var(--abu-text-muted)]">{t.toolbox.categoryMine}</div>
                <ToolGrid>{skillGroups.mine.map((skill) => renderSkillCard(skill))}</ToolGrid>
              </div>
            )}

            {/* Category · Agent-evolved — pending drafts awaiting
                user review. workspace-auto skills (accepted) now
                live in "mine" with a per-card "自进化" badge.
                Section only appears when there are active drafts.
                SkillDraftsPanel is its own list UI (not a card grid) —
                kept as-is rather than reshaped into ToolCards. */}
            {draftsCount > 0 && (
              <div>
                <div className="mb-3 flex items-center gap-1.5 text-body font-medium text-[var(--abu-text-muted)]">
                  <span>{t.toolbox.categoryAgentEvolved}</span>
                  <span className="px-1.5 py-0.5 text-caption rounded bg-purple-100 text-purple-700">{t.toolbox.categoryAgentEvolvedBadge}</span>
                  <span className="text-caption text-[var(--abu-text-placeholder)]">{draftsCount}</span>
                </div>
                <SkillDraftsPanel />
              </div>
            )}

            {/* Category · Built-in — bundled with Abu. Read-only. */}
            {skillGroups.builtin.length > 0 && (
              <div>
                <div className="mb-3 text-body font-medium text-[var(--abu-text-muted)]">{t.toolbox.categoryBuiltin}</div>
                <ToolGrid>{skillGroups.builtin.map((skill) => renderSkillCard(skill))}</ToolGrid>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Detail modal */}
      <ToolDetailModal
        open={!!selected}
        onClose={() => { setSelectedSkill(null); setMenuSkill(null); }}
        disableEscape={!!historySkill}
        maxWidth="max-w-2xl"
        avatar={selected ? <FileText className="h-6 w-6 text-[var(--abu-text-muted)]" /> : undefined}
        title={selected?.name}
        headerActions={selected ? (
          <>
            <Toggle
              checked={!disabledSet.has(selected.name)}
              onChange={() => toggleSkillEnabled(selected.name)}
              tone="green"
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
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-minor text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-muted)] transition-colors"
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
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-minor text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-muted)] transition-colors"
                    onClick={() => { handleExport(selected); setMenuSkill(null); }}
                  >
                    <Download className="h-3 w-3" />
                    {t.toolbox.exportSkill}
                  </button>
                  {/* History (Task #24) — available for all skills;
                      builtin skills typically have no history, so
                      the modal's empty state explains this. */}
                  <button
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-minor text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-muted)] transition-colors"
                    onClick={() => { setHistorySkill(selected); setMenuSkill(null); }}
                  >
                    <Clock className="h-3 w-3" />
                    {t.toolbox.historyMenuLabel}
                  </button>
                  {/* Edit & Delete - available for non-builtin skills */}
                  {selected.source !== 'builtin' && !isSystemSkill(selected) && (
                    <>
                      <button
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-minor text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-muted)] transition-colors"
                        onClick={() => { setEditorSkill(selected); setMenuSkill(null); setSelectedSkill(null); }}
                      >
                        <Pencil className="h-3 w-3" />
                        {t.toolbox.skillEdit}
                      </button>
                      <button
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-minor text-[var(--abu-danger)] hover:bg-[var(--abu-danger-bg)] transition-colors"
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
          </>
        ) : undefined}
      >
        {selected && (
          <div className="space-y-5">
            {/* Added by */}
            <div>
              <div className="text-minor text-[var(--abu-text-muted)] mb-0.5">{t.toolbox.skillAddedBy}</div>
              <div className="text-body font-medium text-[var(--abu-text-primary)]">{
                selected.source === 'builtin' ? t.toolbox.skillSourceBuiltin :
                selected.source === 'user' ? t.toolbox.skillSourceUser :
                selected.source === 'standard' ? t.toolbox.skillSourceStandard :
                (selected.source === 'project' || selected.source === 'project-standard') ? t.toolbox.skillSourceProject :
                (isSystemSkill(selected) ? t.toolbox.skillSourceBuiltin : t.toolbox.skillSourceUser)
              }</div>
            </div>

            {/* Description */}
            <div>
              <div className="flex items-center gap-1 mb-1.5">
                <span className="text-minor text-[var(--abu-text-muted)]">Description</span>
                <Info className="h-3 w-3 text-[var(--abu-text-muted)]" />
              </div>
              <p className="text-body text-[var(--abu-text-primary)] leading-relaxed">{selected.description}</p>
            </div>

            {/* Files: SKILL.md + supporting files, with an on-demand viewer */}
            {(() => {
              const isMd = activeFilePath.endsWith('.md');
              const displayContent = activeFilePath === 'SKILL.md' ? selected.content : activeFileContent;
              const fileTree = buildFileTree(modalFiles);
              return (
                <div className="border border-[var(--abu-border)] rounded-lg overflow-hidden">
                  {/* File list — only when the skill ships supporting files */}
                  {modalFiles.length > 0 && (
                    <div className="max-h-40 overflow-y-auto overlay-scroll border-b border-[var(--abu-border)] p-1.5 space-y-0.5">
                      <div
                        className={`flex items-center gap-2 py-1 px-2 rounded-md cursor-pointer text-body transition-colors ${
                          activeFilePath === 'SKILL.md' ? 'bg-[var(--abu-bg-active)] text-[var(--abu-text-primary)]' : 'text-[var(--abu-text-muted)] hover:bg-[var(--abu-bg-active)]/60 hover:text-[var(--abu-text-primary)]'
                        }`}
                        onClick={() => setActiveFilePath('SKILL.md')}
                      >
                        <FileText className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">SKILL.md</span>
                      </div>
                      {fileTree.map((node) => (
                        <FileTreeItem key={node.path} node={node} selectedFile={activeFilePath} onFileClick={setActiveFilePath} />
                      ))}
                    </div>
                  )}
                  {/* Viewer header: active filename + preview/source toggle */}
                  <div className="flex items-center justify-between gap-2 px-4 py-2.5 bg-[var(--abu-bg-base)] border-b border-[var(--abu-border)]">
                    <span className="text-minor font-medium text-[var(--abu-text-secondary)] truncate">{activeFilePath}</span>
                    <div className="flex items-center gap-1.5 shrink-0">
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
                  </div>
                  {/* Content */}
                  <div className="px-4 py-4 bg-[var(--abu-bg-base)]">
                    {displayContent === null ? (
                      <div className="text-minor text-[var(--abu-text-muted)] py-6 text-center">…</div>
                    ) : contentViewMode === 'preview' && isMd ? (
                      <MarkdownRenderer content={displayContent} />
                    ) : (
                      <pre className="text-minor text-[var(--abu-text-primary)] whitespace-pre-wrap break-words font-mono leading-relaxed">{displayContent}</pre>
                    )}
                  </div>
                </div>
              );
            })()}
          </div>
        )}
      </ToolDetailModal>

      {/* Unified upload modal — conditionally mounted so useFileDragDrop's
          window-level Tauri listener only runs while the modal is open. */}
      {showUploadModal && (
        <SkillUploadModal
          onClose={() => setShowUploadModal(false)}
          onInstalled={(name) => setSelectedSkill(name)}
        />
      )}

      {/* Skill history modal (Task #24) — mounted only when opened. */}
      {historySkill && (
        <SkillHistoryModal
          skillDir={historySkill.skillDir}
          skillName={historySkill.name}
          onClose={() => setHistorySkill(null)}
        />
      )}
    </div>
  );
}
