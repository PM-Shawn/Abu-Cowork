// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render as renderBare, screen, within } from '@testing-library/react';
import { useState, type ReactElement } from 'react';
import { APPROVAL_TITLE, approvalProbe, closingWindow, keepClosingLayersOnScreen, windowBox } from '@/test/dsWindows';
import { DesignSystemProvider } from '@/components/ds/provider';
import type { MemoryHeader, MemoryType } from '@/core/memdir/types';
import { format, getI18n, initLanguage } from '@/i18n';
import MemoryViewModal from './MemoryViewModal';

// Every call the window makes to the memory files, in the order it makes it.
const h = vi.hoisted(() => ({
  log: [] as string[],
  scanMemoryFiles: vi.fn(),
  readMemoryFile: vi.fn(),
  deleteMemory: vi.fn(),
  clearAllMemories: vi.fn(),
}));

vi.mock('@/core/memdir/scan', () => ({ scanMemoryFiles: h.scanMemoryFiles, readMemoryFile: h.readMemoryFile }));
vi.mock('@/core/memdir/write', () => ({ deleteMemory: h.deleteMemory, clearAllMemories: h.clearAllMemories }));

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });
const t = () => getI18n();
const FOLDER = '/fake/project';
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const MINUTE = 60_000;

function memory(filename: string, name: string, minutesOld: number, type: MemoryType = 'project', dir = '/fake/memory'): MemoryHeader {
  return {
    filename,
    filePath: `${dir}/${filename}`,
    name,
    description: `About ${name}`,
    type,
    source: 'agent_explicit',
    created: NOW - minutesOld * MINUTE,
    updated: NOW - minutesOld * MINUTE,
    accessCount: 0,
    private: false,
  };
}

const TEA = memory('tea.md', 'Likes green tea', 5, 'user');
const PNPM = memory('pnpm.md', 'Uses pnpm', 120, 'project');
const TONE = memory('tone.md', 'Answer briefly', 3 * 24 * 60, 'feedback');
const DOCS = memory('docs.md', 'Docs live in the wiki', 90 * 24 * 60, 'reference');

// What is in the fake memory folder; a scan returns a copy in this order.
let stored: MemoryHeader[] = [];

// A promise the test settles by hand: a file call takes time in the app.
function held<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Lets every promise the window waits on settle.
const settle = () => act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); });

const ui = {
  // The names of the listed memories, top to bottom.
  // The rows of the list, top to bottom: each is the button that opens one memory.
  rows: () => Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')),
  names: () => ui.rows().map((row) => row.querySelector('.truncate')?.textContent),
  row: (header: MemoryHeader) => screen.getByText(header.name).closest('button')!,
  expand: async (header: MemoryHeader) => {
    fireEvent.click(ui.row(header));
    await settle();
  },
  // The delete button of the memory that is open; the question has a button of the same name.
  deleteButton: () => within(screen.getByRole('dialog')).getByRole('button', { name: t().common.delete }),
  clearButton: () => screen.queryByRole('button', { name: t().panel.memoryClear }),
  // The Close button at the bottom; the corner button has the same name and comes last.
  closeButton: () => screen.getAllByRole('button', { name: t().common.close })[0],
  question: () => screen.queryByRole('alertdialog'),
  answer: async (name: string) => {
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name }));
    await settle();
  },
  escape: () => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' }),
};

type Scope = { scope: 'project'; workspacePath: string } | { scope: 'personal' };
const PROJECT: Scope = { scope: 'project', workspacePath: FOLDER };
const PERSONAL: Scope = { scope: 'personal' };

async function open(scope: Scope = PROJECT) {
  const onClose = vi.fn(() => { h.log.push('onClose'); });
  const view = render(<MemoryViewModal open onClose={onClose} {...scope} />);
  await settle();
  return {
    onClose,
    close: () => view.rerender(<MemoryViewModal open={false} onClose={onClose} {...scope} />),
    reopen: () => view.rerender(<MemoryViewModal open onClose={onClose} {...scope} />),
  };
}

// Stands in for the right panel: it closes the window when the window asks.
function Owner({ onClosed }: { onClosed: () => void }) {
  const [isOpen, setOpen] = useState(true);
  return <MemoryViewModal open={isOpen} onClose={() => { onClosed(); setOpen(false); }} {...PROJECT} />;
}

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  initLanguage('zh-CN');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  h.log.length = 0;
  stored = [PNPM, TEA, DOCS, TONE];
  h.scanMemoryFiles.mockReset().mockImplementation(async (workspacePath: string | null) => {
    h.log.push(`scan ${String(workspacePath)}`);
    return [...stored];
  });
  h.readMemoryFile.mockReset().mockImplementation(async (filePath: string) => {
    h.log.push(`read ${filePath}`);
    return { header: stored.find((header) => header.filePath === filePath), content: `Body of ${filePath}` };
  });
  h.deleteMemory.mockReset().mockImplementation(async (filename: string, workspacePath: string | null) => {
    h.log.push(`delete ${filename} ${String(workspacePath)}`);
    stored = stored.filter((header) => header.filename !== filename);
  });
  h.clearAllMemories.mockReset().mockImplementation(async (workspacePath: string | null) => {
    h.log.push(`clear ${String(workspacePath)}`);
    const count = stored.length;
    stored = [];
    return count;
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('MemoryViewModal', () => {
  describe('the list', () => {
    it('scans the folder of the workspace and lists its memories, newest first', async () => {
      await open();

      expect(h.log).toEqual([`scan ${FOLDER}`]);
      expect(ui.names()).toEqual([TEA.name, PNPM.name, TONE.name, DOCS.name]);
      expect(screen.getByText(t().panel.memoryTitle, { selector: 'h2, h3' })).toBeInTheDocument();
      expect(screen.getByText(t().panel.memoryDesc)).toBeInTheDocument();
      expect(screen.getByText(format(t().memory.entryCount, { count: '4' }))).toBeInTheDocument();
    });

    it('labels each memory with its kind and its age', async () => {
      await open();

      for (const label of [t().memory.categoryPreference, t().memory.categoryProject, t().memory.categoryFeedback, t().memory.categoryFact]) {
        expect(screen.getByText(label)).toBeInTheDocument();
      }
      for (const age of [
        format(t().memory.minutesAgo, { n: '5' }),
        format(t().memory.hoursAgo, { n: '2' }),
        format(t().memory.daysAgo, { n: '3' }),
        format(t().memory.monthsAgo, { n: '3' }),
      ]) {
        expect(screen.getByText(age)).toBeInTheDocument();
      }
    });

    it('scans the personal folder (no workspace) and carries the personal title', async () => {
      await open(PERSONAL);

      expect(h.scanMemoryFiles).toHaveBeenCalledWith(null);
      expect(screen.getByText(t().sidebar.personalMemoryTitle, { selector: 'h2, h3' })).toBeInTheDocument();
      expect(screen.getByText(t().sidebar.personalMemoryDesc)).toBeInTheDocument();
    });

    it('says there is none when the folder is empty, and offers no clearing', async () => {
      stored = [];
      await open();

      expect(screen.getByText(t().panel.memoryEmpty)).toBeInTheDocument();
      expect(ui.clearButton()).not.toBeInTheDocument();
    });

    it('shows the empty list when the scan fails', async () => {
      h.scanMemoryFiles.mockRejectedValue(new Error('fake scan failure'));
      await open();

      expect(screen.getByText(t().panel.memoryEmpty)).toBeInTheDocument();
    });

    it('scans again each time it opens', async () => {
      const { close, reopen } = await open();
      close();
      stored = [TEA];

      reopen();
      await settle();

      expect(ui.names()).toEqual([TEA.name]);
    });
  });

  describe('one memory', () => {
    it('shows its description at once, then its content, read once', async () => {
      const reading = held<{ content: string }>();
      h.readMemoryFile.mockReturnValueOnce(reading.promise);
      await open();

      await ui.expand(PNPM);
      expect(h.readMemoryFile).toHaveBeenCalledWith(PNPM.filePath);
      expect(screen.getByText(PNPM.description)).toBeInTheDocument();

      await act(async () => { reading.resolve({ content: 'pnpm install, pnpm dev' }); });
      await settle();
      expect(screen.getByText('pnpm install, pnpm dev')).toBeInTheDocument();

      await ui.expand(PNPM);
      await ui.expand(PNPM);
      expect(h.readMemoryFile).toHaveBeenCalledTimes(1);
      expect(screen.getByText('pnpm install, pnpm dev')).toBeInTheDocument();
    });

    it('keeps the description when the file has no content to read', async () => {
      h.readMemoryFile.mockResolvedValue(null);
      await open();

      await ui.expand(PNPM);

      expect(screen.getByText(PNPM.description)).toBeInTheDocument();
    });

    it('shows one memory at a time', async () => {
      await open();

      await ui.expand(PNPM);
      await ui.expand(TEA);

      expect(screen.getByText(`Body of ${TEA.filePath}`)).toBeInTheDocument();
      expect(screen.queryByText(`Body of ${PNPM.filePath}`)).not.toBeInTheDocument();
    });
  });

  describe('deleting one memory', () => {
    it('asks first, naming the memory; the answer deletes that file and scans again', async () => {
      await open();
      await ui.expand(PNPM);
      h.log.length = 0;

      fireEvent.click(ui.deleteButton());
      const question = ui.question()!;
      expect(question).toHaveTextContent(t().memory.deleteTitle);
      expect(question).toHaveTextContent(PNPM.name);
      expect(h.deleteMemory).not.toHaveBeenCalled();

      await ui.answer(t().common.delete);

      expect(h.log).toEqual([`delete ${PNPM.filename} ${FOLDER}`, `scan ${FOLDER}`]);
      expect(ui.names()).toEqual([TEA.name, TONE.name, DOCS.name]);
      expect(ui.question()).not.toBeInTheDocument();
    });

    it('deletes nothing when the answer is to cancel', async () => {
      await open();
      await ui.expand(PNPM);

      fireEvent.click(ui.deleteButton());
      await ui.answer(t().common.cancel);

      expect(h.deleteMemory).not.toHaveBeenCalled();
      expect(ui.names()).toHaveLength(4);
    });

    it('deletes a personal memory from the personal folder', async () => {
      await open(PERSONAL);
      await ui.expand(TEA);

      fireEvent.click(ui.deleteButton());
      await ui.answer(t().common.delete);

      expect(h.deleteMemory).toHaveBeenCalledWith(TEA.filename, null);
      expect(h.scanMemoryFiles).toHaveBeenLastCalledWith(null);
    });

    it('keeps the list when the delete fails', async () => {
      h.deleteMemory.mockRejectedValue(new Error('fake delete failure'));
      await open();
      await ui.expand(PNPM);

      fireEvent.click(ui.deleteButton());
      await ui.answer(t().common.delete);

      expect(ui.names()).toHaveLength(4);
    });
  });

  describe('clearing', () => {
    it('asks first, naming the project memories; the answer clears the folder and empties the list', async () => {
      await open();
      h.log.length = 0;

      fireEvent.click(ui.clearButton()!);
      const question = ui.question()!;
      expect(question).toHaveTextContent(t().panel.memoryClearTitle);
      expect(question).toHaveTextContent(t().panel.memoryClearMessage);
      expect(h.clearAllMemories).not.toHaveBeenCalled();

      await ui.answer(t().panel.memoryClearConfirm);

      expect(h.log).toEqual([`clear ${FOLDER}`]);
      expect(screen.getByText(t().panel.memoryEmpty)).toBeInTheDocument();
      expect(ui.clearButton()).not.toBeInTheDocument();
      expect(ui.question()).not.toBeInTheDocument();
    });

    it('clears nothing when the answer is to cancel', async () => {
      await open();

      fireEvent.click(ui.clearButton()!);
      await ui.answer(t().common.cancel);

      expect(h.clearAllMemories).not.toHaveBeenCalled();
      expect(ui.names()).toHaveLength(4);
    });

    it('names the personal memories and clears the personal folder', async () => {
      await open(PERSONAL);

      fireEvent.click(ui.clearButton()!);
      expect(ui.question()).toHaveTextContent(t().sidebar.personalMemoryClearMessage);
      await ui.answer(t().panel.memoryClearConfirm);

      expect(h.clearAllMemories).toHaveBeenCalledWith(null);
    });

    it('keeps the list when clearing fails', async () => {
      h.clearAllMemories.mockRejectedValue(new Error('fake clear failure'));
      await open();

      fireEvent.click(ui.clearButton()!);
      await ui.answer(t().panel.memoryClearConfirm);

      expect(ui.names()).toHaveLength(4);
    });
  });

  describe('closing', () => {
    it('closes on Escape and on its Close button, deleting nothing', async () => {
      const { onClose } = await open();

      ui.escape();
      expect(onClose).toHaveBeenCalledTimes(1);
      fireEvent.click(ui.closeButton());
      expect(onClose).toHaveBeenCalledTimes(2);

      expect(h.deleteMemory).not.toHaveBeenCalled();
      expect(h.clearAllMemories).not.toHaveBeenCalled();
    });

    // Closing cancels nothing: a delete the user confirmed runs to its end.
    it('does not stop a delete that is under way', async () => {
      const onClosed = vi.fn();
      render(<Owner onClosed={onClosed} />);
      await settle();
      await ui.expand(PNPM);
      const deleting = held<void>();
      h.deleteMemory.mockImplementationOnce(async (filename: string, workspacePath: string | null) => {
        h.log.push(`delete ${filename} ${String(workspacePath)}`);
        await deleting.promise;
        stored = stored.filter((header) => header.filename !== filename);
      });
      h.log.length = 0;

      fireEvent.click(ui.deleteButton());
      await ui.answer(t().common.delete);
      ui.escape();
      expect(onClosed).toHaveBeenCalledTimes(1);
      await act(async () => { deleting.resolve(); });
      await settle();

      expect(h.log).toEqual([`delete ${PNPM.filename} ${FOLDER}`, `scan ${FOLDER}`]);
      expect(stored.map((header) => header.filename)).not.toContain(PNPM.filename);
    });
  });

  describe('as a design-system window', () => {
    it('is a dialog named by its title, with a named corner button beside its Close button', async () => {
      await open();

      expect(screen.getByRole('dialog', { name: t().panel.memoryTitle })).toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: t().common.close })).toHaveLength(2);
    });

    it('shows one spinner with its words while the folder is being scanned', async () => {
      const scanning = held<MemoryHeader[]>();
      h.scanMemoryFiles.mockReturnValueOnce(scanning.promise);
      await open();

      expect(document.querySelectorAll('[data-ds-spinner]')).toHaveLength(1);
      expect(screen.getByRole('status')).toHaveTextContent(t().common.loading);
      expect(ui.clearButton()).not.toBeInTheDocument();

      await act(async () => { scanning.resolve([TEA]); });
      await settle();
      expect(document.querySelectorAll('[data-ds-spinner]')).toHaveLength(0);
    });

    it('lists each memory as a row that says whether it is open', async () => {
      await open();
      expect(ui.rows().map((row) => row.getAttribute('aria-expanded'))).toEqual(['false', 'false', 'false', 'false']);

      await ui.expand(PNPM);

      expect(ui.row(PNPM)).toHaveAttribute('aria-expanded', 'true');
      expect(ui.row(TEA)).toHaveAttribute('aria-expanded', 'false');
    });

    describe('the labels of the kinds', () => {
      const labels = () => [t().memory.categoryPreference, t().memory.categoryProject, t().memory.categoryFeedback, t().memory.categoryFact]
        .map((label) => screen.getByText(label).className).join(' ');

      it('carry no purple', async () => {
        await open();
        expect(labels()).not.toMatch(/purple/);
      });

      it('carry no teal', async () => {
        await open();
        expect(labels()).not.toMatch(/teal/);
      });

      it('carry no clay', async () => {
        await open();
        expect(labels()).not.toMatch(/clay/);
      });
    });

    describe('where the focus is', () => {
      it('opens on its Close button, also once the list is there', async () => {
        await open();
        expect(ui.closeButton()).toHaveFocus();
      });

      it('opens a question on Cancel, where Enter deletes nothing', async () => {
        await open();
        await ui.expand(PNPM);

        fireEvent.click(ui.deleteButton());
        const cancel = within(ui.question()!).getByRole('button', { name: t().common.cancel });
        expect(cancel).toHaveFocus();
        fireEvent.click(cancel);
        await settle();
        expect(h.deleteMemory).not.toHaveBeenCalled();

        fireEvent.click(ui.clearButton()!);
        expect(within(ui.question()!).getByRole('button', { name: t().common.cancel })).toHaveFocus();
      });

      it('goes to the row that took the place of a deleted memory', async () => {
        await open();
        await ui.expand(PNPM);
        const button = ui.deleteButton();
        act(() => button.focus());

        fireEvent.click(button);
        await ui.answer(t().common.delete);

        expect(ui.row(TONE)).toHaveFocus();
      });

      it('goes to the row before when the last memory of the list was deleted', async () => {
        await open();
        await ui.expand(DOCS);
        const button = ui.deleteButton();
        act(() => button.focus());

        fireEvent.click(button);
        await ui.answer(t().common.delete);

        expect(ui.row(TONE)).toHaveFocus();
      });

      it('goes to the Close button when no memory is left, after a delete and after clearing', async () => {
        stored = [TEA];
        await open();
        await ui.expand(TEA);
        fireEvent.click(ui.deleteButton());
        await ui.answer(t().common.delete);
        expect(ui.closeButton()).toHaveFocus();
        cleanup();

        stored = [TEA, PNPM];
        await open();
        const clear = ui.clearButton()!;
        act(() => clear.focus());
        fireEvent.click(clear);
        await ui.answer(t().panel.memoryClearConfirm);
        expect(ui.closeButton()).toHaveFocus();
      });
    });

    describe('a question', () => {
      it('closes alone on Escape: the window stays and nothing is deleted', async () => {
        const { onClose } = await open();
        await ui.expand(PNPM);
        fireEvent.click(ui.deleteButton());

        ui.escape();
        await settle();

        expect(ui.question()).not.toBeInTheDocument();
        expect(onClose).not.toHaveBeenCalled();
        expect(h.deleteMemory).not.toHaveBeenCalled();
        expect(screen.getByRole('dialog', { name: t().panel.memoryTitle })).toBeInTheDocument();
      });

      it('says how many memories clearing takes, on a line of its own', async () => {
        await open();

        fireEvent.click(ui.clearButton()!);

        expect(ui.question()).toHaveTextContent(format(t().memory.entryCount, { count: '4' }));
      });

      it('is not asked again about a memory whose delete is under way: one memory, one delete', async () => {
        await open();
        const deleting = held<void>();
        h.deleteMemory.mockImplementationOnce(async () => { await deleting.promise; });
        await ui.expand(PNPM);
        const button = ui.deleteButton();
        fireEvent.click(button);
        await ui.answer(t().common.delete);

        fireEvent.click(button);

        expect(ui.question()).not.toBeInTheDocument();
        await act(async () => { deleting.resolve(); });
        await settle();
        expect(h.deleteMemory).toHaveBeenCalledTimes(1);
      });

      it('is not asked again while the memories are being cleared', async () => {
        await open();
        const clearing = held<number>();
        h.clearAllMemories.mockImplementationOnce(async () => clearing.promise);
        fireEvent.click(ui.clearButton()!);
        await ui.answer(t().panel.memoryClearConfirm);

        fireEvent.click(ui.clearButton()!);

        expect(ui.question()).not.toBeInTheDocument();
        await act(async () => { clearing.resolve(4); });
        await settle();
        expect(h.clearAllMemories).toHaveBeenCalledTimes(1);
      });

      // The list can change while a question is open: another delete lands and the scan
      // after it no longer finds this memory.
      it('deletes nothing when the memory has left the list by the time of the answer', async () => {
        await open();
        const deleting = held<void>();
        h.deleteMemory.mockImplementationOnce(async (filename: string) => {
          h.log.push(`delete ${filename}`);
          await deleting.promise;
          stored = [];
        });
        await ui.expand(PNPM);
        fireEvent.click(ui.deleteButton());
        await ui.answer(t().common.delete);
        await ui.expand(TEA);
        fireEvent.click(ui.deleteButton());
        expect(ui.question()).toHaveTextContent(TEA.name);

        await act(async () => { deleting.resolve(); });
        await settle();
        await ui.answer(t().common.delete);

        expect(h.deleteMemory).toHaveBeenCalledTimes(1);
        expect(h.deleteMemory).toHaveBeenCalledWith(PNPM.filename, FOLDER);
      });

      it('clears nothing when the list has emptied by the time of the answer', async () => {
        stored = [TEA];
        await open();
        const deleting = held<void>();
        h.deleteMemory.mockImplementationOnce(async () => {
          await deleting.promise;
          stored = [];
        });
        await ui.expand(TEA);
        fireEvent.click(ui.deleteButton());
        await ui.answer(t().common.delete);
        fireEvent.click(ui.clearButton()!);

        await act(async () => { deleting.resolve(); });
        await settle();
        await ui.answer(t().panel.memoryClearConfirm);

        expect(h.clearAllMemories).not.toHaveBeenCalled();
      });
    });

    describe('each opening', () => {
      it('starts with every memory closed and reads a memory again', async () => {
        const { close, reopen } = await open();
        await ui.expand(PNPM);
        close();

        reopen();
        await settle();
        expect(ui.rows().map((row) => row.getAttribute('aria-expanded'))).toEqual(['false', 'false', 'false', 'false']);
        await ui.expand(PNPM);

        expect(h.readMemoryFile).toHaveBeenCalledTimes(2);
      });

      // The scan after a delete belongs to the folder the delete was made in.
      it('keeps the list of the folder in view when a delete made in another folder lands', async () => {
        const onClose = vi.fn();
        const view = render(<MemoryViewModal open onClose={onClose} scope="project" workspacePath={FOLDER} />);
        await settle();
        const deleting = held<void>();
        h.deleteMemory.mockImplementationOnce(async () => { await deleting.promise; });
        await ui.expand(PNPM);
        fireEvent.click(ui.deleteButton());
        await ui.answer(t().common.delete);

        const other = memory('other.md', 'Of the other folder', 1, 'project', '/fake/other-memory');
        h.scanMemoryFiles.mockImplementation(async (workspacePath: string | null) => (workspacePath === '/fake/other' ? [other] : [TEA]));
        view.rerender(<MemoryViewModal open onClose={onClose} scope="project" workspacePath="/fake/other" />);
        await settle();
        await act(async () => { deleting.resolve(); });
        await settle();

        expect(ui.names()).toEqual([other.name]);
      });
    });

    describe('while it fades out', () => {
      it('keeps the list it showed, and asks and deletes nothing', async () => {
        keepClosingLayersOnScreen();
        const { close } = await open();
        await ui.expand(PNPM);
        close();
        expect(closingWindow()).toHaveTextContent(PNPM.name);

        fireEvent.click(within(closingWindow()).getByRole('button', { name: t().common.delete, hidden: true }));
        fireEvent.click(within(closingWindow()).getByRole('button', { name: t().panel.memoryClear, hidden: true }));
        await settle();

        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
        expect(h.deleteMemory).not.toHaveBeenCalled();
        expect(h.clearAllMemories).not.toHaveBeenCalled();
      });
    });

    describe('when an approval arrives', () => {
      const onAnswer = vi.fn();
      function Host({ approval, onClosed }: { approval: boolean; onClosed: () => void }) {
        const [isOpen, setOpen] = useState(true);
        return (
          <>
            <MemoryViewModal open={isOpen} onClose={() => { onClosed(); setOpen(false); }} {...PROJECT} />
            {approvalProbe(approval, onAnswer)}
          </>
        );
      }
      async function besideApproval() {
        onAnswer.mockReset();
        const onClosed = vi.fn();
        const view = render(<Host approval={false} onClosed={onClosed} />);
        await settle();
        return { onClosed, arrive: () => view.rerender(<Host approval onClosed={onClosed} />) };
      }
      const approval = () => windowBox(APPROVAL_TITLE);
      const own = () => windowBox(t().panel.memoryTitle);

      it('is closed for the approval, and deletes nothing', async () => {
        const { onClosed, arrive } = await besideApproval();

        arrive();
        await settle();

        expect(onClosed).toHaveBeenCalledTimes(1);
        expect(own()).toBeNull();
        expect(approval()).not.toBeNull();
        expect(onAnswer).not.toHaveBeenCalled();
        expect(h.deleteMemory).not.toHaveBeenCalled();
        expect(h.clearAllMemories).not.toHaveBeenCalled();
      });

      it.each(['delete', 'clear'] as const)('takes its %s question with it, answered with cancel', async (kind) => {
        const { onClosed, arrive } = await besideApproval();
        if (kind === 'delete') {
          await ui.expand(PNPM);
          fireEvent.click(ui.deleteButton());
        } else {
          fireEvent.click(ui.clearButton()!);
        }
        expect(ui.question()).toBeInTheDocument();

        arrive();
        await settle();

        expect(windowBox(kind === 'delete' ? t().memory.deleteTitle : t().panel.memoryClearTitle)).toBeNull();
        expect(onClosed).toHaveBeenCalledTimes(1);
        expect(approval()).not.toBeNull();
        expect(onAnswer).not.toHaveBeenCalled();
        expect(h.deleteMemory).not.toHaveBeenCalled();
        expect(h.clearAllMemories).not.toHaveBeenCalled();
      });

      it('does not stop a confirmed delete: it runs to its end behind the approval', async () => {
        const { arrive } = await besideApproval();
        const deleting = held<void>();
        h.deleteMemory.mockImplementationOnce(async (filename: string, workspacePath: string | null) => {
          h.log.push(`delete ${filename} ${String(workspacePath)}`);
          await deleting.promise;
        });
        await ui.expand(PNPM);
        fireEvent.click(ui.deleteButton());
        await ui.answer(t().common.delete);
        h.log.length = 0;

        arrive();
        await act(async () => { deleting.resolve(); });
        await settle();

        expect(h.deleteMemory).toHaveBeenCalledTimes(1);
        expect(onAnswer).not.toHaveBeenCalled();
      });
    });
  });
});
