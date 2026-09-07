/**
 * The skill detail — one implementation, two callers.
 *
 * 「我的」 (SkillsSection) hangs its own header actions off it (enable toggle,
 * export, history, edit, delete); 「市场」 (ExternalSkillsPanel) passes none and
 * gets the read-only reading view. Everything below the header is identical by
 * construction, so a skill that arrived with a plugin is never described in a
 * different shape than one the user wrote.
 *
 * The panel owns the supporting-file viewer state: which file is open and
 * whether it renders as markdown or as source. That state is a function of the
 * open skill and nothing else, which is why it moved here with the markup.
 */

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight, Code, Eye, FileText, Folder, Info } from 'lucide-react';
import { useI18n } from '@/i18n';
import { skillLoader } from '@/core/skill/loader';
import MarkdownRenderer from '@/components/chat/MarkdownRenderer';
import ToolDetailModal from '@/components/toolbox/ToolDetailModal';
import { isSystemSkill } from './isSystemSkill';
import type { Skill } from '@/types';

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
        isActive ? 'bg-[var(--abu-bg-hover)] text-[var(--abu-text-primary)]' : 'text-[var(--abu-text-muted)] hover:bg-[var(--abu-bg-active)]/60 hover:text-[var(--abu-text-primary)]'
      }`}
      style={{ marginLeft: ml }}
      onClick={() => onFileClick?.(node.path)}
    >
      <FileText className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{node.name}</span>
    </div>
  );
}

interface SkillDetailPanelProps {
  /** The open skill; `null` keeps the modal closed. */
  skill: Skill | null;
  onClose: () => void;
  /** Header-row controls (enable toggle / `···`). Omitted = read-only detail. */
  headerActions?: ReactNode;
  /** Hand Escape to a nested modal stacked on top (e.g. skill history). */
  disableEscape?: boolean;
}

export default function SkillDetailPanel({ skill, onClose, headerActions, disableEscape }: SkillDetailPanelProps) {
  const { t } = useI18n();
  // Content view mode: preview (rendered) or source (raw)
  const [contentViewMode, setContentViewMode] = useState<'preview' | 'source'>('preview');
  // Supporting-file browsing. `activeFilePath` = 'SKILL.md' shows skill.content;
  // any other path loads via skillLoader on demand.
  const [modalFiles, setModalFiles] = useState<string[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string>('SKILL.md');
  const [activeFileContent, setActiveFileContent] = useState<string | null>(null);

  const skillName = skill?.name ?? null;

  // Load the open skill's supporting files; reset the viewer to SKILL.md.
  useEffect(() => {
    setActiveFilePath('SKILL.md');
    setActiveFileContent(null);
    if (!skillName) { setModalFiles([]); return; }
    let cancelled = false;
    skillLoader.listSupportingFiles(skillName)
      .then((files) => { if (!cancelled) setModalFiles(files); })
      .catch(() => { if (!cancelled) setModalFiles([]); });
    return () => { cancelled = true; };
  }, [skillName]);

  // Load a supporting file's content on demand (SKILL.md uses skill.content).
  useEffect(() => {
    if (!skillName || activeFilePath === 'SKILL.md') { setActiveFileContent(null); return; }
    let cancelled = false;
    setActiveFileContent(null);
    skillLoader.loadSupportingFile(skillName, activeFilePath)
      .then((content) => { if (!cancelled) setActiveFileContent(content ?? ''); })
      .catch(() => { if (!cancelled) setActiveFileContent(''); });
    return () => { cancelled = true; };
  }, [skillName, activeFilePath]);

  return (
    <ToolDetailModal
      open={!!skill}
      onClose={onClose}
      disableEscape={disableEscape}
      maxWidth="max-w-2xl"
      avatar={skill ? <FileText className="h-6 w-6 text-[var(--abu-text-muted)]" /> : undefined}
      title={skill?.name}
      headerActions={skill ? headerActions : undefined}
    >
      {skill && (
        <div data-testid="skill-detail" className="space-y-5">
          {/* Added by */}
          <div>
            <div className="text-minor text-[var(--abu-text-muted)] mb-0.5">{t.toolbox.skillAddedBy}</div>
            <div className="text-body font-medium text-[var(--abu-text-primary)]">{
              skill.source === 'builtin' ? t.toolbox.skillSourceBuiltin :
              skill.source === 'user' ? t.toolbox.skillSourceUser :
              skill.source === 'standard' ? t.toolbox.skillSourceStandard :
              (skill.source === 'project' || skill.source === 'project-standard') ? t.toolbox.skillSourceProject :
              skill.source === 'plugin' ? t.toolbox.skillSourcePlugin :
                skill.source === 'enterprise' ? t.toolbox.organizationSource :
              (isSystemSkill(skill) ? t.toolbox.skillSourceBuiltin : t.toolbox.skillSourceUser)
            }</div>
          </div>

          {/* Description */}
          <div>
            <div className="flex items-center gap-1 mb-1.5">
              <span className="text-minor text-[var(--abu-text-muted)]">Description</span>
              <Info className="h-3 w-3 text-[var(--abu-text-muted)]" />
            </div>
            <p className="text-body text-[var(--abu-text-primary)] leading-relaxed">{skill.description}</p>
          </div>

          {/* Files: SKILL.md + supporting files, with an on-demand viewer */}
          {(() => {
            const isMd = activeFilePath.endsWith('.md');
            const displayContent = activeFilePath === 'SKILL.md' ? skill.content : activeFileContent;
            const fileTree = buildFileTree(modalFiles);
            return (
              <div className="border border-[var(--abu-border)] rounded-lg overflow-hidden">
                {/* File list — only when the skill ships supporting files */}
                {modalFiles.length > 0 && (
                  <div className="max-h-40 overflow-y-auto overlay-scroll border-b border-[var(--abu-border)] p-1.5 space-y-0.5">
                    <div
                      className={`flex items-center gap-2 py-1 px-2 rounded-md cursor-pointer text-body transition-colors ${
                        activeFilePath === 'SKILL.md' ? 'bg-[var(--abu-bg-hover)] text-[var(--abu-text-primary)]' : 'text-[var(--abu-text-muted)] hover:bg-[var(--abu-bg-active)]/60 hover:text-[var(--abu-text-primary)]'
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
  );
}
