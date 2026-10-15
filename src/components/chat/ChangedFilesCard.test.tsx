// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { act, cleanup, fireEvent, render as renderBare, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useToastStore } from '@/stores/toastStore';
import { __testing as turnChangesCache } from '@/hooks/useTurnChanges';
import type { TurnChangedFile, TurnChanges, TurnIndex } from '@/core/session/turnChanges';
import { TurnUndoRefusedError, type TurnUndoPlan, type TurnUndoResult } from '@/core/session/turnUndo';
import type { TurnUndoEntry, TurnUndoRecord } from '@/core/session/turnUndoRecord';
import type { Conversation } from '@/types';
import ChangedFilesCard from './ChangedFilesCard';

const mocks = vi.hoisted(() => ({
  readTurnIndex: vi.fn(),
  readTurnChanges: vi.fn(),
  readTurnUndoRecord: vi.fn(),
  planTurnUndo: vi.fn(),
  undoTurn: vi.fn(),
  reapplyTurn: vi.fn(),
  listeners: new Set<(conversationId: string, loopId: string) => void>(),
}));

vi.mock('@/core/session/turnChanges', () => ({
  readTurnIndex: (...args: unknown[]) => mocks.readTurnIndex(...args),
  readTurnChanges: (...args: unknown[]) => mocks.readTurnChanges(...args),
  readTurnUndoRecord: (...args: unknown[]) => mocks.readTurnUndoRecord(...args),
  onTurnChangesSaved: (listener: (conversationId: string, loopId: string) => void) => {
    mocks.listeners.add(listener);
    return () => { mocks.listeners.delete(listener); };
  },
}));

vi.mock('@/core/session/turnUndo', async (importOriginal) => ({
  TurnUndoRefusedError: (await importOriginal<typeof import('@/core/session/turnUndo')>()).TurnUndoRefusedError,
  planTurnUndo: (...args: unknown[]) => mocks.planTurnUndo(...args),
  undoTurn: (...args: unknown[]) => mocks.undoTurn(...args),
  reapplyTurn: (...args: unknown[]) => mocks.reapplyTurn(...args),
}));

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });

const CONVERSATION_ID = 'conv-1';
const LOOP_ID = 'loop-1';

function counted(display: string, added: number, deleted: number, status: TurnChangedFile['status'] = 'modified'): TurnChangedFile {
  return { path: `/ws/${display}`, display, status, added, deleted, hunks: [] };
}

function uncounted(display: string, status: TurnChangedFile['status']): TurnChangedFile {
  return { path: `/ws/${display}`, display, status };
}

/** Saves one turn the way endTurn would: its file and its index entry. */
function saveTurn(files: TurnChangedFile[], extra: { total?: number; moreFiles?: number } = {}): TurnChanges {
  const total = extra.total ?? files.length;
  const turn: TurnChanges = {
    loopId: LOOP_ID,
    files,
    ...(extra.moreFiles ? { moreFiles: extra.moreFiles } : {}),
    total,
    added: files.reduce((sum, file) => sum + (file.added ?? 0), 0),
    deleted: files.reduce((sum, file) => sum + (file.deleted ?? 0), 0),
  };
  const firstFile = files[0].display.slice(files[0].display.lastIndexOf('/') + 1);
  mocks.readTurnIndex.mockResolvedValue({
    [LOOP_ID]: { total, added: turn.added, deleted: turn.deleted, firstFile },
  } satisfies TurnIndex);
  mocks.readTurnChanges.mockResolvedValue(turn);
  return turn;
}

const card = () => screen.queryByTestId('changed-files-card');
const rows = () => within(screen.getByTestId('changed-files-card')).queryAllByRole('listitem');

function entryOf(display: string, last?: TurnUndoEntry['last']): TurnUndoEntry {
  return {
    path: `/ws/${display}`,
    hash: '0123456789abcdef',
    before: 'file',
    after: 'file',
    beforeSha256: 'a'.repeat(64),
    afterSha256: 'b'.repeat(64),
    ...(last ? { last } : {}),
  };
}

/**
 * Saves a turn whose file tools changed `restorable`, in the state `state`:
 * the index entry gets the restorable count and the undone mark, and the
 * record its entries.
 */
function saveRestorableTurn(files: TurnChangedFile[], restorable: TurnUndoEntry[], state: TurnUndoRecord['state'] = 'applied'): void {
  const turn = saveTurn(files);
  const firstFile = files[0].display.slice(files[0].display.lastIndexOf('/') + 1);
  mocks.readTurnIndex.mockResolvedValue({
    [LOOP_ID]: {
      total: turn.total, added: turn.added, deleted: turn.deleted, firstFile,
      restorable: restorable.length, ...(state === 'undone' ? { undone: true } : {}),
    },
  } satisfies TurnIndex);
  mocks.readTurnUndoRecord.mockResolvedValue({ version: 1, loopId: LOOP_ID, state, entries: restorable } satisfies TurnUndoRecord);
}

function setConversationStatus(status: Conversation['status']): void {
  const conversation: Conversation = {
    id: CONVERSATION_ID, title: 'Changes', messages: [], createdAt: 1_000, updatedAt: 1_000, status,
  };
  useChatStore.setState({ conversations: { [CONVERSATION_ID]: conversation } });
}

function turnSaved(): void {
  for (const listener of [...mocks.listeners]) listener(CONVERSATION_ID, LOOP_ID);
}

const THREE_FILES = [counted('a.md', 3, 1), counted('b.md', 2, 0), counted('c.md', 4, 0, 'created')];
const PLAN: TurnUndoPlan = {
  willRestore: [
    { path: '/ws/a.md', display: 'a.md', action: 'write-before' },
    { path: '/ws/b.md', display: 'b.md', action: 'write-before' },
    { path: '/ws/c.md', display: 'c.md', action: 'trash' },
  ],
  wontRestore: [],
};
const ALL_DONE: TurnUndoResult = { done: 3, notDone: [] };
const toastTitles = () => useToastStore.getState().toasts.map((toast) => toast.title);

describe('ChangedFilesCard', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    turnChangesCache.reset();
    mocks.listeners.clear();
    mocks.readTurnIndex.mockReset();
    mocks.readTurnChanges.mockReset();
    mocks.readTurnIndex.mockResolvedValue({});
    mocks.readTurnChanges.mockResolvedValue(null);
    mocks.readTurnUndoRecord.mockReset();
    mocks.readTurnUndoRecord.mockResolvedValue(null);
    mocks.planTurnUndo.mockReset();
    mocks.planTurnUndo.mockResolvedValue(PLAN);
    mocks.undoTurn.mockReset();
    mocks.undoTurn.mockResolvedValue(ALL_DONE);
    mocks.reapplyTurn.mockReset();
    mocks.reapplyTurn.mockResolvedValue(ALL_DONE);
    setConversationStatus('idle');
    useToastStore.setState({ toasts: [] });
    usePreviewStore.setState({
      tabs: [], currentConversationId: CONVERSATION_ID, activeTabId: null,
      panelStateByConversation: {}, lastActiveTabByConversation: {},
    });
  });

  afterEach(() => {
    cleanup();
    initLanguage('en-US');
    vi.restoreAllMocks();
  });

  it('titles a turn with several files by their count, with the total line counts, one row per file', async () => {
    saveTurn([counted('a.md', 3, 1), counted('docs/b.md', 2, 0), counted('new.md', 4, 0, 'created')]);
    render(<ChangedFilesCard conversationId={CONVERSATION_ID} loopId={LOOP_ID} />);

    const title = await screen.findByRole('button', { name: /^已编辑 3 个文件/ });
    expect(title).toHaveTextContent('+9');
    expect(title).toHaveTextContent('−1');
    expect(rows().map((row) => row.textContent)).toEqual(['a.md+3−1', 'docs/b.md+2−0', 'new.md+4−0']);
  });

  it('takes the width of the reply column, as the file cards beside it do', async () => {
    saveTurn([counted('a.md', 3, 1), counted('b.md', 2, 0)]);
    render(<ChangedFilesCard conversationId={CONVERSATION_ID} loopId={LOOP_ID} />);

    const root = await screen.findByTestId('changed-files-card');
    expect([...root.classList].filter((name) => name.startsWith('max-w-'))).toEqual([]);
  });

  it('carries the hover fill of the title across the part of the row that holds the undo button', async () => {
    saveRestorableTurn(THREE_FILES, [entryOf('a.md'), entryOf('b.md'), entryOf('c.md')]);
    render(<ChangedFilesCard conversationId={CONVERSATION_ID} loopId={LOOP_ID} />);

    const root = await screen.findByTestId('changed-files-card');
    const undoButton = await within(root).findByRole('button', { name: '撤销' });
    const title = within(root).getByRole('button', { name: /已编辑 3 个文件/ });
    expect(title.classList.contains('peer')).toBe(true);
    expect(undoButton.parentElement?.previousElementSibling).toBe(title);
    expect(undoButton.parentElement?.classList.contains('peer-hover:bg-fill-hover')).toBe(true);
  });

  it('shows only the title, with the file name, for a turn that changed one file', async () => {
    saveTurn([counted('docs/方案.md', 3, 3)]);
    render(<ChangedFilesCard conversationId={CONVERSATION_ID} loopId={LOOP_ID} />);

    const title = await screen.findByRole('button', { name: /^已编辑 方案\.md/ });
    expect(title).toHaveTextContent('+3');
    expect(title).toHaveTextContent('−3');
    expect(rows()).toHaveLength(0);
    expect(mocks.readTurnChanges).not.toHaveBeenCalled();
  });

  it('shows the three status words for files without line counts, and no total when no file has counts', async () => {
    saveTurn([uncounted('合同.docx', 'modified'), uncounted('报表.xlsx', 'created'), uncounted('旧稿.md', 'deleted')]);
    render(<ChangedFilesCard conversationId={CONVERSATION_ID} loopId={LOOP_ID} />);

    const title = await screen.findByRole('button', { name: '已编辑 3 个文件' });
    expect(title).not.toHaveTextContent('+');
    expect(rows().map((row) => row.textContent)).toEqual(['合同.docx已修改', '报表.xlsx新建', '旧稿.md已删除']);
  });

  it('shows a file deleted with the file tool as +0 and its deleted lines', async () => {
    saveTurn([counted('草稿.md', 0, 12, 'deleted'), counted('a.md', 1, 0)]);
    render(<ChangedFilesCard conversationId={CONVERSATION_ID} loopId={LOOP_ID} />);

    await screen.findByRole('button', { name: /^已编辑 2 个文件/ });
    expect(rows()[0].textContent).toBe('草稿.md+0−12');
  });

  it('shows four of six files, then all six, then four again', async () => {
    saveTurn(Array.from({ length: 6 }, (_, index) => counted(`file-${index + 1}.md`, 1, 0)));
    render(<ChangedFilesCard conversationId={CONVERSATION_ID} loopId={LOOP_ID} />);

    const expand = await screen.findByRole('button', { name: '全部 6 个文件' });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    expect(rows()).toHaveLength(4);

    fireEvent.click(expand);
    expect(rows()).toHaveLength(6);
    const collapse = screen.getByRole('button', { name: '收起' });
    expect(collapse).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(collapse);
    expect(rows()).toHaveLength(4);
    expect(screen.getByRole('button', { name: '全部 6 个文件' })).toBeInTheDocument();
  });

  it('shows no expand button for exactly four files', async () => {
    saveTurn(Array.from({ length: 4 }, (_, index) => counted(`file-${index + 1}.md`, 1, 0)));
    render(<ChangedFilesCard conversationId={CONVERSATION_ID} loopId={LOOP_ID} />);

    await screen.findByRole('button', { name: /^已编辑 4 个文件/ });
    expect(rows()).toHaveLength(4);
    expect(screen.queryByRole('button', { name: /全部/ })).toBeNull();
  });

  it('counts every changed file in the title and the button, and says how many it leaves out once all are shown', async () => {
    saveTurn(
      Array.from({ length: 5 }, (_, index) => counted(`file-${index + 1}.md`, 1, 0)),
      { total: 7, moreFiles: 2 },
    );
    render(<ChangedFilesCard conversationId={CONVERSATION_ID} loopId={LOOP_ID} />);

    await screen.findByRole('button', { name: /^已编辑 7 个文件/ });
    expect(screen.queryByText('另有 2 个文件')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '全部 7 个文件' }));
    expect(rows()).toHaveLength(5);
    expect(screen.getByText('另有 2 个文件')).toBeInTheDocument();
  });

  it('renders nothing for a turn that changed no file', async () => {
    render(<ChangedFilesCard conversationId={CONVERSATION_ID} loopId={LOOP_ID} />);
    await waitFor(() => expect(mocks.readTurnIndex).toHaveBeenCalled());
    await act(async () => {});
    expect(card()).toBeNull();
  });

  it('renders nothing while the index or the files of the turn are being read', async () => {
    let releaseTurn: (turn: TurnChanges) => void = () => {};
    const turn = saveTurn([counted('a.md', 1, 0), counted('b.md', 1, 0)]);
    mocks.readTurnChanges.mockReturnValue(new Promise<TurnChanges>((resolve) => { releaseTurn = resolve; }));

    render(<ChangedFilesCard conversationId={CONVERSATION_ID} loopId={LOOP_ID} />);
    expect(card()).toBeNull();
    await waitFor(() => expect(mocks.readTurnChanges).toHaveBeenCalled());
    expect(card()).toBeNull();

    await act(async () => { releaseTurn(turn); });
    expect(card()).not.toBeNull();
  });

  it('shows the title alone when the files of the turn cannot be read', async () => {
    saveTurn([counted('a.md', 1, 0), counted('b.md', 1, 0)]);
    mocks.readTurnChanges.mockRejectedValue(new Error('EIO'));
    render(<ChangedFilesCard conversationId={CONVERSATION_ID} loopId={LOOP_ID} />);

    await screen.findByRole('button', { name: /^已编辑 2 个文件/ });
    expect(rows()).toHaveLength(0);
  });

  it('opens the changes tab on the first file from the title, named after the first file and the count', async () => {
    saveTurn([counted('a.md', 1, 0), counted('docs/b.md', 1, 0), counted('c.md', 1, 0)]);
    render(<ChangedFilesCard conversationId={CONVERSATION_ID} loopId={LOOP_ID} />);

    fireEvent.click(await screen.findByRole('button', { name: /^已编辑 3 个文件/ }));

    expect(usePreviewStore.getState().tabs).toMatchObject([{
      kind: 'changes', conversationId: CONVERSATION_ID, loopId: LOOP_ID, fileIndex: 0, title: '改动：a.md 等 3 个文件',
    }]);
  });

  it('opens the changes tab on the file of the row that was pressed, and returns to the same tab', async () => {
    saveTurn([counted('a.md', 1, 0), counted('docs/b.md', 1, 0), counted('c.md', 1, 0)]);
    render(<ChangedFilesCard conversationId={CONVERSATION_ID} loopId={LOOP_ID} />);

    fireEvent.click(await screen.findByRole('button', { name: /^docs\/b\.md/ }));
    fireEvent.click(screen.getByRole('button', { name: /^c\.md/ }));

    const tabs = usePreviewStore.getState().tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ kind: 'changes', fileIndex: 2 });
  });

  it('names the tab after the one file of a single-file turn', async () => {
    saveTurn([counted('docs/方案.md', 3, 3)]);
    render(<ChangedFilesCard conversationId={CONVERSATION_ID} loopId={LOOP_ID} />);

    fireEvent.click(await screen.findByRole('button', { name: /^已编辑 方案\.md/ }));

    expect(usePreviewStore.getState().tabs).toMatchObject([{ kind: 'changes', fileIndex: 0, title: '改动：方案.md' }]);
  });

  it('mounts no tooltip and no menu', async () => {
    saveRestorableTurn([counted('a.md', 1, 0), counted('b.md', 1, 0)], [entryOf('a.md'), entryOf('b.md')]);
    render(<ChangedFilesCard conversationId={CONVERSATION_ID} loopId={LOOP_ID} />);
    const root = await screen.findByTestId('changed-files-card');
    expect(within(root).getByRole('button', { name: '撤销' })).toBeInTheDocument();
    expect(root.querySelector('[data-state]')).toBeNull();
    expect(root.querySelector('[aria-haspopup]')).toBeNull();
  });

  describe('undo', () => {
    const undoButton = () => within(screen.getByTestId('changed-files-card')).getByRole('button', { name: '撤销' });
    const reapplyButton = () => within(screen.getByTestId('changed-files-card')).getByRole('button', { name: '放回改动' });
    const question = (name: string) => screen.findByRole('alertdialog', { name });

    async function renderCard(): Promise<void> {
      render(<ChangedFilesCard conversationId={CONVERSATION_ID} loopId={LOOP_ID} />);
      await screen.findByTestId('changed-files-card');
    }

    it('offers undo on a turn with a file to restore, beside the title that still opens the changes tab', async () => {
      saveRestorableTurn(THREE_FILES, THREE_FILES.map((file) => entryOf(file.display)));
      await renderCard();

      expect(undoButton()).not.toHaveAttribute('aria-disabled');
      expect(undoButton()).not.toHaveAttribute('title');
      expect(screen.queryByRole('button', { name: '放回改动' })).toBeNull();
      expect(rows().map((row) => row.textContent)).toEqual(['a.md+3−1', 'b.md+2−0', 'c.md+4−0']);

      fireEvent.click(screen.getByRole('button', { name: /^已编辑 3 个文件/ }));
      expect(usePreviewStore.getState().tabs).toMatchObject([{ kind: 'changes', fileIndex: 0 }]);
      expect(mocks.planTurnUndo).not.toHaveBeenCalled();
    });

    it('offers undo on a turn that changed one file', async () => {
      saveRestorableTurn([counted('docs/方案.md', 3, 3)], [entryOf('docs/方案.md')]);
      await renderCard();
      expect(screen.getByRole('button', { name: /^已编辑 方案\.md/ })).toBeInTheDocument();
      expect(undoButton()).toBeInTheDocument();
    });

    it('offers no undo on a turn without a file to restore', async () => {
      saveTurn([uncounted('合同.docx', 'modified'), uncounted('报表.xlsx', 'created')]);
      await renderCard();
      expect(screen.queryByRole('button', { name: '撤销' })).toBeNull();
      expect(screen.queryByRole('button', { name: '放回改动' })).toBeNull();
      expect(mocks.readTurnUndoRecord).not.toHaveBeenCalled();
    });

    it('opens the question with the plan read at that moment, and does nothing when it is cancelled', async () => {
      saveRestorableTurn(THREE_FILES, THREE_FILES.map((file) => entryOf(file.display)));
      await renderCard();

      fireEvent.click(undoButton());
      const dialog = await question('撤销这一轮的文件改动？');
      expect(mocks.planTurnUndo).toHaveBeenCalledExactlyOnceWith(CONVERSATION_ID, LOOP_ID, 'undo', expect.anything());
      expect(dialog).toHaveTextContent('3 个文件会恢复到这一轮开始之前');

      fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      expect(mocks.undoTurn).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: /^已编辑 3 个文件/ })).toBeInTheDocument();
    });

    it('cannot be used while a turn of the conversation runs, and says why', async () => {
      saveRestorableTurn(THREE_FILES, THREE_FILES.map((file) => entryOf(file.display)));
      setConversationStatus('running');
      await renderCard();

      expect(undoButton()).toHaveAttribute('aria-disabled', 'true');
      expect(undoButton()).toHaveAttribute('title', '阿布正在工作，结束后可以撤销');
      fireEvent.click(undoButton());
      await act(async () => {});
      expect(mocks.planTurnUndo).not.toHaveBeenCalled();
      expect(screen.queryByRole('alertdialog')).toBeNull();

      act(() => setConversationStatus('idle'));
      expect(undoButton()).not.toHaveAttribute('aria-disabled');
      expect(undoButton()).not.toHaveAttribute('title');
    });

    it('undoes once the question is confirmed, and is busy until that has ended', async () => {
      saveRestorableTurn(THREE_FILES, THREE_FILES.map((file) => entryOf(file.display)));
      let release: (result: TurnUndoResult) => void = () => {};
      mocks.undoTurn.mockReturnValue(new Promise<TurnUndoResult>((resolve) => { release = resolve; }));
      await renderCard();

      fireEvent.click(undoButton());
      fireEvent.click(within(await question('撤销这一轮的文件改动？')).getByRole('button', { name: '撤销' }));
      await waitFor(() => expect(mocks.undoTurn).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      expect(undoButton()).toHaveAttribute('aria-disabled', 'true');
      expect(undoButton()).not.toHaveAttribute('title');

      fireEvent.click(undoButton());
      await act(async () => {});
      expect(mocks.planTurnUndo).toHaveBeenCalledTimes(1);

      await act(async () => { release(ALL_DONE); });
      expect(undoButton()).not.toHaveAttribute('aria-disabled');
      expect(toastTitles()).toEqual([]);
    });

    it('tells in a notice how many files were restored and how many were not, when files failed or were refused', async () => {
      saveRestorableTurn(THREE_FILES, THREE_FILES.map((file) => entryOf(file.display)));
      mocks.undoTurn.mockResolvedValue({
        done: 1,
        notDone: [
          { path: '/ws/a.md', display: 'a.md', reason: 'not-authorized' },
          { path: '/ws/b.md', display: 'b.md', reason: 'write-failed' },
        ],
      } satisfies TurnUndoResult);
      await renderCard();

      fireEvent.click(undoButton());
      fireEvent.click(within(await question('撤销这一轮的文件改动？')).getByRole('button', { name: '撤销' }));

      await waitFor(() => expect(toastTitles()).toEqual(['已恢复 1 个，2 个没有恢复']));
    });

    it('says that Abu is working when a turn began between the question and its answer', async () => {
      saveRestorableTurn(THREE_FILES, THREE_FILES.map((file) => entryOf(file.display)));
      mocks.undoTurn.mockRejectedValue(new TurnUndoRefusedError('turn-running'));
      await renderCard();

      fireEvent.click(undoButton());
      fireEvent.click(within(await question('撤销这一轮的文件改动？')).getByRole('button', { name: '撤销' }));

      await waitFor(() => expect(toastTitles()).toEqual(['阿布正在工作，结束后可以撤销']));
      expect(undoButton()).not.toHaveAttribute('aria-disabled');
    });

    it('leaves a file the question already listed as not restored out of the notice', async () => {
      saveRestorableTurn(THREE_FILES, THREE_FILES.map((file) => entryOf(file.display)));
      mocks.planTurnUndo.mockResolvedValue({
        willRestore: [PLAN.willRestore[1], PLAN.willRestore[2]],
        wontRestore: [{ path: '/ws/a.md', display: 'a.md', reason: 'not-authorized' }],
      } satisfies TurnUndoPlan);
      const listedOnly: TurnUndoResult = { done: 2, notDone: [{ path: '/ws/a.md', display: 'a.md', reason: 'not-authorized' }] };
      mocks.undoTurn.mockResolvedValueOnce(listedOnly).mockResolvedValueOnce({
        done: 1,
        notDone: [...listedOnly.notDone, { path: '/ws/b.md', display: 'b.md', reason: 'write-failed' }],
      } satisfies TurnUndoResult);
      await renderCard();

      fireEvent.click(undoButton());
      fireEvent.click(within(await question('撤销这一轮的文件改动？')).getByRole('button', { name: '撤销' }));
      await waitFor(() => expect(mocks.undoTurn).toHaveBeenCalledTimes(1));
      expect(toastTitles()).toEqual([]);

      fireEvent.click(undoButton());
      fireEvent.click(within(await question('撤销这一轮的文件改动？')).getByRole('button', { name: '撤销' }));
      await waitFor(() => expect(toastTitles()).toEqual(['已恢复 1 个，1 个没有恢复']));
    });

    it('titles an undone turn by the files that were restored, marks the others, and offers to put the changes back', async () => {
      saveRestorableTurn(
        [...THREE_FILES, uncounted('报表.xlsx', 'created')],
        [entryOf('a.md', 'done'), entryOf('b.md', 'skipped'), entryOf('c.md', 'done')],
        'undone',
      );
      await renderCard();

      expect(screen.getByRole('button', { name: /^已撤销 2 个文件的改动/ })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^已编辑/ })).toBeNull();
      expect(rows().map((row) => row.textContent)).toEqual(['a.md+3−1', 'b.md没有恢复+2−0', 'c.md+4−0', '报表.xlsx没有恢复新建']);
      expect(reapplyButton()).not.toHaveAttribute('aria-disabled');
      expect(screen.queryByRole('button', { name: '撤销' })).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: /^b\.md/ }));
      expect(usePreviewStore.getState().tabs).toMatchObject([{ kind: 'changes', fileIndex: 1 }]);
    });

    it('titles an undone turn by the file name when one file was restored', async () => {
      saveRestorableTurn(THREE_FILES, [entryOf('a.md', 'failed'), entryOf('docs/b.md', 'done'), entryOf('c.md', 'skipped')], 'undone');
      await renderCard();
      expect(screen.getByRole('button', { name: /^已撤销 b\.md 的改动/ })).toBeInTheDocument();
    });

    it('titles an undone single-file turn by its file name', async () => {
      saveRestorableTurn([counted('docs/方案.md', 3, 3)], [entryOf('docs/方案.md', 'done')], 'undone');
      await renderCard();
      expect(screen.getByRole('button', { name: /^已撤销 方案\.md 的改动/ })).toBeInTheDocument();
      expect(reapplyButton()).toBeInTheDocument();
    });

    it.each<[string, Partial<TurnIndex[string]>, RegExp]>([
      ['by the count of files its undo restored', { undoneCount: 2 }, /^已撤销 2 个文件的改动/],
      ['by the name of the one file its undo restored', { undoneCount: 1, undoneName: 'b.md' }, /^已撤销 b\.md 的改动/],
    ])('titles an undone turn whose copies are gone %s, with no button and no row marks', async (_label, marks, title) => {
      const turn = saveTurn(THREE_FILES);
      mocks.readTurnIndex.mockResolvedValue({
        [LOOP_ID]: { total: turn.total, added: turn.added, deleted: turn.deleted, firstFile: 'a.md', undone: true, ...marks },
      } satisfies TurnIndex);
      render(<ChangedFilesCard conversationId={CONVERSATION_ID} loopId={LOOP_ID} />);

      expect(await screen.findByRole('button', { name: title })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^已编辑/ })).toBeNull();
      expect(screen.queryByRole('button', { name: '撤销' })).toBeNull();
      expect(screen.queryByRole('button', { name: '放回改动' })).toBeNull();
      expect(rows().map((row) => row.textContent)).toEqual(['a.md+3−1', 'b.md+2−0', 'c.md+4−0']);
      expect(mocks.readTurnUndoRecord).not.toHaveBeenCalled();
    });

    it('shows the undone turn once the undo has been saved', async () => {
      saveRestorableTurn(THREE_FILES, THREE_FILES.map((file) => entryOf(file.display)));
      await renderCard();
      expect(undoButton()).toBeInTheDocument();

      saveRestorableTurn(THREE_FILES, THREE_FILES.map((file) => entryOf(file.display, 'done')), 'undone');
      act(() => turnSaved());

      expect(await screen.findByRole('button', { name: /^已撤销 3 个文件的改动/ })).toBeInTheDocument();
      expect(reapplyButton()).toBeInTheDocument();
    });

    it('cannot put the changes back while a turn of the conversation runs, and says why', async () => {
      saveRestorableTurn(THREE_FILES, THREE_FILES.map((file) => entryOf(file.display, 'done')), 'undone');
      setConversationStatus('running');
      await renderCard();

      expect(reapplyButton()).toHaveAttribute('aria-disabled', 'true');
      expect(reapplyButton()).toHaveAttribute('title', '阿布正在工作，结束后可以放回改动');
      fireEvent.click(reapplyButton());
      await act(async () => {});
      expect(mocks.planTurnUndo).not.toHaveBeenCalled();
    });

    it('puts the changes back once its question is confirmed, is busy meanwhile, and tells of the files not put back', async () => {
      saveRestorableTurn(THREE_FILES, THREE_FILES.map((file) => entryOf(file.display, 'done')), 'undone');
      let release: (result: TurnUndoResult) => void = () => {};
      mocks.reapplyTurn.mockReturnValue(new Promise<TurnUndoResult>((resolve) => { release = resolve; }));
      await renderCard();

      fireEvent.click(reapplyButton());
      const dialog = await question('把这一轮的改动放回来？');
      expect(mocks.planTurnUndo).toHaveBeenCalledExactlyOnceWith(CONVERSATION_ID, LOOP_ID, 'reapply', expect.anything());
      fireEvent.click(within(dialog).getByRole('button', { name: '放回改动' }));
      await waitFor(() => expect(mocks.reapplyTurn).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      expect(reapplyButton()).toHaveAttribute('aria-disabled', 'true');
      expect(mocks.undoTurn).not.toHaveBeenCalled();

      await act(async () => {
        release({ done: 2, notDone: [{ path: '/ws/a.md', display: 'a.md', reason: 'not-authorized' }] });
      });
      expect(reapplyButton()).not.toHaveAttribute('aria-disabled');
      expect(toastTitles()).toEqual(['已放回 2 个，1 个没有放回']);
    });

    it('marks the files that were not put back on the card of a turn that is applied again', async () => {
      saveRestorableTurn(THREE_FILES, [entryOf('a.md', 'failed'), entryOf('b.md', 'done'), entryOf('c.md', 'skipped')]);
      await renderCard();

      expect(screen.getByRole('button', { name: /^已编辑 3 个文件/ })).toBeInTheDocument();
      expect(rows().map((row) => row.textContent)).toEqual(['a.md没有放回+3−1', 'b.md+2−0', 'c.md没有放回+4−0']);
      expect(undoButton()).toBeInTheDocument();
    });
  });
});
