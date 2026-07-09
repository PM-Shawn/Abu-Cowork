import { useState, useEffect } from 'react';
import { useI18n, format } from '@/i18n';
import { scanMemoryFiles, readMemoryFile } from '@/core/memdir/scan';
import { deleteMemory, clearAllMemories } from '@/core/memdir/write';
import type { MemoryHeader, MemoryType } from '@/core/memdir/types';
import ConfirmDialog from './ConfirmDialog';
import { ChevronDown, ChevronUp, Trash2 } from 'lucide-react';

interface ProjectMemoryProps {
  open: boolean;
  onClose: () => void;
  scope: 'project';
  workspacePath: string;
}

interface PersonalMemoryProps {
  open: boolean;
  onClose: () => void;
  scope: 'personal';
  workspacePath?: never;
}

type MemoryViewModalProps = ProjectMemoryProps | PersonalMemoryProps;

const TYPE_COLORS: Record<MemoryType, string> = {
  user: 'bg-orange-100 text-orange-700 dark:bg-orange-400/15 dark:text-orange-300',
  project: 'bg-purple-100 text-purple-700 dark:bg-purple-400/15 dark:text-purple-300',
  feedback: 'bg-teal-100 text-teal-700 dark:bg-teal-400/15 dark:text-teal-300',
  reference: 'bg-blue-100 text-blue-700 dark:bg-blue-400/15 dark:text-blue-300',
};

function getTypeLabel(type: MemoryType, t: ReturnType<typeof useI18n>['t']): string {
  const map: Record<MemoryType, string> = {
    user: t.memory.categoryPreference,
    project: t.memory.categoryProject,
    feedback: t.memory.categoryFeedback,
    reference: t.memory.categoryFact,
  };
  return map[type];
}

function formatAge(timestamp: number, t: ReturnType<typeof useI18n>['t']): string {
  const diffMs = Date.now() - timestamp;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 60) return format(t.memory.minutesAgo, { n: String(minutes) });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return format(t.memory.hoursAgo, { n: String(hours) });
  const days = Math.floor(hours / 24);
  if (days < 30) return format(t.memory.daysAgo, { n: String(days) });
  return format(t.memory.monthsAgo, { n: String(Math.floor(days / 30)) });
}

export default function MemoryViewModal(props: MemoryViewModalProps) {
  const { open, onClose, scope } = props;
  const { t } = useI18n();
  const [headers, setHeaders] = useState<MemoryHeader[]>([]);
  const [expandedContent, setExpandedContent] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<MemoryHeader | null>(null);

  const isPersonal = scope === 'personal';
  const wsPath = isPersonal ? null : props.workspacePath;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const items = await scanMemoryFiles(wsPath);
        if (!cancelled) setHeaders(items.sort((a, b) => b.updated - a.updated));
      } catch {
        if (!cancelled) setHeaders([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [open, wsPath]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const handleExpand = async (header: MemoryHeader) => {
    const id = header.filename;
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    if (!expandedContent[id]) {
      const file = await readMemoryFile(header.filePath);
      if (file) {
        setExpandedContent(prev => ({ ...prev, [id]: file.content }));
      }
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteMemory(deleteTarget.filename, wsPath);
      setDeleteTarget(null);
      const items = await scanMemoryFiles(wsPath);
      setHeaders(items.sort((a, b) => b.updated - a.updated));
    } catch (err) {
      console.error('Failed to delete memory:', err);
    }
  };

  const handleClear = async () => {
    try {
      await clearAllMemories(wsPath);
      setHeaders([]);
      setShowClearConfirm(false);
    } catch (err) {
      console.error('Failed to clear memory:', err);
    }
  };

  const title = isPersonal ? t.sidebar.personalMemoryTitle : t.panel.memoryTitle;
  const desc = isPersonal ? t.sidebar.personalMemoryDesc : t.panel.memoryDesc;
  const accentColor = isPersonal ? 'var(--abu-clay)' : '#8b7ec8';

  return (
    <>
      <ConfirmDialog
        open={showClearConfirm}
        title={t.panel.memoryClearTitle}
        message={isPersonal ? t.sidebar.personalMemoryClearMessage : t.panel.memoryClearMessage}
        confirmText={t.panel.memoryClearConfirm}
        cancelText={t.common.cancel}
        onConfirm={handleClear}
        onCancel={() => setShowClearConfirm(false)}
        variant="danger"
      />

      <ConfirmDialog
        open={!!deleteTarget}
        title={t.memory.deleteTitle}
        message={deleteTarget?.name ?? ''}
        confirmText={t.common.delete}
        cancelText={t.common.cancel}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
        variant="danger"
      />

      <div
        className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 animate-in fade-in duration-150"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className="bg-[var(--abu-bg-base)] rounded-2xl shadow-xl w-[480px] flex flex-col p-6 animate-in zoom-in-95 duration-150">
          <h3 className="text-[16px] font-semibold text-[var(--abu-text-primary)] mb-1">
            {title}
          </h3>
          <p className="text-[13px] text-[var(--abu-text-muted)] mb-4">
            {desc}
          </p>

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div
                className="w-5 h-5 border-2 border-t-transparent rounded-full animate-spin"
                style={{ borderColor: accentColor, borderTopColor: 'transparent' }}
              />
            </div>
          ) : headers.length > 0 ? (
            <div className="max-h-[60vh] overflow-y-auto space-y-2 mb-4">
              <div className="text-[12px] text-[var(--abu-text-placeholder)] mb-2">
                {format(t.memory.entryCount, { count: String(headers.length) })}
              </div>
              {headers.map((header) => (
                <div
                  key={header.filename}
                  className="border border-[var(--abu-border)] rounded-lg bg-[var(--abu-bg-muted)] overflow-hidden"
                >
                  <div
                    className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-[var(--abu-bg-hover)] transition-colors"
                    onClick={() => handleExpand(header)}
                  >
                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 ${TYPE_COLORS[header.type]}`}>
                      {getTypeLabel(header.type, t)}
                    </span>
                    <span className="text-[12px] text-[var(--abu-text-primary)] flex-1 truncate">
                      {header.name}
                    </span>
                    <span className="text-[10px] text-[var(--abu-text-placeholder)] whitespace-nowrap shrink-0">
                      {formatAge(header.updated, t)}
                    </span>
                    {expandedId === header.filename ? (
                      <ChevronUp className="h-3 w-3 text-[var(--abu-text-placeholder)] shrink-0" />
                    ) : (
                      <ChevronDown className="h-3 w-3 text-[var(--abu-text-placeholder)] shrink-0" />
                    )}
                  </div>

                  {expandedId === header.filename && (
                    <div className="px-3 pb-2.5 border-t border-[var(--abu-bg-active)]">
                      <p className="text-[11px] text-[var(--abu-text-tertiary)] leading-relaxed mt-2 whitespace-pre-wrap">
                        {expandedContent[header.filename] ?? header.description}
                      </p>
                      <div className="flex justify-end mt-2">
                        <button
                          onClick={(e) => { e.stopPropagation(); setDeleteTarget(header); }}
                          className="p-1 rounded text-[var(--abu-text-placeholder)] hover:text-red-500 hover:bg-red-50 transition-colors"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="flex items-center justify-center py-12">
              <p className="text-[13px] text-[var(--abu-text-placeholder)]">
                {t.panel.memoryEmpty}
              </p>
            </div>
          )}

          <div className="flex gap-3">
            {headers.length > 0 && (
              <button
                onClick={() => setShowClearConfirm(true)}
                className="px-4 py-2.5 rounded-lg text-[13px] font-medium text-red-500 hover:bg-red-50 transition-colors"
              >
                {t.panel.memoryClear}
              </button>
            )}
            <div className="flex-1" />
            <button
              onClick={onClose}
              className="px-4 py-2.5 rounded-lg text-[13px] font-medium bg-[var(--abu-bg-muted)] text-[var(--abu-text-secondary)] hover:bg-[var(--abu-bg-hover)] transition-colors"
            >
              {t.common.close}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
