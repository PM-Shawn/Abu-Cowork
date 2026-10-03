/** Skill contents and supporting files; the owning page supplies the released header actions. */

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { IconButton } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Pressable } from '@/components/ds/pressable';
import { Spinner } from '@/components/ds/spinner';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { skillLoader } from '@/core/skill/loader';
import MarkdownRenderer from '@/components/chat/MarkdownRenderer';
import ToolDetailModal from '@/components/toolbox/ToolDetailModal';
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

// One row of the file list: a folder that opens, or a file the viewer shows.
const FILE_ROW = 'flex w-full items-center gap-2 rounded-control px-2 py-1 text-left text-ui';
const fileRowTone = (active: boolean) => (active ? 'bg-fill-selected text-label' : 'text-label-secondary hover:bg-fill-hover hover:text-label');

/** Recursive file tree row — indent adapted for the modal (no list-panel base offset). */
function FileTreeItem({
  node, depth = 0, selectedFile, onFileClick,
}: {
  node: FileNode; depth?: number;
  selectedFile?: string | null;
  onFileClick?: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const indent = { marginLeft: depth * 16 };

  if (node.isDir) {
    return (
      <div>
        <div style={indent}>
          <Pressable aria-expanded={expanded} className={cn(FILE_ROW, fileRowTone(false))} onClick={() => setExpanded(!expanded)}>
            <Icon icon={expanded ? AppIcons.expand : AppIcons.disclose} size="sm" />
            <Icon icon={AppIcons.folder} size="sm" />
            <span className="truncate">{node.name}</span>
          </Pressable>
        </div>
        {expanded && node.children.map((child) => (
          <FileTreeItem key={child.path} node={child} depth={depth + 1} selectedFile={selectedFile} onFileClick={onFileClick} />
        ))}
      </div>
    );
  }

  const isActive = selectedFile === node.path;
  return (
    <div style={indent}>
      <Pressable aria-current={isActive || undefined} className={cn(FILE_ROW, fileRowTone(isActive))} onClick={() => onFileClick?.(node.path)}>
        <Icon icon={AppIcons.file} size="sm" />
        <span className="truncate">{node.name}</span>
      </Pressable>
    </div>
  );
}

interface SkillDetailPanelProps {
  /** The open skill; `null` keeps the modal closed. */
  skill: Skill | null;
  onClose: () => void;
  /** Header-row controls (enable toggle / `···`). Omitted = read-only detail. */
  headerActions?: ReactNode;
  footer?: ReactNode;
  /** Accepted for callers written before the layer registry; one dialog is open at a time, so it has no effect. */
  disableEscape?: boolean;
  /** Runs once the window has gone; `event.preventDefault()` there keeps the focus from returning to the card that opened it. */
  onCloseAutoFocus?: (event: Event) => void;
}

export default function SkillDetailPanel({ skill, onClose, headerActions, footer, disableEscape, onCloseAutoFocus }: SkillDetailPanelProps) {
  const { t } = useI18n();
  // Content view mode: preview (rendered) or source (raw)
  const [contentViewMode, setContentViewMode] = useState<'preview' | 'source'>('preview');
  // Supporting-file browsing. `activeFilePath` = 'SKILL.md' shows skill.content;
  // any other path loads via skillLoader on demand.
  const [modalFiles, setModalFiles] = useState<string[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string>('SKILL.md');
  const [activeFileContent, setActiveFileContent] = useState<string | null>(null);

  // The window keeps showing the skill it held while it fades out.
  const [held, setHeld] = useState(skill);
  if (skill && skill !== held) setHeld(skill);
  const shown = skill ?? held;

  const skillName = skill?.name ?? null;

  // Load the open skill's supporting files; reset the viewer to SKILL.md.
  // A closing window (no skill) keeps what it shows.
  useEffect(() => {
    if (!skillName) return;
    setActiveFilePath('SKILL.md');
    setActiveFileContent(null);
    setModalFiles([]);
    let cancelled = false;
    skillLoader.listSupportingFiles(skillName)
      .then((files) => { if (!cancelled) setModalFiles(files); })
      .catch(() => { if (!cancelled) setModalFiles([]); });
    return () => { cancelled = true; };
  }, [skillName]);

  // Load a supporting file's content on demand (SKILL.md uses skill.content).
  useEffect(() => {
    if (!skillName) return;
    if (activeFilePath === 'SKILL.md') { setActiveFileContent(null); return; }
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
      // The window's name is the skill's: the heading inside adds the word for what it is.
      ariaLabel={shown?.name}
      onClose={onClose}
      onCloseAutoFocus={onCloseAutoFocus}
      disableEscape={disableEscape}
      maxWidth="max-w-2xl"
      avatar={shown ? <Icon icon={AppIcons.file} size="lg" className="text-label-tertiary" /> : undefined}
      stackedHeader
      headerActions={shown ? headerActions : undefined}
      footer={shown ? footer : undefined}
    >
      {shown && (
        <div data-testid="skill-detail" className="space-y-5">
          <div className="space-y-2">
            <h2 className="text-title text-label">
              {shown.name} <span className="font-normal text-label-tertiary">Skill</span>
            </h2>
            <p className="text-ui text-label-secondary">{shown.description}</p>
          </div>

          {/* Files: SKILL.md + supporting files, with an on-demand viewer */}
          {(() => {
            const isMd = activeFilePath.endsWith('.md');
            const displayContent = activeFilePath === 'SKILL.md' ? shown.content : activeFileContent;
            const fileTree = buildFileTree(modalFiles);
            return (
              <div className="overflow-hidden rounded-panel border border-separator">
                {/* File list — only when the skill ships supporting files */}
                {modalFiles.length > 0 && (
                  <div className="max-h-40 space-y-1 overflow-y-auto overlay-scroll border-b border-separator p-1">
                    <Pressable
                      aria-current={activeFilePath === 'SKILL.md' || undefined}
                      className={cn(FILE_ROW, fileRowTone(activeFilePath === 'SKILL.md'))}
                      onClick={() => setActiveFilePath('SKILL.md')}
                    >
                      <Icon icon={AppIcons.file} size="sm" />
                      <span className="truncate">SKILL.md</span>
                    </Pressable>
                    {fileTree.map((node) => (
                      <FileTreeItem key={node.path} node={node} selectedFile={activeFilePath} onFileClick={setActiveFilePath} />
                    ))}
                  </div>
                )}
                {/* Viewer header: active filename + preview/source toggle */}
                <div className="flex items-center justify-between gap-2 border-b border-separator px-4 py-2">
                  <span className="truncate text-ui-sm font-medium text-label-secondary">{activeFilePath}</span>
                  <div className="flex shrink-0 items-center gap-1">
                    <IconButton
                      size="sm"
                      icon={AppIcons.preview}
                      label={t.panel.previewMode}
                      aria-pressed={contentViewMode === 'preview'}
                      onClick={() => setContentViewMode('preview')}
                    />
                    <IconButton
                      size="sm"
                      icon={AppIcons.viewSource}
                      label={t.panel.sourceMode}
                      aria-pressed={contentViewMode === 'source'}
                      onClick={() => setContentViewMode('source')}
                    />
                  </div>
                </div>
                {/* Content */}
                <div className="bg-code p-5">
                  {displayContent === null ? (
                    <div className="flex justify-center py-6"><Spinner size="sm" label={t.common.loading} /></div>
                  ) : contentViewMode === 'preview' && isMd ? (
                    <MarkdownRenderer content={displayContent} />
                  ) : (
                    <pre className="whitespace-pre-wrap break-words font-code text-ui-sm text-label">{displayContent}</pre>
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
