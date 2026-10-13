import { memo, useRef, useState } from 'react';
import { Button } from '@/components/ds/button';
import { Pressable } from '@/components/ds/pressable';
import { format, useI18n } from '@/i18n';
import type { TranslationDict } from '@/i18n/types';
import { useChatStore } from '@/stores/chatStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useToastStore } from '@/stores/toastStore';
import { useTurnChangesDetail, useTurnChangesEntry, useTurnUndo, useTurnUndoRecord } from '@/hooks/useTurnChanges';
import type { TurnChangedFile } from '@/core/session/turnChanges';
import { TurnUndoRefusedError, type TurnUndoDirection, type TurnUndoPlan } from '@/core/session/turnUndo';
import type { TurnUndoRecord } from '@/core/session/turnUndoRecord';
import TurnUndoDialog from './TurnUndoDialog';

/** File rows shown before the rest is asked for. */
const MAX_ROWS_SHOWN = 4;

function changeStatusLabel(t: TranslationDict, status: TurnChangedFile['status']): string {
  if (status === 'created') return t.chat.changeCreated;
  if (status === 'deleted') return t.chat.changeDeleted;
  return t.chat.changeModified;
}

/** "+N −M", or the status word of a file that has no line counts. */
export function ChangeAmount({ file }: { file: Pick<TurnChangedFile, 'status' | 'added' | 'deleted'> }) {
  const { t } = useI18n();
  if (file.added === undefined || file.deleted === undefined) {
    return <span className="shrink-0 text-ui-sm text-label-tertiary">{changeStatusLabel(t, file.status)}</span>;
  }
  return <LineCounts added={file.added} deleted={file.deleted} />;
}

function LineCounts({ added, deleted }: { added: number; deleted: number }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 font-code text-ui-sm">
      <span className="text-success">+{added}</span>
      <span className="text-danger">−{deleted}</span>
    </span>
  );
}

function fileNameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * The mark of a file row. In an undone turn: every file that does not hold its
 * content before the turn. In a turn whose changes were put back: the files
 * that were left out of that.
 */
function rowMark(t: TranslationDict, record: TurnUndoRecord | null, path: string): string | null {
  if (!record) return null;
  const last = record.entries.find((entry) => entry.path === path)?.last;
  if (record.state === 'undone') return last === 'done' ? null : t.chat.undoNotRestored;
  return last === 'failed' || last === 'skipped' ? t.chat.reapplyNotPutBack : null;
}

/**
 * The files a turn changed, under its reply. Renders nothing while the record
 * is being read and for a turn that changed no file. A turn with one file is
 * the title alone. The title and every row open the turn's changes tab.
 *
 * A turn with a file to restore has one button beside the title: it undoes the
 * turn's file changes or, once the turn is undone, puts them back. Either asks
 * first, with the plan read at that moment.
 */
function ChangedFilesCard({ conversationId, loopId }: { conversationId: string; loopId: string }) {
  const { t } = useI18n();
  const entry = useTurnChangesEntry(conversationId, loopId, true);
  const many = entry !== null && entry.total > 1;
  const restorable = (entry?.restorable ?? 0) > 0;
  const detail = useTurnChangesDetail(conversationId, loopId, many);
  const record = useTurnUndoRecord(conversationId, loopId, restorable);
  // The record names the state once it is read, so the title and the button change together with the marks.
  const undone = restorable && (record ? record.state === 'undone' : entry?.undone === true);
  const turnRunning = useChatStore((s) => s.conversations[conversationId]?.status === 'running');
  const { plan, run, busy } = useTurnUndo(conversationId, loopId);
  const openTurnChanges = usePreviewStore((s) => s.openTurnChanges);
  const addToast = useToastStore((s) => s.addToast);
  const [allShown, setAllShown] = useState(false);
  // The question on the page; it keeps what it showed while it fades.
  const [question, setQuestion] = useState<{ direction: TurnUndoDirection; plan: TurnUndoPlan } | null>(null);
  const [questionOpen, setQuestionOpen] = useState(false);
  const planning = useRef(false);

  if (!entry) return null;
  if (many && detail.status === 'loading') return null;
  if (undone && !record) return null;

  const tabTitle = many
    ? format(t.panel.changesTabMany, { name: entry.firstFile, count: entry.total })
    : format(t.panel.changesTabSingle, { name: entry.firstFile });
  const open = (fileIndex: number) => openTurnChanges({ conversationId, loopId, fileIndex, title: tabTitle });

  const files = many ? detail.turn?.files ?? [] : [];
  const foldable = files.length > MAX_ROWS_SHOWN;
  const shown = foldable && !allShown ? files.slice(0, MAX_ROWS_SHOWN) : files;
  const moreFiles = detail.turn?.moreFiles ?? 0;

  const restored = undone && record ? record.entries.filter((file) => file.last === 'done') : [];
  const title = !undone
    ? many
      ? format(t.chat.changedFilesTitle, { count: entry.total })
      : format(t.chat.changedFileSingleTitle, { name: entry.firstFile })
    : restored.length === 1
      ? format(t.chat.undoneFileSingleTitle, { name: fileNameOf(restored[0].path) })
      : format(t.chat.undoneFilesTitle, { count: restored.length });

  const direction: TurnUndoDirection = undone ? 'reapply' : 'undo';
  const unavailable = busy || turnRunning;

  const ask = async (): Promise<void> => {
    if (planning.current) return;
    planning.current = true;
    try {
      const planned = await plan(direction);
      setQuestion({ direction, plan: planned });
      setQuestionOpen(true);
    } finally {
      planning.current = false;
    }
  };

  const confirm = async (): Promise<void> => {
    if (!question || !questionOpen) return;
    setQuestionOpen(false);
    const [outcome] = await Promise.allSettled([run(question.direction)]);
    if (outcome.status === 'rejected') {
      // A turn began between the question and its answer: say why nothing happened.
      if (outcome.reason instanceof TurnUndoRefusedError && outcome.reason.reason === 'turn-running') {
        addToast({ type: 'warning', title: question.direction === 'undo' ? t.chat.undoBusyHint : t.chat.reapplyBusyHint });
        return;
      }
      throw outcome.reason;
    }
    const result = outcome.value;
    if (!result) return;
    // The question already listed these files; the notice counts the ones it did not.
    const listed = new Set(question.plan.wontRestore.map((file) => file.path));
    const notDone = result.notDone.filter((file) => !listed.has(file.path)).length;
    if (notDone === 0) return;
    addToast({
      type: 'warning',
      title: format(
        question.direction === 'undo' ? t.chat.undoPartialNotice : t.chat.reapplyPartialNotice,
        { done: result.done, notDone },
      ),
    });
  };

  return (
    <div data-testid="changed-files-card" className="mt-2 overflow-hidden rounded-panel border border-separator bg-surface">
      <div className="flex items-center">
        <Pressable
          onClick={() => open(0)}
          className="peer flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left text-ui text-label transition-colors duration-fast hover:bg-fill-hover"
        >
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {entry.added + entry.deleted > 0 && <LineCounts added={entry.added} deleted={entry.deleted} />}
        </Pressable>
        {restorable && (
          // The title's hover fill runs on under the button, to the end of the row.
          <div className="flex shrink-0 items-center self-stretch px-2 transition-colors duration-fast peer-hover:bg-fill-hover">
            <Button
              size="sm"
              variant="secondary"
              busy={unavailable}
              title={turnRunning ? (undone ? t.chat.reapplyBusyHint : t.chat.undoBusyHint) : undefined}
              onClick={() => { void ask(); }}
            >
              {undone ? t.chat.reapplyTurn : t.chat.undoTurn}
            </Button>
          </div>
        )}
      </div>
      {shown.length > 0 && (
        <ul className="border-t border-separator py-1">
          {shown.map((file, index) => {
            const mark = rowMark(t, record, file.path);
            return (
              <li key={file.path}>
                <Pressable
                  onClick={() => open(index)}
                  title={file.display}
                  className="flex w-full items-center gap-3 px-3 py-1 text-left text-ui-sm text-label-secondary transition-colors duration-fast hover:bg-fill-hover hover:text-label"
                >
                  <span className="min-w-0 flex-1 truncate">{file.display}</span>
                  {mark && <span className="shrink-0 text-ui-sm text-label-tertiary">{mark}</span>}
                  <ChangeAmount file={file} />
                </Pressable>
              </li>
            );
          })}
        </ul>
      )}
      {(!foldable || allShown) && moreFiles > 0 && (
        <div className="px-3 pb-2 text-ui-sm text-label-tertiary">
          {format(t.chat.moreChangedFiles, { count: moreFiles })}
        </div>
      )}
      {foldable && (
        <div className="border-t border-separator px-3 py-1">
          <Pressable
            aria-expanded={allShown}
            onClick={() => setAllShown((value) => !value)}
            className="rounded-control text-ui-sm text-label-secondary transition-colors duration-fast hover:text-label"
          >
            {allShown ? t.chat.collapseFiles : format(t.chat.allFilesCount, { count: entry.total })}
          </Pressable>
        </div>
      )}
      {question && (
        <TurnUndoDialog
          open={questionOpen}
          direction={question.direction}
          plan={question.plan}
          onConfirm={() => { void confirm(); }}
          onCancel={() => setQuestionOpen(false)}
        />
      )}
    </div>
  );
}

export default memo(ChangedFilesCard);
