import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, IconButton } from '@/components/ds/button';
import { useConfirm } from '@/components/ds/confirm-context';
import { Dialog, DialogClose } from '@/components/ds/dialog';
import { Disclosure } from '@/components/ds/disclosure';
import { EmptyState } from '@/components/ds/empty-state';
import { AppIcons } from '@/components/ds/icons';
import { lastInputWasPointer } from '@/components/ds/input-modality';
import { Spinner } from '@/components/ds/spinner';
import { Tag } from '@/components/ds/tag';
import { focusIsOnWindow } from '@/components/toolbox/cardFocus';
import { scanMemoryFiles, readMemoryFile } from '@/core/memdir/scan';
import { deleteMemory, clearAllMemories } from '@/core/memdir/write';
import type { MemoryHeader, MemoryType } from '@/core/memdir/types';
import { useI18n, format } from '@/i18n';

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

const newestFirst = (items: MemoryHeader[]) => items.sort((a, b) => b.updated - a.updated);

export default function MemoryViewModal(props: MemoryViewModalProps) {
  const { open, onClose, scope } = props;
  const { t } = useI18n();
  const confirm = useConfirm();
  const [headers, setHeaders] = useState<MemoryHeader[]>([]);
  // The content of the memories that were opened, by file.
  const [expandedContent, setExpandedContent] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const isPersonal = scope === 'personal';
  const wsPath = isPersonal ? null : props.workspacePath;

  // The window lists one folder for one opening. It starts over when it opens and when the
  // folder changes while it is open; once closed it keeps what it showed while it fades out.
  const shownFor = open ? wsPath ?? '' : undefined;
  const [listedFor, setListedFor] = useState<string | undefined>(undefined);
  if (shownFor !== listedFor) {
    setListedFor(shownFor);
    if (shownFor !== undefined) {
      setLoading(true);
      setExpandedId(null);
      setExpandedContent({});
    }
  }

  // What the handlers read after a question or a file call: the list and the folder as they are then.
  const headersRef = useRef(headers);
  const folderRef = useRef(wsPath);
  // Whether the window is on the page and open: false once it is closing or has been taken away.
  const isOpen = useRef(open);
  useLayoutEffect(() => {
    headersRef.current = headers;
    folderRef.current = wsPath;
    isOpen.current = open;
    return () => { isOpen.current = false; };
  });

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    async function load() {
      let items: MemoryHeader[];
      try {
        items = newestFirst(await scanMemoryFiles(wsPath));
      } catch {
        items = [];
      }
      // A scan of an earlier opening, or of the folder shown before, is dropped.
      if (cancelled) return;
      setHeaders(items);
      setLoading(false);
    }
    void load();
    return () => { cancelled = true; };
  }, [open, wsPath]);

  // A removed row takes the focus with it: the browser puts it on the page, and the dialog then
  // on its own box. `removedAt` is the place the memory had in the list; the focus goes to the
  // row now at that place, else the last row, else the Close button.
  const listRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const removedAt = useRef<number | null>(null);
  useLayoutEffect(() => {
    const place = removedAt.current;
    removedAt.current = null;
    if (place === null || !open) return;
    const active = document.activeElement;
    const onOwnBox = active instanceof HTMLElement && active.hasAttribute('data-ds-layer') && closeRef.current !== null && active.contains(closeRef.current);
    if (!focusIsOnWindow() && !onOwnBox) return;
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>('button[aria-expanded]') ?? []);
    const target = rows[Math.min(place, rows.length - 1)] ?? closeRef.current;
    target?.focus(lastInputWasPointer() ? { focusVisible: false } : undefined);
  }, [headers, open]);

  const handleExpand = async (header: MemoryHeader) => {
    const id = header.filename;
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    if (!expandedContent[header.filePath]) {
      const file = await readMemoryFile(header.filePath);
      if (file) {
        setExpandedContent((prev) => ({ ...prev, [header.filePath]: file.content }));
      }
    }
  };

  // The memories that have a question open or a delete under way: one delete per memory.
  const deleting = useRef(new Set<string>());
  const handleDelete = async (header: MemoryHeader) => {
    // The window keeps rendering while it fades out: nothing is asked or deleted then.
    if (!open || deleting.current.has(header.filePath)) return;
    deleting.current.add(header.filePath);
    try {
      // Asked inside the click handler, so the question ends with the window, answered with cancel.
      const confirmed = await confirm({
        title: t.memory.deleteTitle,
        message: header.name,
        confirmLabel: t.common.delete,
        tone: 'danger',
      });
      if (!confirmed) return;
      // The list may have changed while the question was open: only a memory still listed is deleted.
      const index = headersRef.current.findIndex((item) => item.filePath === header.filePath);
      if (index === -1) return;
      await deleteMemory(header.filename, wsPath);
      const items = newestFirst(await scanMemoryFiles(wsPath));
      // The scan belongs to the folder the delete was made in.
      if (folderRef.current !== wsPath) return;
      removedAt.current = index;
      setHeaders(items);
    } catch (err) {
      console.error('Failed to delete memory:', err);
    } finally {
      deleting.current.delete(header.filePath);
    }
  };

  const clearing = useRef(false);
  const handleClear = async () => {
    // Nothing is asked from a window that is fading out, nor while a clear is under way.
    if (!open || clearing.current) return;
    clearing.current = true;
    try {
      // The question says how many memories will go, so the folder is scanned now: a task may
      // have written memories since the window opened. Clearing removes what a scan lists.
      let found: MemoryHeader[] | null;
      try {
        found = newestFirst(await scanMemoryFiles(wsPath));
      } catch {
        found = null;
      }
      // The scan took a moment: the window may have closed or moved to another folder meanwhile.
      if (!isOpen.current || folderRef.current !== wsPath) return;
      if (found) {
        setHeaders(found);
        if (found.length === 0) {
          removedAt.current = 0;
          return;
        }
      }
      const sentence = isPersonal ? t.sidebar.personalMemoryClearMessage : t.panel.memoryClearMessage;
      const confirmed = await confirm({
        title: t.panel.memoryClearTitle,
        // The second line is the count of that scan; without a scan the question has no number.
        message: found ? `${sentence}\n${format(t.memory.entryCount, { count: String(found.length) })}` : sentence,
        confirmLabel: t.panel.memoryClearConfirm,
        tone: 'danger',
      });
      // Nothing is cleared once the list has emptied.
      if (!confirmed || headersRef.current.length === 0) return;
      await clearAllMemories(wsPath);
      if (folderRef.current !== wsPath) return;
      removedAt.current = 0;
      setHeaders([]);
    } catch (err) {
      console.error('Failed to clear memory:', err);
    } finally {
      clearing.current = false;
    }
  };

  const title = isPersonal ? t.sidebar.personalMemoryTitle : t.panel.memoryTitle;
  const desc = isPersonal ? t.sidebar.personalMemoryDesc : t.panel.memoryDesc;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      title={title}
      description={desc}
      size="md"
      closeButton
      // The list is not there yet when the window opens; it opens on Close, which deletes nothing.
      initialFocus={() => closeRef.current}
      footer={(
        <div className="flex w-full items-center justify-between gap-2">
          <div>
            {!loading && headers.length > 0 && (
              <Button variant="danger" size="sm" onClick={handleClear}>{t.panel.memoryClear}</Button>
            )}
          </div>
          <DialogClose asChild><Button ref={closeRef} variant="secondary">{t.common.close}</Button></DialogClose>
        </div>
      )}
    >
      {loading ? (
        <div className="flex justify-center py-8">
          <Spinner label={t.common.loading} />
        </div>
      ) : headers.length > 0 ? (
        <div ref={listRef} className="flex flex-col gap-1">
          <div className="text-ui-sm text-label-tertiary">
            {format(t.memory.entryCount, { count: String(headers.length) })}
          </div>
          {headers.map((header) => (
            <Disclosure
              key={header.filename}
              open={expandedId === header.filename}
              onOpenChange={() => { void handleExpand(header); }}
              title={(
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="flex shrink-0"><Tag>{getTypeLabel(header.type, t)}</Tag></span>
                  <span className="min-w-0 flex-1 truncate">{header.name}</span>
                  <span className="shrink-0 whitespace-nowrap text-caption font-normal text-label-tertiary">
                    {formatAge(header.updated, t)}
                  </span>
                </span>
              )}
            >
              <p className="whitespace-pre-wrap break-words text-caption text-label-tertiary">
                {expandedContent[header.filePath] ?? header.description}
              </p>
              <div className="mt-1 flex justify-end">
                <IconButton
                  size="sm"
                  icon={AppIcons.delete}
                  label={t.common.delete}
                  onClick={() => { void handleDelete(header); }}
                />
              </div>
            </Disclosure>
          ))}
        </div>
      ) : (
        <EmptyState title={t.panel.memoryEmpty} />
      )}
    </Dialog>
  );
}
