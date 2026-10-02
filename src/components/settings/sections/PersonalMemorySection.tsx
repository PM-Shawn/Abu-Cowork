import { memo, useState, useEffect, useCallback, useId, useLayoutEffect, useRef, useMemo } from 'react';
import { useI18n, format } from '@/i18n';
import { scanMemoryFiles, readMemoryFile } from '@/core/memdir/scan';
import { deleteMemory, setMemoryPrivate, setMemoryDescription } from '@/core/memdir/write';
import { memoryAge, isStale } from '@/core/memdir/age';
import type { MemoryHeader, MemoryType } from '@/core/memdir/types';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { Button, IconButton } from '@/components/ds/button';
import { Checkbox } from '@/components/ds/checkbox';
import { useConfirm } from '@/components/ds/confirm-context';
import { EmptyState } from '@/components/ds/empty-state';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Popover } from '@/components/ds/popover';
import { Pressable } from '@/components/ds/pressable';
import { Spinner } from '@/components/ds/spinner';
import { StatusIcon } from '@/components/ds/status-icon';
import { Switch } from '@/components/ds/switch';
import { Tag } from '@/components/ds/tag';
import { TextField } from '@/components/ds/text-field';
import { cn } from '@/lib/utils';

function getTypeLabel(type: MemoryType, t: ReturnType<typeof useI18n>['t']): string {
  const map: Record<MemoryType, string> = {
    user: t.memory.categoryPreference,
    project: t.memory.categoryProject,
    feedback: t.memory.categoryFeedback,
    reference: t.memory.categoryFact,
  };
  return map[type];
}

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
function deriveTopicDescription(header: MemoryHeader, t: ReturnType<typeof useI18n>['t']): string {
  const name = header.name.trim();
  if (name && !descriptionLooksRevealing(name)) {
    return name;
  }
  switch (header.type) {
    case 'user': return t.memory.topicUser;
    case 'feedback': return t.memory.topicFeedback;
    case 'project': return t.memory.topicProject;
    case 'reference': return t.memory.topicReference;
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

interface DescriptionHint {
  key: string;
  pristineDescription: string;
  draft: string;
}

// What a row can ask the page to do. The object never changes, so a row is drawn again only
// when what it shows changes.
interface RowActions {
  toggleSelected: (key: string) => void;
  expand: (header: MemoryHeader) => void;
  togglePrivate: (header: MemoryHeader, workspacePath: string | null, next: boolean) => void;
  requestDelete: (header: MemoryHeader, workspacePath: string | null) => void;
  editHintDraft: (draft: string) => void;
  saveDescription: (header: MemoryHeader, workspacePath: string | null) => void;
  dismissHint: () => void;
}

function entryKey(workspacePath: string | null, filename: string): string {
  return `${workspacePath ?? 'g'}:${filename}`;
}

// One memory. A collapsed row mounts no tooltip, menu or other floating root, so a long list
// adds no listeners to the page.
const MemoryRow = memo(function MemoryRow({ header, workspacePath, bulkMode, selected, expanded, content, hint, actions }: {
  header: MemoryHeader;
  workspacePath: string | null;
  bulkMode: boolean;
  selected: boolean;
  expanded: boolean;
  // The file's text once it has been read; the description stands in until then.
  content: string | undefined;
  // Set only on the row whose description the page suggests rewriting.
  hint: DescriptionHint | null;
  actions: RowActions;
}) {
  const { t } = useI18n();
  const id = useId();
  const key = entryKey(workspacePath, header.filename);

  const summary = (
    <>
      <Tag>{getTypeLabel(header.type, t)}</Tag>
      <span className="flex min-w-0 flex-1 items-center gap-2 text-ui text-label">
        <span className="truncate">{header.name}</span>
        {header.private && (
          <span title={t.memory.privateTooltip} className="flex shrink-0">
            <Icon icon={AppIcons.private} size="sm" className="text-label-tertiary" />
          </span>
        )}
      </span>
      <span className="whitespace-nowrap text-caption text-label-tertiary">
        {format(t.memory.updatedAt, { age: memoryAge(header.updated) })}
      </span>
      {isStale(header.updated) && (
        <span title={t.memory.staleTooltip} className="flex shrink-0">
          <Tag tone="warning">{t.memory.staleBadge}</Tag>
        </span>
      )}
    </>
  );

  return (
    <div className={cn('rounded-panel border', bulkMode && selected ? 'border-control-border bg-fill-selected' : 'border-separator')}>
      {bulkMode ? (
        // The whole row ticks its box: the row is the box's label.
        <label htmlFor={`${id}-box`} className="flex items-center gap-2 rounded-panel px-3 py-2 hover:bg-fill-hover">
          <Checkbox id={`${id}-box`} checked={selected} onCheckedChange={() => actions.toggleSelected(key)} />
          {summary}
        </label>
      ) : (
        <Pressable
          aria-expanded={expanded}
          onClick={() => actions.expand(header)}
          className="flex w-full items-center gap-2 rounded-panel px-3 py-2 text-left hover:bg-fill-hover"
        >
          {summary}
          <Icon icon={expanded ? AppIcons.collapse : AppIcons.expand} size="sm" className="text-label-tertiary" />
        </Pressable>
      )}

      {!bulkMode && expanded && (
        <div className="border-t border-separator px-3 pb-3">
          <p className="mt-3 whitespace-pre-wrap rounded-control bg-code p-3 font-code text-ui-sm text-label-secondary">
            {content ?? header.description}
          </p>
          <div className="mt-3 flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-caption text-label-tertiary">
                {header.source === 'auto_flush' ? t.memory.sourceAutoFlush : header.source === 'agent_explicit' ? t.memory.sourceAgentExplicit : t.memory.sourceUserManual}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <Icon icon={AppIcons.private} size="sm" className="text-label-tertiary" />
                <span className="text-ui-sm text-label-secondary">
                  {t.memory.privateLabel}
                </span>
                <Switch
                  aria-label={t.memory.privateLabel}
                  checked={header.private}
                  onCheckedChange={() => actions.togglePrivate(header, workspacePath, !header.private)}
                />
              </div>
              <p className="mt-1 text-caption text-label-tertiary">
                {t.memory.privateDesc}
              </p>

              {/* Description-leak hint: shown only when the
                  user just flipped private ON for a memory
                  whose description looks like a content leak.
                  Closing requires explicit user action — no
                  outside-click dismiss. */}
              {hint && (
                <div className="mt-2 flex items-start gap-2 rounded-control bg-warning-soft p-3">
                  <StatusIcon tone="warning" size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="text-ui-sm font-medium text-label">
                      {t.memory.privateDescHintTitle}
                    </div>
                    <p className="mt-1 text-ui-sm text-label-secondary">
                      {t.memory.privateDescHintBody}
                    </p>
                    <div className="mt-2">
                      <div className="text-caption text-label-tertiary">
                        {t.memory.privateDescCurrent}：
                      </div>
                      <div className="truncate text-caption text-label-secondary line-through">
                        {hint.pristineDescription}
                      </div>
                    </div>
                    <div className="mt-2">
                      <label htmlFor={`${id}-description`} className="mb-1 block text-caption text-label-tertiary">
                        {t.memory.privateDescNewLabel}
                      </label>
                      <TextField
                        id={`${id}-description`}
                        value={hint.draft}
                        placeholder={t.memory.privateDescPlaceholder}
                        onChange={(e) => actions.editHintDraft(e.target.value)}
                      />
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={!hint.draft.trim()}
                        onClick={() => actions.saveDescription(header, workspacePath)}
                      >
                        {t.memory.privateDescSave}
                      </Button>
                      <Button size="sm" variant="plain" onClick={actions.dismissHint}>
                        {t.memory.privateDescSkip}
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </div>
            <IconButton
              size="sm"
              icon={AppIcons.delete}
              label={t.common.delete}
              onClick={() => actions.requestDelete(header, workspacePath)}
            />
          </div>
        </div>
      )}
    </div>
  );
});

export default function PersonalMemorySection() {
  const { t } = useI18n();
  const confirm = useConfirm();
  const [groups, setGroups] = useState<MemoryGroup[]>([]);
  const [expandedContent, setExpandedContent] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
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

  // Inline "rewrite description" hint, fired when toggling private on a
  // memory whose description looks like it leaks content. Keyed by
  // workspacePath:filename so only the relevant row shows the panel.
  // `draft` is the user-edited new description; `pristineDescription` lets
  // us show the original below the input for context.
  const [descHint, setDescHint] = useState<DescriptionHint | null>(null);

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
          key: entryKey(group.workspacePath, header.filename),
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

  // What the list holds now. A question stays open while the list is read again, so its answer
  // is checked against this, never against what the list held when the question was asked.
  const current = useRef({ allEntries, selectedKeys });
  useLayoutEffect(() => { current.current = { allEntries, selectedKeys }; });

  const requestDelete = async (header: MemoryHeader, workspacePath: string | null) => {
    const key = entryKey(workspacePath, header.filename);
    const confirmed = await confirm({
      title: t.memory.deleteTitle,
      message: header.name,
      confirmLabel: t.common.delete,
      tone: 'danger',
    });
    if (!confirmed) return;
    // The memory the question named: still in the list, and still that memory.
    const target = current.current.allEntries.find((entry) => entry.key === key);
    if (!target || target.header.name !== header.name) return;
    try {
      await deleteMemory(target.header.filename, target.workspacePath);
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
      const key = entryKey(workspacePath, header.filename);
      if (next && descriptionLooksRevealing(header.description)) {
        setDescHint({
          key,
          pristineDescription: header.description,
          draft: deriveTopicDescription(header, t),
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

  const requestBulkDelete = async () => {
    const confirmed = await confirm({
      title: t.memory.bulkConfirmTitle,
      message: format(t.memory.bulkConfirmMessage, { count: String(selectedKeys.size) }),
      confirmLabel: t.common.delete,
      tone: 'danger',
    });
    if (!confirmed) return;
    // Only the ticked memories that are still in the list.
    const now = current.current;
    const targets = now.allEntries.filter((e) => now.selectedKeys.has(e.key));
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

  // The handlers above read this render's state. Rows get one object that never changes and
  // always reaches the newest handlers.
  const handlers = useRef({ toggleSelected, handleExpand, handleTogglePrivate, requestDelete, handleSaveDescription });
  useLayoutEffect(() => {
    handlers.current = { toggleSelected, handleExpand, handleTogglePrivate, requestDelete, handleSaveDescription };
  });
  const rowActions = useMemo<RowActions>(() => ({
    toggleSelected: (key) => handlers.current.toggleSelected(key),
    expand: (header) => { void handlers.current.handleExpand(header); },
    togglePrivate: (header, workspacePath, next) => { void handlers.current.handleTogglePrivate(header, workspacePath, next); },
    requestDelete: (header, workspacePath) => { void handlers.current.requestDelete(header, workspacePath); },
    editHintDraft: (draft) => setDescHint((prev) => (prev ? { ...prev, draft } : prev)),
    saveDescription: (header, workspacePath) => { void handlers.current.handleSaveDescription(header, workspacePath); },
    dismissHint: () => setDescHint(null),
  }), []);

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center gap-2">
          <h3 className="text-title text-label">
            {t.sidebar.personalMemoryTitle}
          </h3>
          <Popover
            align="start"
            className="w-85"
            trigger={(
              <Pressable aria-label={t.sidebar.memoryGuideTitle} className="inline-flex rounded-control text-label-tertiary hover:text-label">
                <Icon icon={AppIcons.info} size="sm" />
              </Pressable>
            )}
          >
            <div className="space-y-2 text-ui-sm text-label-secondary">
              <p className="text-ui font-medium text-label">{t.sidebar.memoryGuideTitle}</p>
              <div className="space-y-1">
                <p><span className="font-medium text-label">{t.sidebar.memoryGuidePersonalName}</span> — {t.sidebar.memoryGuidePersonalDesc}</p>
                <p><span className="font-medium text-label">{t.sidebar.memoryGuideProjectMemoryName}</span> — {t.sidebar.memoryGuideProjectMemoryDesc}</p>
                <p><span className="font-medium text-label">{t.sidebar.memoryGuideProjectRulesName}</span> — {t.sidebar.memoryGuideProjectRulesDesc}</p>
              </div>
              <p className="border-t border-separator pt-2 text-caption text-label-tertiary">{t.sidebar.memoryGuideTip}</p>
            </div>
          </Popover>
        </div>
        <p className="mt-1 text-ui-sm text-label-secondary">
          {t.sidebar.personalMemoryDesc}
        </p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Spinner label={t.common.loading} />
        </div>
      ) : totalCount > 0 ? (
        <div className="space-y-4">
          {/* Top toolbar: count + bulk toggle / bulk actions */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-ui-sm text-label-tertiary">
              {bulkMode
                ? format(t.memory.bulkSelected, { count: String(selectedKeys.size) })
                : format(t.memory.entryCount, { count: String(totalCount) })}
            </div>
            {bulkMode ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="secondary" onClick={() => selectByFilter(isAutoFlushStale)}>
                  {t.memory.bulkSelectAutoFlushUnused}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => selectByFilter(isStaleHeader)}>
                  {t.memory.bulkSelectUnused}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => selectByFilter(() => true)}>
                  {t.memory.bulkSelectAll}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setSelectedKeys(new Set())}>
                  {t.memory.bulkClearSelection}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  icon={AppIcons.delete}
                  disabled={selectedKeys.size === 0}
                  onClick={() => { void requestBulkDelete(); }}
                >
                  {t.memory.bulkDelete}
                </Button>
                <Button size="sm" variant="plain" icon={AppIcons.close} onClick={exitBulkMode}>
                  {t.memory.bulkExit}
                </Button>
              </div>
            ) : (
              <Button size="sm" variant="secondary" icon={AppIcons.tidyUp} onClick={() => setBulkMode(true)}>
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
                <Pressable
                  aria-expanded={!isCollapsed}
                  onClick={() => toggleGroup(groupKey)}
                  className="flex items-center gap-1 rounded-control text-ui-sm font-medium text-label-tertiary hover:text-label"
                >
                  <Icon icon={AppIcons.disclose} size="sm" className={cn('transition-transform duration-fast', !isCollapsed && 'rotate-90')} />
                  <Icon icon={group.icon === 'global' ? AppIcons.allProjects : AppIcons.folderOpen} size="sm" />
                  <span>{group.label}</span>
                  <span>({group.headers.length})</span>
                </Pressable>

                {/* Group entries — hidden when collapsed */}
                {!isCollapsed && group.headers.map((header) => {
                  const key = entryKey(group.workspacePath, header.filename);
                  const expanded = expandedId === header.filename;
                  return (
                    <MemoryRow
                      key={key}
                      header={header}
                      workspacePath={group.workspacePath}
                      bulkMode={bulkMode}
                      selected={selectedKeys.has(key)}
                      expanded={expanded}
                      content={expanded ? expandedContent[header.filename] : undefined}
                      hint={descHint?.key === key ? descHint : null}
                      actions={rowActions}
                    />
                  );
                })}
              </div>
            );
          })}
        </div>
      ) : (
        <EmptyState title={t.panel.memoryEmpty} description={t.memory.emptyHint} />
      )}
    </div>
  );
}
