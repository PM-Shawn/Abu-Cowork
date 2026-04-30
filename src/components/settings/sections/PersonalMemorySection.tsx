import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useI18n, format } from '@/i18n';
import { HelpCircle, Trash2, ChevronDown, ChevronUp, FolderOpen, Globe, ListChecks, X, Check } from 'lucide-react';
import { scanMemoryFiles, readMemoryFile } from '@/core/memdir/scan';
import { deleteMemory } from '@/core/memdir/write';
import type { MemoryHeader, MemoryType } from '@/core/memdir/types';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import ConfirmDialog from '@/components/common/ConfirmDialog';
import { Button } from '@/components/ui/button';

// Abu 设计 token：toolbar 按钮风格（对齐 AboutSection 的"检查更新"按钮）
const ABU_BTN_OUTLINE =
  'border border-[var(--abu-border)] bg-transparent text-[var(--abu-text-secondary)] ' +
  'hover:bg-[var(--abu-bg-active)] hover:text-[var(--abu-text-primary)] hover:border-[var(--abu-border-hover)] ' +
  'active:scale-[0.98]';

const ABU_BTN_GHOST =
  'bg-transparent text-[var(--abu-text-muted)] ' +
  'hover:bg-[var(--abu-bg-active)] hover:text-[var(--abu-text-primary)]';

const ABU_BTN_DESTRUCTIVE =
  'border border-red-200 bg-red-50 text-red-600 ' +
  'hover:bg-red-100 hover:border-red-300 hover:text-red-700 ' +
  'active:scale-[0.98]';

function getTypeLabel(type: MemoryType, t: ReturnType<typeof useI18n>['t']): string {
  const map: Record<MemoryType, string> = {
    user: t.memory.categoryPreference,
    project: t.memory.categoryProject,
    feedback: t.memory.categoryFeedback,
    reference: t.memory.categoryFact,
  };
  return map[type];
}

const TYPE_COLORS: Record<MemoryType, string> = {
  user: 'bg-orange-100 text-orange-700',
  project: 'bg-purple-100 text-purple-700',
  feedback: 'bg-teal-100 text-teal-700',
  reference: 'bg-blue-100 text-blue-700',
};

function formatAge(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}天前`;
  return `${Math.floor(days / 30)}个月前`;
}

function isUnused(header: MemoryHeader): boolean {
  // Never-recalled by the agent. accessCount is now meaningful (P1 removed
  // passive-injection bumps), so accessCount===0 means "the agent has never
  // pulled this via recall/read_memory" — a strong cleanup-candidate signal.
  return header.accessCount === 0;
}

function isAutoFlushUnused(header: MemoryHeader): boolean {
  return header.source === 'auto_flush' && header.accessCount === 0;
}

interface MemoryGroup {
  label: string;
  icon: 'global' | 'workspace';
  workspacePath: string | null;
  headers: MemoryHeader[];
}

interface SelectableEntry {
  key: string;
  header: MemoryHeader;
  workspacePath: string | null;
}

export default function PersonalMemorySection() {
  const { t } = useI18n();
  const [groups, setGroups] = useState<MemoryGroup[]>([]);
  const [expandedContent, setExpandedContent] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ header: MemoryHeader; workspacePath: string | null } | null>(null);
  const [showTip, setShowTip] = useState(false);
  const tipRef = useRef<HTMLDivElement>(null);
  const recentPaths = useWorkspaceStore((s) => s.recentPaths);

  // Bulk cleanup mode
  const [bulkMode, setBulkMode] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);

  const totalCount = groups.reduce((sum, g) => sum + g.headers.length, 0);

  // Flatten for bulk filters/operations — order matches group display order.
  const allEntries: SelectableEntry[] = useMemo(() => {
    const entries: SelectableEntry[] = [];
    for (const group of groups) {
      for (const header of group.headers) {
        entries.push({
          key: `${group.workspacePath ?? 'g'}:${header.filename}`,
          header,
          workspacePath: group.workspacePath,
        });
      }
    }
    return entries;
  }, [groups]);

  const loadEntries = useCallback(async () => {
    setLoading(true);
    try {
      const result: MemoryGroup[] = [];

      const globalItems = await scanMemoryFiles(null);
      if (globalItems.length > 0) {
        result.push({
          label: t.memory.globalMemories,
          icon: 'global',
          workspacePath: null,
          headers: globalItems.sort((a, b) => b.updated - a.updated),
        });
      }

      for (const wsPath of recentPaths) {
        try {
          const wsItems = await scanMemoryFiles(wsPath);
          if (wsItems.length > 0) {
            const folderName = wsPath.split('/').filter(Boolean).pop() || wsPath;
            result.push({
              label: folderName,
              icon: 'workspace',
              workspacePath: wsPath,
              headers: wsItems.sort((a, b) => b.updated - a.updated),
            });
          }
        } catch { /* skip inaccessible workspaces */ }
      }

      setGroups(result);
    } catch {
      setGroups([]);
    } finally {
      setLoading(false);
    }
  }, [recentPaths, t.memory]);

  useEffect(() => { loadEntries(); }, [loadEntries]);

  // Close tip on click outside
  useEffect(() => {
    if (!showTip) return;
    const handleClick = (e: MouseEvent) => {
      if (tipRef.current && !tipRef.current.contains(e.target as Node)) {
        setShowTip(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showTip]);

  const exitBulkMode = useCallback(() => {
    setBulkMode(false);
    setSelectedKeys(new Set());
  }, []);

  const toggleSelected = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectByFilter = (filter: (h: MemoryHeader) => boolean) => {
    const next = new Set<string>();
    for (const e of allEntries) {
      if (filter(e.header)) next.add(e.key);
    }
    setSelectedKeys(next);
  };

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
        setExpandedContent((prev) => ({ ...prev, [id]: file.content }));
      }
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteMemory(deleteTarget.header.filename, deleteTarget.workspacePath);
      setDeleteTarget(null);
      await loadEntries();
    } catch (err) {
      console.error('Failed to delete memory:', err);
    }
  };

  const handleBulkDelete = async () => {
    setBulkConfirmOpen(false);
    const targets = allEntries.filter((e) => selectedKeys.has(e.key));
    for (const target of targets) {
      try {
        await deleteMemory(target.header.filename, target.workspacePath);
      } catch (err) {
        console.error(`Failed to delete ${target.header.filename}:`, err);
      }
    }
    exitBulkMode();
    await loadEntries();
  };

  return (
    <>
      <ConfirmDialog
        open={!!deleteTarget}
        title={t.memory.deleteTitle}
        message={deleteTarget?.header.name ?? ''}
        confirmText={t.common.delete}
        cancelText={t.common.cancel}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
        variant="danger"
      />

      <ConfirmDialog
        open={bulkConfirmOpen}
        title={t.memory.bulkConfirmTitle}
        message={format(t.memory.bulkConfirmMessage, { count: String(selectedKeys.size) })}
        confirmText={t.common.delete}
        cancelText={t.common.cancel}
        onConfirm={handleBulkDelete}
        onCancel={() => setBulkConfirmOpen(false)}
        variant="danger"
      />

      <div className="space-y-4">
        <div>
          <div className="flex items-center gap-1.5 relative" ref={tipRef}>
            <h3 className="text-[15px] font-semibold text-[var(--abu-text-primary)]">
              {t.sidebar.personalMemoryTitle}
            </h3>
            <button
              onClick={() => setShowTip(!showTip)}
              className="text-[var(--abu-text-placeholder)] hover:text-[var(--abu-text-muted)] transition-colors"
            >
              <HelpCircle className="h-3.5 w-3.5" />
            </button>

            {showTip && (
              <div className="absolute top-full left-0 mt-2 w-[340px] p-4 bg-white rounded-xl shadow-lg border border-[var(--abu-border)] z-50 animate-in fade-in slide-in-from-top-1 duration-150">
                <div className="space-y-2.5 text-[12px] text-[var(--abu-text-tertiary)] leading-relaxed">
                  <p className="text-[13px] text-[var(--abu-text-secondary)] font-medium">{t.sidebar.memoryGuideTitle}</p>
                  <div className="space-y-1.5">
                    <p><span className="font-medium text-[var(--abu-clay)]">{t.sidebar.memoryGuidePersonalName}</span> — {t.sidebar.memoryGuidePersonalDesc}</p>
                    <p><span className="font-medium text-[#8b7ec8]">{t.sidebar.memoryGuideProjectMemoryName}</span> — {t.sidebar.memoryGuideProjectMemoryDesc}</p>
                    <p><span className="font-medium text-[var(--abu-text-secondary)]">{t.sidebar.memoryGuideProjectRulesName}</span> — {t.sidebar.memoryGuideProjectRulesDesc}</p>
                  </div>
                  <p className="text-[11px] text-[var(--abu-text-muted)] border-t border-[var(--abu-bg-active)] pt-2">{t.sidebar.memoryGuideTip}</p>
                </div>
              </div>
            )}
          </div>
          <p className="text-[13px] text-[var(--abu-text-muted)] mt-1">
            {t.sidebar.personalMemoryDesc}
          </p>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="w-5 h-5 border-2 border-[var(--abu-clay)] border-t-transparent rounded-full animate-spin" />
          </div>
        ) : totalCount > 0 ? (
          <div className="space-y-4">
            {/* Top toolbar: count + bulk toggle / bulk actions */}
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="text-[12px] text-[var(--abu-text-placeholder)]">
                {bulkMode
                  ? format(t.memory.bulkSelected, { count: String(selectedKeys.size) })
                  : format(t.memory.entryCount, { count: String(totalCount) })}
              </div>
              {bulkMode ? (
                <div className="flex items-center gap-1.5 flex-wrap">
                  <Button size="xs" variant="ghost" className={ABU_BTN_OUTLINE} onClick={() => selectByFilter(isAutoFlushUnused)}>
                    {t.memory.bulkSelectAutoFlushUnused}
                  </Button>
                  <Button size="xs" variant="ghost" className={ABU_BTN_OUTLINE} onClick={() => selectByFilter(isUnused)}>
                    {t.memory.bulkSelectUnused}
                  </Button>
                  <Button size="xs" variant="ghost" className={ABU_BTN_OUTLINE} onClick={() => selectByFilter(() => true)}>
                    {t.memory.bulkSelectAll}
                  </Button>
                  <Button size="xs" variant="ghost" className={ABU_BTN_OUTLINE} onClick={() => setSelectedKeys(new Set())}>
                    {t.memory.bulkClearSelection}
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    className={selectedKeys.size === 0 ? ABU_BTN_OUTLINE : ABU_BTN_DESTRUCTIVE}
                    disabled={selectedKeys.size === 0}
                    onClick={() => setBulkConfirmOpen(true)}
                  >
                    <Trash2 className="h-3 w-3 mr-1" />
                    {t.memory.bulkDelete}
                  </Button>
                  <Button size="xs" variant="ghost" className={ABU_BTN_GHOST} onClick={exitBulkMode}>
                    <X className="h-3 w-3 mr-1" />
                    {t.memory.bulkExit}
                  </Button>
                </div>
              ) : (
                <Button size="xs" variant="ghost" className={ABU_BTN_OUTLINE} onClick={() => setBulkMode(true)}>
                  <ListChecks className="h-3 w-3 mr-1" />
                  {t.memory.bulkCleanup}
                </Button>
              )}
            </div>

            {groups.map((group) => (
              <div key={group.workspacePath ?? '__global__'} className="space-y-2">
                {/* Group header */}
                <div className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--abu-text-muted)] uppercase tracking-wider">
                  {group.icon === 'global' ? (
                    <Globe className="h-3 w-3" />
                  ) : (
                    <FolderOpen className="h-3 w-3" />
                  )}
                  <span>{group.label}</span>
                  <span className="text-[var(--abu-text-placeholder)]">({group.headers.length})</span>
                </div>

                {/* Group entries */}
                {group.headers.map((header) => {
                  const key = `${group.workspacePath ?? 'g'}:${header.filename}`;
                  const isSelected = selectedKeys.has(key);
                  return (
                    <div
                      key={key}
                      className={`border rounded-lg overflow-hidden transition-colors ${
                        bulkMode && isSelected
                          ? 'border-[var(--abu-clay)] bg-orange-50/50'
                          : 'border-[var(--abu-border)] bg-[var(--abu-bg-muted)]'
                      }`}
                    >
                      <div
                        className="flex items-center gap-2 px-3 py-2.5 cursor-pointer hover:bg-[var(--abu-bg-hover)] transition-colors"
                        onClick={() => bulkMode ? toggleSelected(key) : handleExpand(header)}
                      >
                        {bulkMode && (
                          <span
                            className={`flex h-4 w-4 items-center justify-center rounded-full border transition-colors ${
                              isSelected
                                ? 'border-[var(--abu-clay)] bg-[var(--abu-clay)] text-white'
                                : 'border-[var(--abu-text-placeholder)]'
                            }`}
                          >
                            {isSelected && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
                          </span>
                        )}
                        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${TYPE_COLORS[header.type]}`}>
                          {getTypeLabel(header.type, t)}
                        </span>
                        <span className="text-[13px] text-[var(--abu-text-primary)] flex-1 truncate">
                          {header.name}
                        </span>
                        <span className="text-[11px] text-[var(--abu-text-placeholder)] whitespace-nowrap">
                          {formatAge(header.updated)}
                        </span>
                        {!bulkMode && (
                          expandedId === header.filename ? (
                            <ChevronUp className="h-3.5 w-3.5 text-[var(--abu-text-placeholder)]" />
                          ) : (
                            <ChevronDown className="h-3.5 w-3.5 text-[var(--abu-text-placeholder)]" />
                          )
                        )}
                      </div>

                      {!bulkMode && expandedId === header.filename && (
                        <div className="px-3 pb-3 border-t border-[var(--abu-bg-active)]">
                          <p className="text-[12px] text-[var(--abu-text-tertiary)] leading-relaxed mt-2 whitespace-pre-wrap">
                            {expandedContent[header.filename] ?? header.description}
                          </p>
                          <div className="flex items-center justify-between mt-2 pt-2 border-t border-[var(--abu-bg-muted)]">
                            <span className="text-[10px] text-[var(--abu-text-placeholder)]">
                              {header.source === 'auto_flush' ? t.memory.sourceAutoFlush : header.source === 'agent_explicit' ? t.memory.sourceAgentExplicit : t.memory.sourceUserManual}
                              {' · '}
                              {format(t.memory.recallCount, { count: String(header.accessCount) })}
                            </span>
                            <button
                              onClick={(e) => { e.stopPropagation(); setDeleteTarget({ header, workspacePath: group.workspacePath }); }}
                              className="p-1 rounded text-[var(--abu-text-placeholder)] hover:text-red-500 hover:bg-red-50 transition-colors"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <p className="text-[13px] text-[var(--abu-text-placeholder)]">
              {t.panel.memoryEmpty}
            </p>
            <p className="text-[12px] text-[var(--abu-text-placeholder)] mt-1">
              {t.memory.emptyHint}
            </p>
          </div>
        )}
      </div>
    </>
  );
}
