import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useI18n, format } from '@/i18n';
import { HelpCircle, Trash2, ChevronDown, ChevronUp, ChevronRight, FolderOpen, Globe, ListChecks, X, Check, Lock, AlertTriangle } from 'lucide-react';
import { scanMemoryFiles, readMemoryFile } from '@/core/memdir/scan';
import { deleteMemory, setMemoryPrivate, setMemoryDescription } from '@/core/memdir/write';
import { memoryAge, isStale } from '@/core/memdir/age';
import type { MemoryHeader, MemoryType } from '@/core/memdir/types';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useSettingsStore } from '@/stores/settingsStore';
import ConfirmDialog from '@/components/common/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { Toggle } from '@/components/ui/toggle';
import { Input } from '@/components/ui/input';

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

/**
 * Stale memory: 60+ days untouched. Replaces the old `isUnused` (accessCount-based)
 * filter — accessCount became meaningless after the v0.15 architecture shift to
 * Phase 2 content injection (memories are used without accessCount being bumped).
 * Recency is now the meaningful "is this still useful?" signal.
 */
function isStaleHeader(header: MemoryHeader): boolean {
  return isStale(header.updated);
}

function isAutoFlushStale(header: MemoryHeader): boolean {
  return header.source === 'auto_flush' && isStale(header.updated);
}

/**
 * Heuristic: does this description appear to leak content rather than just
 * stating a topic? Used to nudge the user when toggling private — if true,
 * we surface an inline hint suggesting a topic-only rewrite.
 *
 * Conservative criteria (false positives are fine; missed leaks are not):
 * - Length > 20 characters (topics are typically short)
 * - OR contains any digit (numbers usually mean values, not topics)
 * - OR contains a comma/period/中文逗号/中文句号 (compound description = content sketch)
 */
function descriptionLooksRevealing(description: string): boolean {
  const desc = description.trim();
  if (!desc) return false;
  if (desc.length > 20) return true;
  if (/\d/.test(desc)) return true;
  if (/[,，.。]/.test(desc)) return true;
  return false;
}

/**
 * Derive a safe topic-only description for a memory whose current
 * description leaks content. Tries the `name` field first (it's
 * usually short and topic-y); falls back to a type-based generic
 * if `name` itself also looks revealing.
 *
 * The user sees this pre-filled in the rewrite input and only has
 * to click "save" — no need to think up a topic themselves.
 */
function deriveTopicDescription(header: MemoryHeader): string {
  const name = header.name.trim();
  if (name && !descriptionLooksRevealing(name)) {
    return name;
  }
  switch (header.type) {
    case 'user': return '用户偏好';
    case 'feedback': return '用户反馈';
    case 'project': return '项目信息';
    case 'reference': return '外部资源';
  }
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
  const hasRunAudit = useSettingsStore((s) => s.hasRunSensitiveAudit_v015);
  const setShouldRunMemoryAudit = useSettingsStore((s) => s.setShouldRunMemoryAudit);

  // Trigger the one-shot sensitive-memory audit when the user first opens
  // this panel. SensitiveAuditDialog (mounted in App.tsx) handles the scan
  // and only shows a dialog if there are actual hits.
  useEffect(() => {
    if (!hasRunAudit) {
      setShouldRunMemoryAudit(true);
    }
  }, [hasRunAudit, setShouldRunMemoryAudit]);

  // Bulk cleanup mode
  const [bulkMode, setBulkMode] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);

  // Inline "rewrite description" hint, fired when toggling private on a
  // memory whose description looks like it leaks content. Keyed by
  // workspacePath:filename so only the relevant row shows the panel.
  // `draft` is the user-edited new description; `pristineDescription` lets
  // us show the original below the input for context.
  const [descHint, setDescHint] = useState<{
    key: string;
    pristineDescription: string;
    draft: string;
  } | null>(null);

  // Collapsed groups: workspace path key, '__global__' for the global group.
  // Default behavior: all groups start expanded so users see what's there;
  // toggling persists only within this session (intentional — users typically
  // want a fresh view each time they open settings).
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const toggleGroup = useCallback((key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

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

  const handleTogglePrivate = async (
    header: MemoryHeader,
    workspacePath: string | null,
    next: boolean,
  ) => {
    try {
      await setMemoryPrivate(header.filename, next, workspacePath);
      await loadEntries();
      // After flipping ON, surface the description-leak hint when the
      // existing description looks like a value rather than a topic.
      // Flipping OFF clears the hint regardless. Pre-fill `draft` with
      // a derived topic so the user just clicks save (or tweaks).
      const key = `${workspacePath ?? 'g'}:${header.filename}`;
      if (next && descriptionLooksRevealing(header.description)) {
        setDescHint({
          key,
          pristineDescription: header.description,
          draft: deriveTopicDescription(header),
        });
      } else if (descHint?.key === key) {
        setDescHint(null);
      }
    } catch (err) {
      console.error('Failed to toggle memory private flag:', err);
    }
  };

  const handleSaveDescription = async (
    header: MemoryHeader,
    workspacePath: string | null,
  ) => {
    if (!descHint) return;
    const draft = descHint.draft.trim();
    if (!draft) return;
    try {
      await setMemoryDescription(header.filename, draft, workspacePath);
      setDescHint(null);
      await loadEntries();
    } catch (err) {
      console.error('Failed to update memory description:', err);
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
                  <Button size="xs" variant="ghost" className={ABU_BTN_OUTLINE} onClick={() => selectByFilter(isAutoFlushStale)}>
                    {t.memory.bulkSelectAutoFlushUnused}
                  </Button>
                  <Button size="xs" variant="ghost" className={ABU_BTN_OUTLINE} onClick={() => selectByFilter(isStaleHeader)}>
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

            {groups.map((group) => {
              const groupKey = group.workspacePath ?? '__global__';
              const isCollapsed = collapsedGroups.has(groupKey);
              return (
              <div key={groupKey} className="space-y-2">
                {/* Group header — clickable to toggle collapse */}
                <button
                  type="button"
                  onClick={() => toggleGroup(groupKey)}
                  className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--abu-text-muted)] uppercase tracking-wider hover:text-[var(--abu-text-primary)] transition-colors w-full"
                >
                  {isCollapsed ? (
                    <ChevronRight className="h-3 w-3" />
                  ) : (
                    <ChevronDown className="h-3 w-3" />
                  )}
                  {group.icon === 'global' ? (
                    <Globe className="h-3 w-3" />
                  ) : (
                    <FolderOpen className="h-3 w-3" />
                  )}
                  <span>{group.label}</span>
                  <span className="text-[var(--abu-text-placeholder)]">({group.headers.length})</span>
                </button>

                {/* Group entries — hidden when collapsed */}
                {!isCollapsed && group.headers.map((header) => {
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
                        <span className="text-[13px] text-[var(--abu-text-primary)] flex-1 truncate flex items-center gap-1.5">
                          {header.name}
                          {header.private && (
                            <span title={t.memory.privateTooltip} className="shrink-0">
                              <Lock className="h-3 w-3 text-amber-600" />
                            </span>
                          )}
                        </span>
                        <span className="text-[11px] text-[var(--abu-text-placeholder)] whitespace-nowrap">
                          {format(t.memory.updatedAt, { age: memoryAge(header.updated) })}
                        </span>
                        {isStale(header.updated) && (
                          <span
                            className="text-[10px] text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded whitespace-nowrap"
                            title={t.memory.staleTooltip}
                          >
                            {t.memory.staleBadge}
                          </span>
                        )}
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
                          <div
                            className="flex items-start justify-between gap-3 mt-2 pt-2 border-t border-[var(--abu-bg-muted)]"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <div className="flex-1 min-w-0">
                              <div className="text-[10px] text-[var(--abu-text-placeholder)]">
                                {header.source === 'auto_flush' ? t.memory.sourceAutoFlush : header.source === 'agent_explicit' ? t.memory.sourceAgentExplicit : t.memory.sourceUserManual}
                              </div>
                              <div className="flex items-center gap-2 mt-1.5">
                                <Lock className="h-3 w-3 text-amber-600 shrink-0" />
                                <span className="text-[11px] text-[var(--abu-text-secondary)]">
                                  {t.memory.privateLabel}
                                </span>
                                <Toggle
                                  size="sm"
                                  checked={header.private}
                                  onChange={() => handleTogglePrivate(header, group.workspacePath, !header.private)}
                                />
                              </div>
                              <p className="text-[10.5px] text-[var(--abu-text-placeholder)] mt-1 leading-snug">
                                {t.memory.privateDesc}
                              </p>

                              {/* Description-leak hint: shown only when the
                                  user just flipped private ON for a memory
                                  whose description looks like a content leak.
                                  Closing requires explicit user action — no
                                  outside-click dismiss. */}
                              {descHint?.key === key && (
                                <div className="mt-2 p-2.5 border border-amber-200 bg-amber-50/60 rounded-md">
                                  <div className="flex items-start gap-1.5">
                                    <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0 mt-0.5" />
                                    <div className="flex-1 min-w-0">
                                      <div className="text-[11px] font-medium text-amber-900">
                                        {t.memory.privateDescHintTitle}
                                      </div>
                                      <p className="text-[10.5px] text-amber-800 leading-snug mt-0.5">
                                        {t.memory.privateDescHintBody}
                                      </p>
                                      <div className="mt-2">
                                        <div className="text-[10px] text-[var(--abu-text-placeholder)] mb-0.5">
                                          {t.memory.privateDescCurrent}：
                                        </div>
                                        <div className="text-[11px] text-[var(--abu-text-tertiary)] line-through truncate">
                                          {descHint.pristineDescription}
                                        </div>
                                      </div>
                                      <div className="mt-1.5">
                                        <label className="text-[10px] text-[var(--abu-text-placeholder)] block mb-0.5">
                                          {t.memory.privateDescNewLabel}
                                        </label>
                                        <Input
                                          type="text"
                                          value={descHint.draft}
                                          placeholder={t.memory.privateDescPlaceholder}
                                          onChange={(e) =>
                                            setDescHint((prev) =>
                                              prev ? { ...prev, draft: e.target.value } : prev,
                                            )
                                          }
                                          className="text-[11px]"
                                        />
                                      </div>
                                      <div className="flex items-center gap-1.5 mt-2">
                                        <Button
                                          size="xs"
                                          variant="default"
                                          disabled={!descHint.draft.trim()}
                                          onClick={() => handleSaveDescription(header, group.workspacePath)}
                                        >
                                          {t.memory.privateDescSave}
                                        </Button>
                                        <Button
                                          size="xs"
                                          variant="ghost"
                                          onClick={() => setDescHint(null)}
                                        >
                                          {t.memory.privateDescSkip}
                                        </Button>
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              )}
                            </div>
                            <button
                              onClick={(e) => { e.stopPropagation(); setDeleteTarget({ header, workspacePath: group.workspacePath }); }}
                              className="p-1 rounded text-[var(--abu-text-placeholder)] hover:text-red-500 hover:bg-red-50 transition-colors shrink-0"
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
              );
            })}
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
