import { useState, useEffect, useRef } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { useProjectStore } from '@/stores/projectStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useI18n } from '@/i18n';
import { FolderClosed, FolderOpen, Plus, Pin, PinOff, Settings, Archive, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { format } from '@/i18n';
import type { Project } from '@/types/project';
import type { Conversation, ConversationStatus } from '@/types';

const MAX_VISIBLE_CONVERSATIONS = 5;

function ConvStatusDot({ status }: { status: ConversationStatus }) {
  if (status === 'running') {
    return <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shrink-0" />;
  }
  return null;
}

interface ProjectItemProps {
  project: Project;
  conversations: Conversation[];
  expanded: boolean;
  onNewTask: (projectId: string) => void;
  onOpenSettings: (projectId: string) => void;
}

export default function ProjectItem({ project, conversations, expanded, onNewTask, onOpenSettings }: ProjectItemProps) {
  const { t } = useI18n();
  const toggleExpanded = useProjectStore((s) => s.toggleExpanded);
  const togglePin = useProjectStore((s) => s.togglePin);
  const archiveProject = useProjectStore((s) => s.archiveProject);
  const deleteProject = useProjectStore((s) => s.deleteProject);
  const switchConversation = useChatStore((s) => s.switchConversation);
  const deleteConversation = useChatStore((s) => s.deleteConversation);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const setViewMode = useSettingsStore((s) => s.setViewMode);
  const viewMode = useSettingsStore((s) => s.viewMode);

  const setConversationProject = useChatStore((s) => s.setConversationProject);

  // Project header context menu
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  // Conversation context menu
  const [convMenu, setConvMenu] = useState<{ x: number; y: number; convId: string } | null>(null);
  // Archive confirmation dialog
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  useEffect(() => {
    if (!contextMenu && !convMenu) return;
    const handleClick = () => { setContextMenu(null); setConvMenu(null); };
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [contextMenu, convMenu]);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const menuWidth = 180, menuHeight = 200;
    const x = Math.min(e.clientX, window.innerWidth - menuWidth - 8);
    const y = Math.min(e.clientY, window.innerHeight - menuHeight - 8);
    setContextMenu({ x, y });
  };

  const handleConvClick = (convId: string) => {
    switchConversation(convId);
    setViewMode('chat');
  };

  const visibleConvs = conversations.slice(0, MAX_VISIBLE_CONVERSATIONS);
  const hasMore = conversations.length > MAX_VISIBLE_CONVERSATIONS;

  return (
    <div>
      {/* Project header row */}
      <div
        className="group flex items-center gap-1.5 px-2 rounded-lg transition-colors hover:bg-[var(--abu-bg-hover)]"
        onContextMenu={handleContextMenu}
      >
        <button
          onClick={() => toggleExpanded(project.id)}
          className="flex-1 min-w-0 flex items-center gap-1.5 py-1.5 text-left"
        >
          {expanded
            ? <FolderOpen className="h-3.5 w-3.5 text-[var(--abu-text-tertiary)] shrink-0" strokeWidth={1.5} />
            : <FolderClosed className="h-3.5 w-3.5 text-[var(--abu-text-tertiary)] shrink-0" strokeWidth={1.5} />
          }
          <span className="flex-1 truncate text-[13px] text-[var(--abu-text-secondary)]">
            {project.name}
          </span>
          {project.pinned && (
            <Pin className="h-3 w-3 text-[var(--abu-text-muted)] shrink-0" />
          )}
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onNewTask(project.id); }}
          className="p-0.5 text-[var(--abu-text-muted)] hover:text-[var(--abu-text-primary)] transition-colors opacity-0 group-hover:opacity-100 shrink-0"
          title={t.project.newTask}
        >
          <Plus className="h-3 w-3" />
        </button>
      </div>

      {/* Expanded content */}
      {expanded && (
        <div className="mt-0.5 space-y-px">
          {visibleConvs.map((conv) => {
            const isActive = conv.id === activeConversationId && viewMode === 'chat';
            return (
              <div
                key={conv.id}
                role="button"
                tabIndex={0}
                onClick={() => handleConvClick(conv.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const x = Math.min(e.clientX, window.innerWidth - 180);
                  const y = Math.min(e.clientY, window.innerHeight - 100);
                  setConvMenu({ x, y, convId: conv.id });
                }}
                className={cn(
                  'group/conv flex items-center gap-1.5 w-full pl-8 pr-2 py-1.5 rounded-lg text-[12px] transition-colors cursor-pointer',
                  isActive
                    ? 'bg-[var(--abu-bg-active)] text-[var(--abu-text-primary)]'
                    : 'text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-hover)] hover:text-[var(--abu-text-primary)]'
                )}
              >
                <ConvStatusDot status={conv.status ?? 'idle'} />
                <span className="flex-1 truncate">
                  {conv.title.replace(/\[Attachment:\s*`[^`]*`\]\s*/g, '').trim() || conv.title}
                </span>
                <button
                  onClick={(e) => { e.stopPropagation(); deleteConversation(conv.id); }}
                  className="h-4 w-4 flex items-center justify-center opacity-0 group-hover/conv:opacity-100 text-[var(--abu-text-tertiary)] hover:text-red-500 shrink-0"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            );
          })}

          {hasMore && (
            <button
              onClick={() => toggleExpanded(project.id)}
              className="w-full pl-8 pr-2 py-0.5 text-[11px] text-[var(--abu-text-muted)] hover:text-[var(--abu-text-tertiary)] text-left"
            >
              +{conversations.length - MAX_VISIBLE_CONVERSATIONS} more
            </button>
          )}

        </div>
      )}

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 bg-white rounded-lg shadow-lg border border-[var(--abu-border)] py-1 min-w-[160px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            onClick={() => { togglePin(project.id); setContextMenu(null); }}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-[13px] text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-active)]"
          >
            {project.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
            {project.pinned ? t.project.unpin : t.project.pin}
          </button>
          <button
            onClick={() => { onOpenSettings(project.id); setContextMenu(null); }}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-[13px] text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-active)]"
          >
            <Settings className="h-3.5 w-3.5" />
            {t.project.editSettings}
          </button>
          <button
            onClick={() => {
              // Open folder in Finder/Explorer
              import('@tauri-apps/plugin-opener').then(({ revealItemInDir }) => {
                revealItemInDir(project.workspacePath).catch(console.error);
              });
              setContextMenu(null);
            }}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-[13px] text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-active)]"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            {t.project.openInFinder}
          </button>
          <div className="my-1 border-t border-[var(--abu-border)]" />
          <button
            onClick={() => { setContextMenu(null); setShowArchiveConfirm(true); }}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-[13px] text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-active)]"
          >
            <Archive className="h-3.5 w-3.5" />
            {t.project.archive}
          </button>
          <button
            onClick={() => { setContextMenu(null); setShowDeleteConfirm(true); }}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-[13px] text-red-500 hover:bg-[var(--abu-bg-active)]"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t.project.delete}
          </button>
        </div>
      )}

      {/* Conversation context menu */}
      {convMenu && (
        <div
          className="fixed z-50 bg-white rounded-lg shadow-lg border border-[var(--abu-border)] py-1 min-w-[140px]"
          style={{ left: convMenu.x, top: convMenu.y }}
        >
          <button
            onClick={() => {
              setConversationProject(convMenu.convId, undefined);
              setConvMenu(null);
            }}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-[13px] text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-active)]"
          >
            {t.project.removeFromProject}
          </button>
          <button
            onClick={() => {
              deleteConversation(convMenu.convId);
              setConvMenu(null);
            }}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-[13px] text-red-500 hover:bg-[var(--abu-bg-active)]"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t.project.delete}
          </button>
        </div>
      )}

      {/* Archive confirmation dialog */}
      {showArchiveConfirm && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 animate-in fade-in duration-150"
          onClick={(e) => { if (e.target === e.currentTarget) setShowArchiveConfirm(false); }}
        >
          <div className="bg-white rounded-2xl shadow-xl w-[380px] p-6 animate-in zoom-in-95 duration-150">
            <h3 className="text-[16px] font-semibold text-[var(--abu-text-primary)] mb-2">
              {t.project.archiveProject}
            </h3>
            <p className="text-[14px] text-[var(--abu-text-tertiary)] leading-relaxed mb-6">
              {format(t.project.archiveConfirm, { name: project.name })}
            </p>
            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => setShowArchiveConfirm(false)}
                className="px-4 py-2 rounded-lg text-[13px] font-medium text-[var(--abu-text-tertiary)] hover:bg-[var(--abu-bg-muted)] transition-colors"
              >
                {t.project.cancel}
              </button>
              <button
                onClick={() => {
                  archiveProject(project.id);
                  setShowArchiveConfirm(false);
                }}
                className="px-4 py-2 rounded-lg text-[13px] font-medium text-white bg-red-500 hover:bg-red-600 transition-colors"
              >
                {t.project.archive}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation dialog */}
      {showDeleteConfirm && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 animate-in fade-in duration-150"
          onClick={(e) => { if (e.target === e.currentTarget) setShowDeleteConfirm(false); }}
        >
          <div className="bg-white rounded-2xl shadow-xl w-[380px] p-6 animate-in zoom-in-95 duration-150">
            <h3 className="text-[16px] font-semibold text-[var(--abu-text-primary)] mb-2">
              {t.project.deleteProject}
            </h3>
            <p className="text-[14px] text-[var(--abu-text-tertiary)] leading-relaxed mb-6">
              {t.project.deleteConfirm}
            </p>
            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="px-4 py-2 rounded-lg text-[13px] font-medium text-[var(--abu-text-tertiary)] hover:bg-[var(--abu-bg-muted)] transition-colors"
              >
                {t.project.cancel}
              </button>
              <button
                onClick={() => {
                  // Unlink conversations → they go back to Recents
                  for (const conv of conversations) {
                    setConversationProject(conv.id, undefined);
                  }
                  deleteProject(project.id);
                  setShowDeleteConfirm(false);
                }}
                className="px-4 py-2 rounded-lg text-[13px] font-medium text-white bg-red-500 hover:bg-red-600 transition-colors"
              >
                {t.project.delete}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
