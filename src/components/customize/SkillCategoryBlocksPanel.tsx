/**
 * SkillCategoryBlocksPanel — manage "don't propose this kind" blocks.
 *
 * When a user clicks "这类别再提议" on a skill proposal card, we write
 * a feedback memory so future system prompts stop proposing similar
 * skills. Prior to Task #45 this was a one-way door — misclicks were
 * unrecoverable without editing memdir files by hand.
 *
 * This panel scans workspace feedback memories, filters to the
 * category-block pattern (see core/skill/categoryBlocks.ts), and lets
 * the user revoke blocks via `deleteMemory`. Hidden entirely when the
 * workspace has no blocks, so the Toolbox UI stays unchanged for
 * users who never hit this path.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ds/button';
import { focusIsOnWindow } from '@/components/toolbox/cardFocus';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { useI18n, format } from '@/i18n';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useToastStore } from '@/stores/toastStore';
import { scanMemoryFiles } from '@/core/memdir/scan';
import { deleteMemory } from '@/core/memdir/write';
import {
  isCategoryBlock,
  parseCategoryBlock,
  type CategoryBlockEntry,
} from '@/core/skill/categoryBlocks';

export default function SkillCategoryBlocksPanel() {
  const { t } = useI18n();
  const workspacePath = useWorkspaceStore((s) => s.currentPath);
  const addToast = useToastStore((s) => s.addToast);

  const [blocks, setBlocks] = useState<CategoryBlockEntry[]>([]);

  const loadBlocks = useCallback(async () => {
    if (!workspacePath) {
      setBlocks([]);
      return;
    }
    try {
      const headers = await scanMemoryFiles(workspacePath);
      const entries = headers
        .filter(isCategoryBlock)
        .map(parseCategoryBlock)
        .filter((e): e is CategoryBlockEntry => e !== null)
        .sort((a, b) => b.createdAt - a.createdAt);
      setBlocks(entries);
    } catch {
      // scan failure just means we render nothing — a silent empty
      // list is better than a broken panel here.
      setBlocks([]);
    }
  }, [workspacePath]);

  useEffect(() => {
    void loadBlocks();
  }, [loadBlocks]);

  // The row whose button was pressed leaves with its button. The focus goes to the row that took
  // its place, else the one before it, else — the panel has left too — the page's 「添加」 button.
  const listRef = useRef<HTMLDivElement>(null);
  const removedAt = useRef<number | null>(null);
  useLayoutEffect(() => {
    const index = removedAt.current;
    if (index === null) return;
    removedAt.current = null;
    // Only when no control has the focus: the user may have moved on while the unblock ran.
    if (!focusIsOnWindow()) return;
    const buttons = Array.from(listRef.current?.querySelectorAll<HTMLElement>('button') ?? []);
    const next = buttons[Math.min(index, buttons.length - 1)]
      ?? document.querySelector<HTMLElement>('[data-testid="skill-create-trigger"]');
    next?.focus();
  }, [blocks]);

  const handleUnblock = async (entry: CategoryBlockEntry) => {
    try {
      await deleteMemory(entry.filename, workspacePath);
      // Optimistic remove from the list — the memdir write is atomic
      // and already succeeded, so a follow-up scan would just confirm.
      removedAt.current = blocks.findIndex((b) => b.filename === entry.filename);
      setBlocks((prev) => prev.filter((b) => b.filename !== entry.filename));
    } catch (err) {
      addToast({
        type: 'error',
        title: t.toolbox.categoryBlocksUnblockError,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  if (blocks.length === 0) return null;

  return (
    <div className="mx-4 my-3 overflow-hidden rounded-panel border border-separator">
      <div className="flex items-center justify-between border-b border-separator px-3 py-2">
        <div className="flex items-center gap-2">
          <Icon icon={AppIcons.block} size="sm" className="text-label-tertiary" />
          <span className="text-ui-sm font-medium text-label">
            {t.toolbox.categoryBlocksTitle}
          </span>
          <span className="text-caption text-label-tertiary">
            {format(t.toolbox.categoryBlocksCount, { count: String(blocks.length) })}
          </span>
        </div>
      </div>
      <div className="border-b border-separator px-3 py-1 text-caption text-label-tertiary">
        {t.toolbox.categoryBlocksHint}
      </div>
      <div ref={listRef} className="max-h-48 overflow-y-auto overlay-scroll">
        {blocks.map((entry) => (
          <div
            key={entry.filename}
            className="flex items-center gap-2 border-b border-separator px-3 py-2 last:border-b-0"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-ui-sm font-medium text-label">
                {entry.skillName}
              </div>
              {entry.description && (
                <div className="mt-1 line-clamp-1 text-caption text-label-tertiary">
                  {entry.description}
                </div>
              )}
            </div>
            <Button variant="plain" size="sm" onClick={() => { void handleUnblock(entry); }}>
              {t.toolbox.categoryBlocksUnblock}
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
