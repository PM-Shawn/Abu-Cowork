// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { getLanguageSetting, setLanguage } from '@/i18n';
import type { Toast } from '@/stores/toastStore';
import { Button } from './button';
import { Dialog } from './dialog';
import { EmptyState } from './empty-state';
import { AppIcons } from './icons';
import { InlineMessage } from './inline-message';
import { LoadError } from './load-error';
import { DesignSystemProvider } from './provider';
import { MAX_VISIBLE_TOASTS, Toaster } from './toaster';

const toast = (n: number, extra: Partial<Toast> = {}): Toast => ({ id: `t${n}`, type: 'success', title: `Saved ${n}`, ...extra });

const shown = () => within(screen.getByRole('region', { name: 'Notifications' }));
// Titles of the rendered notifications, in DOM order.
const shownTitles = () => [...document.querySelectorAll('li[data-ds-motion]')].map((item) => item.textContent ?? '');

function DialogAndToasts({ toasts, onDialogChange }: { toasts: Toast[]; onDialogChange: (open: boolean) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => { onDialogChange(next); setOpen(next); }}
        title="Rename task"
      >
        <input aria-label="New name" />
      </Dialog>
      <Toaster toasts={toasts} onDismiss={() => undefined} />
    </>
  );
}

function ToasterHarness({ initial, onDismissed }: { initial: Toast[]; onDismissed?: (id: string) => void }) {
  const [toasts, setToasts] = useState(initial);
  return (
    <Toaster
      toasts={toasts}
      onDismiss={(id) => {
        onDismissed?.(id);
        setToasts((list) => list.filter((item) => item.id !== id));
      }}
    />
  );
}

describe('feedback components', () => {
  it('EmptyState says what is missing and offers the next step', () => {
    render(<EmptyState icon={AppIcons.folder} title="No files yet" description="Files the task creates show up here." action={<Button>Add a file</Button>} />);
    expect(screen.getByText('No files yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add a file' })).toBeInTheDocument();
  });

  it('InlineMessage announces errors as alerts and pairs every tone with an icon', () => {
    render(<><InlineMessage tone="danger">Key is invalid</InlineMessage><InlineMessage tone="info">Saved locally</InlineMessage></>);
    expect(screen.getByRole('alert')).toHaveTextContent('Key is invalid');
    expect(screen.getByRole('status')).toHaveTextContent('Saved locally');
    expect(screen.getByRole('alert').querySelector('svg')).toHaveClass('text-danger');
  });

  it('LoadError shows the reason and retries', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<LoadError reason="This task could not be read." onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('This task could not be read.');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('Toaster shows at most three notifications, newest last', () => {
    render(<ToasterHarness initial={[1, 2, 3, 4, 5].map((n) => toast(n))} />, { wrapper: DesignSystemProvider });
    expect(MAX_VISIBLE_TOASTS).toBe(3);
    expect(shown().queryByText('Saved 1')).toBeNull();
    expect(shown().queryByText('Saved 2')).toBeNull();
    expect(shown().getByText('Saved 3')).toBeInTheDocument();
    expect(shown().getByText('Saved 5')).toBeInTheDocument();
  });

  it('Toaster names its region with the localized label', () => {
    const previous = getLanguageSetting();
    setLanguage('zh-CN');
    try {
      render(<ToasterHarness initial={[toast(1)]} />, { wrapper: DesignSystemProvider });
      const region = screen.getByRole('region', { name: '通知' });
      expect(region).toHaveAttribute('data-electron-no-drag');
    } finally {
      setLanguage(previous);
    }
  });

  it('Toaster announces only additions and keeps list semantics', () => {
    render(<ToasterHarness initial={[toast(1), toast(2)]} />, { wrapper: DesignSystemProvider });
    const region = screen.getByRole('region', { name: 'Notifications' });
    const live = region.querySelector('[aria-live]');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toHaveAttribute('aria-atomic', 'false');
    const list = within(region).getByRole('list');
    expect(list).not.toHaveAttribute('role');
    expect(list).not.toHaveAttribute('aria-live');
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  });

  it('Toaster moves focus to the next notification after a keyboard Close or Undo', async () => {
    const user = userEvent.setup();
    render(
      <ToasterHarness
        initial={[
          toast(1, { type: 'info', title: 'Task deleted', actions: [{ label: 'Undo', onClick: () => undefined }] }),
          toast(2),
          toast(3),
        ]}
      />,
      { wrapper: DesignSystemProvider },
    );
    screen.getByRole('button', { name: 'Undo' }).focus();
    await user.keyboard('{Enter}');
    expect(shownTitles()).toEqual(['Saved 2', 'Saved 3']);
    const firstClose = within(document.querySelectorAll('li[data-ds-motion]')[0] as HTMLElement).getByRole('button', { name: 'Close' });
    expect(firstClose).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(shownTitles()).toEqual(['Saved 3']);
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(shownTitles()).toEqual([]);
  });

  it('Toaster keeps store order when a hidden older notification comes back', async () => {
    const user = userEvent.setup();
    render(<ToasterHarness initial={[1, 2, 3, 4].map((n) => toast(n))} />, { wrapper: DesignSystemProvider });
    expect(shownTitles()).toEqual(['Saved 2', 'Saved 3', 'Saved 4']);
    const newest = document.querySelectorAll('li[data-ds-motion]')[2];
    await user.click(within(newest as HTMLElement).getByRole('button', { name: 'Close' }));
    expect(shownTitles()).toEqual(['Saved 1', 'Saved 2', 'Saved 3']);
  });

  it('Escape closes an open dialog even after a notification arrives', async () => {
    const user = userEvent.setup();
    const onDialogChange = vi.fn();
    const { rerender } = render(<DialogAndToasts toasts={[]} onDialogChange={onDialogChange} />, { wrapper: DesignSystemProvider });
    rerender(<DialogAndToasts toasts={[toast(1, { title: 'Copied' })]} onDialogChange={onDialogChange} />);
    await user.keyboard('{Escape}');
    expect(onDialogChange).toHaveBeenCalledWith(false);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(shownTitles()).toEqual(['Copied']);
  });

  it('Toaster runs an action such as Undo and then dismisses the notification exactly once', async () => {
    const user = userEvent.setup();
    const onUndo = vi.fn();
    const onDismissed = vi.fn();
    render(
      <ToasterHarness initial={[toast(1, { type: 'info', title: 'Task deleted', actions: [{ label: 'Undo', onClick: onUndo }] })]} onDismissed={onDismissed} />,
      { wrapper: DesignSystemProvider },
    );
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onUndo).toHaveBeenCalledOnce();
    expect(onDismissed).toHaveBeenCalledOnce();
    expect(onDismissed).toHaveBeenCalledWith('t1');
    expect(onUndo.mock.invocationCallOrder[0]).toBeLessThan(onDismissed.mock.invocationCallOrder[0]);
    expect(shownTitles()).toEqual([]);
  });

  // Radix turns pointer input off on <body> while a modal dialog is open. The notification list
  // is portaled into <body> and turns it back on for itself, so Close and Undo can be pressed.
  it('Toaster takes pointer input while a modal dialog has turned it off on the page', async () => {
    const user = userEvent.setup();
    const onDismissed = vi.fn();
    const onUndo = vi.fn();
    // What the Tailwind class does in the app; the test page has no stylesheet.
    const sheet = document.createElement('style');
    sheet.textContent = '.pointer-events-auto { pointer-events: auto; }';
    document.head.appendChild(sheet);
    const before = document.body.style.pointerEvents;
    try {
      render(
        <ToasterHarness
          initial={[toast(1, { type: 'info', title: 'Task deleted', actions: [{ label: 'Undo', onClick: onUndo }] }), toast(2)]}
          onDismissed={onDismissed}
        />,
        { wrapper: DesignSystemProvider },
      );
      const region = screen.getByRole('region', { name: 'Notifications' });
      expect((region.getAttribute('class') ?? '').split(/\s+/)).toContain('pointer-events-auto');
      document.body.style.pointerEvents = 'none';
      expect(getComputedStyle(document.body).pointerEvents).toBe('none');

      await user.click(screen.getByRole('button', { name: 'Undo' }));
      expect(onUndo).toHaveBeenCalledOnce();
      expect(onDismissed.mock.calls).toEqual([['t1']]);
      await user.click(screen.getByRole('button', { name: 'Close' }));
      expect(onDismissed.mock.calls).toEqual([['t1'], ['t2']]);
    } finally {
      document.body.style.pointerEvents = before;
      sheet.remove();
    }
  });

  // A press on a notification is not a press outside the dialog: the dialog stays, with what is in it.
  it('a press on a notification leaves the open dialog open, and a press on the scrim still closes it', async () => {
    const user = userEvent.setup();
    const onDialogChange = vi.fn();
    const onDismissed = vi.fn();
    const onUndo = vi.fn();
    const sheet = document.createElement('style');
    sheet.textContent = '.pointer-events-auto { pointer-events: auto; }';
    document.head.appendChild(sheet);
    function Page() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <Dialog open={open} onOpenChange={(next) => { onDialogChange(next); setOpen(next); }} title="Rename task">
            <input aria-label="New name" />
          </Dialog>
          <ToasterHarness
            initial={[toast(1, { type: 'info', title: 'Task deleted', actions: [{ label: 'Undo', onClick: onUndo }] }), toast(2)]}
            onDismissed={onDismissed}
          />
        </>
      );
    }
    try {
      render(<Page />, { wrapper: DesignSystemProvider });
      const dialog = screen.getByRole('dialog', { name: 'Rename task' });
      // Radix has turned pointer input off on the page behind the dialog.
      expect(document.body.style.pointerEvents).toBe('none');

      await user.click(screen.getByRole('button', { name: 'Undo', hidden: true }));
      expect(onUndo).toHaveBeenCalledOnce();
      expect(onDismissed.mock.calls).toEqual([['t1']]);
      await user.click(screen.getByRole('button', { name: 'Close', hidden: true }));
      expect(onDismissed.mock.calls).toEqual([['t1'], ['t2']]);
      expect(onDialogChange).not.toHaveBeenCalled();
      expect(dialog).toBeInTheDocument();

      const scrim = document.querySelector('.bg-scrim') as HTMLElement;
      await user.click(scrim);
      expect(onDialogChange.mock.calls).toEqual([[false]]);
    } finally {
      sheet.remove();
    }
  });

  // A notification's button takes the focus when it is pressed. Once the notification has left,
  // the focus is back on what had it before, not on the window.
  it('Toaster hands the focus back to what had it after a pointer press on an action or on Close', async () => {
    const user = userEvent.setup();
    render(
      <>
        <input aria-label="Draft" />
        <ToasterHarness initial={[toast(1, { type: 'info', title: 'Task deleted', actions: [{ label: 'Undo', onClick: () => undefined }] }), toast(2)]} />
      </>,
      { wrapper: DesignSystemProvider },
    );
    const draft = screen.getByRole('textbox', { name: 'Draft' });
    draft.focus();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(shownTitles()).toEqual(['Saved 2']);
    expect(draft).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(shownTitles()).toEqual([]);
    expect(draft).toHaveFocus();
  });

  it('Toaster hands the focus back once the last notification is closed from the keyboard', async () => {
    const user = userEvent.setup();
    render(
      <>
        <input aria-label="Draft" />
        <ToasterHarness initial={[toast(1), toast(2)]} />
      </>,
      { wrapper: DesignSystemProvider },
    );
    const draft = screen.getByRole('textbox', { name: 'Draft' });
    draft.focus();
    await user.tab();
    expect(document.activeElement?.closest('li')?.textContent).toContain('Saved 1');
    await user.keyboard('{Enter}');
    // The next notification first: a keyboard user may want to close that one too.
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(shownTitles()).toEqual([]);
    expect(draft).toHaveFocus();
  });

  it('Toaster moves the focus on when the notification that holds it expires', async () => {
    const user = userEvent.setup();
    const page = (toasts: Toast[]) => (
      <>
        <input aria-label="Draft" />
        <Toaster toasts={toasts} onDismiss={() => undefined} />
      </>
    );
    const { rerender } = render(page([toast(1), toast(2)]), { wrapper: DesignSystemProvider });
    const draft = screen.getByRole('textbox', { name: 'Draft' });
    draft.focus();
    await user.tab();
    expect(document.activeElement?.closest('li')?.textContent).toContain('Saved 1');
    rerender(page([toast(2)]));
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    rerender(page([]));
    expect(draft).toHaveFocus();
  });

  it('Toaster never takes the focus when a notification arrives or leaves by itself', async () => {
    const user = userEvent.setup();
    const page = (toasts: Toast[]) => (
      <>
        <input aria-label="Draft" />
        <input aria-label="Other" />
        <Toaster toasts={toasts} onDismiss={() => undefined} />
      </>
    );
    const { rerender } = render(page([]), { wrapper: DesignSystemProvider });
    const draft = screen.getByRole('textbox', { name: 'Draft' });
    const other = screen.getByRole('textbox', { name: 'Other' });
    draft.focus();
    rerender(page([toast(1, { actions: [{ label: 'Undo', onClick: () => undefined }] })]));
    expect(draft).toHaveFocus();
    rerender(page([]));
    expect(draft).toHaveFocus();

    // The focus was in a notification and the user has moved it elsewhere since: it stays there.
    rerender(page([toast(2)]));
    await user.tab();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    other.focus();
    rerender(page([]));
    expect(other).toHaveFocus();
  });

  it('Toaster leaves the focus alone when what had it is no longer on the page', async () => {
    const user = userEvent.setup();
    const page = (toasts: Toast[], withDraft: boolean) => (
      <>
        {withDraft && <input aria-label="Draft" />}
        <Toaster toasts={toasts} onDismiss={() => undefined} />
      </>
    );
    const { rerender } = render(page([toast(1)], true), { wrapper: DesignSystemProvider });
    screen.getByRole('textbox', { name: 'Draft' }).focus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    rerender(page([toast(1)], false));
    rerender(page([], false));
    expect(document.body).toHaveFocus();
  });

  // A file name or a key with no space in it would otherwise run past the card and off the window.
  it('Toaster breaks a long word in the title and in the message', () => {
    const name = 'averylongfoldername_'.repeat(8);
    render(<ToasterHarness initial={[toast(1, { type: 'error', title: `Could not save ${name}`, message: `/fake/project/${name}` })]} />, { wrapper: DesignSystemProvider });
    expect(shown().getByText(`Could not save ${name}`)).toHaveClass('break-words');
    expect(shown().getByText(`/fake/project/${name}`)).toHaveClass('break-words');
  });

  it('Toaster closes a notification from its close button', async () => {
    const user = userEvent.setup();
    const onDismissed = vi.fn();
    render(<ToasterHarness initial={[toast(1, { type: 'error', title: 'Upload failed' })]} onDismissed={onDismissed} />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onDismissed).toHaveBeenCalledWith('t1');
  });
});
