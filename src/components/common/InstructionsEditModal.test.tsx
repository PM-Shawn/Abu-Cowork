// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render as renderBare, screen } from '@testing-library/react';
import { useState, type ReactElement } from 'react';
import { exists, mkdir, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { APPROVAL_TITLE, approvalProbe, closingWindow, discardQuestion, keepClosingLayersOnScreen, windowBox } from '@/test/dsWindows';
import { DesignSystemProvider } from '@/components/ds/provider';
import { getI18n, initLanguage } from '@/i18n';
import InstructionsEditModal from './InstructionsEditModal';

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });
const t = () => getI18n();
const FOLDER = '/fake/project';
const DIR = `${FOLDER}/.abu`;
const FILE = `${DIR}/ABU.md`;

// Every file call the window makes, in the order it makes it.
let log: string[] = [];
// What is on the fake disk: the instructions file of each folder, and the folders that have `.abu`.
let files: Record<string, string> = {};
let dirs: string[] = [];

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
  field: () => screen.getByRole<HTMLTextAreaElement>('textbox'),
  queryField: () => screen.queryByRole<HTMLTextAreaElement>('textbox'),
  save: () => screen.getByRole('button', { name: new RegExp(`^(${t().common.save}|${t().panel.instructionsSaving.replace(/\./g, '\\.')})$`) }),
  cancel: () => screen.getByRole('button', { name: t().common.cancel }),
  type: (value: string) => fireEvent.change(ui.field(), { target: { value } }),
  escape: () => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' }),
};

// Stands in for the right panel: it closes the window when the window asks.
function Owner({ onClosed, folder = FOLDER }: { onClosed: () => void; folder?: string }) {
  const [isOpen, setOpen] = useState(true);
  return (
    <InstructionsEditModal
      open={isOpen}
      onClose={() => { onClosed(); setOpen(false); }}
      workspacePath={folder}
    />
  );
}

async function open(folder = FOLDER) {
  const onClose = vi.fn(() => { log.push('onClose'); });
  const view = render(<InstructionsEditModal open onClose={onClose} workspacePath={folder} />);
  await settle();
  return {
    onClose,
    close: () => view.rerender(<InstructionsEditModal open={false} onClose={onClose} workspacePath={folder} />),
    reopen: () => view.rerender(<InstructionsEditModal open onClose={onClose} workspacePath={folder} />),
    moveTo: (other: string) => view.rerender(<InstructionsEditModal open onClose={onClose} workspacePath={other} />),
  };
}

async function openInOwner() {
  const onClosed = vi.fn(() => { log.push('onClose'); });
  render(<Owner onClosed={onClosed} />);
  await settle();
  return { onClosed };
}

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  initLanguage('zh-CN');
  log = [];
  files = {};
  dirs = [];
  vi.mocked(exists).mockReset().mockImplementation(async (path) => {
    log.push(`exists ${String(path)}`);
    return String(path) in files || dirs.includes(String(path));
  });
  vi.mocked(readTextFile).mockReset().mockImplementation(async (path) => {
    log.push(`readTextFile ${String(path)}`);
    return files[String(path)];
  });
  vi.mocked(mkdir).mockReset().mockImplementation(async (path, options) => {
    log.push(`mkdir ${String(path)} ${JSON.stringify(options)}`);
    dirs.push(String(path));
  });
  vi.mocked(writeTextFile).mockReset().mockImplementation(async (path, text) => {
    log.push(`writeTextFile ${String(path)} [${text}]`);
    files[String(path)] = text;
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('InstructionsEditModal', () => {
  describe('what it opens with', () => {
    it('shows what .abu/ABU.md of the folder holds', async () => {
      files[FILE] = 'Answer briefly.';
      dirs.push(DIR);

      await open();

      expect(ui.field().value).toBe('Answer briefly.');
      expect(log).toEqual([`exists ${FILE}`, `readTextFile ${FILE}`]);
      expect(screen.getByText(t().panel.instructionsTitle)).toBeInTheDocument();
      expect(screen.getByText(t().panel.instructionsDesc)).toBeInTheDocument();
    });

    it('starts empty when the file does not exist, and reads nothing', async () => {
      await open();

      expect(ui.field().value).toBe('');
      expect(ui.field()).toHaveAttribute('placeholder', t().panel.instructionsPlaceholder);
      expect(log).toEqual([`exists ${FILE}`]);
    });

    it('starts empty when the file cannot be read', async () => {
      files[FILE] = 'Answer briefly.';
      vi.mocked(readTextFile).mockRejectedValue(new Error('fake read failure'));

      await open();

      expect(ui.field().value).toBe('');
    });

    it('shows no field while the file is being read, and saves nothing then', async () => {
      const reading = held<boolean>();
      vi.mocked(exists).mockReturnValueOnce(reading.promise);

      await open();
      expect(ui.queryField()).not.toBeInTheDocument();
      fireEvent.click(ui.save());
      await settle();
      expect(writeTextFile).not.toHaveBeenCalled();

      reading.resolve(false);
      await settle();
      expect(ui.field().value).toBe('');
    });

    it('reads the file again each time it opens', async () => {
      files[FILE] = 'Answer briefly.';
      const { close, reopen } = await open();
      ui.type('Typed and left');
      close();
      files[FILE] = 'Changed on disk.';

      reopen();
      await settle();

      expect(ui.field().value).toBe('Changed on disk.');
    });

    it('drops a read that an earlier opening started', async () => {
      const first = held<string>();
      files[FILE] = 'On disk now.';
      vi.mocked(readTextFile).mockReturnValueOnce(first.promise);
      const { close, reopen } = await open();

      close();
      reopen();
      await settle();
      first.resolve('From the first opening.');
      await settle();

      expect(ui.field().value).toBe('On disk now.');
    });

    // The text on screen is always the text of the folder a save would write to.
    it('reads the other folder when the folder changes while it is open', async () => {
      files[FILE] = 'Answer briefly.';
      files['/fake/other/.abu/ABU.md'] = 'The other folder.';
      const { moveTo } = await open();
      ui.type('Typed for the first folder');

      moveTo('/fake/other');
      await settle();

      expect(ui.field().value).toBe('The other folder.');
    });
  });

  describe('saving', () => {
    it('makes .abu when it is missing, writes the whole text, then closes, in that order', async () => {
      const { onClose } = await open();
      log.length = 0;
      ui.type('Use pnpm.\nAnswer briefly.');

      fireEvent.click(ui.save());
      await settle();

      expect(log).toEqual([
        `exists ${DIR}`,
        `mkdir ${DIR} {"recursive":true}`,
        `writeTextFile ${FILE} [Use pnpm.\nAnswer briefly.]`,
        'onClose',
      ]);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('makes no folder when .abu is there', async () => {
      files[FILE] = 'Old.';
      dirs.push(DIR);
      await open();
      log.length = 0;
      ui.type('New.');

      fireEvent.click(ui.save());
      await settle();

      expect(log).toEqual([`exists ${DIR}`, `writeTextFile ${FILE} [New.]`, 'onClose']);
    });

    it('writes an emptied text as an empty file', async () => {
      files[FILE] = 'Old.';
      dirs.push(DIR);
      await open();
      ui.type('');

      fireEvent.click(ui.save());
      await settle();

      expect(writeTextFile).toHaveBeenCalledWith(FILE, '');
    });

    it('says so when the save fails, stays open with the text, and saves on the next press', async () => {
      const { onClose } = await open();
      ui.type('Use pnpm.');
      vi.mocked(writeTextFile).mockRejectedValueOnce(new Error('fake write failure'));

      fireEvent.click(ui.save());
      await settle();

      const message = screen.getByRole('alert');
      expect(message).toHaveTextContent(t().panel.instructionsSaveFailed);
      expect(message).toHaveTextContent('fake write failure');
      expect(onClose).not.toHaveBeenCalled();
      expect(ui.field().value).toBe('Use pnpm.');

      fireEvent.click(ui.save());
      await settle();
      expect(files[FILE]).toBe('Use pnpm.');
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('takes the message away when the next save starts', async () => {
      await open();
      vi.mocked(mkdir).mockRejectedValueOnce(new Error('fake folder failure'));
      fireEvent.click(ui.save());
      await settle();
      expect(screen.getByRole('alert')).toHaveTextContent('fake folder failure');
      expect(writeTextFile).not.toHaveBeenCalled();

      const writing = held<void>();
      vi.mocked(writeTextFile).mockReturnValueOnce(writing.promise);
      fireEvent.click(ui.save());
      await settle();

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('takes one save at a time and says it is saving', async () => {
      await open();
      ui.type('Use pnpm.');
      const writing = held<void>();
      vi.mocked(writeTextFile).mockReturnValueOnce(writing.promise);

      fireEvent.click(ui.save());
      await settle();
      expect(ui.save()).toHaveTextContent(t().panel.instructionsSaving);
      fireEvent.click(ui.save());
      await settle();

      expect(writeTextFile).toHaveBeenCalledTimes(1);

      writing.resolve();
      await settle();
    });

    // The handler keeps its own count: the look of the button is not what stops a second save.
    it('saves once for two presses that arrive before the window has drawn again', async () => {
      await open();
      ui.type('Use pnpm.');
      const button = ui.save();

      act(() => {
        button.click();
        button.click();
      });
      await settle();

      expect(writeTextFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('closing', () => {
    it('closes on Escape when the text is as it was read', async () => {
      files[FILE] = 'Answer briefly.';
      const { onClose } = await open();

      ui.escape();

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(writeTextFile).not.toHaveBeenCalled();
    });

    it('closes on Cancel without writing', async () => {
      files[FILE] = 'Answer briefly.';
      const { onClose } = await open();

      fireEvent.click(ui.cancel());

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(writeTextFile).not.toHaveBeenCalled();
    });

    // Closing cancels nothing: the one write call carries the whole text and runs to its end,
    // and the owner hears of the saved file again, which is how the panel learns the file exists.
    it('does not stop a save that is under way: the whole text is written and the owner is told again', async () => {
      files[FILE] = 'Answer briefly.';
      dirs.push(DIR);
      const { onClosed } = await openInOwner();
      const writing = held<void>();
      vi.mocked(writeTextFile).mockImplementationOnce(async (path, text) => {
        log.push(`writeTextFile ${String(path)} [${text}]`);
        await writing.promise;
      });
      log.length = 0;

      fireEvent.click(ui.save());
      await settle();
      ui.escape();
      expect(onClosed).toHaveBeenCalledTimes(1);

      writing.resolve();
      await settle();

      expect(log).toEqual([`exists ${DIR}`, `writeTextFile ${FILE} [Answer briefly.]`, 'onClose', 'onClose']);
    });
  });

  describe('as a design-system window', () => {
    it('is a dialog named by its title, with a named corner button', async () => {
      await open();

      expect(screen.getByRole('dialog', { name: t().panel.instructionsTitle })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: t().common.close })).toBeInTheDocument();
    });

    it('shows one spinner with its words while the file is being read, and none after', async () => {
      const reading = held<boolean>();
      vi.mocked(exists).mockReturnValueOnce(reading.promise);
      await open();

      expect(document.querySelectorAll('[data-ds-spinner]')).toHaveLength(1);
      expect(screen.getByRole('status')).toHaveTextContent(t().common.loading);

      reading.resolve(false);
      await settle();
      expect(document.querySelectorAll('[data-ds-spinner]')).toHaveLength(0);
    });

    describe('where the focus is', () => {
      it('opens on Cancel while the file is being read, and moves to the text once it is there', async () => {
        const reading = held<boolean>();
        vi.mocked(exists).mockReturnValueOnce(reading.promise);
        await open();
        expect(ui.cancel()).toHaveFocus();

        reading.resolve(false);
        await settle();

        expect(ui.field()).toHaveFocus();
      });

      it('leaves the focus where the user put it while the file was being read', async () => {
        const reading = held<boolean>();
        vi.mocked(exists).mockReturnValueOnce(reading.promise);
        await open();
        const corner = screen.getByRole('button', { name: t().common.close });
        act(() => corner.focus());

        reading.resolve(false);
        await settle();

        expect(corner).toHaveFocus();
      });
    });

    describe('with the text changed', () => {
      it('asks before it closes on Escape; keeping on leaves the text, discarding writes nothing', async () => {
        files[FILE] = 'Answer briefly.';
        const { onClose } = await open();
        ui.type('Answer at length.');

        ui.escape();
        expect(discardQuestion.box()).not.toBeNull();
        expect(onClose).not.toHaveBeenCalled();

        discardQuestion.keepEditing();
        expect(ui.field().value).toBe('Answer at length.');

        ui.escape();
        discardQuestion.discard();
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(writeTextFile).not.toHaveBeenCalled();
      });

      it('asks on Cancel and on the corner button too', async () => {
        const { onClose } = await open();
        ui.type('Use pnpm.');

        fireEvent.click(ui.cancel());
        expect(discardQuestion.box()).not.toBeNull();
        discardQuestion.keepEditing();
        fireEvent.click(screen.getByRole('button', { name: t().common.close }));
        expect(discardQuestion.box()).not.toBeNull();

        expect(onClose).not.toHaveBeenCalled();
      });

      it('asks nothing once the text is what was read again', async () => {
        files[FILE] = 'Answer briefly.';
        const { onClose } = await open();
        ui.type('Answer at length.');
        ui.type('Answer briefly.');

        ui.escape();

        expect(discardQuestion.box()).toBeNull();
        expect(onClose).toHaveBeenCalledTimes(1);
      });

      it('saves without asking', async () => {
        const { onClose } = await open();
        ui.type('Use pnpm.');

        fireEvent.click(ui.save());
        await settle();

        expect(discardQuestion.box()).toBeNull();
        expect(onClose).toHaveBeenCalledTimes(1);
      });
    });

    describe('while a save is under way', () => {
      async function saving(text: string) {
        const opened = await openInOwner();
        ui.type(text);
        const writing = held<void>();
        vi.mocked(writeTextFile).mockImplementationOnce(async (path, body) => {
          log.push(`writeTextFile ${String(path)} [${body}]`);
          await writing.promise;
        });
        fireEvent.click(ui.save());
        await settle();
        return { ...opened, writing };
      }

      it('keeps the Save button in the tab order and takes no press on it', async () => {
        const { writing } = await saving('Use pnpm.');

        expect(ui.save()).toHaveAttribute('aria-disabled', 'true');
        expect(ui.save()).not.toBeDisabled();

        writing.resolve();
        await settle();
      });

      // Escape asks about the typed text; the save is not stopped by it, and when it lands the
      // window closes and the question goes with it.
      it('asks on Escape, and the save that lands closes the window and the question', async () => {
        const { onClosed, writing } = await saving('Use pnpm.');

        ui.escape();
        expect(discardQuestion.box()).not.toBeNull();
        expect(onClosed).not.toHaveBeenCalled();

        writing.resolve();
        await settle();

        expect(log.filter((entry) => entry.startsWith('writeTextFile'))).toEqual([`writeTextFile ${FILE} [Use pnpm.]`]);
        expect(onClosed).toHaveBeenCalledTimes(1);
        expect(discardQuestion.box()).toBeNull();
        expect(windowBox(t().panel.instructionsTitle)).toBeNull();
      });

      it('keeps the question and shows the failure when the save fails behind it', async () => {
        const { onClosed, writing } = await saving('Use pnpm.');
        ui.escape();

        writing.reject(new Error('fake write failure'));
        await settle();

        expect(discardQuestion.box()).not.toBeNull();
        discardQuestion.keepEditing();
        expect(screen.getByRole('alert')).toHaveTextContent('fake write failure');
        expect(ui.field().value).toBe('Use pnpm.');
        expect(onClosed).not.toHaveBeenCalled();
      });
    });

    describe('while it fades out', () => {
      it('keeps the text it showed and saves nothing on Save', async () => {
        keepClosingLayersOnScreen();
        files[FILE] = 'Answer briefly.';
        const { onClose, close } = await open();
        log.length = 0;
        close();
        expect(closingWindow()).toHaveTextContent(t().panel.instructionsTitle);
        expect(screen.getByRole<HTMLTextAreaElement>('textbox', { hidden: true }).value).toBe('Answer briefly.');

        fireEvent.click(screen.getByRole('button', { name: t().common.save, hidden: true }));
        await settle();

        expect(log).toEqual([]);
        expect(onClose).not.toHaveBeenCalled();
      });

      it('shows no message when a save fails after it was closed', async () => {
        keepClosingLayersOnScreen();
        files[FILE] = 'Answer briefly.';
        const { close } = await open();
        const writing = held<void>();
        vi.mocked(writeTextFile).mockReturnValueOnce(writing.promise);
        fireEvent.click(ui.save());
        await settle();

        close();
        writing.reject(new Error('fake write failure'));
        await settle();

        expect(closingWindow()).not.toHaveTextContent(t().panel.instructionsSaveFailed);
        expect(screen.queryByRole('alert', { hidden: true })).not.toBeInTheDocument();
      });
    });

    // A save belongs to the opening it was started in.
    it('is not closed by the save of an earlier opening, and keeps what was typed since', async () => {
      const { onClose, close, reopen } = await open();
      ui.type('First opening.');
      const writing = held<void>();
      vi.mocked(writeTextFile).mockReturnValueOnce(writing.promise);
      fireEvent.click(ui.save());
      await settle();

      close();
      reopen();
      await settle();
      ui.type('Second opening.');
      writing.resolve();
      await settle();

      expect(onClose).not.toHaveBeenCalled();
      expect(ui.field().value).toBe('Second opening.');
      fireEvent.click(ui.save());
      await settle();
      expect(vi.mocked(writeTextFile).mock.calls.at(-1)).toEqual([FILE, 'Second opening.']);
    });

    describe('when an approval arrives', () => {
      const onAnswer = vi.fn();
      function Host({ approval, onClosed }: { approval: boolean; onClosed: () => void }) {
        const [isOpen, setOpen] = useState(true);
        return (
          <>
            <InstructionsEditModal open={isOpen} onClose={() => { onClosed(); setOpen(false); }} workspacePath={FOLDER} />
            {approvalProbe(approval, onAnswer)}
          </>
        );
      }
      async function besideApproval() {
        onAnswer.mockReset();
        const onClosed = vi.fn(() => { log.push('onClose'); });
        const view = render(<Host approval={false} onClosed={onClosed} />);
        await settle();
        return {
          onClosed,
          arrive: () => view.rerender(<Host approval onClosed={onClosed} />),
          leave: () => view.rerender(<Host approval={false} onClosed={onClosed} />),
        };
      }
      const approval = () => windowBox(APPROVAL_TITLE);
      const own = () => windowBox(t().panel.instructionsTitle);

      it('asks about the changed text; the approval waits off the page, unanswered, and keeping on keeps the text', async () => {
        const { onClosed, arrive } = await besideApproval();
        ui.type('Use pnpm.');

        arrive();
        expect(discardQuestion.box()).not.toBeNull();
        expect(approval()).toBeNull();

        discardQuestion.keepEditing();
        expect(approval()).toBeNull();
        expect(ui.field().value).toBe('Use pnpm.');
        expect(onClosed).not.toHaveBeenCalled();
        expect(onAnswer).not.toHaveBeenCalled();
        expect(writeTextFile).not.toHaveBeenCalled();
      });

      it('is closed for the approval when the text is as it was read, and writes nothing', async () => {
        const { onClosed, arrive } = await besideApproval();

        arrive();

        expect(onClosed).toHaveBeenCalledTimes(1);
        expect(own()).toBeNull();
        expect(approval()).not.toBeNull();
        expect(onAnswer).not.toHaveBeenCalled();
        expect(writeTextFile).not.toHaveBeenCalled();
      });

      it('steps aside while it saves, unasked and unclosed, and the save that lands closes it', async () => {
        const { onClosed, arrive } = await besideApproval();
        ui.type('Use pnpm.');
        const writing = held<void>();
        vi.mocked(writeTextFile).mockImplementationOnce(async (path, body) => {
          log.push(`writeTextFile ${String(path)} [${body}]`);
          await writing.promise;
        });
        fireEvent.click(ui.save());
        await settle();
        const window = own();

        arrive();
        expect(approval()).not.toBeNull();
        expect(own()).toBe(window);
        expect(window).toHaveAttribute('hidden');
        expect(discardQuestion.box()).toBeNull();
        expect(onClosed).not.toHaveBeenCalled();

        writing.resolve();
        await settle();

        expect(log.filter((entry) => entry.startsWith('writeTextFile'))).toEqual([`writeTextFile ${FILE} [Use pnpm.]`]);
        expect(onClosed).toHaveBeenCalledTimes(1);
        expect(approval()).not.toBeNull();
        expect(onAnswer).not.toHaveBeenCalled();
      });

      it('returns after the approval with the text and the failure when the save failed meanwhile', async () => {
        const { onClosed, arrive, leave } = await besideApproval();
        ui.type('Use pnpm.');
        const writing = held<void>();
        vi.mocked(writeTextFile).mockReturnValueOnce(writing.promise);
        fireEvent.click(ui.save());
        await settle();
        const window = own();

        arrive();
        writing.reject(new Error('fake write failure'));
        await settle();
        leave();

        expect(own()).toBe(window);
        expect(window).not.toHaveAttribute('hidden');
        expect(ui.field().value).toBe('Use pnpm.');
        expect(screen.getByRole('alert')).toHaveTextContent('fake write failure');
        expect(onClosed).not.toHaveBeenCalled();
        expect(onAnswer).not.toHaveBeenCalled();
      });
    });
  });
});
