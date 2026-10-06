// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { useState } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLanguageSetting, setLanguage } from '@/i18n';
import { MAX_VISIBLE_TOASTS, type Toast } from '@/stores/toastStore';
import { Button } from './button';
import { Dialog } from './dialog';
import { EmptyState } from './empty-state';
import { AppIcons } from './icons';
import { InlineMessage } from './inline-message';
import { LoadError } from './load-error';
import { DesignSystemProvider } from './provider';
import { TOAST_SETTLE_MS } from './styles';
import { Toaster } from './toaster';

const toast = (n: number, extra: Partial<Toast> = {}): Toast => ({ id: `t${n}`, type: 'success', title: `Saved ${n}`, ...extra });

const shown = () => within(screen.getByRole('region', { name: 'Notifications' }));
// Titles of the rendered notifications, in page order: the newest first, as they are drawn from the top.
const shownTitles = () => [...document.querySelectorAll('li[data-ds-motion]')].map((item) => item.textContent ?? '');
const setupUser = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
// A notification takes no pointer press for a moment after it appeared or moved: let that pass.
const settle = () => act(() => { vi.advanceTimersByTime(TOAST_SETTLE_MS); });
// What the Tailwind classes do in the app; the test page has no stylesheet.
function pointerRules(): HTMLStyleElement {
  const sheet = document.createElement('style');
  sheet.textContent = '.pointer-events-auto { pointer-events: auto; } .pointer-events-none { pointer-events: none; }';
  document.head.appendChild(sheet);
  return sheet;
}

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
  // The clock moves with real time, so user-event works; `settle` moves it past the press guard.
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

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
    const user = setupUser();
    const onRetry = vi.fn();
    render(<LoadError reason="This task could not be read." onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('This task could not be read.');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  // The newest ones are on screen; the store keeps the time of the ones pushed out.
  it('Toaster shows at most three notifications, the newest three, newest first', () => {
    render(<ToasterHarness initial={[1, 2, 3, 4, 5].map((n) => toast(n))} />, { wrapper: DesignSystemProvider });
    expect(MAX_VISIBLE_TOASTS).toBe(3);
    expect(shownTitles()).toEqual(['Saved 5', 'Saved 4', 'Saved 3']);
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
    const user = setupUser();
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
    expect(shownTitles()).toEqual(['Saved 3', 'Saved 2']);
    // The close button now at the place of the one that left: the last one.
    const lastClose = within(document.querySelectorAll('li[data-ds-motion]')[1] as HTMLElement).getByRole('button', { name: 'Close' });
    expect(lastClose).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(shownTitles()).toEqual(['Saved 3']);
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(shownTitles()).toEqual([]);
  });

  it('Toaster brings a pushed-out notification back at the bottom when a shown one is closed', async () => {
    const user = setupUser();
    render(<ToasterHarness initial={[1, 2, 3, 4, 5].map((n) => toast(n))} />, { wrapper: DesignSystemProvider });
    expect(shownTitles()).toEqual(['Saved 5', 'Saved 4', 'Saved 3']);
    settle();
    const second = document.querySelectorAll('li[data-ds-motion]')[1];
    await user.click(within(second as HTMLElement).getByRole('button', { name: 'Close' }));
    expect(shownTitles()).toEqual(['Saved 5', 'Saved 3', 'Saved 2']);
  });

  it('Escape closes an open dialog even after a notification arrives', async () => {
    const user = setupUser();
    const onDialogChange = vi.fn();
    const { rerender } = render(<DialogAndToasts toasts={[]} onDialogChange={onDialogChange} />, { wrapper: DesignSystemProvider });
    rerender(<DialogAndToasts toasts={[toast(1, { title: 'Copied' })]} onDialogChange={onDialogChange} />);
    await user.keyboard('{Escape}');
    expect(onDialogChange).toHaveBeenCalledWith(false);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(shownTitles()).toEqual(['Copied']);
  });

  it('Toaster runs an action such as Undo and then dismisses the notification exactly once', async () => {
    const user = setupUser();
    const onUndo = vi.fn();
    const onDismissed = vi.fn();
    render(
      <ToasterHarness initial={[toast(1, { type: 'info', title: 'Task deleted', actions: [{ label: 'Undo', onClick: onUndo }] })]} onDismissed={onDismissed} />,
      { wrapper: DesignSystemProvider },
    );
    settle();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onUndo).toHaveBeenCalledOnce();
    expect(onDismissed).toHaveBeenCalledOnce();
    expect(onDismissed).toHaveBeenCalledWith('t1');
    expect(onUndo.mock.invocationCallOrder[0]).toBeLessThan(onDismissed.mock.invocationCallOrder[0]);
    expect(shownTitles()).toEqual([]);
  });

  // Radix turns pointer input off on <body> while a modal dialog is open. Each notification turns it
  // back on for itself, so Close and Undo can be pressed. The list's own box (the gaps between
  // notifications) takes no press: what is under a gap gets it.
  it('Toaster notifications take pointer input while a modal dialog has turned it off on the page, the gaps do not', async () => {
    const user = setupUser();
    const onDismissed = vi.fn();
    const onUndo = vi.fn();
    const sheet = pointerRules();
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
      expect(region).toHaveClass('pointer-events-none');
      expect(region).not.toHaveClass('pointer-events-auto');
      for (const item of within(region).getAllByRole('listitem')) expect(item).toHaveClass('pointer-events-auto');
      expect(getComputedStyle(region).pointerEvents).toBe('none');
      document.body.style.pointerEvents = 'none';
      expect(getComputedStyle(document.body).pointerEvents).toBe('none');
      settle();

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
    const user = setupUser();
    const onDialogChange = vi.fn();
    const onDismissed = vi.fn();
    const onUndo = vi.fn();
    const sheet = pointerRules();
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
      settle();

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
    const user = setupUser();
    render(
      <>
        <input aria-label="Draft" />
        <ToasterHarness initial={[toast(1, { type: 'info', title: 'Task deleted', actions: [{ label: 'Undo', onClick: () => undefined }] }), toast(2)]} />
      </>,
      { wrapper: DesignSystemProvider },
    );
    const draft = screen.getByRole('textbox', { name: 'Draft' });
    draft.focus();
    settle();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(shownTitles()).toEqual(['Saved 2']);
    expect(draft).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(shownTitles()).toEqual([]);
    expect(draft).toHaveFocus();
  });

  it('Toaster is walked by Tab from the top, and hands the focus back once the last one is closed from the keyboard', async () => {
    const user = setupUser();
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
    // The newest one is drawn on top and comes first.
    expect(document.activeElement?.closest('li')?.textContent).toContain('Saved 2');
    await user.tab();
    expect(document.activeElement?.closest('li')?.textContent).toContain('Saved 1');
    await user.tab({ shift: true });
    await user.keyboard('{Enter}');
    // The next notification first: a keyboard user may want to close that one too.
    expect(shownTitles()).toEqual(['Saved 1']);
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(shownTitles()).toEqual([]);
    expect(draft).toHaveFocus();
  });

  it('Toaster moves the focus on when the notification that holds it expires', async () => {
    const user = setupUser();
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
    expect(document.activeElement?.closest('li')?.textContent).toContain('Saved 2');
    rerender(page([toast(1)]));
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    rerender(page([]));
    expect(draft).toHaveFocus();
  });

  it('Toaster never takes the focus when a notification arrives or leaves by itself', async () => {
    const user = setupUser();
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
    const user = setupUser();
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

  // Top centre, newest on top: the place measured to cover no approval button and to keep the
  // newest notification's title and close button clear of the native browser view.
  it('Toaster sits at the top centre of the window with the newest notification on top', () => {
    render(<ToasterHarness initial={[toast(1), toast(2)]} />, { wrapper: DesignSystemProvider });
    const region = screen.getByRole('region', { name: 'Notifications' });
    for (const name of ['fixed', 'top-4', 'left-1/2', '-translate-x-1/2', 'z-toast', 'w-80']) expect(region).toHaveClass(name);
    expect(region).not.toHaveClass('bottom-4');
    expect(region).not.toHaveClass('right-4');
    // The page order is the drawn order, top to bottom, so Tab and a screen reader follow what is seen.
    expect(shownTitles()).toEqual(['Saved 2', 'Saved 1']);
    const list = within(region).getByRole('list');
    expect(list).toHaveClass('flex-col');
    expect(list).not.toHaveClass('flex-col-reverse');
  });

  // Each class of the entrance is its own token: one glued to the next is neither.
  it('Toaster notifications carry every entrance class as a separate token', () => {
    render(<ToasterHarness initial={[toast(1)]} />, { wrapper: DesignSystemProvider });
    const item = shown().getByRole('listitem');
    for (const name of [
      'data-[state=open]:animate-in',
      'data-[state=open]:fade-in-0',
      'data-[state=open]:slide-in-from-top-2',
      'data-[state=open]:duration-base',
      'data-[state=open]:ease-enter',
    ]) expect(item).toHaveClass(name);
    expect((item.getAttribute('class') ?? '').split(/\s+/).filter((token) => token.split('data-[state=open]:').length > 2)).toEqual([]);
  });

  // A file name or a key with no space in it would otherwise run past the card and off the window.
  it('Toaster breaks a long word in the title and in the message', () => {
    const name = 'averylongfoldername_'.repeat(8);
    render(<ToasterHarness initial={[toast(1, { type: 'error', title: `Could not save ${name}`, message: `/fake/project/${name}` })]} />, { wrapper: DesignSystemProvider });
    expect(shown().getByText(`Could not save ${name}`)).toHaveClass('break-words');
    expect(shown().getByText(`/fake/project/${name}`)).toHaveClass('break-words');
  });

  // A message can list every file that failed (the skill history's revert): it scrolls inside the
  // notification, so three of them still fit the window and the title and close button stay put.
  it('Toaster limits the height of a message and lets it scroll', () => {
    const message = Array.from({ length: 40 }, (_, n) => `skills/fake/file-${n}.md: permission denied`).join('; ');
    render(<ToasterHarness initial={[toast(1, { type: 'error', title: 'Revert failed', message })]} />, { wrapper: DesignSystemProvider });
    const text = shown().getByText(message);
    expect(text).toHaveClass('max-h-32');
    expect(text).toHaveClass('overflow-y-auto');
    expect(shown().getByText('Revert failed')).not.toHaveClass('max-h-32');
  });

  // A caller can pass a whole sentence as the title (the goal bar does): three lines of it show and
  // the rest scrolls, so one notification has a known greatest height.
  it('Toaster limits the height of a title and lets it scroll', () => {
    const title = 'The goal was not updated because '.repeat(12);
    render(<ToasterHarness initial={[toast(1, { type: 'error', title })]} />, { wrapper: DesignSystemProvider });
    const text = shown().getByText(title.trim());
    expect(text).toHaveClass('max-h-13.5');
    expect(text).toHaveClass('overflow-y-auto');
    expect(text).toHaveClass('break-words');
  });

  it('Toaster closes a notification from its close button', async () => {
    const user = setupUser();
    const onDismissed = vi.fn();
    render(<ToasterHarness initial={[toast(1, { type: 'error', title: 'Upload failed' })]} onDismissed={onDismissed} />, { wrapper: DesignSystemProvider });
    settle();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onDismissed).toHaveBeenCalledWith('t1');
  });
});

// A notification that arrives or leaves moves others. A press aimed at one notification's button
// must not land on another's, so one that appeared or moved takes no pointer press for a moment.
describe('Toaster press guard', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const authorize = (n: number, onClick: () => void): Toast => toast(n, { type: 'warning', title: `Write blocked ${n}`, actions: [{ label: `Authorize ${n}`, onClick }] });
  // A pointer press reports detail 1; a click raised by Enter or Space reports 0.
  const press = (name: string) => fireEvent.click(screen.getByRole('button', { name }), { detail: 1 });
  const closeOf = (title: string) => {
    const item = shown().getAllByRole('listitem').find((candidate) => candidate.textContent?.includes(title));
    if (!item) throw new Error(`no notification ${title}`);
    return within(item).getByRole('button', { name: 'Close' });
  };
  const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

  it('has an interval of the entrance plus a reaction margin', () => {
    expect(TOAST_SETTLE_MS).toBe(500);
  });

  it('ignores a press on a notification that a new arrival has just moved, and takes it after the interval', () => {
    const first = vi.fn();
    const second = vi.fn();
    const onDismiss = vi.fn();
    const page = (toasts: Toast[]) => <Toaster toasts={toasts} onDismiss={onDismiss} />;
    const { rerender } = render(page([authorize(1, first)]), { wrapper: DesignSystemProvider });
    advance(TOAST_SETTLE_MS);
    rerender(page([authorize(1, first), authorize(2, second)]));
    expect(shownTitles().map((text) => text.slice(0, 15))).toEqual(['Write blocked 2', 'Write blocked 1']);

    press('Authorize 1');
    press('Authorize 2');
    fireEvent.click(closeOf('Write blocked 1'), { detail: 1 });
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(shown().getAllByRole('listitem')).toHaveLength(2);

    advance(TOAST_SETTLE_MS - 1);
    press('Authorize 1');
    expect(first).not.toHaveBeenCalled();
    advance(1);
    press('Authorize 1');
    expect(first).toHaveBeenCalledOnce();
    expect(onDismiss.mock.calls).toEqual([['t1']]);
  });

  it('takes a press at once on a notification that did not move when one below it left', () => {
    const first = vi.fn();
    const second = vi.fn();
    const onDismiss = vi.fn();
    const page = (toasts: Toast[]) => <Toaster toasts={toasts} onDismiss={onDismiss} />;
    const { rerender } = render(page([authorize(1, first), authorize(2, second)]), { wrapper: DesignSystemProvider });
    advance(TOAST_SETTLE_MS);
    // The older one, drawn below, ends. The newer one on top stays where it is.
    rerender(page([authorize(2, second)]));
    press('Authorize 2');
    expect(second).toHaveBeenCalledOnce();
    expect(onDismiss.mock.calls).toEqual([['t2']]);
  });

  it('guards the notification that moved up into the place of the one that left', () => {
    const first = vi.fn();
    const second = vi.fn();
    const page = (toasts: Toast[]) => <Toaster toasts={toasts} onDismiss={() => undefined} />;
    const { rerender } = render(page([authorize(1, first), authorize(2, second)]), { wrapper: DesignSystemProvider });
    advance(TOAST_SETTLE_MS);
    // The top one leaves (a press on its button): the second press of a double click finds the next one there.
    rerender(page([authorize(1, first)]));
    press('Authorize 1');
    expect(first).not.toHaveBeenCalled();
    advance(TOAST_SETTLE_MS);
    press('Authorize 1');
    expect(first).toHaveBeenCalledOnce();
  });

  it('guards a notification that has just appeared, and one that returned', () => {
    const first = vi.fn();
    const page = (toasts: Toast[]) => <Toaster toasts={toasts} onDismiss={() => undefined} />;
    const { rerender } = render(page([]), { wrapper: DesignSystemProvider });
    rerender(page([authorize(1, first)]));
    press('Authorize 1');
    expect(first).not.toHaveBeenCalled();
    advance(TOAST_SETTLE_MS);
    press('Authorize 1');
    expect(first).toHaveBeenCalledOnce();
  });

  // The interval does not read the time of day: after the system time is set back, a press is
  // held back for the interval and no longer.
  it('takes a press after the interval when the system time was set back meanwhile', () => {
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
    const first = vi.fn();
    const page = (toasts: Toast[]) => <Toaster toasts={toasts} onDismiss={() => undefined} />;
    const { rerender } = render(page([]), { wrapper: DesignSystemProvider });
    rerender(page([authorize(1, first)]));
    vi.setSystemTime(new Date('2026-01-01T11:00:00Z'));
    advance(TOAST_SETTLE_MS - 1);
    press('Authorize 1');
    expect(first).not.toHaveBeenCalled();
    advance(1);
    press('Authorize 1');
    expect(first).toHaveBeenCalledOnce();
  });

  it('holds a press back for the whole interval when the system time was set forward meanwhile', () => {
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
    const first = vi.fn();
    const page = (toasts: Toast[]) => <Toaster toasts={toasts} onDismiss={() => undefined} />;
    const { rerender } = render(page([]), { wrapper: DesignSystemProvider });
    rerender(page([authorize(1, first)]));
    vi.setSystemTime(new Date('2026-01-01T13:00:00Z'));
    press('Authorize 1');
    expect(first).not.toHaveBeenCalled();
  });

  it('lets the keyboard act inside the interval and shows no disabled state', () => {
    const first = vi.fn();
    const onDismiss = vi.fn();
    const page = (toasts: Toast[]) => <Toaster toasts={toasts} onDismiss={onDismiss} />;
    const { rerender } = render(page([authorize(1, first)]), { wrapper: DesignSystemProvider });
    advance(TOAST_SETTLE_MS);
    rerender(page([authorize(1, first), toast(2)]));
    const button = screen.getByRole('button', { name: 'Authorize 1' });
    expect(button).not.toBeDisabled();
    expect(button).not.toHaveAttribute('aria-disabled');
    // Enter or Space on the focused button raises a click with detail 0.
    button.focus();
    fireEvent.click(button, { detail: 0 });
    expect(first).toHaveBeenCalledOnce();
    expect(onDismiss.mock.calls).toEqual([['t1']]);
  });
});
