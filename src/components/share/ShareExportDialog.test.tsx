// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { act, render as renderBare, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState, type ReactElement } from 'react';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { Button } from '@/components/ds/button';
import { DesignSystemProvider } from '@/components/ds/provider';
import { APPROVAL_TITLE, approvalProbe, closingWindow, finishClosing, keepClosingLayersOnScreen, windowBox } from '@/test/dsWindows';
import { serializeShareBundle, type ShareBundle } from '@/core/session/shareBundle';
import { format, getI18n, initLanguage } from '@/i18n';
import type { Conversation, Message } from '@/types';
import ShareExportDialog from './ShareExportDialog';
import { useChatStore } from '../../stores/chatStore';

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });
const t = () => getI18n();
const realExport = useChatStore.getState().exportConversationForShare;
const FILENAME = 'abu-conversation-fake.abu.json';
const CHOSEN = '/fake/exports/fake.abu.json';
// Long enough for the redactor to take it for a key; it is none.
const FAKE_KEY = 'sk-test-not-a-secret-not-a-secret';

// Everything the window does on the way to a file, in the order it does it.
let log: string[] = [];

// A promise the test settles by hand: the save dialog and the write take time in the app.
function held<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Lets every promise the window waits on settle.
const settle = () => act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); });

function message(id: string, role: Message['role'], content: Message['content'], extra: Partial<Message> = {}): Message {
  return { id, role, content, timestamp: 1, ...extra };
}

function bundleOf(messages: Message[], stats: Partial<ShareBundle['stats']> = {}): ShareBundle {
  return {
    schema: { abuShareVersion: 1, tier: 'standard', exportedAt: 1 },
    conversation: { id: 'c1', title: 'Fake conversation', createdAt: 1, updatedAt: 1 },
    messages,
    attachments: {},
    stats: { redactionCount: 0, attachmentCount: 0, embeddedCount: 0, sizeBytes: 2048, ...stats },
  };
}

const TWO_MESSAGES = [
  message('m1', 'user', 'Fake question about tea'),
  message('m2', 'assistant', 'Fake answer about tea', {
    toolCalls: [{ id: 't1', name: 'fake_lookup', input: {}, result: 'fake lookup result' }],
  }),
];

// The build of the share bundle, answered by the test.
function buildWith(bundle: ShareBundle | null) {
  useChatStore.setState({ exportConversationForShare: (async () => bundle) as never });
}

const ui = {
  exportButton: () => screen.getByRole<HTMLButtonElement>('button', { name: t().share.exportBtn }),
  cancel: () => screen.getByRole('button', { name: t().share.cancel }),
  close: () => screen.getByRole('button', { name: t().common.close }),
  escape: () => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' }),
};

// The owner hears that the window closed once the window has left the page, one timer tick
// after its content has gone. The tests that close the window hold the clock and move it here.
const holdTheClock = () => { vi.useFakeTimers(); };
const leavePage = () => act(() => { vi.runOnlyPendingTimers(); });

async function open(bundle: ShareBundle | null = bundleOf(TWO_MESSAGES)) {
  holdTheClock();
  buildWith(bundle);
  const onClose = vi.fn(() => { log.push('onClose'); });
  const view = render(<ShareExportDialog convId="c1" defaultFilename={FILENAME} onClose={onClose} />);
  await settle();
  return { onClose, ...view };
}

// Stands in for the sidebar: it takes the window off the page when the window says it has closed.
function Owner({ onClosed, children }: { onClosed: () => void; children?: ReactElement }) {
  const [convId, setConvId] = useState<string | null>('c1');
  return (
    <>
      {convId && <ShareExportDialog convId={convId} defaultFilename={FILENAME} onClose={() => { onClosed(); setConvId(null); }} />}
      {children}
    </>
  );
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
  vi.mocked(saveDialog).mockReset().mockImplementation(async (options) => {
    log.push(`saveDialog ${JSON.stringify(options)}`);
    return CHOSEN;
  });
  vi.mocked(writeTextFile).mockReset().mockImplementation(async (path, text) => {
    log.push(`writeTextFile ${String(path)} ${text.length}`);
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useChatStore.setState({ exportConversationForShare: realExport, conversations: {}, conversationIndex: {} });
  vi.restoreAllMocks();
});

describe('ShareExportDialog progress + cancel (#7)', () => {
  it('renders live progress N/total while the bundle builds', async () => {
    useChatStore.setState({
      // Report progress synchronously, then never resolve → stays in loading.
      exportConversationForShare: (async (
        _id: string,
        opts?: { onProgress?: (done: number, total: number) => void },
      ) => {
        opts?.onProgress?.(3, 10);
        return new Promise(() => {});
      }) as never,
    });

    render(<ShareExportDialog convId="c1" defaultFilename="x.json" onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText(/3\/10/)).toBeInTheDocument());
  });

  it('aborts the build when the dialog unmounts (cancel)', async () => {
    let receivedSignal: AbortSignal | undefined;
    useChatStore.setState({
      exportConversationForShare: (async (
        _id: string,
        opts?: { signal?: AbortSignal },
      ) => {
        receivedSignal = opts?.signal;
        return new Promise(() => {});
      }) as never,
    });

    const { unmount } = render(
      <ShareExportDialog convId="c1" defaultFilename="x.json" onClose={() => {}} />,
    );
    await waitFor(() => expect(receivedSignal).toBeDefined());
    expect(receivedSignal!.aborted).toBe(false);
    unmount();
    expect(receivedSignal!.aborted).toBe(true); // cleanup aborted the build
  });
});

describe('ShareExportDialog', () => {
  describe('the build', () => {
    it('asks for the bundle of its conversation and says it is preparing', async () => {
      const build = vi.fn((_id: string, _opts?: unknown) => new Promise<ShareBundle | null>(() => undefined));
      useChatStore.setState({ exportConversationForShare: build as never });

      render(<ShareExportDialog convId="c1" defaultFilename={FILENAME} onClose={() => undefined} />);
      await settle();

      expect(build).toHaveBeenCalledTimes(1);
      expect(build.mock.calls[0][0]).toBe('c1');
      expect(screen.getByText(t().share.loading)).toBeInTheDocument();
      expect(ui.exportButton()).toBeDisabled();
    });

    it('shows that the export failed, with the reason, when the build fails', async () => {
      useChatStore.setState({ exportConversationForShare: (async () => { throw new Error('fake build failure'); }) as never });

      render(<ShareExportDialog convId="c1" defaultFilename={FILENAME} onClose={() => undefined} />);
      await settle();

      expect(screen.getByText(format(t().share.exportError, { error: 'fake build failure' }))).toBeInTheDocument();
      expect(ui.exportButton()).toBeDisabled();
    });

    it('shows that the export failed when the conversation is not there', async () => {
      await open(null);

      expect(screen.getByText(format(t().share.exportError, { error: 'conversation not found' }))).toBeInTheDocument();
      expect(ui.exportButton()).toBeDisabled();
    });
  });

  describe('the preview', () => {
    it('lists what the other side will and will not see', async () => {
      await open();

      for (const words of [
        t().share.exportDialogTitle, t().share.visibleToOthers, t().share.itemMessages, t().share.itemToolCalls,
        t().share.hiddenFromOthers, t().share.itemUserFiles, t().share.itemCredentials, t().share.itemAiGenerated,
        t().share.redactionTitle, t().share.previewTitle,
      ]) {
        expect(screen.getByText(new RegExp(words.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeInTheDocument();
      }
    });

    it('shows the messages, the tools that were called and their results', async () => {
      await open();

      expect(screen.getByText('Fake question about tea')).toBeInTheDocument();
      expect(screen.getByText('Fake answer about tea')).toBeInTheDocument();
      expect(screen.getByText(t().task.calledTool)).toBeInTheDocument();
      expect(screen.getByText('fake_lookup')).toBeInTheDocument();
      expect(screen.getByText('fake lookup result')).toBeInTheDocument();
    });

    it('counts the messages, the attachments and the size', async () => {
      await open(bundleOf(TWO_MESSAGES, { attachmentCount: 3, sizeBytes: 2048 }));

      expect(screen.getByText(format(t().share.statsMessages, { count: 2 }))).toBeInTheDocument();
      expect(screen.getByText(format(t().share.statsAttachments, { count: 3 }))).toBeInTheDocument();
      expect(screen.getByText(format(t().share.statsSize, { size: '2.0 KB' }))).toBeInTheDocument();
    });

    it('says that nothing needed redacting, or how many places were redacted', async () => {
      const { unmount } = await open();
      expect(screen.getByText(t().share.noRedaction)).toBeInTheDocument();
      unmount();

      await open(bundleOf(TWO_MESSAGES, { redactionCount: 2 }));
      expect(screen.getByText(new RegExp(format(t().share.redactionCount, { count: 2 })))).toBeInTheDocument();
      expect(screen.queryByText(t().share.noRedaction)).not.toBeInTheDocument();
    });

    it('says there are no messages when the conversation is empty', async () => {
      await open(bundleOf([]));
      expect(screen.getByText(t().share.previewEmpty)).toBeInTheDocument();
    });

    it('shows the first fifty messages and counts the rest', async () => {
      const many = Array.from({ length: 53 }, (_, index) => message(`m${index}`, 'user', `Fake line ${index}`));
      await open(bundleOf(many));

      expect(screen.getByText('Fake line 49')).toBeInTheDocument();
      expect(screen.queryByText('Fake line 50')).not.toBeInTheDocument();
      expect(screen.getByText(/3 more/)).toBeInTheDocument();
    });

    it('cuts a long message at 1500 characters and a long tool result at 240', async () => {
      const longText = 'a'.repeat(1600);
      const longResult = 'b'.repeat(300);
      await open(bundleOf([
        message('m1', 'user', longText),
        message('m2', 'assistant', '', { toolCalls: [{ id: 't1', name: 'fake_lookup', input: {}, result: longResult }] }),
      ]));

      expect(screen.getByText(`${'a'.repeat(1500)}…`)).toBeInTheDocument();
      expect(screen.getByText(`${'b'.repeat(240)}…`)).toBeInTheDocument();
    });

    it('counts pictures and other attachments of a message instead of showing them', async () => {
      await open(bundleOf([
        message('m1', 'user', [
          { type: 'text', text: 'Fake picture question' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } },
        ] as Message['content']),
      ]));

      expect(screen.getByText('Fake picture question')).toBeInTheDocument();
      expect(screen.getByText(/× 2/)).toBeInTheDocument();
      expect(document.querySelectorAll('img[src^="data:"]')).toHaveLength(0);
    });

    // The real build: what was a key in the conversation is a marker in the preview and in the file.
    it('shows the marker where the conversation held a key, and writes the marker to the file', async () => {
      const conversation: Conversation = {
        id: 'c1',
        title: 'Fake conversation',
        messages: [message('m1', 'user', `Fake request with ${FAKE_KEY} inside`)],
        createdAt: 1,
        updatedAt: 1,
        status: 'idle',
      };
      useChatStore.setState({ conversations: { c1: conversation } });
      let written = '';
      vi.mocked(writeTextFile).mockImplementation(async (_path, text) => { written = text; });
      render(<ShareExportDialog convId="c1" defaultFilename={FILENAME} onClose={() => undefined} />);
      await waitFor(() => expect(screen.getByText(/Fake request with/)).toBeInTheDocument());

      expect(screen.getByText(/Fake request with/)).toHaveTextContent('[REDACTED:openai-key]');
      expect(document.body).not.toHaveTextContent(FAKE_KEY);
      expect(screen.getByText(new RegExp(format(t().share.redactionCount, { count: 1 })))).toBeInTheDocument();

      fireEvent.click(ui.exportButton());
      await settle();

      expect(written).toContain('[REDACTED:openai-key]');
      expect(written).not.toContain(FAKE_KEY);
    });
  });

  describe('exporting', () => {
    it('asks where to save, writes the whole bundle there, then closes, in that order', async () => {
      const bundle = bundleOf(TWO_MESSAGES);
      const { onClose } = await open(bundle);

      fireEvent.click(ui.exportButton());
      await settle();
      leavePage();

      const options = { defaultPath: FILENAME, filters: [{ name: 'Abu Conversation', extensions: ['json'] }] };
      expect(log).toEqual([
        `saveDialog ${JSON.stringify(options)}`,
        `writeTextFile ${CHOSEN} ${serializeShareBundle(bundle).length}`,
        'onClose',
      ]);
      expect(vi.mocked(writeTextFile).mock.calls[0][1]).toBe(serializeShareBundle(bundle));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('asks where to save once, however often Export is pressed meanwhile', async () => {
      await open();
      const choosing = held<string | null>();
      vi.mocked(saveDialog).mockReturnValueOnce(choosing.promise);

      fireEvent.click(ui.exportButton());
      await settle();
      fireEvent.click(ui.exportButton());
      await settle();

      expect(saveDialog).toHaveBeenCalledTimes(1);
      await act(async () => { choosing.resolve(null); });
    });

    // The handler keeps its own count: the look of the button is not what stops a second export.
    it('asks where to save once for two presses that arrive before the window has drawn again', async () => {
      await open();
      const choosing = held<string | null>();
      vi.mocked(saveDialog).mockReturnValue(choosing.promise);
      const button = ui.exportButton();

      act(() => {
        button.click();
        button.click();
      });
      await settle();

      expect(saveDialog).toHaveBeenCalledTimes(1);
      await act(async () => { choosing.resolve(null); });
    });

    it('stays open and writes nothing when no place is chosen, and exports on the next press', async () => {
      const { onClose } = await open();
      vi.mocked(saveDialog).mockResolvedValueOnce(null);

      fireEvent.click(ui.exportButton());
      await settle();
      expect(writeTextFile).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByText('Fake question about tea')).toBeInTheDocument();

      fireEvent.click(ui.exportButton());
      await settle();
      leavePage();
      expect(writeTextFile).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('shows that the export failed when the file cannot be written, stays open, and exports no more', async () => {
      const { onClose } = await open();
      vi.mocked(writeTextFile).mockRejectedValueOnce(new Error('fake write failure'));

      fireEvent.click(ui.exportButton());
      await settle();

      expect(screen.getByText(format(t().share.exportError, { error: 'fake write failure' }))).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
      expect(ui.exportButton()).toBeDisabled();
    });

    it('exports nothing before the bundle is ready', async () => {
      useChatStore.setState({ exportConversationForShare: (() => new Promise(() => undefined)) as never });
      render(<ShareExportDialog convId="c1" defaultFilename={FILENAME} onClose={() => undefined} />);
      await settle();

      fireEvent.click(ui.exportButton());
      await settle();

      expect(saveDialog).not.toHaveBeenCalled();
    });
  });

  describe('closing', () => {
    it.each(['cancel', 'close', 'escape'] as const)('closes on %s, writing nothing', async (way) => {
      const { onClose } = await open();

      if (way === 'escape') ui.escape();
      else fireEvent.click(ui[way]());
      leavePage();

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(saveDialog).not.toHaveBeenCalled();
      expect(writeTextFile).not.toHaveBeenCalled();
    });

    // Closing cancels nothing: once a place is chosen the whole bundle is written there.
    it('does not stop an export that is under way: the file is written whole after the window has gone', async () => {
      const bundle = bundleOf(TWO_MESSAGES);
      holdTheClock();
      buildWith(bundle);
      const onClosed = vi.fn(() => { log.push('onClose'); });
      render(<Owner onClosed={onClosed} />);
      await settle();
      const choosing = held<string | null>();
      vi.mocked(saveDialog).mockReturnValueOnce(choosing.promise);

      fireEvent.click(ui.exportButton());
      await settle();
      fireEvent.click(ui.cancel());
      await settle();
      leavePage();
      expect(onClosed).toHaveBeenCalledTimes(1);
      expect(screen.queryByText(t().share.exportDialogTitle)).not.toBeInTheDocument();

      await act(async () => { choosing.resolve(CHOSEN); });
      await settle();

      expect(writeTextFile).toHaveBeenCalledTimes(1);
      expect(vi.mocked(writeTextFile).mock.calls[0]).toEqual([CHOSEN, serializeShareBundle(bundle)]);
      expect(onClosed).toHaveBeenCalledTimes(1);
    });
  });

  describe('as a design-system window', () => {
    it('is a dialog named by its title, and its corner button is named Close', async () => {
      await open();

      expect(screen.getByRole('dialog', { name: t().share.exportDialogTitle })).toBeInTheDocument();
      expect(ui.close()).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'close' })).not.toBeInTheDocument();
    });

    it('shows the progress as words beside one spinner, with no bar', async () => {
      holdTheClock();
      useChatStore.setState({
        exportConversationForShare: (async (_id: string, opts?: { onProgress?: (done: number, total: number) => void }) => {
          opts?.onProgress?.(3, 10);
          return new Promise(() => undefined);
        }) as never,
      });
      render(<ShareExportDialog convId="c1" defaultFilename={FILENAME} onClose={() => undefined} />);
      await settle();

      expect(document.querySelectorAll('[data-ds-spinner]')).toHaveLength(1);
      expect(screen.getByRole('status')).toHaveTextContent(`${t().share.loading} 3/10`);
      expect(document.querySelector('[role="progressbar"]')).toBeNull();
      expect(screen.getByRole('dialog').querySelector('[style*="width"]')).toBeNull();
    });

    it('shows a failed build as a message with its shape', async () => {
      await open(null);

      expect(screen.getByRole('alert')).toHaveTextContent(format(t().share.exportError, { error: 'conversation not found' }));
    });

    it('has one primary button, Export', async () => {
      await open();

      expect(ui.exportButton()).toHaveClass('bg-emphasis');
      expect(ui.cancel()).not.toHaveClass('bg-emphasis');
    });

    it('marks what is seen and what is not with icons, not with emoji', async () => {
      await open();
      const text = screen.getByRole('dialog').textContent ?? '';

      expect(text).not.toContain('✅');
      expect(text).not.toContain('❌');
      expect(screen.getByText(t().share.itemMessages).closest('li')?.querySelector('svg')).not.toBeNull();
      expect(screen.getByText(t().share.itemCredentials).closest('li')?.querySelector('svg')).not.toBeNull();
    });

    // What the conversation said stays in the text of the page.
    it('puts nothing of the conversation, the file name or the chosen place into a title, a name or a data attribute', async () => {
      await open();
      vi.mocked(writeTextFile).mockReturnValueOnce(held<void>().promise);
      fireEvent.click(ui.exportButton());
      await settle();
      expect(vi.mocked(writeTextFile).mock.calls[0][0]).toBe(CHOSEN);

      const carried =Array.from(screen.getByRole('dialog').querySelectorAll('*')).flatMap((element) => Array.from(element.attributes)
        .filter((attribute) => attribute.name === 'title' || attribute.name.startsWith('aria-') || attribute.name.startsWith('data-'))
        .map((attribute) => attribute.value)).join('\n');
      for (const words of ['Fake question', 'Fake answer', 'fake_lookup', 'fake lookup result', FILENAME, CHOSEN]) {
        expect(carried).not.toContain(words);
      }
    });

    describe('where the focus is', () => {
      it('opens on Cancel, while the bundle builds and once it is ready', async () => {
        await open();
        expect(ui.cancel()).toHaveFocus();
      });
    });

    // Export cannot be pressed after a failed write: the focus that was on it goes to Cancel.
    it('moves the focus from Export to Cancel when the write fails', async () => {
      await open();
      vi.mocked(writeTextFile).mockRejectedValueOnce(new Error('fake write failure'));
      const button = ui.exportButton();
      act(() => button.focus());

      fireEvent.click(button);
      await settle();

      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(ui.cancel()).toHaveFocus();
    });

    describe('while an export is under way', () => {
      it('keeps the Export button in the tab order and takes no press on it', async () => {
        await open();
        const choosing = held<string | null>();
        vi.mocked(saveDialog).mockReturnValueOnce(choosing.promise);

        fireEvent.click(ui.exportButton());
        await settle();

        expect(ui.exportButton()).toHaveAttribute('aria-disabled', 'true');
        expect(ui.exportButton()).not.toBeDisabled();
        await act(async () => { choosing.resolve(null); });
        await settle();
        expect(ui.exportButton()).not.toHaveAttribute('aria-disabled');
      });
    });

    describe('while it fades out', () => {
      it('keeps the preview it showed, exports nothing, and tells its owner once it has gone', async () => {
        keepClosingLayersOnScreen();
        const { onClose } = await open();

        fireEvent.click(ui.cancel());
        expect(closingWindow()).toHaveTextContent('Fake question about tea');
        expect(onClose).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: t().share.exportBtn, hidden: true }));
        await settle();
        expect(saveDialog).not.toHaveBeenCalled();

        finishClosing();
        expect(onClose).toHaveBeenCalledTimes(1);
      });

      it('stops the build, so a bundle that lands meanwhile changes nothing', async () => {
        keepClosingLayersOnScreen();
        holdTheClock();
        const building = held<ShareBundle | null>();
        let signal: AbortSignal | undefined;
        useChatStore.setState({
          exportConversationForShare: ((_id: string, opts?: { signal?: AbortSignal }) => {
            signal = opts?.signal;
            return building.promise;
          }) as never,
        });
        render(<ShareExportDialog convId="c1" defaultFilename={FILENAME} onClose={() => undefined} />);
        await settle();

        ui.escape();
        expect(signal?.aborted).toBe(true);
        await act(async () => { building.resolve(bundleOf(TWO_MESSAGES)); });
        await settle();

        expect(closingWindow()).toHaveTextContent(t().share.loading);
        expect(closingWindow()).not.toHaveTextContent('Fake question about tea');
      });

      it('shows no message when the write fails after it was closed', async () => {
        keepClosingLayersOnScreen();
        await open();
        const writing = held<void>();
        vi.mocked(writeTextFile).mockReturnValueOnce(writing.promise);
        fireEvent.click(ui.exportButton());
        await settle();

        ui.escape();
        writing.reject(new Error('fake write failure'));
        await settle();

        expect(closingWindow()).toHaveTextContent('Fake question about tea');
        expect(screen.queryByRole('alert', { hidden: true })).not.toBeInTheDocument();
      });
    });

    describe('when an approval arrives', () => {
      const onAnswer = vi.fn();
      async function besideApproval() {
        onAnswer.mockReset();
        holdTheClock();
        buildWith(bundleOf(TWO_MESSAGES));
        const onClosed = vi.fn(() => { log.push('onClose'); });
        const view = render(<Owner onClosed={onClosed}>{approvalProbe(false, onAnswer)}</Owner>);
        await settle();
        return {
          onClosed,
          arrive: () => view.rerender(<Owner onClosed={onClosed}>{approvalProbe(true, onAnswer)}</Owner>),
          leave: () => view.rerender(<Owner onClosed={onClosed}>{approvalProbe(false, onAnswer)}</Owner>),
        };
      }
      const approval = () => windowBox(APPROVAL_TITLE);
      const own = () => windowBox(t().share.exportDialogTitle);

      it('is closed for the approval when no export is under way, and writes nothing', async () => {
        const { onClosed, arrive } = await besideApproval();

        arrive();
        leavePage();

        expect(onClosed).toHaveBeenCalledTimes(1);
        expect(own()).toBeNull();
        expect(approval()).not.toBeNull();
        expect(onAnswer).not.toHaveBeenCalled();
        expect(saveDialog).not.toHaveBeenCalled();
      });

      it('steps aside while it exports, unclosed; the chosen place gets the whole file and the window leaves', async () => {
        const bundle = bundleOf(TWO_MESSAGES);
        const { onClosed, arrive } = await besideApproval();
        const choosing = held<string | null>();
        vi.mocked(saveDialog).mockReturnValueOnce(choosing.promise);
        fireEvent.click(ui.exportButton());
        await settle();
        const window = own();

        arrive();
        leavePage();
        expect(approval()).not.toBeNull();
        expect(own()).toBe(window);
        expect(window).toHaveAttribute('hidden');
        expect(onClosed).not.toHaveBeenCalled();

        await act(async () => { choosing.resolve(CHOSEN); });
        await settle();
        leavePage();

        expect(vi.mocked(writeTextFile).mock.calls).toEqual([[CHOSEN, serializeShareBundle(bundle)]]);
        expect(onClosed).toHaveBeenCalledTimes(1);
        expect(own()).toBeNull();
        expect(approval()).not.toBeNull();
        expect(onAnswer).not.toHaveBeenCalled();
      });

      it('returns after the approval with its preview when no place was chosen meanwhile, and exports then', async () => {
        const { onClosed, arrive, leave } = await besideApproval();
        const choosing = held<string | null>();
        vi.mocked(saveDialog).mockReturnValueOnce(choosing.promise);
        fireEvent.click(ui.exportButton());
        await settle();
        const window = own();

        arrive();
        await act(async () => { choosing.resolve(null); });
        await settle();
        leave();
        leavePage();

        expect(own()).toBe(window);
        expect(window).not.toHaveAttribute('hidden');
        expect(screen.getByText('Fake question about tea')).toBeInTheDocument();
        expect(onClosed).not.toHaveBeenCalled();
        expect(writeTextFile).not.toHaveBeenCalled();
        expect(onAnswer).not.toHaveBeenCalled();

        fireEvent.click(ui.exportButton());
        await settle();
        expect(writeTextFile).toHaveBeenCalledTimes(1);
      });

      // A window opened while an approval shows is turned away before it is painted; its owner
      // hears of it and takes it off the page, so the next export starts a new window.
      it('tells its owner when it is turned away because an approval is showing', async () => {
        holdTheClock();
        buildWith(bundleOf(TWO_MESSAGES));
        const onClosed = vi.fn();
        function Late() {
          const [convId, setConvId] = useState<string | null>(null);
          return (
            <>
              <Button onClick={() => setConvId('c1')}>Open the export</Button>
              {convId && <ShareExportDialog convId={convId} defaultFilename={FILENAME} onClose={() => { onClosed(); setConvId(null); }} />}
              {approvalProbe(true, onAnswer)}
            </>
          );
        }
        onAnswer.mockReset();
        render(<Late />);
        await settle();

        fireEvent.click(screen.getByRole('button', { name: 'Open the export', hidden: true }));
        await settle();
        leavePage();

        expect(own()).toBeNull();
        expect(onClosed).toHaveBeenCalledTimes(1);
        expect(approval()).not.toBeNull();
        expect(onAnswer).not.toHaveBeenCalled();
      });
    });
  });
});
