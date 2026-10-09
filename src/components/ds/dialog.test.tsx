// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from './button';
import { Combobox } from './combobox';
import { useConfirm, type Confirm } from './confirm-context';
import { ContextMenu } from './context-menu';
import { Dialog, DialogClose } from './dialog';
import { Menu, MenuItem } from './menu';
import { Popover } from './popover';
import { DesignSystemProvider } from './provider';
import { Select } from './select';
import { TOAST_SETTLE_MS } from './styles';
import { keepClosingLayersOnScreen, passSettleInterval } from '@/test/dsWindows';

const platformMock = vi.hoisted(() => ({ mac: false }));
vi.mock('@/utils/platform', () => ({
  isMacOS: () => platformMock.mac,
  isWindows: () => !platformMock.mac,
}));

// happy-dom does not implement the pointer-capture and scrolling calls Radix Select and
// cmdk make while opening a list.
beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
});

function RenameDialog({ dirty = false }: { dirty?: boolean }) {
  return (
    <Dialog
      trigger={<Button>Rename</Button>}
      title="Rename task"
      dirty={dirty}
      footer={<DialogClose asChild><Button>Cancel</Button></DialogClose>}
    >
      <input aria-label="Name" />
    </Dialog>
  );
}

function TwoDialogs({ firstDirty = false, onSecondChange }: { firstDirty?: boolean; onSecondChange?: (open: boolean) => void }) {
  const [first, setFirst] = useState(false);
  const [second, setSecond] = useState(false);
  return (
    <>
      <Button onClick={() => setFirst(true)}>Open first</Button>
      <Dialog open={first} onOpenChange={setFirst} title="First" dirty={firstDirty}>
        <Button onClick={() => setSecond(true)}>Open second</Button>
      </Dialog>
      <Dialog open={second} onOpenChange={(next) => { onSecondChange?.(next); setSecond(next); }} title="Second" />
    </>
  );
}

// A settings-like dialog with a form dialog inside it, and a third dialog that arrives from outside.
function NestedFormAndNewcomer({ onOuterChange, onNewcomerChange }: {
  onOuterChange: (open: boolean) => void;
  onNewcomerChange: (open: boolean) => void;
}) {
  const [outer, setOuter] = useState(true);
  const [form, setForm] = useState(true);
  const [newcomer, setNewcomer] = useState(false);
  return (
    <>
      <Dialog open={outer} onOpenChange={(next) => { onOuterChange(next); setOuter(next); }} title="Outer">
        <Dialog open={form} onOpenChange={setForm} title="Form" dirty>
          <Button onClick={() => setNewcomer(true)}>Open newcomer</Button>
        </Dialog>
      </Dialog>
      <Dialog open={newcomer} onOpenChange={(next) => { onNewcomerChange(next); setNewcomer(next); }} title="Newcomer" />
    </>
  );
}

describe('Dialog', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('asks about unsaved input in a dialog opened inside the open one before a new dialog replaces both', async () => {
    const user = userEvent.setup();
    const onOuterChange = vi.fn();
    const onNewcomerChange = vi.fn();
    render(<NestedFormAndNewcomer onOuterChange={onOuterChange} onNewcomerChange={onNewcomerChange} />, { wrapper: DesignSystemProvider });
    await user.click(await screen.findByRole('button', { name: 'Open newcomer' }));

    expect(screen.getByRole('alertdialog', { name: 'Discard these changes?' })).toBeInTheDocument();
    // Both dialogs are still there; the question hides them from screen readers.
    expect(screen.getAllByRole('dialog', { hidden: true })).toHaveLength(2);
    expect(screen.getByText('Outer')).toBeInTheDocument();
    expect(screen.getByText('Form')).toBeInTheDocument();
    expect(screen.queryByText('Newcomer')).toBeNull();
    expect(onOuterChange).not.toHaveBeenCalled();

    // The question takes no pointer press for a moment after it appears: it has been read.
    passSettleInterval();
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getByRole('dialog', { name: 'Newcomer' })).toBeInTheDocument();
    expect(screen.queryByText('Outer')).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(onOuterChange.mock.calls).toEqual([[false]]);
    expect(onNewcomerChange).not.toHaveBeenCalled();
  });

  it('takes no pointer input once it is closing, and neither does its discard question', async () => {
    const user = userEvent.setup();
    render(<Dialog open dirty title="Host">Body</Dialog>, { wrapper: DesignSystemProvider });
    // The important flag beats the inline pointer-events that Radix puts on a modal layer.
    expect(screen.getByRole('dialog', { name: 'Host' })).toHaveClass('data-[state=closed]:pointer-events-none!');
    await user.keyboard('{Escape}');
    expect(screen.getByRole('alertdialog', { name: 'Discard these changes?' })).toHaveClass('data-[state=closed]:pointer-events-none!');
  });

  it('closes once and raises nothing when Discard is activated again while the question fades out', async () => {
    // happy-dom reports no animation, so Radix removes a closed layer at once. With this, a closed
    // layer has an exit animation: it stays on the page, as it does in the app while it fades out.
    const real = window.getComputedStyle.bind(window);
    const computed = vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element, pseudo?: string | null) => {
      const styles = real(element, pseudo);
      return new Proxy(styles, {
        get(target, prop) {
          if (prop === 'animationName') return element.getAttribute('data-state') === 'closed' ? 'exit' : 'enter';
          const value = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    });
    const errors: unknown[] = [];
    const onError = (event: ErrorEvent) => { errors.push(event.error); event.preventDefault(); };
    window.addEventListener('error', onError);
    try {
      const user = userEvent.setup();
      const onOpenChange = vi.fn();
      render(<Dialog open dirty title="Host" onOpenChange={onOpenChange}>Body</Dialog>, { wrapper: DesignSystemProvider });
      await user.keyboard('{Escape}');
      const discard = screen.getByRole('button', { name: 'Discard' });
      fireEvent.click(discard);
      expect(document.querySelector('[role="alertdialog"][data-state="closed"]')).toContainElement(discard);

      fireEvent.click(discard);

      expect(errors).toEqual([]);
      expect(onOpenChange.mock.calls).toEqual([[false]]);
    } finally {
      window.removeEventListener('error', onError);
      computed.mockRestore();
    }
  });

  it('opens from its trigger, closes on Escape, and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    render(<RenameDialog />, { wrapper: DesignSystemProvider });
    const trigger = screen.getByRole('button', { name: 'Rename' });
    await user.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Rename task' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('asks before discarding unsaved input, and keeps it when the user keeps editing', async () => {
    const user = userEvent.setup();
    render(<RenameDialog dirty />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('alertdialog', { name: 'Discard these changes?' }))
      .toHaveAccessibleDescription('What you typed will not be kept.');
    passSettleInterval();
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Rename task' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    passSettleInterval();
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  // A form that saves in the background closes itself when the save lands. A discard question
  // that was asked meanwhile has nothing left to ask about.
  it('takes the discard question away when the owner closes the dialog, and asks nothing on the next opening', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const tree = (open: boolean) => (
      <Dialog open={open} onOpenChange={onOpenChange} title="Add service" dirty>
        <input aria-label="Name" />
      </Dialog>
    );
    const { rerender } = render(tree(true), { wrapper: DesignSystemProvider });
    await user.keyboard('{Escape}');
    expect(screen.getByRole('alertdialog', { name: 'Discard these changes?' })).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();

    rerender(tree(false));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByRole('dialog', { hidden: true })).toBeNull();
    // Neither answer was given: the owner is not told to close a second time.
    expect(onOpenChange).not.toHaveBeenCalled();

    rerender(tree(true));
    expect(screen.getByRole('dialog', { name: 'Add service' })).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    // The next Escape asks afresh, and Discard closes once.
    await user.keyboard('{Escape}');
    passSettleInterval();
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onOpenChange).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('returns focus to the trigger after the user discards', async () => {
    const user = userEvent.setup();
    render(<RenameDialog dirty />, { wrapper: DesignSystemProvider });
    const trigger = screen.getByRole('button', { name: 'Rename' });
    await user.click(trigger);
    await user.keyboard('{Escape}');
    passSettleInterval();
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('asks a dirty dialog before another dialog replaces it, then opens the other one', async () => {
    const user = userEvent.setup();
    render(<TwoDialogs firstDirty />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'Open first' }));
    await user.click(screen.getByRole('button', { name: 'Open second' }));
    expect(screen.getByRole('alertdialog', { name: 'Discard these changes?' })).toBeInTheDocument();
    // Only the first dialog exists; the discard prompt hides it from screen readers.
    expect(screen.getAllByRole('dialog', { hidden: true })).toHaveLength(1);
    expect(screen.queryByText('Second')).toBeNull();
    passSettleInterval();
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getAllByRole('dialog', { hidden: true })).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: 'Second' })).toBeInTheDocument();
    expect(screen.queryByText('First')).toBeNull();
  });

  // The waiting dialog is held, not closed: closing it is the user's decision.
  it('does not tell the waiting dialog to close before the user decides, nor when they discard', async () => {
    const user = userEvent.setup();
    const onSecondChange = vi.fn();
    render(<TwoDialogs firstDirty onSecondChange={onSecondChange} />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'Open first' }));
    await user.click(screen.getByRole('button', { name: 'Open second' }));
    expect(screen.getByRole('alertdialog', { name: 'Discard these changes?' })).toBeInTheDocument();
    expect(onSecondChange).not.toHaveBeenCalled();
    passSettleInterval();
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getByRole('dialog', { name: 'Second' })).toBeInTheDocument();
    expect(onSecondChange).not.toHaveBeenCalled();
  });

  it.each([
    ['Keep editing', async (user: ReturnType<typeof userEvent.setup>) => {
      passSettleInterval();
      await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    }],
    ['Escape', async (user: ReturnType<typeof userEvent.setup>) => { await user.keyboard('{Escape}'); }],
  ])('closes the waiting dialog when the user answers with %s, and keeps the first one', async (_name, answer) => {
    const user = userEvent.setup();
    const onSecondChange = vi.fn();
    render(<TwoDialogs firstDirty onSecondChange={onSecondChange} />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'Open first' }));
    await user.click(screen.getByRole('button', { name: 'Open second' }));
    await answer(user);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'First' })).toBeInTheDocument();
    expect(screen.queryByText('Second')).toBeNull();
    expect(onSecondChange.mock.calls).toEqual([[false]]);
  });

  it('closes the open dialog before showing another one', async () => {
    const user = userEvent.setup();
    render(<TwoDialogs />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'Open first' }));
    await user.click(screen.getByRole('button', { name: 'Open second' }));
    expect(screen.queryByRole('dialog', { name: 'First' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Second' })).toBeInTheDocument();
  });

  it('gives focus back to the element focused before a dialog without a trigger opened', async () => {
    const user = userEvent.setup();
    function OpenedByCode() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Button onClick={() => setOpen(true)}>Search</Button>
          <Dialog open={open} onOpenChange={setOpen} title="Search" titleHidden>
            <input aria-label="Query" />
          </Dialog>
        </>
      );
    }
    render(<OpenedByCode />, { wrapper: DesignSystemProvider });
    const opener = screen.getByRole('button', { name: 'Search' });
    await user.click(opener);
    expect(screen.getByRole('textbox', { name: 'Query' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('gives focus back to the element that asked a useConfirm() question', async () => {
    const user = userEvent.setup();
    function AskingRow() {
      const confirm = useConfirm();
      return (
        <Button onClick={() => { void confirm({ title: 'Archive this project?', confirmLabel: 'Archive' }); }}>
          Launch plan
        </Button>
      );
    }
    render(<AskingRow />, { wrapper: DesignSystemProvider });
    const row = screen.getByRole('button', { name: 'Launch plan' });
    await user.click(row);
    const question = screen.getByRole('alertdialog', { name: 'Archive this project?' });
    passSettleInterval();
    await user.click(within(question).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(row).toHaveFocus());
  });

  it('keeps focus in the new dialog when the registry closes the old one', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<TwoDialogs />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'Open first' }));
    await user.click(screen.getByRole('button', { name: 'Open second' }));
    const second = screen.getByRole('dialog', { name: 'Second' });
    // Flush the closing dialog's deferred focus return.
    await act(() => vi.runOnlyPendingTimersAsync());
    expect(second).toContainElement(document.activeElement as HTMLElement);
  });

  it('keeps a hidden title as the accessible name without showing it', () => {
    render(
      <Dialog open title="Search" titleHidden>
        <input aria-label="Query" />
      </Dialog>,
      { wrapper: DesignSystemProvider },
    );
    const dialog = screen.getByRole('dialog', { name: 'Search' });
    const title = screen.getByText('Search');
    expect(title).not.toHaveClass('text-title');
    // Radix VisuallyHidden clips the element to one pixel.
    expect(title.style.position).toBe('absolute');
    expect(title.style.width).toBe('1px');
    expect(dialog.querySelector('.mt-4')).toBeNull();
  });

  it('centres itself by default and anchors its top edge with placement top', () => {
    const { unmount } = render(<Dialog open title="Centred" />, { wrapper: DesignSystemProvider });
    expect(screen.getByRole('dialog')).toHaveClass('top-1/2', '-translate-y-1/2');
    unmount();
    render(<Dialog open title="Anchored" placement="top" />, { wrapper: DesignSystemProvider });
    const anchored = screen.getByRole('dialog');
    expect(anchored).toHaveClass('top-1/7', 'translate-y-0', 'left-1/2', '-translate-x-1/2');
    expect(anchored).not.toHaveClass('top-1/2');
    expect(anchored).not.toHaveClass('-translate-y-1/2');
  });

  it('keeps a top-placed dialog inside the window: its height limit starts from where it is anchored', () => {
    render(<Dialog open title="Anchored" placement="top" />, { wrapper: DesignSystemProvider });
    const anchored = screen.getByRole('dialog');
    expect(anchored).toHaveClass('max-h-[calc(100dvh*6/7-3rem)]');
    expect(anchored).not.toHaveClass('max-h-[calc(100dvh-6rem)]');
  });

  it('marks its content as an open layer and dims the window behind it', async () => {
    const user = userEvent.setup();
    render(<RenameDialog />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    expect(screen.getByRole('dialog')).toHaveAttribute('data-ds-layer');
    expect(document.querySelector('.bg-scrim')).not.toBeNull();
  });
});

describe('Dialog sizes and scrolling', () => {
  afterEach(() => { platformMock.mac = false; });

  it('has an extra-large width', () => {
    render(<Dialog open title="Grant access" size="xl"><p>Body text</p></Dialog>, { wrapper: DesignSystemProvider });
    expect(screen.getByRole('dialog')).toHaveClass('max-w-3xl');
  });

  it.each(['sm', 'md', 'lg', 'xl'] as const)('size %s is never taller than the window and scrolls its content', (size) => {
    render(<Dialog open title="Grant access" size={size}><p>Body text</p></Dialog>, { wrapper: DesignSystemProvider });
    expect(screen.getByRole('dialog')).toHaveClass('max-h-[calc(100dvh-6rem)]');
    expect(screen.getByText('Body text').parentElement).toHaveClass('overflow-y-auto');
  });

  it('keeps the buttons under the scrolling content at their own height', () => {
    render(<Dialog open title="Grant access" footer={<Button>Done</Button>}><p>Body text</p></Dialog>, { wrapper: DesignSystemProvider });
    expect(screen.getByRole('button', { name: 'Done' }).parentElement).toHaveClass('shrink-0');
  });

  it('size page fills the settings-window box and leaves scrolling to its content', () => {
    render(<Dialog open title="Settings" titleHidden size="page"><p>Body text</p></Dialog>, { wrapper: DesignSystemProvider });
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(dialog).toHaveClass('m-auto');
    expect(dialog).toHaveClass('max-h-[840px]');
    expect(dialog).toHaveClass('inset-x-0');
    expect(dialog).toHaveClass('bottom-6');
    // A transform would make the dialog the positioning box of fixed elements inside it.
    expect(dialog).not.toHaveClass('-translate-x-1/2');
    expect(dialog).not.toHaveClass('-translate-y-1/2');
    expect(dialog).not.toHaveClass('max-w-md');
    expect(dialog).not.toHaveClass('p-6');
    const body = screen.getByText('Body text').parentElement;
    expect(body).toHaveClass('flex-1');
    expect(body).not.toHaveClass('overflow-y-auto');
  });

  it('size page starts below the macOS window buttons and nearer the top elsewhere', () => {
    platformMock.mac = true;
    const { unmount } = render(<Dialog open title="Settings" titleHidden size="page" />, { wrapper: DesignSystemProvider });
    expect(screen.getByRole('dialog')).toHaveClass('top-12');
    expect(screen.getByRole('dialog')).not.toHaveClass('top-6');
    unmount();
    platformMock.mac = false;
    render(<Dialog open title="Settings" titleHidden size="page" />, { wrapper: DesignSystemProvider });
    expect(screen.getByRole('dialog')).toHaveClass('top-6');
    expect(screen.getByRole('dialog')).not.toHaveClass('top-12');
  });
});

describe('Dialog close button, data attributes and focus', () => {
  afterEach(() => { vi.useRealTimers(); });

  function Closable({ dirty = false, closeButton = true }: { dirty?: boolean; closeButton?: true | { 'data-test-close': string } }) {
    return (
      <Dialog trigger={<Button>Open</Button>} title="Grant access" dirty={dirty} closeButton={closeButton} footer={<Button>Done</Button>}>
        <Button>Allow</Button>
        <Button>Deny</Button>
      </Dialog>
    );
  }

  it('puts the close button last, so the dialog opens with focus on its first control', async () => {
    const user = userEvent.setup();
    render(<Closable />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = screen.getByRole('dialog', { name: 'Grant access' });
    const close = within(dialog).getByRole('button', { name: 'Close' });
    const focusable = dialog.querySelectorAll('button, input, select, textarea, a[href], [tabindex]');
    expect(focusable[focusable.length - 1]).toBe(close);
    expect(within(dialog).getByRole('button', { name: 'Allow' })).toHaveFocus();
    // The title leaves room for the button in the corner.
    expect(within(dialog).getByText('Grant access')).toHaveClass('pr-8');
  });

  // An enlarged image has nothing to press but the close button. Focus on that button would
  // show its tooltip the moment the dialog opens.
  it('opens with focus on the dialog itself when the close button is its only control, and closes on one Escape', async () => {
    const user = userEvent.setup();
    render(
      <Dialog trigger={<Button>Enlarge</Button>} title="Picture" titleHidden closeButton>
        <p>A picture</p>
      </Dialog>,
      { wrapper: DesignSystemProvider },
    );
    const trigger = screen.getByRole('button', { name: 'Enlarge' });
    await user.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Picture' });

    expect(dialog).toHaveFocus();
    expect(within(dialog).getByRole('button', { name: 'Close' })).not.toHaveFocus();
    expect(screen.queryByRole('tooltip')).toBeNull();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('still reaches the close button with Tab when it is the only control', async () => {
    const user = userEvent.setup();
    render(
      <Dialog trigger={<Button>Enlarge</Button>} title="Picture" titleHidden closeButton>
        <p>A picture</p>
      </Dialog>,
      { wrapper: DesignSystemProvider },
    );
    await user.click(screen.getByRole('button', { name: 'Enlarge' }));

    await user.tab();

    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
  });

  // A press on an empty part of a dialog puts focus on its box. From there the browser would
  // look for the neighbour outside the dialog and the focus trap would hand focus back to the box.
  it('goes from the dialog box to its last control on Shift+Tab and to its first on Tab', async () => {
    const user = userEvent.setup();
    render(<Closable />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'Open' }));
    const dialog = screen.getByRole('dialog', { name: 'Grant access' });

    dialog.focus();
    await user.tab({ shift: true });
    expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus();

    dialog.focus();
    await user.tab();
    expect(within(dialog).getByRole('button', { name: 'Allow' })).toHaveFocus();
  });

  it('reaches the close button with Shift+Tab when it is the only control', async () => {
    const user = userEvent.setup();
    render(
      <Dialog trigger={<Button>Enlarge</Button>} title="Picture" titleHidden closeButton>
        <p>A picture</p>
      </Dialog>,
      { wrapper: DesignSystemProvider },
    );
    await user.click(screen.getByRole('button', { name: 'Enlarge' }));
    expect(screen.getByRole('dialog', { name: 'Picture' })).toHaveFocus();

    await user.tab({ shift: true });

    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
  });

  // The browser decides by itself whether focus moved by code shows its ring, and gets it wrong
  // for the first such move after a load. The dialog says it: no ring after a pointer press.
  it('asks for no focus ring on its first control when a pointer press opened it, and leaves the ring to a key press', async () => {
    const user = userEvent.setup();
    render(<Closable />, { wrapper: DesignSystemProvider });
    const trigger = screen.getByRole('button', { name: 'Open' });
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    const optionsFor = (name: string) => focus.mock.calls
      .filter((_, index) => (focus.mock.contexts[index] as HTMLElement).textContent === name)
      .map(([options]) => options);
    try {
      await user.click(trigger);
      expect(screen.getByRole('button', { name: 'Allow' })).toHaveFocus();
      expect(optionsFor('Allow')).toEqual([{ preventScroll: true, focusVisible: false }]);

      focus.mockClear();
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(trigger).toHaveFocus();
      focus.mockClear();
      await user.keyboard('{Enter}');
      expect(screen.getByRole('button', { name: 'Allow' })).toHaveFocus();
      expect(optionsFor('Allow').some((options) => options?.focusVisible === false)).toBe(false);
    } finally {
      focus.mockRestore();
    }
  });

  it('opens with focus on the control its owner names', async () => {
    const user = userEvent.setup();
    render(
      <Dialog
        trigger={<Button>Open</Button>}
        title="Pages"
        initialFocus={(content) => content.querySelector<HTMLElement>('[aria-current="page"]')}
      >
        <Button>First page</Button>
        <Button aria-current="page">Second page</Button>
      </Dialog>,
      { wrapper: DesignSystemProvider },
    );
    await user.click(screen.getByRole('button', { name: 'Open' }));

    expect(screen.getByRole('button', { name: 'Second page' })).toHaveFocus();
  });

  // happy-dom reports -1 as the tab index of an editable box and of a summary; a browser reports 0.
  // This gives those two the browser's answer and leaves every other element as it is.
  function tabIndexAsInABrowser() {
    const real = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'tabIndex');
    if (!real?.get) throw new Error('No tabIndex getter to stand in for');
    const realGet = real.get;
    return vi.spyOn(HTMLElement.prototype, 'tabIndex', 'get').mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute('tabindex')) return realGet.call(this) as number;
      if (this.getAttribute('contenteditable') === 'true' || this.tagName === 'SUMMARY') return 0;
      return realGet.call(this) as number;
    });
  }

  it.each([
    ['an editable box', <div key="control" contentEditable suppressContentEditableWarning data-test-control="">Notes</div>],
    ['a summary', <details key="control"><summary data-test-control="">More</summary>Details</details>],
    ['a frame', <iframe key="control" title="Preview" data-test-control="" />],
  ])('leaves the first focus to %s beside the close button: it is a control the Tab key reaches', async (_name, control) => {
    const user = userEvent.setup();
    const tabIndex = tabIndexAsInABrowser();
    try {
      render(
        <Dialog trigger={<Button>Open</Button>} title="Picture" titleHidden closeButton>
          {control}
        </Dialog>,
        { wrapper: DesignSystemProvider },
      );
      await user.click(screen.getByRole('button', { name: 'Open' }));
      const dialog = screen.getByRole('dialog', { name: 'Picture' });

      expect(dialog).not.toHaveFocus();
      expect(dialog.querySelector('[data-test-control]')).toHaveFocus();
    } finally {
      tabIndex.mockRestore();
    }
  });

  it('counts neither a hidden field, a disabled button nor a hidden one as a control', async () => {
    const user = userEvent.setup();
    render(
      <Dialog trigger={<Button>Open</Button>} title="Picture" titleHidden closeButton>
        <input type="hidden" name="kind" value="picture" />
        <Button disabled>Save</Button>
        <Button hidden>Later</Button>
      </Dialog>,
      { wrapper: DesignSystemProvider },
    );
    await user.click(screen.getByRole('button', { name: 'Open' }));

    expect(screen.getByRole('dialog', { name: 'Picture' })).toHaveFocus();
  });

  it('has no close button and no room for one unless asked', () => {
    render(<Dialog open title="Grant access"><Button>Allow</Button></Dialog>, { wrapper: DesignSystemProvider });
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    expect(screen.getByText('Grant access')).not.toHaveClass('pr-8');
  });

  it('closes from the close button', async () => {
    const user = userEvent.setup();
    render(<Closable />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks before the close button discards unsaved input', async () => {
    const user = userEvent.setup();
    render(<Closable dirty />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'Open' }));
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('alertdialog', { name: 'Discard these changes?' })).toBeInTheDocument();
    // The dialog is still there, hidden from screen readers by the question.
    expect(screen.getAllByRole('dialog', { hidden: true })).toHaveLength(1);
    passSettleInterval();
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByRole('dialog', { hidden: true })).toBeNull();
  });

  it('passes data attributes to the close button and to the dialog box', async () => {
    const user = userEvent.setup();
    render(
      <Dialog trigger={<Button>Open</Button>} title="Grant access" closeButton={{ 'data-test-close': '' }} contentProps={{ 'data-test-dialog': '' }}>
        <Button>Allow</Button>
      </Dialog>,
      { wrapper: DesignSystemProvider },
    );
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByRole('button', { name: 'Close' })).toHaveAttribute('data-test-close', '');
    const dialog = screen.getByRole('dialog', { name: 'Grant access' });
    expect(dialog).toHaveAttribute('data-test-dialog', '');
    // The dialog's own markers win over anything a caller passes.
    expect(dialog).toHaveAttribute('data-ds-layer');
    expect(dialog).toHaveAttribute('data-electron-no-drag');
  });

  it('lets the caller decide where focus goes when the dialog closes', async () => {
    const user = userEvent.setup();
    function Grant() {
      const [open, setOpen] = useState(false);
      const composer = useRef<HTMLInputElement>(null);
      return (
        <>
          <Button onClick={() => setOpen(true)}>Open</Button>
          <input aria-label="Message" ref={composer} />
          <Dialog
            open={open}
            onOpenChange={setOpen}
            title="Grant access"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              composer.current?.focus();
            }}
          >
            <Button>Allow</Button>
          </Dialog>
        </>
      );
    }
    render(<Grant />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByRole('button', { name: 'Allow' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveFocus());
  });

  it('runs the caller after the layer handler, which keeps focus in a dialog that replaced this one', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const seen: boolean[] = [];
    function Replaced() {
      const [first, setFirst] = useState(false);
      const [second, setSecond] = useState(false);
      return (
        <>
          <Button onClick={() => setFirst(true)}>Open first</Button>
          <Dialog open={first} onOpenChange={setFirst} title="First" onCloseAutoFocus={(event) => { seen.push(event.defaultPrevented); }}>
            <Button onClick={() => setSecond(true)}>Open second</Button>
          </Dialog>
          <Dialog open={second} onOpenChange={setSecond} title="Second"><Button>Stay</Button></Dialog>
        </>
      );
    }
    render(<Replaced />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'Open first' }));
    await user.click(screen.getByRole('button', { name: 'Open second' }));
    await act(() => vi.runOnlyPendingTimersAsync());
    expect(seen).toEqual([true]);
    expect(screen.getByRole('dialog', { name: 'Second' })).toContainElement(document.activeElement as HTMLElement);
  });
});

type User = ReturnType<typeof userEvent.setup>;

const FLOATING: { name: string; element: ReactNode; open: (user: User) => Promise<void> }[] = [
  {
    name: 'Select',
    element: <Select label="Model" value="sonnet" onValueChange={() => undefined} options={[{ value: 'sonnet', label: 'Claude Sonnet 5' }]} />,
    open: (user) => user.click(screen.getByRole('combobox', { name: 'Model' })),
  },
  {
    name: 'Menu',
    element: <Menu trigger={<Button>Actions</Button>}><MenuItem>Rename</MenuItem></Menu>,
    open: (user) => user.click(screen.getByRole('button', { name: 'Actions' })),
  },
  {
    name: 'Popover',
    element: <Popover trigger={<Button>Details</Button>}>Popover body</Popover>,
    open: (user) => user.click(screen.getByRole('button', { name: 'Details' })),
  },
  {
    name: 'Combobox',
    element: (
      <Combobox
        label="Model"
        value=""
        onValueChange={() => undefined}
        options={[{ value: 'sonnet', label: 'Claude Sonnet 5' }]}
        placeholder="Choose a model"
        searchPlaceholder="Search models"
        emptyText="No matching model"
      />
    ),
    open: (user) => user.click(screen.getByRole('combobox', { name: 'Model' })),
  },
  {
    name: 'ContextMenu',
    element: <ContextMenu content={<MenuItem>Copy</MenuItem>}><div>Message body</div></ContextMenu>,
    open: async () => { fireEvent.contextMenu(screen.getByText('Message body')); },
  },
];

function lastLayer(): Element {
  const layers = document.querySelectorAll('[data-ds-layer]');
  return layers[layers.length - 1];
}

describe('floating layers and dialogs', () => {
  it.each(FLOATING)('$name opened inside a dialog sits on the dialog level', async ({ element, open }) => {
    const user = userEvent.setup();
    render(<Dialog open title="Host">{element}</Dialog>, { wrapper: DesignSystemProvider });
    const dialog = screen.getByRole('dialog', { name: 'Host' });
    await open(user);
    expect(document.querySelectorAll('[data-ds-layer]')).toHaveLength(2);
    const layer = lastLayer();
    expect(layer).not.toBe(dialog);
    expect(layer).toHaveClass('z-dialog');
    expect(layer).not.toHaveClass('z-popover');
  });

  it.each(FLOATING)('$name opened on the page sits on the popover level', async ({ element, open }) => {
    const user = userEvent.setup();
    render(<>{element}</>, { wrapper: DesignSystemProvider });
    await open(user);
    expect(document.querySelectorAll('[data-ds-layer]')).toHaveLength(1);
    const layer = lastLayer();
    expect(layer).toHaveClass('z-popover');
    expect(layer).not.toHaveClass('z-dialog');
  });
});

describe('telling the app that a dialog is on screen', () => {
  it('reports a dialog and a question through the provider, and nothing for a menu', async () => {
    const user = userEvent.setup();
    const onModalChange = vi.fn();
    function Page() {
      const confirm = useConfirm();
      return (
        <>
          <Menu trigger={<Button>Actions</Button>}><MenuItem>Rename</MenuItem></Menu>
          <Button onClick={() => { void confirm({ title: 'Delete this file?', confirmLabel: 'Delete' }); }}>Delete</Button>
          <Dialog trigger={<Button>Search</Button>} title="Search" />
        </>
      );
    }
    render(<DesignSystemProvider onModalChange={onModalChange}><Page /></DesignSystemProvider>);

    await user.click(screen.getByRole('button', { name: 'Actions' }));
    await user.keyboard('{Escape}');
    expect(onModalChange.mock.calls).toEqual([[false]]);

    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(onModalChange.mock.calls).toEqual([[false], [true]]);
    await user.keyboard('{Escape}');
    expect(onModalChange.mock.calls).toEqual([[false], [true], [false]]);

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByRole('alertdialog', { name: 'Delete this file?' })).toBeInTheDocument();
    expect(onModalChange.mock.calls).toEqual([[false], [true], [false], [true]]);
    passSettleInterval();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onModalChange.mock.calls).toEqual([[false], [true], [false], [true], [false]]);
  });
});

describe('Dialog that only its buttons can close', () => {
  // The page behind a modal dialog ignores the pointer; the browser still delivers the
  // pointerdown Radix listens for, so user-event's own check is skipped.
  const anywhere = () => userEvent.setup({ pointerEventsCheck: 0 });

  function PrivacyCheck({ dismissible, onOpenChange }: { dismissible?: boolean; onOpenChange?: (open: boolean) => void }) {
    const [open, setOpen] = useState(false);
    const [scope, setScope] = useState('all');
    return (
      <>
        <Button onClick={() => setOpen(true)}>Check memories</Button>
        <p>Elsewhere</p>
        <Dialog
          open={open}
          onOpenChange={(next) => { onOpenChange?.(next); setOpen(next); }}
          title="Privacy check"
          role="alertdialog"
          dismissible={dismissible}
          closeButton
          footer={(
            <>
              <DialogClose asChild><Button>Later</Button></DialogClose>
              <Button variant="primary" onClick={() => setOpen(false)}>Mark private</Button>
            </>
          )}
        >
          <Select label="Scope" value={scope} onValueChange={setScope} options={[{ value: 'all', label: 'All' }, { value: 'some', label: 'Some' }]} />
        </Dialog>
      </>
    );
  }

  async function openCheck(user: ReturnType<typeof userEvent.setup>) {
    const opener = screen.getByRole('button', { name: 'Check memories' });
    await user.click(opener);
    // A question takes no pointer press for a moment after it appears: this one has been read.
    passSettleInterval();
    return { opener, check: screen.getByRole('alertdialog', { name: 'Privacy check' }) };
  }

  it('stays open on Escape', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<PrivacyCheck dismissible={false} onOpenChange={onOpenChange} />, { wrapper: DesignSystemProvider });
    const { check } = await openCheck(user);
    await user.keyboard('{Escape}');
    expect(check).toBeInTheDocument();
    expect(check).toHaveAttribute('data-state', 'open');
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('stays open when the user presses outside it, and still dims and blocks the window behind it', async () => {
    const user = anywhere();
    const onOpenChange = vi.fn();
    render(<PrivacyCheck dismissible={false} onOpenChange={onOpenChange} />, { wrapper: DesignSystemProvider });
    const { check } = await openCheck(user);
    const scrim = document.querySelector('.bg-scrim');
    expect(scrim).not.toBeNull();
    await user.click(scrim as Element);
    await user.click(screen.getByText('Elsewhere'));
    expect(check).toHaveAttribute('data-state', 'open');
    expect(onOpenChange).not.toHaveBeenCalled();
    // The page behind it takes no pointer input while it is open.
    expect(document.body.style.pointerEvents).toBe('none');
  });

  it('closes on Escape and on a press outside when nothing says otherwise', async () => {
    const user = anywhere();
    render(<PrivacyCheck />, { wrapper: DesignSystemProvider });
    await openCheck(user);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await openCheck(user);
    await user.click(screen.getByText('Elsewhere'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('has no close button in the corner even when one is asked for', async () => {
    const user = userEvent.setup();
    render(<PrivacyCheck dismissible={false} />, { wrapper: DesignSystemProvider });
    const { check } = await openCheck(user);
    expect(within(check).queryByRole('button', { name: 'Close' })).toBeNull();
    expect(within(check).getByText('Privacy check')).not.toHaveClass('pr-8');
  });

  it('closes from its own buttons and gives focus back to what opened it', async () => {
    const user = userEvent.setup();
    render(<PrivacyCheck dismissible={false} />, { wrapper: DesignSystemProvider });
    const first = await openCheck(user);
    await user.click(within(first.check).getByRole('button', { name: 'Later' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(first.opener).toHaveFocus());

    const second = await openCheck(user);
    await user.click(within(second.check).getByRole('button', { name: 'Mark private' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(second.opener).toHaveFocus());
  });

  it('keeps Tab inside it', async () => {
    const user = userEvent.setup();
    render(<PrivacyCheck dismissible={false} />, { wrapper: DesignSystemProvider });
    const { check } = await openCheck(user);
    const stops = [
      within(check).getByRole('combobox', { name: 'Scope' }),
      within(check).getByRole('button', { name: 'Later' }),
      within(check).getByRole('button', { name: 'Mark private' }),
    ];
    expect(stops[0]).toHaveFocus();
    await user.tab();
    expect(stops[1]).toHaveFocus();
    await user.tab();
    expect(stops[2]).toHaveFocus();
    // From the last control Tab goes back to the first, never to the page behind.
    await user.tab();
    expect(stops[0]).toHaveFocus();
    await user.tab({ shift: true });
    expect(stops[2]).toHaveFocus();
  });

  it('lets a list opened inside it close on its own Escape', async () => {
    const user = userEvent.setup();
    render(<PrivacyCheck dismissible={false} />, { wrapper: DesignSystemProvider });
    const { check } = await openCheck(user);
    await user.click(within(check).getByRole('combobox', { name: 'Scope' }));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(check).toHaveAttribute('data-state', 'open');
    // With the list gone, Escape reaches the dialog and still does nothing.
    await user.keyboard('{Escape}');
    expect(check).toHaveAttribute('data-state', 'open');
  });

  it('stacks over an open dialog and leaves both open on Escape', async () => {
    const user = userEvent.setup();
    function OverSettings() {
      const [check, setCheck] = useState(false);
      return (
        <>
          <Dialog open title="Settings"><Button onClick={() => setCheck(true)}>Open check</Button></Dialog>
          <Dialog open={check} onOpenChange={setCheck} title="Privacy check" role="alertdialog" dismissible={false} footer={<Button onClick={() => setCheck(false)}>Later</Button>} />
        </>
      );
    }
    render(<OverSettings />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'Open check' }));
    const check = screen.getByRole('alertdialog', { name: 'Privacy check' });
    await user.keyboard('{Escape}');
    expect(check).toHaveAttribute('data-state', 'open');
    // The dialog underneath is hidden from screen readers while the question is over it.
    expect(screen.getByRole('dialog', { hidden: true })).toHaveAttribute('data-state', 'open');
    passSettleInterval();
    await user.click(within(check).getByRole('button', { name: 'Later' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Settings' })).toHaveAttribute('data-state', 'open');
  });

  it('is still closed by the layer registry when the dialog it was asked over goes away', async () => {
    const user = userEvent.setup();
    const onCheckChange = vi.fn();
    function OverSettings() {
      const [settings, setSettings] = useState(true);
      const [check, setCheck] = useState(false);
      return (
        <>
          <Dialog open={settings} onOpenChange={setSettings} title="Settings"><Button onClick={() => setCheck(true)}>Open check</Button></Dialog>
          <Dialog
            open={check}
            onOpenChange={(next) => { onCheckChange(next); setCheck(next); }}
            title="Privacy check"
            role="alertdialog"
            dismissible={false}
            footer={<Button onClick={() => setSettings(false)}>Close settings</Button>}
          />
        </>
      );
    }
    render(<OverSettings />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'Open check' }));
    passSettleInterval();
    await user.click(screen.getByRole('button', { name: 'Close settings' }));
    expect(onCheckChange.mock.calls).toEqual([[false]]);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByRole('dialog', { hidden: true })).toBeNull();
  });
});

describe('Dialog header', () => {
  const scrollArea = (dialog: HTMLElement) => dialog.querySelector<HTMLElement>('.overflow-y-auto')!;
  // Tag and classes of each element the dialog box holds directly.
  const outline = (dialog: HTMLElement) => Array.from(dialog.children).map((child) => `${child.tagName.toLowerCase()}.${child.className}`);

  it('keeps the header above the scrolling content, and opens on the first control of the header', () => {
    render(
      <Dialog open title="Canva" titleHidden closeButton header={<Button>Header action</Button>} footer={<Button>Footer action</Button>}>
        <Button>Body action</Button>
      </Dialog>,
      { wrapper: DesignSystemProvider },
    );
    const dialog = screen.getByRole('dialog', { name: 'Canva' });
    const header = screen.getByRole('button', { name: 'Header action' });
    const body = screen.getByRole('button', { name: 'Body action' });
    expect(scrollArea(dialog)).toContainElement(body);
    expect(scrollArea(dialog)).not.toContainElement(header);
    expect(header.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(header).toHaveFocus();
    // The header cannot shrink when the content is taller than the window.
    expect(header.parentElement).toHaveClass('shrink-0');
  });

  it('with a hidden title, the header stops short of the close button in the corner', () => {
    render(
      <Dialog open title="Canva" titleHidden closeButton header={<Button>Header action</Button>}>Body</Dialog>,
      { wrapper: DesignSystemProvider },
    );
    const box = screen.getByRole('button', { name: 'Header action' }).parentElement;
    expect(box).toHaveClass('pr-8');
    expect(box).not.toHaveClass('mt-4');
  });

  it('under a visible title, the header takes the full width and the content keeps its gap', () => {
    render(
      <Dialog open title="Canva" closeButton header={<Button>Header action</Button>}>Body</Dialog>,
      { wrapper: DesignSystemProvider },
    );
    const box = screen.getByRole('button', { name: 'Header action' }).parentElement;
    expect(box).toHaveClass('mt-4');
    expect(box).not.toHaveClass('pr-8');
    expect(screen.getByText('Canva')).toHaveClass('pr-8');
    expect(scrollArea(screen.getByRole('dialog')).parentElement).toHaveClass('mt-4');
  });

  it('puts the gap between the header and the content when the title is hidden', () => {
    render(
      <Dialog open title="Canva" titleHidden header={<Button>Header action</Button>}>Body</Dialog>,
      { wrapper: DesignSystemProvider },
    );
    expect(scrollArea(screen.getByRole('dialog')).parentElement).toHaveClass('mt-4');
  });

  it('renders the same elements as before for a dialog without a header', () => {
    const { unmount } = render(<Dialog open title="Plain" footer={<Button>Done</Button>}>Body</Dialog>, { wrapper: DesignSystemProvider });
    expect(outline(screen.getByRole('dialog'))).toEqual([
      'h2.text-title text-label',
      'div.flex min-h-0 flex-col mt-4',
      'div.mt-6 flex shrink-0 justify-end gap-2',
    ]);
    unmount();
    render(<Dialog open title="Search" titleHidden>Body</Dialog>, { wrapper: DesignSystemProvider });
    const hidden = screen.getByRole('dialog');
    expect(outline(hidden).slice(1)).toEqual(['div.flex min-h-0 flex-col']);
    expect(hidden.children).toHaveLength(2);
  });
});

/**
 * A layer stays on the page while it fades out, and Radix still counts it as the top layer.
 * An Escape pressed then belongs to the top layer that is open.
 */
describe('Escape while the layer above fades out', () => {
  // happy-dom reports no animation, so Radix removes a closed layer at once. With this, a closed
  // layer has an exit animation: it stays on the page, as it does in the app while it fades out.
  let restoreStyles: (() => void) | null = null;
  function keepClosingLayersOnScreen() {
    const real = window.getComputedStyle.bind(window);
    const spy = vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element, pseudo?: string | null) => {
      const styles = real(element, pseudo);
      return new Proxy(styles, {
        get(target, prop) {
          if (prop === 'animationName') return element.getAttribute('data-state') === 'closed' ? 'exit' : 'enter';
          const value = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    });
    restoreStyles = () => spy.mockRestore();
  }
  afterEach(() => {
    restoreStyles?.();
    restoreStyles = null;
  });

  const escape = () => { fireEvent.keyDown(document, { key: 'Escape' }); };

  function Window({ onOpenChange, dirty = false, dismissible = true, children }: {
    onOpenChange: (open: boolean) => void;
    dirty?: boolean;
    dismissible?: boolean;
    children: ReactNode;
  }) {
    const [open, setOpen] = useState(true);
    return (
      <Dialog open={open} onOpenChange={(next) => { onOpenChange(next); setOpen(next); }} title="Window" dirty={dirty} dismissible={dismissible}>
        {children}
      </Dialog>
    );
  }

  const more = <Menu trigger={<Button>More</Button>}><MenuItem>One</MenuItem></Menu>;
  const info = <Popover trigger={<Button>Info</Button>}><p>Details</p></Popover>;

  it('closes the dialog on the second Escape when a menu was open in it', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<Window onOpenChange={onOpenChange}>{more}</Window>, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    keepClosingLayersOnScreen();

    escape();
    expect(document.querySelector('[role="menu"][data-state="closed"]')).not.toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
    escape();

    expect(onOpenChange.mock.calls).toEqual([[false]]);
  });

  it('closes the dialog on the second Escape when a popover was open in it', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<Window onOpenChange={onOpenChange}>{info}</Window>, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'Info' }));
    expect(screen.getByText('Details')).toBeInTheDocument();
    keepClosingLayersOnScreen();

    escape();
    expect(onOpenChange).not.toHaveBeenCalled();
    escape();

    expect(onOpenChange.mock.calls).toEqual([[false]]);
  });

  it('closes the dialog on the second Escape when a combobox list was open in it', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(
      <Window onOpenChange={onOpenChange}>
        <Combobox
          label="Model"
          value=""
          onValueChange={() => undefined}
          options={[{ value: 'sonnet', label: 'Claude Sonnet 5' }]}
          placeholder="Choose a model"
          searchPlaceholder="Search models"
          emptyText="No matching model"
        />
      </Window>,
      { wrapper: DesignSystemProvider },
    );
    await user.click(screen.getByRole('combobox', { name: 'Model' }));
    expect(screen.getByPlaceholderText('Search models')).toBeInTheDocument();
    keepClosingLayersOnScreen();

    escape();
    expect(onOpenChange).not.toHaveBeenCalled();
    escape();

    expect(onOpenChange.mock.calls).toEqual([[false]]);
  });

  it('closes the dialog on the second Escape when a context menu was open in it', () => {
    const onOpenChange = vi.fn();
    render(
      <Window onOpenChange={onOpenChange}>
        <ContextMenu content={<MenuItem>Copy</MenuItem>}><div>Message body</div></ContextMenu>
      </Window>,
      { wrapper: DesignSystemProvider },
    );
    fireEvent.contextMenu(screen.getByText('Message body'));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    keepClosingLayersOnScreen();

    escape();
    expect(onOpenChange).not.toHaveBeenCalled();
    escape();

    expect(onOpenChange.mock.calls).toEqual([[false]]);
  });

  it('closes the outer dialog on the second Escape when a dialog was open inside it', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(
      <Window onOpenChange={onOpenChange}>
        <Dialog trigger={<Button>Open inner</Button>} title="Inner">Inner body</Dialog>
      </Window>,
      { wrapper: DesignSystemProvider },
    );
    await user.click(screen.getByRole('button', { name: 'Open inner' }));
    expect(screen.getByText('Inner body')).toBeInTheDocument();
    keepClosingLayersOnScreen();

    escape();
    expect(onOpenChange).not.toHaveBeenCalled();
    escape();

    expect(onOpenChange.mock.calls).toEqual([[false]]);
  });

  it('asks again about unsaved input when Escape comes while the question fades out', () => {
    const onOpenChange = vi.fn();
    render(<Window onOpenChange={onOpenChange} dirty><input aria-label="Name" /></Window>, { wrapper: DesignSystemProvider });
    keepClosingLayersOnScreen();
    const question = () => document.querySelector('[role="alertdialog"]');

    escape();
    expect(question()).toHaveAttribute('data-state', 'open');
    escape();
    expect(question()).toHaveAttribute('data-state', 'closed');
    escape();

    expect(question()).toHaveAttribute('data-state', 'open');
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('leaves a dialog only its buttons may close open after two Escapes with a menu in it', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<Window onOpenChange={onOpenChange} dismissible={false}>{more}</Window>, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'More' }));
    keepClosingLayersOnScreen();

    escape();
    escape();

    expect(onOpenChange).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"][data-state="open"]')).not.toBeNull();
  });

  it('closes a popover opened while a menu fades out first, then the dialog', async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<Window onOpenChange={onOpenChange}>{more}{info}</Window>, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'More' }));
    keepClosingLayersOnScreen();
    escape();
    fireEvent.click(screen.getByText('Info'));
    expect(screen.getByText('Details').closest('[data-state]')).toHaveAttribute('data-state', 'open');

    escape();
    expect(screen.getByText('Details').closest('[data-state]')).toHaveAttribute('data-state', 'closed');
    expect(onOpenChange).not.toHaveBeenCalled();
    escape();

    expect(onOpenChange.mock.calls).toEqual([[false]]);
  });

  // Radix turns pointer input off on <body> under a modal layer and counts a menu that is fading
  // out as one. Two Escapes within one frame end both fades together, the dialog first: its menu
  // leaves the page still counted, and Radix never turns pointer input back on.
  it('gives the page its pointer input back when the dialog leaves before the menu that was fading in it', async () => {
    const user = userEvent.setup();
    render(<Window onOpenChange={() => {}}>{more}</Window>, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'More' }));
    expect(document.body.style.pointerEvents).toBe('none');
    keepClosingLayersOnScreen();
    escape();
    escape();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][data-state="closed"]');
    expect(dialog).not.toBeNull();
    expect(document.querySelector('[role="menu"][data-state="closed"]')).not.toBeNull();

    // The dialog's fade ends first; what the layers do once they have gone runs one timer tick later.
    vi.useFakeTimers();
    try {
      const ended = new Event('animationend', { bubbles: true });
      Object.defineProperty(ended, 'animationName', { value: 'exit' });
      act(() => { dialog!.dispatchEvent(ended); });
      act(() => { vi.runOnlyPendingTimers(); });
    } finally {
      vi.useRealTimers();
    }

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.body.style.pointerEvents).toBe('');
  });

  it('gives the page its pointer input back when the dialog leaves before the context menu that was fading in it', () => {
    render(
      <Window onOpenChange={() => {}}>
        <ContextMenu content={<MenuItem>Copy</MenuItem>}><div>Message body</div></ContextMenu>
      </Window>,
      { wrapper: DesignSystemProvider },
    );
    fireEvent.contextMenu(screen.getByText('Message body'));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(document.body.style.pointerEvents).toBe('none');
    keepClosingLayersOnScreen();
    escape();
    escape();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][data-state="closed"]');
    expect(dialog).not.toBeNull();
    expect(document.querySelector('[role="menu"][data-state="closed"]')).not.toBeNull();

    vi.useFakeTimers();
    try {
      const ended = new Event('animationend', { bubbles: true });
      Object.defineProperty(ended, 'animationName', { value: 'exit' });
      act(() => { dialog!.dispatchEvent(ended); });
      act(() => { vi.runOnlyPendingTimers(); });
    } finally {
      vi.useRealTimers();
    }

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.body.style.pointerEvents).toBe('');
  });

  it('gives the page its pointer input back when the owner takes the dialog away while its menu fades', async () => {
    const user = userEvent.setup();
    // The page that owns the dialog leaves: the dialog and its menu go in one step, with no fade.
    function Page({ shown }: { shown: boolean }) {
      return shown ? <Window onOpenChange={() => {}}>{more}</Window> : null;
    }
    const view = render(<Page shown />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'More' }));
    expect(document.body.style.pointerEvents).toBe('none');
    keepClosingLayersOnScreen();
    escape();
    expect(document.querySelector('[role="menu"][data-state="closed"]')).not.toBeNull();
    expect(document.querySelector('[role="dialog"][data-state="open"]')).not.toBeNull();

    vi.useFakeTimers();
    try {
      view.rerender(<Page shown={false} />);
      act(() => { vi.runOnlyPendingTimers(); });
    } finally {
      vi.useRealTimers();
    }

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.body.style.pointerEvents).toBe('');
  });

  it('leaves pointer input off while a layer is still on the page', async () => {
    const user = userEvent.setup();
    render(<Window onOpenChange={() => {}}>{more}</Window>, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'More' }));
    keepClosingLayersOnScreen();
    escape();
    const menu = document.querySelector<HTMLElement>('[role="menu"][data-state="closed"]');
    expect(menu).not.toBeNull();

    // The menu has gone; its dialog is still open over the page.
    vi.useFakeTimers();
    try {
      const ended = new Event('animationend', { bubbles: true });
      Object.defineProperty(ended, 'animationName', { value: 'exit' });
      act(() => { menu!.dispatchEvent(ended); });
      act(() => { vi.runOnlyPendingTimers(); });
    } finally {
      vi.useRealTimers();
    }

    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(screen.getByRole('dialog')).toHaveAttribute('data-state', 'open');
    expect(document.body.style.pointerEvents).toBe('none');
  });
});

describe('Dialog size viewer, long descriptions and presses outside', () => {
  it('size viewer fills the window up to a 24px margin and hands its whole box to the content', () => {
    render(<Dialog open title="Image" titleHidden size="viewer" closeButton><p>Picture</p></Dialog>, { wrapper: DesignSystemProvider });
    const dialog = screen.getByRole('dialog', { name: 'Image' });
    expect(dialog).toHaveClass('inset-6');
    expect(dialog).toHaveClass('p-0');
    expect(dialog).not.toHaveClass('max-w-md');
    expect(dialog).not.toHaveClass('-translate-x-1/2');
    const body = screen.getByText('Picture').parentElement;
    expect(body).toHaveClass('flex-1');
    expect(body).toHaveClass('min-h-0');
    expect(body).toHaveClass('flex-col');
    expect(body).not.toHaveClass('mt-4');
    expect(body).not.toHaveClass('overflow-y-auto');
    expect(document.querySelector('[data-ds-dialog-close]')).toHaveClass('absolute');
  });

  it('breaks and scrolls a description that is longer than the window', () => {
    const long = 'x'.repeat(3000);
    render(<Dialog open title="Archive these files?" description={long} />, { wrapper: DesignSystemProvider });
    const description = screen.getByText(long);
    expect(description).toHaveClass('break-words');
    expect(description).toHaveClass('max-h-60');
    expect(description).toHaveClass('overflow-y-auto');
  });

  // happy-dom lays nothing out: the description is as tall as the test says, in a box of 240px.
  function descriptionIs(height: number) {
    const isDescription = (element: Element) => element.classList.contains('max-h-60');
    const scroll = vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function (this: Element) { return isDescription(this) ? height : 0; });
    const client = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return isDescription(this) ? Math.min(height, 240) : 0; });
    return () => { scroll.mockRestore(); client.mockRestore(); };
  }
  const ADDRESS = `https://long.example.test/?q=${'x'.repeat(2000)}`;
  const question = (description: ReactNode, closeOnly = false) => (
    <Dialog
      open
      role="alertdialog"
      title="Open this link?"
      description={description}
      closeButton={closeOnly}
      footer={closeOnly ? undefined : <><Button>Cancel</Button><Button>Open</Button></>}
    />
  );

  it('makes a description taller than its box a named scroll region the Tab key reaches, and still opens on the first button', async () => {
    const restore = descriptionIs(882);
    const user = userEvent.setup();
    render(question(ADDRESS), { wrapper: DesignSystemProvider });
    const description = screen.getByText(ADDRESS);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus());
    expect(description).toHaveAttribute('tabindex', '0');
    expect(description).toHaveAttribute('role', 'group');
    expect(description).toHaveAccessibleName('Open this link?');
    expect(description).toHaveClass('focus-visible:ring-2');

    // The whole order: the text, then the two buttons, and round again.
    await user.tab({ shift: true });
    expect(description).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Open' })).toHaveFocus();
    restore();
  });

  it('adds no Tab stop for a description that fits its box', async () => {
    const restore = descriptionIs(36);
    const user = userEvent.setup();
    render(question('https://example.test/docs'), { wrapper: DesignSystemProvider });
    const description = screen.getByText('https://example.test/docs');

    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus());
    expect(description).not.toHaveAttribute('tabindex');
    expect(description).not.toHaveAttribute('role');
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Open' })).toHaveFocus();
    restore();
  });

  it('follows the description when it grows past its box or shrinks back into it', () => {
    let restore = descriptionIs(36);
    const view = render(question('short'), { wrapper: DesignSystemProvider });
    expect(screen.getByText('short')).not.toHaveAttribute('tabindex');
    restore();

    restore = descriptionIs(882);
    view.rerender(question(ADDRESS));
    expect(screen.getByText(ADDRESS)).toHaveAttribute('tabindex', '0');
    restore();

    restore = descriptionIs(36);
    view.rerender(question('short again'));
    expect(screen.getByText('short again')).not.toHaveAttribute('tabindex');
    restore();
  });

  it('still opens on its own box when the close button is the only control and the description scrolls', async () => {
    const restore = descriptionIs(882);
    render(question(ADDRESS, true), { wrapper: DesignSystemProvider });

    await waitFor(() => expect(screen.getByRole('alertdialog', { name: 'Open this link?' })).toHaveFocus());
    expect(screen.getByText(ADDRESS)).toHaveAttribute('tabindex', '0');
    restore();
  });

  it('ignores a press outside with outsidePress="ignore", and still closes on Escape', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onOpenChange = vi.fn();
    render(
      <>
        <p>Elsewhere</p>
        <Dialog open onOpenChange={onOpenChange} title="Run this command?" outsidePress="ignore" footer={<Button>Cancel</Button>} />
      </>,
      { wrapper: DesignSystemProvider },
    );
    await user.click(document.querySelector('.bg-scrim') as Element);
    await user.click(screen.getByText('Elsewhere'));
    expect(onOpenChange).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(onOpenChange.mock.calls).toEqual([[false]]);
  });

  it('takes urgent only on an approval', () => {
    render(
      <>
        <Dialog open layer="approval" urgent title="Allow this folder?" />
        {/* @ts-expect-error -- urgent orders the line of approvals; a plain dialog has no line */}
        <Dialog urgent title="Search" />
        {/* @ts-expect-error -- the same with the layer spelled out */}
        <Dialog layer="dialog" urgent title="Settings" />
      </>,
      { wrapper: DesignSystemProvider },
    );
    expect(screen.getByRole('dialog', { name: 'Allow this folder?' })).toBeInTheDocument();
  });
});

describe('approvals and the windows around them', () => {
  let restoreStyles: (() => void) | null = null;
  // A closed layer has an exit animation here, as in the app: it stays on the page until its fade
  // ends. A hidden one is not displayed, so Radix takes it away at once when it closes.
  beforeEach(() => {
    vi.useFakeTimers();
    const real = window.getComputedStyle.bind(window);
    const spy = vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element, pseudo?: string | null) => {
      const styles = real(element, pseudo);
      return new Proxy(styles, {
        get(target, prop) {
          if (prop === 'display' && element.hasAttribute('hidden')) return 'none';
          if (prop === 'animationName') return element.getAttribute('data-state') === 'closed' ? 'exit' : 'enter';
          const value = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    });
    restoreStyles = () => spy.mockRestore();
    moves = [];
    document.addEventListener('focusin', onFocusIn);
  });
  afterEach(() => {
    document.removeEventListener('focusin', onFocusIn);
    restoreStyles?.();
    restoreStyles = null;
    vi.useRealTimers();
  });

  // Every element that received the focus, in order. Where the focus ends up is not enough: the
  // focus trap of the layer on the page pulls it back after a layer that left has taken it away.
  let moves: string[] = [];
  const onFocusIn = (event: FocusEvent) => {
    const target = event.target;
    moves.push(target instanceof HTMLElement ? (target.getAttribute('aria-label') ?? target.textContent ?? target.tagName) : 'other');
  };
  const takeMoves = () => {
    const seen = moves;
    moves = [];
    return seen;
  };

  // The box of the window with this title, open or fading out.
  function box(title: string): HTMLElement | null {
    const boxes = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]'));
    return boxes.find((element) => element.querySelector('h2')?.textContent === title) ?? null;
  }

  // The fade of this window ends; what a layer does once it has gone runs one timer tick later.
  // Returns every element that received the focus because of it.
  function endFade(title: string): string[] {
    const element = box(title);
    if (!element) throw new Error(`No window titled ${title} is on the page`);
    expect(element).toHaveAttribute('data-state', 'closed');
    takeMoves();
    const ended = new Event('animationend', { bubbles: true });
    Object.defineProperty(ended, 'animationName', { value: 'exit' });
    act(() => { element.dispatchEvent(ended); });
    act(() => { vi.runOnlyPendingTimers(); });
    expect(box(title)).toBeNull();
    return takeMoves();
  }

  // Records whether the window with this title was ever on the page while it watched.
  function watchFor(title: string) {
    let seen = false;
    const look = () => { if (box(title)) seen = true; };
    const check = (records: MutationRecord[]) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof HTMLElement && node.textContent?.includes(title)) seen = true;
        }
      }
      look();
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-state'] });
    return () => {
      check(observer.takeRecords());
      observer.disconnect();
      return seen;
    };
  }

  const cancelOf = (content: HTMLElement) => content.querySelector<HTMLElement>('[data-approval-cancel]');

  interface DeskProps {
    login?: boolean;
    busy?: boolean;
    dirty?: boolean;
    command?: boolean;
    folder?: boolean;
    search?: boolean;
    quit?: boolean;
    onLogin?: (open: boolean) => void;
    onCommand?: (open: boolean) => void;
    onFolder?: (open: boolean) => void;
    onSearch?: (open: boolean) => void;
    onQuit?: (open: boolean) => void;
    onModalChange?: (open: boolean) => void;
    container?: HTMLElement;
  }

  function Desk({
    login = false, busy = true, dirty = false, command = false, folder = false, search = false, quit = false,
    onLogin, onCommand, onFolder, onSearch, onQuit, onModalChange, container,
  }: DeskProps) {
    const [email, setEmail] = useState('');
    return (
      <DesignSystemProvider onModalChange={onModalChange} container={container}>
        <Button>Account</Button>
        <Button>Send</Button>
        <Dialog open={login} busy={busy} dirty={dirty} onOpenChange={onLogin} title="Sign in">
          <input aria-label="Email" value={email} onChange={(event) => setEmail(event.target.value)} />
        </Dialog>
        <Dialog
          open={command}
          onOpenChange={onCommand}
          layer="approval"
          role="alertdialog"
          outsidePress="ignore"
          title="Run this command?"
          initialFocus={cancelOf}
          footer={<><Button data-approval-cancel="">Cancel</Button><Button variant="primary">Run</Button></>}
        />
        <Dialog
          open={folder}
          onOpenChange={onFolder}
          layer="approval"
          role="alertdialog"
          outsidePress="ignore"
          title="Allow this folder?"
          initialFocus={cancelOf}
          footer={<><Button data-approval-cancel="">Deny</Button><Button variant="primary">Allow</Button></>}
        />
        <Dialog open={search} onOpenChange={onSearch} title="Search"><input aria-label="Query" /></Dialog>
        <Dialog
          open={quit}
          onOpenChange={onQuit}
          role="alertdialog"
          title="Close the window?"
          footer={<><Button>Minimize</Button><Button variant="primary">Quit</Button></>}
        />
      </DesignSystemProvider>
    );
  }

  const cancel = () => screen.getByRole('button', { name: 'Cancel' });

  it('turns away a dialog opened while an approval is on screen: it is told to close and is never on the page', () => {
    const onSearch = vi.fn();
    const onCommand = vi.fn();
    const view = render(<Desk command onSearch={onSearch} onCommand={onCommand} />);
    expect(cancel()).toHaveFocus();

    const sawSearch = watchFor('Search');
    view.rerender(<Desk command search onSearch={onSearch} onCommand={onCommand} />);
    act(() => { vi.runOnlyPendingTimers(); });

    expect(sawSearch()).toBe(false);
    expect(onSearch.mock.calls).toEqual([[false]]);
    expect(onCommand).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog', { name: 'Run this command?' })).toHaveAttribute('data-state', 'open');
    expect(cancel()).toHaveFocus();
  });

  it('keeps a dialog that is rendered already open off the page, and the focus in the approval, when layers portal into a given node', () => {
    // Radix mounts a portal into <body> one render late, into a given node at once: there a
    // dialog that is open in its first render would join the page, take the focus and fade out
    // before the registry is heard.
    const host = document.createElement('div');
    document.body.appendChild(host);
    function Page({ search, onSearch }: { search: boolean; onSearch: (open: boolean) => void }) {
      return (
        <DesignSystemProvider container={host}>
          <Dialog open layer="approval" title="Run this command?" initialFocus={cancelOf} footer={<Button data-approval-cancel="">Cancel</Button>} />
          {search && <Dialog open onOpenChange={onSearch} title="Search"><input aria-label="Query" /></Dialog>}
        </DesignSystemProvider>
      );
    }
    try {
      const onSearch = vi.fn();
      const view = render(<Page search={false} onSearch={onSearch} />);
      expect(cancel()).toHaveFocus();
      takeMoves();

      const sawSearch = watchFor('Search');
      view.rerender(<Page search onSearch={onSearch} />);
      act(() => { vi.runOnlyPendingTimers(); });

      expect(sawSearch()).toBe(false);
      expect(takeMoves()).toEqual([]);
      expect(onSearch.mock.calls).toEqual([[false]]);
      expect(cancel()).toHaveFocus();
      view.unmount();
    } finally {
      host.remove();
    }
  });

  it('keeps a busy dialog that opens under an approval off the page from its first render, unclosed, and shows it when the approval has gone', () => {
    const onLogin = vi.fn();
    const onCommand = vi.fn();
    const view = render(<Desk onLogin={onLogin} onCommand={onCommand} />);
    const send = screen.getByRole('button', { name: 'Send' });
    send.focus();
    view.rerender(<Desk command onLogin={onLogin} onCommand={onCommand} />);
    expect(cancel()).toHaveFocus();
    takeMoves();

    const sawLogin = watchFor('Sign in');
    view.rerender(<Desk command login onLogin={onLogin} onCommand={onCommand} />);
    act(() => { vi.runOnlyPendingTimers(); });

    expect(sawLogin()).toBe(false);
    expect(box('Sign in')).toBeNull();
    expect(onLogin).not.toHaveBeenCalled();
    expect(onCommand).not.toHaveBeenCalled();
    // The approval keeps the focus.
    expect(takeMoves()).toEqual([]);
    expect(cancel()).toHaveFocus();

    // The approval is answered: the window is shown, with the focus on its first control.
    view.rerender(<Desk login onLogin={onLogin} onCommand={onCommand} />);
    expect(screen.getByRole('textbox', { name: 'Email' })).toHaveFocus();
    expect(endFade('Run this command?')).toEqual([]);
    expect(screen.getByRole('dialog', { name: 'Sign in' })).toHaveAttribute('data-state', 'open');
    expect(screen.getByRole('textbox', { name: 'Email' })).toHaveFocus();
    expect(onLogin).not.toHaveBeenCalled();

    // Its owner closes it: focus goes where the approval's would have gone, not onto the window.
    view.rerender(<Desk onLogin={onLogin} onCommand={onCommand} />);
    expect(endFade('Sign in')).toEqual(['Send']);
    expect(send).toHaveFocus();
  });

  it('turns away a dialog that is not busy when it opens under an approval', () => {
    const onLogin = vi.fn();
    const view = render(<Desk command busy={false} onLogin={onLogin} />);
    view.rerender(<Desk command login busy={false} onLogin={onLogin} />);
    expect(onLogin.mock.calls).toEqual([[false]]);
    expect(box('Sign in')).toBeNull();
  });

  it('shows a dialog that an approval turned away when it is opened after the approval has gone', () => {
    const view = render(<Desk command search />);
    view.rerender(<Desk command />);
    view.rerender(<Desk />);
    endFade('Run this command?');
    view.rerender(<Desk search />);
    expect(screen.getByRole('dialog', { name: 'Search' })).toHaveAttribute('data-state', 'open');
    expect(screen.getByRole('textbox', { name: 'Query' })).toHaveFocus();
  });

  it('has a busy window step aside for an approval and brings it back as it was, with focus where it belongs at every step', () => {
    const onLogin = vi.fn();
    const view = render(<Desk onLogin={onLogin} />);
    const opener = screen.getByRole('button', { name: 'Account' });
    opener.focus();
    view.rerender(<Desk login onLogin={onLogin} />);
    const email = screen.getByRole('textbox', { name: 'Email' });
    fireEvent.change(email, { target: { value: 'ada@example.test' } });
    expect(email).toHaveFocus();
    const window = box('Sign in');
    const scrims = () => Array.from(document.querySelectorAll('.bg-scrim')).filter((scrim) => !scrim.hasAttribute('hidden'));
    expect(scrims()).toHaveLength(1);
    takeMoves();

    // The approval arrives: the window is hidden, with its scrim, and its owner hears nothing.
    view.rerender(<Desk login command onLogin={onLogin} />);
    expect(box('Sign in')).toBe(window);
    expect(window).toHaveAttribute('hidden');
    expect(scrims()).toHaveLength(1);
    expect(screen.queryByRole('dialog', { name: 'Sign in' })).toBeNull();
    expect(screen.getByRole('alertdialog', { name: 'Run this command?' })).toHaveAttribute('data-state', 'open');
    expect(takeMoves()).toEqual(['Cancel']);
    act(() => { vi.runOnlyPendingTimers(); });
    expect(takeMoves()).toEqual([]);
    expect(cancel()).toHaveFocus();
    expect(onLogin).not.toHaveBeenCalled();

    // The approval is answered: the same window is back with what was typed, and focus where it was in it.
    view.rerender(<Desk login onLogin={onLogin} />);
    expect(box('Sign in')).toBe(window);
    expect(window).not.toHaveAttribute('hidden');
    expect(email).toBeInTheDocument();
    expect(email).toHaveValue('ada@example.test');
    expect(takeMoves()).toEqual(['Email']);
    expect(endFade('Run this command?')).toEqual([]);
    // The approval has gone, and what it hid from screen readers is theirs again.
    expect(screen.getByRole('dialog', { name: 'Sign in' })).toBe(window);
    expect(screen.getByRole('textbox', { name: 'Email' })).toBe(email);
    expect(email).toHaveFocus();
    expect(onLogin).not.toHaveBeenCalled();

    // Its owner closes it: focus returns to the button that opened it the first time.
    view.rerender(<Desk onLogin={onLogin} />);
    expect(endFade('Sign in')).toEqual(['Account']);
    expect(opener).toHaveFocus();
  });

  it('keeps focus in the next approval in line after the first one has faded out', () => {
    const onFolder = vi.fn();
    const view = render(<Desk />);
    screen.getByRole('button', { name: 'Send' }).focus();
    view.rerender(<Desk command />);
    view.rerender(<Desk command folder onFolder={onFolder} />);
    expect(box('Allow this folder?')).toBeNull();
    expect(onFolder).not.toHaveBeenCalled();

    view.rerender(<Desk folder onFolder={onFolder} />);
    expect(screen.getByRole('alertdialog', { name: 'Allow this folder?' })).toHaveAttribute('data-state', 'open');
    expect(screen.getByRole('button', { name: 'Deny' })).toHaveFocus();
    expect(endFade('Run this command?')).toEqual([]);
    expect(screen.getByRole('button', { name: 'Deny' })).toHaveFocus();
    expect(onFolder).not.toHaveBeenCalled();
  });

  it('gives focus back to where it was before the approval when no layer takes its place', () => {
    const view = render(<Desk />);
    const send = screen.getByRole('button', { name: 'Send' });
    send.focus();
    view.rerender(<Desk command />);
    expect(cancel()).toHaveFocus();
    view.rerender(<Desk />);
    expect(endFade('Run this command?')).toEqual(['Send']);
    expect(send).toHaveFocus();
  });

  describe('when the place the focus returns to is no control on the page', () => {
    function Composer({ command = false, folder = false, send = true, onFocusUnplaced }: {
      command?: boolean;
      folder?: boolean;
      send?: boolean;
      onFocusUnplaced: () => void;
    }) {
      return (
        <DesignSystemProvider>
          <input aria-label="Message" />
          {send && <Button>Send</Button>}
          <Dialog
            open={command}
            layer="approval"
            role="alertdialog"
            outsidePress="ignore"
            title="Run this command?"
            initialFocus={cancelOf}
            onFocusUnplaced={onFocusUnplaced}
            footer={<><Button data-approval-cancel="">Cancel</Button><Button variant="primary">Run</Button></>}
          />
          <Dialog
            open={folder}
            layer="approval"
            role="alertdialog"
            outsidePress="ignore"
            title="Allow this folder?"
            initialFocus={cancelOf}
            onFocusUnplaced={onFocusUnplaced}
            footer={<><Button data-approval-cancel="">Deny</Button><Button variant="primary">Allow</Button></>}
          />
        </DesignSystemProvider>
      );
    }
    const toMessage = () => vi.fn(() => { screen.getByRole('textbox', { name: 'Message' }).focus(); });

    it('asks its owner once the window has left, when the control that had the focus is gone', () => {
      const onFocusUnplaced = toMessage();
      const view = render(<Composer onFocusUnplaced={onFocusUnplaced} />);
      screen.getByRole('button', { name: 'Send' }).focus();
      view.rerender(<Composer command onFocusUnplaced={onFocusUnplaced} />);
      expect(cancel()).toHaveFocus();
      view.rerender(<Composer command send={false} onFocusUnplaced={onFocusUnplaced} />);
      view.rerender(<Composer send={false} onFocusUnplaced={onFocusUnplaced} />);
      expect(onFocusUnplaced).not.toHaveBeenCalled();

      expect(endFade('Run this command?')).toEqual(['Message']);
      expect(onFocusUnplaced).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('textbox', { name: 'Message' })).toHaveFocus();
    });

    it('asks its owner when no control had the focus as the window appeared', () => {
      const onFocusUnplaced = toMessage();
      const view = render(<Composer onFocusUnplaced={onFocusUnplaced} />);
      expect(document.body).toHaveFocus();
      view.rerender(<Composer command onFocusUnplaced={onFocusUnplaced} />);
      view.rerender(<Composer onFocusUnplaced={onFocusUnplaced} />);

      expect(endFade('Run this command?')).toEqual(['Message']);
      expect(onFocusUnplaced).toHaveBeenCalledTimes(1);
    });

    it('does not ask while the control that had the focus is on the page: the focus returns there', () => {
      const onFocusUnplaced = toMessage();
      const view = render(<Composer onFocusUnplaced={onFocusUnplaced} />);
      const send = screen.getByRole('button', { name: 'Send' });
      send.focus();
      view.rerender(<Composer command onFocusUnplaced={onFocusUnplaced} />);
      view.rerender(<Composer onFocusUnplaced={onFocusUnplaced} />);

      expect(endFade('Run this command?')).toEqual(['Send']);
      expect(onFocusUnplaced).not.toHaveBeenCalled();
      expect(send).toHaveFocus();
    });

    it('does not ask for an approval the next one takes the place of; the last of the run asks', () => {
      const onFocusUnplaced = toMessage();
      const view = render(<Composer onFocusUnplaced={onFocusUnplaced} />);
      view.rerender(<Composer command onFocusUnplaced={onFocusUnplaced} />);
      view.rerender(<Composer folder onFocusUnplaced={onFocusUnplaced} />);
      expect(endFade('Run this command?')).toEqual([]);
      expect(onFocusUnplaced).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Deny' })).toHaveFocus();

      view.rerender(<Composer onFocusUnplaced={onFocusUnplaced} />);
      expect(endFade('Allow this folder?')).toEqual(['Message']);
      expect(onFocusUnplaced).toHaveBeenCalledTimes(1);
    });
  });

  it('gives focus back to where it was before the first approval after two approvals in a row', () => {
    const view = render(<Desk />);
    const send = screen.getByRole('button', { name: 'Send' });
    send.focus();
    view.rerender(<Desk command />);
    view.rerender(<Desk command folder />);
    view.rerender(<Desk folder />);
    expect(endFade('Run this command?')).toEqual([]);
    view.rerender(<Desk />);
    expect(endFade('Allow this folder?')).toEqual(['Send']);
    expect(send).toHaveFocus();
  });

  it('keeps focus in an approval that is shown in the render in which the one before it leaves', () => {
    // The chat view renders one approval at a time: the next one is not in line, it arrives as the first leaves.
    const view = render(<Desk />);
    const send = screen.getByRole('button', { name: 'Send' });
    send.focus();
    view.rerender(<Desk command />);
    view.rerender(<Desk folder />);
    expect(screen.getByRole('button', { name: 'Deny' })).toHaveFocus();
    expect(endFade('Run this command?')).toEqual([]);
    expect(screen.getByRole('button', { name: 'Deny' })).toHaveFocus();

    view.rerender(<Desk />);
    expect(endFade('Allow this folder?')).toEqual(['Send']);
  });

  it('gives focus back to what opened a window that closed while it stood aside for an approval', () => {
    const view = render(<Desk />);
    const opener = screen.getByRole('button', { name: 'Account' });
    opener.focus();
    view.rerender(<Desk login />);
    view.rerender(<Desk login command />);
    // Its work ended and its owner closed it while the approval was on screen: focus stays in the approval.
    takeMoves();
    view.rerender(<Desk command />);
    // It was hidden, so it goes without a fade; what a layer does once it has gone runs one timer tick later.
    act(() => { vi.runOnlyPendingTimers(); });
    expect(box('Sign in')).toBeNull();
    expect(takeMoves()).toEqual([]);
    expect(cancel()).toHaveFocus();
    view.rerender(<Desk />);
    expect(endFade('Run this command?')).toEqual(['Account']);
    expect(opener).toHaveFocus();
  });

  it('brings back a busy window opened inside another one, with what was typed in it and the focus in it', () => {
    // The window inside lives in the content of the outer one: both stay mounted while they stand aside.
    function Section() {
      const [adding, setAdding] = useState(false);
      const [key, setKey] = useState('');
      return (
        <>
          <Button onClick={() => setAdding(true)}>Add provider</Button>
          <Dialog open={adding} onOpenChange={setAdding} busy title="Add provider">
            <input aria-label="Key" value={key} onChange={(event) => setKey(event.target.value)} />
          </Dialog>
        </>
      );
    }
    function Page({ command }: { command: boolean }) {
      return (
        <DesignSystemProvider>
          <Dialog open title="Settings"><Section /></Dialog>
          <Dialog open={command} layer="approval" title="Run this command?" initialFocus={cancelOf} footer={<Button data-approval-cancel="">Cancel</Button>} />
        </DesignSystemProvider>
      );
    }
    const view = render(<Page command={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add provider' }));
    const key = screen.getByRole('textbox', { name: 'Key' });
    fireEvent.change(key, { target: { value: 'sk-test-not-a-secret' } });
    expect(key).toHaveFocus();

    view.rerender(<Page command />);
    expect(box('Settings')).toHaveAttribute('hidden');
    expect(box('Add provider')).toHaveAttribute('hidden');
    expect(cancel()).toHaveFocus();
    takeMoves();

    view.rerender(<Page command={false} />);
    expect(box('Settings')).not.toHaveAttribute('hidden');
    expect(box('Add provider')).not.toHaveAttribute('hidden');
    expect(key).toBeInTheDocument();
    expect(key).toHaveValue('sk-test-not-a-secret');
    // The window inside gets the focus back; the outer one does not take it for its own first control.
    expect(takeMoves()).toEqual(['Key']);
    expect(endFade('Run this command?')).toEqual([]);
    expect(screen.getByRole('textbox', { name: 'Key' })).toBe(key);
    expect(key).toHaveFocus();
  });

  it('puts focus on the first control of a window that comes back when none of its controls had it', () => {
    const view = render(<Desk login />);
    (document.activeElement as HTMLElement).blur();
    expect(document.body).toHaveFocus();
    view.rerender(<Desk login command />);
    expect(cancel()).toHaveFocus();
    takeMoves();

    view.rerender(<Desk login />);
    expect(takeMoves()).toEqual(['Email']);
    expect(endFade('Run this command?')).toEqual([]);
    expect(screen.getByRole('textbox', { name: 'Email' })).toHaveFocus();
  });

  it('gives focus back to what opened a window whose unsaved input the user discarded for an approval', () => {
    const onLogin = vi.fn();
    const view = render(<Desk />);
    const opener = screen.getByRole('button', { name: 'Account' });
    opener.focus();
    view.rerender(<Desk login busy={false} dirty onLogin={onLogin} />);
    view.rerender(<Desk login busy={false} dirty command onLogin={onLogin} />);
    expect(box('Discard these changes?')).toHaveAttribute('data-state', 'open');
    expect(box('Run this command?')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onLogin.mock.calls).toEqual([[false]]);
    view.rerender(<Desk command onLogin={onLogin} />);
    expect(cancel()).toHaveFocus();
    // Neither the question nor the window takes the focus from the approval as it fades.
    expect(endFade('Discard these changes?')).toEqual([]);
    expect(endFade('Sign in')).toEqual([]);
    expect(cancel()).toHaveFocus();

    view.rerender(<Desk onLogin={onLogin} />);
    expect(endFade('Run this command?')).toEqual(['Account']);
    expect(opener).toHaveFocus();
  });

  it('gives focus back to what opened a window that closed after the user kept editing, once the approval that waited has gone', () => {
    const view = render(<Desk />);
    const opener = screen.getByRole('button', { name: 'Account' });
    opener.focus();
    view.rerender(<Desk login busy={false} dirty />);
    view.rerender(<Desk login busy={false} dirty command />);
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(endFade('Discard these changes?')).toEqual(['Email']);
    expect(box('Run this command?')).toBeNull();

    // The save lands and the owner closes the window: the approval shows, and keeps the focus.
    takeMoves();
    view.rerender(<Desk command />);
    expect(takeMoves()).toEqual(['Cancel']);
    expect(endFade('Sign in')).toEqual([]);
    expect(cancel()).toHaveFocus();

    view.rerender(<Desk />);
    expect(endFade('Run this command?')).toEqual(['Account']);
    expect(opener).toHaveFocus();
  });

  it('hides the discard question of a busy window with it, and brings both back unanswered', () => {
    const onLogin = vi.fn();
    const view = render(<Desk login dirty onLogin={onLogin} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    const question = box('Discard these changes?') as HTMLElement;
    expect(question).toHaveAttribute('data-state', 'open');
    const words = question.textContent;
    expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus();

    view.rerender(<Desk login dirty command onLogin={onLogin} />);
    expect(box('Sign in')).toHaveAttribute('hidden');
    expect(question).toHaveAttribute('hidden');
    expect(question).toHaveAttribute('data-state', 'open');
    expect(cancel()).toHaveFocus();
    takeMoves();

    view.rerender(<Desk login dirty onLogin={onLogin} />);
    expect(box('Sign in')).not.toHaveAttribute('hidden');
    expect(box('Discard these changes?')).toBe(question);
    expect(question).not.toHaveAttribute('hidden');
    expect(question.textContent).toBe(words);
    expect(takeMoves()).toEqual(['Keep editing']);
    expect(endFade('Run this command?')).toEqual([]);
    expect(screen.getByRole('button', { name: 'Keep editing' })).toHaveFocus();
    expect(onLogin).not.toHaveBeenCalled();
  });

  it('gives focus back to what opened the window an approval took the place of', () => {
    const view = render(<Desk />);
    const opener = screen.getByRole('button', { name: 'Account' });
    opener.focus();
    view.rerender(<Desk login busy={false} />);
    view.rerender(<Desk login busy={false} command />);
    view.rerender(<Desk command />);
    expect(endFade('Sign in')).toEqual([]);
    view.rerender(<Desk />);
    expect(endFade('Run this command?')).toEqual(['Account']);
  });

  it('keeps a window that stepped aside off the page when one approval replaces another in one render', () => {
    const onLogin = vi.fn();
    const view = render(<Desk login />);
    view.rerender(<Desk login command onLogin={onLogin} />);
    const window = box('Sign in') as HTMLElement;
    expect(window).toHaveAttribute('hidden');

    // Any change of the window's hidden state would be recorded here.
    const shown: boolean[] = [];
    const observer = new MutationObserver((records) => { for (const record of records) shown.push(!(record.target as HTMLElement).hidden); });
    observer.observe(window, { attributes: true, attributeFilter: ['hidden'] });
    takeMoves();
    view.rerender(<Desk login folder onLogin={onLogin} />);
    for (const record of observer.takeRecords()) shown.push(!(record.target as HTMLElement).hidden);
    observer.disconnect();

    expect(shown).toEqual([]);
    expect(window).toHaveAttribute('hidden');
    expect(takeMoves()).toEqual(['Deny']);
    expect(screen.getByRole('alertdialog', { name: 'Allow this folder?' })).toHaveAttribute('data-state', 'open');
    expect(endFade('Run this command?')).toEqual([]);
    expect(screen.getByRole('button', { name: 'Deny' })).toHaveFocus();
    expect(onLogin).not.toHaveBeenCalled();

    view.rerender(<Desk login onLogin={onLogin} />);
    expect(box('Sign in')).toBe(window);
    expect(window).not.toHaveAttribute('hidden');
  });

  it('shows an urgent approval before one that was already in line, and never in place of the one on screen', () => {
    function Line({ command, file, workspace }: { command: boolean; file: boolean; workspace: boolean }) {
      return (
        <DesignSystemProvider>
          <Dialog open={command} layer="approval" title="Run this command?" />
          <Dialog open={file} layer="approval" title="Allow writing this file?" />
          <Dialog open={workspace} layer="approval" urgent title="Use this folder?" />
        </DesignSystemProvider>
      );
    }
    const view = render(<Line command file={false} workspace={false} />);
    view.rerender(<Line command file workspace={false} />);
    view.rerender(<Line command file workspace />);
    expect(screen.getByRole('dialog', { name: 'Run this command?' })).toHaveAttribute('data-state', 'open');
    expect(box('Use this folder?')).toBeNull();

    view.rerender(<Line command={false} file workspace />);
    expect(screen.getByRole('dialog', { name: 'Use this folder?' })).toHaveAttribute('data-state', 'open');
    expect(box('Allow writing this file?')).toBeNull();
    endFade('Run this command?');
    view.rerender(<Line command={false} file workspace={false} />);
    expect(screen.getByRole('dialog', { name: 'Allow writing this file?' })).toHaveAttribute('data-state', 'open');
  });

  it('has a question step aside for an approval and brings it back unanswered', () => {
    const onQuit = vi.fn();
    const view = render(<Desk quit onQuit={onQuit} />);
    expect(screen.getByRole('button', { name: 'Minimize' })).toHaveFocus();

    view.rerender(<Desk quit command onQuit={onQuit} />);
    expect(box('Close the window?')).toHaveAttribute('hidden');
    expect(cancel()).toHaveFocus();

    view.rerender(<Desk quit onQuit={onQuit} />);
    expect(box('Close the window?')).not.toHaveAttribute('hidden');
    expect(endFade('Run this command?')).toEqual([]);
    expect(screen.getByRole('alertdialog', { name: 'Close the window?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Minimize' })).toHaveFocus();
    expect(onQuit).not.toHaveBeenCalled();
  });

  // The approval took the focus by itself, and the user may still be pressing keys for it when
  // the question returns. A question returns the way it opened: on the control that ends nothing.
  it('brings a question back with the focus on the control it opened on, not on the one the focus had moved to', () => {
    const onQuit = vi.fn();
    const view = render(<Desk quit onQuit={onQuit} />);
    act(() => { screen.getByRole('button', { name: 'Quit' }).focus(); });
    expect(screen.getByRole('button', { name: 'Quit' })).toHaveFocus();

    view.rerender(<Desk quit command onQuit={onQuit} />);
    expect(cancel()).toHaveFocus();

    view.rerender(<Desk quit onQuit={onQuit} />);
    expect(endFade('Run this command?')).toEqual([]);
    expect(screen.getByRole('button', { name: 'Minimize' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Quit' })).not.toHaveFocus();
    expect(onQuit).not.toHaveBeenCalled();
  });

  // After a group returns, the focus is inside its top layer: the question, not the window under it.
  it('gives the focus to the question when a busy window and the question asked over it return together', () => {
    const onQuit = vi.fn();
    const onLogin = vi.fn();
    const view = render(<Desk login onQuit={onQuit} onLogin={onLogin} />);
    act(() => { screen.getByRole('textbox', { name: 'Email' }).focus(); });
    view.rerender(<Desk login quit onQuit={onQuit} onLogin={onLogin} />);
    expect(screen.getByRole('button', { name: 'Minimize' })).toHaveFocus();

    view.rerender(<Desk login quit command onQuit={onQuit} onLogin={onLogin} />);
    expect(box('Sign in')).toHaveAttribute('hidden');
    expect(box('Close the window?')).toHaveAttribute('hidden');
    expect(cancel()).toHaveFocus();

    view.rerender(<Desk login quit onQuit={onQuit} onLogin={onLogin} />);
    endFade('Run this command?');
    expect(box('Sign in')).not.toHaveAttribute('hidden');
    expect(box('Close the window?')).not.toHaveAttribute('hidden');
    expect(screen.getByRole('button', { name: 'Minimize' })).toHaveFocus();
    expect(onQuit).not.toHaveBeenCalled();
    expect(onLogin).not.toHaveBeenCalled();
  });

  it('gives the focus to a confirmation when it returns with the busy window it was asked over', async () => {
    const answers: boolean[] = [];
    function Asker() {
      const confirm = useConfirm();
      return <Button onClick={() => { void confirm({ title: 'Remove it?', confirmLabel: 'Remove', tone: 'danger' }).then((answer) => { answers.push(answer); }); }}>Ask</Button>;
    }
    function Page({ command }: { command: boolean }) {
      return (
        <DesignSystemProvider>
          <Dialog open busy title="Install"><input aria-label="Name" /><Asker /></Dialog>
          <Dialog open={command} layer="approval" role="alertdialog" outsidePress="ignore" title="Run this command?" initialFocus={cancelOf} footer={<Button data-approval-cancel="">Cancel</Button>} />
        </DesignSystemProvider>
      );
    }
    const view = render(<Page command={false} />);
    act(() => { screen.getByRole('button', { name: 'Ask' }).click(); });
    act(() => { screen.getByRole('button', { name: 'Remove' }).focus(); });

    view.rerender(<Page command />);
    expect(box('Remove it?')).toHaveAttribute('hidden');
    view.rerender(<Page command={false} />);
    endFade('Run this command?');
    expect(box('Remove it?')).not.toHaveAttribute('hidden');
    expect(within(box('Remove it?')!).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(answers).toEqual([]);
  });

  it('brings the question back alone when a busy window opened under the approval, and shows that window once the question has been answered', () => {
    const onQuit = vi.fn();
    const onLogin = vi.fn();
    const view = render(<Desk quit onQuit={onQuit} onLogin={onLogin} />);
    view.rerender(<Desk quit command onQuit={onQuit} onLogin={onLogin} />);
    view.rerender(<Desk quit command login onQuit={onQuit} onLogin={onLogin} />);
    expect(box('Close the window?')).toHaveAttribute('hidden');
    expect(box('Sign in')).toBeNull();

    // The approval is answered: the question is back, with the focus, and nothing is over it.
    const sawLogin = watchFor('Sign in');
    view.rerender(<Desk quit login onQuit={onQuit} onLogin={onLogin} />);
    expect(endFade('Run this command?')).toEqual([]);
    expect(sawLogin()).toBe(false);
    expect(box('Close the window?')).not.toHaveAttribute('hidden');
    expect(screen.getByRole('alertdialog', { name: 'Close the window?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Minimize' })).toHaveFocus();
    expect(onQuit).not.toHaveBeenCalled();
    expect(onLogin).not.toHaveBeenCalled();

    // Its owner answers the question: the window that waited is shown.
    view.rerender(<Desk login onQuit={onQuit} onLogin={onLogin} />);
    expect(screen.getByRole('dialog', { name: 'Sign in' })).toHaveAttribute('data-state', 'open');
    expect(screen.getByRole('textbox', { name: 'Email' })).toHaveFocus();
    expect(onQuit).not.toHaveBeenCalled();
    expect(onLogin).not.toHaveBeenCalled();
  });

  it('closes a window that holds nothing when an approval arrives', () => {
    const onLogin = vi.fn();
    const view = render(<Desk login busy={false} onLogin={onLogin} />);
    view.rerender(<Desk login busy={false} command onLogin={onLogin} />);
    expect(onLogin.mock.calls).toEqual([[false]]);
    expect(cancel()).toHaveFocus();
  });

  it('tells the app the last dialog has left when its fade has ended, not when it closed', () => {
    const order: string[] = [];
    function Page({ open }: { open: boolean }) {
      return (
        <DesignSystemProvider onModalChange={(modal) => order.push(`modal ${modal}`)}>
          <Dialog open={open} title="Search" onCloseAutoFocus={() => order.push('focus given back')}>
            <input aria-label="Query" />
          </Dialog>
        </DesignSystemProvider>
      );
    }
    const view = render(<Page open />);
    expect(order).toEqual(['modal true']);

    view.rerender(<Page open={false} />);
    expect(box('Search')).toHaveAttribute('data-state', 'closed');
    expect(order).toEqual(['modal true']);
    endFade('Search');
    // Radix reports that the content has gone; the layer says so before the caller hears it.
    expect(order).toEqual(['modal true', 'modal false', 'focus given back']);
  });

  // A fade can end later than its nominal 200 ms when the main thread is busy. Until the content
  // has left the page the app is not told: what it hides under a dialog would show through it.
  it('does not tell the app a dialog has left while its content is still on the page, however long the fade runs', () => {
    const onModalChange = vi.fn();
    const view = render(<Desk search onModalChange={onModalChange} />);
    view.rerender(<Desk onModalChange={onModalChange} />);
    expect(box('Search')).toHaveAttribute('data-state', 'closed');
    expect(onModalChange.mock.calls).toEqual([[true]]);
    act(() => { vi.advanceTimersByTime(200); });
    expect(box('Search')).not.toBeNull();
    expect(onModalChange.mock.calls).toEqual([[true]]);
    act(() => { vi.advanceTimersByTime(313); });
    expect(box('Search')).not.toBeNull();
    expect(onModalChange.mock.calls).toEqual([[true]]);
    endFade('Search');
    expect(onModalChange.mock.calls).toEqual([[true], [false]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('tells the app within one fade when a fading dialog leaves the page with its owner', () => {
    const onModalChange = vi.fn();
    function Page({ open, mounted }: { open: boolean; mounted: boolean }) {
      return (
        <DesignSystemProvider onModalChange={onModalChange}>
          {mounted && <Dialog open={open} title="Search"><input aria-label="Query" /></Dialog>}
        </DesignSystemProvider>
      );
    }
    const view = render(<Page open mounted />);
    view.rerender(<Page open={false} mounted />);
    expect(box('Search')).toHaveAttribute('data-state', 'closed');
    view.rerender(<Page open={false} mounted={false} />);
    expect(box('Search')).toBeNull();
    act(() => { vi.advanceTimersByTime(200); });
    expect(onModalChange.mock.calls).toEqual([[true], [false]]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drops the timer of a dialog that still fades when the provider leaves the page', () => {
    const onModalChange = vi.fn();
    const view = render(<Desk search onModalChange={onModalChange} />);
    view.rerender(<Desk onModalChange={onModalChange} />);
    act(() => { vi.advanceTimersByTime(250); });
    expect(box('Search')).not.toBeNull();
    onModalChange.mockClear();
    view.unmount();
    act(() => { vi.runOnlyPendingTimers(); });
    expect(vi.getTimerCount()).toBe(0);
    expect(onModalChange).not.toHaveBeenCalled();
  });
});

// An approval opens by itself, and a question's confirming button sits where the button that
// asked it, or the button of the layer before it, was. A pointer press that is on its way when
// such a layer appears was aimed at something else.
describe('approvals and questions: a pointer press begun before the layer could be read', () => {
  // The clock of the page: a layer counts its interval from the moment it is on the page.
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  type Answer = 'cancel' | 'run' | 'refuse';
  const cancelOf = (content: HTMLElement) => content.querySelector<HTMLElement>('[data-approval-cancel]');

  // An approval as the app builds one: only its own buttons answer; Escape and the corner refuse.
  function Approval({
    shown = true, title = 'Run this command?', role = 'alertdialog', outsidePress = 'ignore', settleKey, confirmLabel = 'Run', onAnswer, children,
  }: {
    shown?: boolean;
    title?: string;
    role?: 'dialog' | 'alertdialog';
    outsidePress?: 'close' | 'ignore';
    settleKey?: unknown;
    confirmLabel?: string;
    onAnswer: (answer: Answer) => void;
    children?: ReactNode;
  }) {
    return (
      <Dialog
        open={shown}
        onOpenChange={(next) => { if (!next) onAnswer('refuse'); }}
        layer="approval"
        role={role}
        outsidePress={outsidePress}
        title={title}
        settleKey={settleKey}
        initialFocus={cancelOf}
        footer={(
          <>
            <Button data-approval-cancel="" onClick={() => onAnswer('cancel')}>Cancel</Button>
            <Button variant="primary" onClick={() => onAnswer('run')}>{confirmLabel}</Button>
          </>
        )}
      >
        {children}
      </Dialog>
    );
  }

  function Capture({ onReady }: { onReady: (confirm: Confirm) => void }) {
    const confirm = useConfirm();
    useEffect(() => { onReady(confirm); }, [confirm, onReady]);
    return null;
  }
  let confirmOf: Confirm | null = null;
  const keepConfirm = (confirm: Confirm) => { confirmOf = confirm; };
  // Asks a useConfirm() question; the list holds its answer once it has one.
  function askQuestion(title = 'Remove this site?', confirmLabel = 'Remove'): boolean[] {
    const heard: boolean[] = [];
    const confirm = confirmOf;
    if (!confirm) throw new Error('Capture did not render');
    act(() => { void confirm({ title, confirmLabel, tone: 'danger' }).then((answer) => { heard.push(answer); }); });
    return heard;
  }

  const by = (name: string) => screen.getByRole('button', { name });
  // A pointer press as the browser reports it: it begins on the button and its click says detail 1.
  // A click raised by Enter or Space says detail 0.
  // The mouse-down in between moves the focus to the button unless it was told not to.
  const begin = (name: string) => {
    const button = by(name);
    fireEvent.pointerDown(button);
    if (fireEvent.mouseDown(button)) button.focus();
  };
  const end = (name: string, detail = 1) => fireEvent.click(by(name), { detail });
  const pointerPress = (name: string) => { begin(name); end(name); };
  // user-event waits on timers between its steps, so for it the clock moves by itself. Used where
  // the case reads no interval: what a key or a press outside does at the first moment.
  const realUser = (options: Parameters<typeof userEvent.setup>[0] = {}) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    return userEvent.setup({ advanceTimers: vi.advanceTimersByTime, ...options });
  };
  const settle = () => act(() => { vi.advanceTimersByTime(TOAST_SETTLE_MS); });
  const later = () => act(() => { vi.advanceTimersByTime(TOAST_SETTLE_MS * 10); });
  // What a layer does once it has left the page runs one timer tick later.
  const tick = () => act(() => { vi.advanceTimersByTime(0); });
  const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
  const show = (ui: ReactNode) => render(ui, { wrapper: DesignSystemProvider });
  function windowOf(title: string): HTMLElement {
    const found = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]'))
      .find((element) => element.querySelector('h2')?.textContent === title);
    if (!found) throw new Error(`No window titled ${title} is on the page`);
    return found;
  }
  const onPage = (title: string) => Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'))
    .some((element) => element.querySelector('h2')?.textContent === title && !element.hasAttribute('hidden'));

  describe('what stays as it is', () => {
    it('answers from the keyboard at the first moment: Enter on the focused Cancel cancels', async () => {
      const user = realUser();
      const answers: Answer[] = [];
      show(<Approval onAnswer={(answer) => answers.push(answer)} />);
      expect(by('Cancel')).toHaveFocus();
      await user.keyboard('{Enter}');
      expect(answers).toEqual(['cancel']);
    });

    it('answers from the keyboard at the first moment: a key on Run, reached on purpose, allows', () => {
      const answers: Answer[] = [];
      show(<Approval onAnswer={(answer) => answers.push(answer)} />);
      fireEvent.click(by('Run'), { detail: 0 });
      expect(answers).toEqual(['run']);
    });

    it('refuses on Escape at the first moment, once', async () => {
      const user = realUser();
      const answers: Answer[] = [];
      show(<Approval onAnswer={(answer) => answers.push(answer)} />);
      await user.keyboard('{Escape}');
      expect(answers).toEqual(['refuse']);
    });

    it('opens on its cancelling button, and neither opening nor leaving the page answers it', () => {
      const answers: Answer[] = [];
      const view = show(<Approval onAnswer={(answer) => answers.push(answer)} />);
      expect(by('Cancel')).toHaveFocus();
      later();
      view.unmount();
      tick();
      expect(answers).toEqual([]);
    });

    it('does nothing on a press on the area around an approval that ignores it', async () => {
      const user = realUser({ pointerEventsCheck: 0 });
      const answers: Answer[] = [];
      show(<Approval onAnswer={(answer) => answers.push(answer)} />);
      tick();
      await user.click(document.querySelector('.bg-scrim') as HTMLElement);
      expect(answers).toEqual([]);
      expect(onPage('Run this command?')).toBe(true);
    });

    it('refuses the task grant window on a press on the area around it, at the first moment', async () => {
      const user = realUser({ pointerEventsCheck: 0 });
      const answers: Answer[] = [];
      show(<Approval role="dialog" outsidePress="close" title="Set up the browser" onAnswer={(answer) => answers.push(answer)} />);
      // Radix starts to listen for presses outside one timer tick after the window is on the page.
      tick();
      await user.click(document.querySelector('.bg-scrim') as HTMLElement);
      expect(answers).toEqual(['refuse']);
    });

    it('stacks a question over the approval; the answer to the question leaves the approval on the page, unanswered', async () => {
      const answers: Answer[] = [];
      show(<><Approval onAnswer={(answer) => answers.push(answer)} /><Capture onReady={keepConfirm} /></>);
      const removed = askQuestion();
      const titles = Array.from(document.querySelectorAll('[role="alertdialog"]')).map((element) => element.querySelector('h2')?.textContent);
      expect(titles).toEqual(['Run this command?', 'Remove this site?']);
      expect(by('Cancel')).toHaveFocus();

      fireEvent.click(by('Remove'), { detail: 0 });
      await flush();
      tick();
      expect(removed).toEqual([true]);
      expect(answers).toEqual([]);
      expect(windowOf('Run this command?')).toHaveAttribute('data-state', 'open');
    });

    it('takes a pointer press on an ordinary window the moment it is on the page', () => {
      const onSave = vi.fn();
      show(<Dialog open title="Rename task" footer={<Button onClick={onSave}>Save</Button>}><input aria-label="Name" /></Dialog>);
      expect(windowOf('Rename task')).not.toHaveAttribute('data-ds-settling');
      pointerPress('Save');
      expect(onSave).toHaveBeenCalledTimes(1);
    });
  });

  describe('an approval', () => {
    it('takes no pointer press when it has just appeared, keeps the focus on Cancel, and takes one made after the interval', () => {
      const answers: Answer[] = [];
      show(<Approval onAnswer={(answer) => answers.push(answer)} />);
      pointerPress('Run');
      expect(by('Cancel')).toHaveFocus();
      pointerPress('Cancel');
      expect(answers).toEqual([]);
      expect(onPage('Run this command?')).toBe(true);

      settle();
      pointerPress('Run');
      expect(by('Run')).toHaveFocus();
      expect(answers).toEqual(['run']);
    });

    it('takes no press from user-event either, which presses the way a pointer does', async () => {
      // The clock moves by itself here: the first press comes well inside the interval.
      const user = realUser();
      const answers: Answer[] = [];
      show(<Approval onAnswer={(answer) => answers.push(answer)} />);
      await user.click(by('Run'));
      expect(answers).toEqual([]);
      expect(by('Cancel')).toHaveFocus();
      settle();
      await user.click(by('Run'));
      expect(answers).toEqual(['run']);
    });

    it('does not let an early press move the focus onto Run: the browser is told not to move it', () => {
      show(<Approval onAnswer={() => undefined} />);
      begin('Run');
      // A mouse-down that is not default-prevented moves the focus to the button it lands on.
      expect(fireEvent.mouseDown(by('Run'))).toBe(false);
      end('Run');
      expect(by('Cancel')).toHaveFocus();

      settle();
      begin('Run');
      expect(fireEvent.mouseDown(by('Run'))).toBe(true);
    });

    it('starts nothing below it on an early press: no control hears the press begin', () => {
      const onDown = vi.fn();
      show(<Approval onAnswer={() => undefined}><Button onPointerDown={onDown} onMouseDown={onDown}>Choose a folder</Button></Approval>);
      fireEvent.pointerDown(by('Choose a folder'));
      fireEvent.mouseDown(by('Choose a folder'));
      expect(onDown).not.toHaveBeenCalled();
      settle();
      fireEvent.pointerDown(by('Choose a folder'));
      fireEvent.mouseDown(by('Choose a folder'));
      expect(onDown).toHaveBeenCalledTimes(2);
    });

    it('never holds the keyboard: a key press inside the interval answers', () => {
      const answers: Answer[] = [];
      show(<Approval onAnswer={(answer) => answers.push(answer)} />);
      act(() => { vi.advanceTimersByTime(TOAST_SETTLE_MS / 2); });
      fireEvent.click(by('Run'), { detail: 0 });
      expect(answers).toEqual(['run']);
    });

    it('does not take a press that began inside the interval, however late it ends; the next press is the user\'s own', () => {
      const answers: Answer[] = [];
      show(<Approval onAnswer={(answer) => answers.push(answer)} />);
      act(() => { vi.advanceTimersByTime(TOAST_SETTLE_MS - 20); });
      begin('Run');
      act(() => { vi.advanceTimersByTime(70); });
      end('Run');
      expect(answers).toEqual([]);
      pointerPress('Run');
      expect(answers).toEqual(['run']);
    });

    it('marks its box for as long as it holds presses back, and reads one clock for the mark and for the press', () => {
      const answers: Answer[] = [];
      show(<Approval onAnswer={(answer) => answers.push(answer)} />);
      const box = windowOf('Run this command?');
      expect(box).toHaveAttribute('data-ds-settling', '');
      act(() => { vi.advanceTimersByTime(TOAST_SETTLE_MS - 1); });
      expect(box).toHaveAttribute('data-ds-settling', '');
      pointerPress('Run');
      expect(answers).toEqual([]);
      act(() => { vi.advanceTimersByTime(1); });
      expect(box).not.toHaveAttribute('data-ds-settling');
      pointerPress('Run');
      expect(answers).toEqual(['run']);
    });

    it('keeps the mark when its timer runs a few milliseconds early: the mark goes when the clock says so', () => {
      const answers: Answer[] = [];
      show(<Approval onAnswer={(answer) => answers.push(answer)} />);
      const box = windowOf('Run this command?');
      // From here on the clock the layer reads is 3 ms behind its timers.
      const now = performance.now.bind(performance);
      const clock = vi.spyOn(performance, 'now').mockImplementation(() => now() - 3);
      act(() => { vi.advanceTimersByTime(TOAST_SETTLE_MS); });
      expect(box).toHaveAttribute('data-ds-settling', '');
      pointerPress('Run');
      expect(answers).toEqual([]);
      act(() => { vi.advanceTimersByTime(3); });
      expect(box).not.toHaveAttribute('data-ds-settling');
      pointerPress('Run');
      expect(answers).toEqual(['run']);
      clock.mockRestore();
    });

    it('shows nothing as disabled while it holds pointer presses back', () => {
      show(<Approval onAnswer={() => undefined} />);
      for (const name of ['Cancel', 'Run']) {
        expect(by(name)).toBeEnabled();
        expect(by(name)).not.toHaveAttribute('aria-disabled');
      }
    });

    it('becomes pressable after the interval whatever renders in between: the count is not started again', () => {
      const answers: Answer[] = [];
      const onAnswer = (answer: Answer) => { answers.push(answer); };
      const view = show(<Approval onAnswer={onAnswer} />);
      act(() => { vi.advanceTimersByTime(TOAST_SETTLE_MS - 1); });
      for (let i = 0; i < 5; i += 1) view.rerender(<Approval onAnswer={onAnswer} />);
      act(() => { vi.advanceTimersByTime(1); });
      expect(windowOf('Run this command?')).not.toHaveAttribute('data-ds-settling');
      pointerPress('Run');
      expect(answers).toEqual(['run']);
    });

    it('leaves no timer behind when it leaves the page inside the interval', () => {
      const view = show(<Approval onAnswer={() => undefined} />);
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      view.unmount();
      // The focus hand-back of a layer that left runs on a timer of no delay.
      tick();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('leaves no timer behind when it is answered inside the interval', () => {
      function Page() {
        const [shown, setShown] = useState(true);
        return <Approval shown={shown} onAnswer={() => setShown(false)} />;
      }
      show(<Page />);
      fireEvent.click(by('Cancel'), { detail: 0 });
      tick();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('counts the interval again when the meaning of its buttons changes inside one window', () => {
      const answers: Answer[] = [];
      const onAnswer = (answer: Answer) => { answers.push(answer); };
      const view = show(<Approval settleKey={false} onAnswer={onAnswer} />);
      later();
      // The same button now grants for good.
      view.rerender(<Approval settleKey confirmLabel="Confirm" onAnswer={onAnswer} />);
      expect(windowOf('Run this command?')).toHaveAttribute('data-ds-settling', '');
      begin('Confirm');
      end('Confirm', 2);
      expect(answers).toEqual([]);
      settle();
      pointerPress('Confirm');
      expect(answers).toEqual(['run']);
    });

    it('holds the next request of a queue the same way: a double press answers one request', () => {
      const log: string[] = [];
      function Queue() {
        const [ids, setIds] = useState(['first', 'second']);
        const id = ids[0];
        if (!id) return null;
        return <Approval key={id} title={`Run the ${id} command?`} onAnswer={(answer) => { log.push(`${id}:${answer}`); setIds((rest) => rest.slice(1)); }} />;
      }
      show(<Queue />);
      settle();
      pointerPress('Run');
      begin('Run');
      end('Run', 2);
      expect(log).toEqual(['first:run']);
      expect(onPage('Run the second command?')).toBe(true);
      expect(by('Cancel')).toHaveFocus();
      settle();
      pointerPress('Run');
      expect(log).toEqual(['first:run', 'second:run']);
    });

    it('counts the interval from the moment it is shown after waiting behind another approval, not from when it was asked', () => {
      const answers: Answer[] = [];
      const page = (first: boolean) => (
        <>
          <Approval shown={first} title="Allow this folder?" confirmLabel="Allow" onAnswer={() => undefined} />
          <Approval onAnswer={(answer) => answers.push(answer)} />
        </>
      );
      const view = show(page(true));
      expect(onPage('Run this command?')).toBe(false);
      later();
      view.rerender(page(false));
      expect(onPage('Run this command?')).toBe(true);
      pointerPress('Run');
      expect(answers).toEqual([]);
      settle();
      pointerPress('Run');
      expect(answers).toEqual(['run']);
    });

    it('is held when it takes the place of a window that stepped aside with work in flight', () => {
      const answers: Answer[] = [];
      const page = (command: boolean) => (
        <>
          <Dialog open busy title="Install"><input aria-label="Name" /></Dialog>
          <Approval shown={command} onAnswer={(answer) => answers.push(answer)} />
        </>
      );
      const view = show(page(false));
      later();
      view.rerender(page(true));
      expect(windowOf('Install')).toHaveAttribute('hidden');
      pointerPress('Run');
      expect(answers).toEqual([]);
      expect(by('Cancel')).toHaveFocus();
      settle();
      pointerPress('Run');
      expect(answers).toEqual(['run']);
    });
  });

  describe('an approval under another layer', () => {
    it('takes no pointer press between the answer to a question over it and the moment that question has left, nor for the interval after', async () => {
      const answers: Answer[] = [];
      show(<><Approval onAnswer={(answer) => answers.push(answer)} /><Capture onReady={keepConfirm} /></>);
      later();
      const removed = askQuestion();
      // Covered: a press that reaches it anyway is not taken.
      const covered = windowOf('Run this command?').querySelector('button:not([data-approval-cancel])') as HTMLElement;
      fireEvent.pointerDown(covered);
      fireEvent.click(covered, { detail: 1 });
      expect(answers).toEqual([]);
      later();

      pointerPress('Remove');
      await flush();
      expect(removed).toEqual([true]);
      expect(document.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
      // The second press of a double press on 「Remove」: the question is gone from the page, and the
      // timer on which it reports that has not run yet.
      begin('Run');
      end('Run', 2);
      expect(answers).toEqual([]);

      tick();
      expect(windowOf('Run this command?')).toHaveAttribute('data-ds-settling', '');
      pointerPress('Run');
      expect(answers).toEqual([]);
      expect(by('Cancel')).toHaveFocus();
      settle();
      pointerPress('Run');
      expect(answers).toEqual(['run']);
    });

    it('starts the count once, when the last of two questions that followed each other over it has left', async () => {
      const answers: Answer[] = [];
      show(<><Approval onAnswer={(answer) => answers.push(answer)} /><Capture onReady={keepConfirm} /></>);
      later();
      const first = askQuestion('Remove this site?', 'Remove');
      later();
      const second = askQuestion('Block this site?', 'Block');
      await flush();
      tick();
      expect(first).toEqual([false]);
      // The first question has left; the second is still over the approval.
      later();
      const covered = windowOf('Run this command?').querySelector('button:not([data-approval-cancel])') as HTMLElement;
      fireEvent.pointerDown(covered);
      fireEvent.click(covered, { detail: 1 });
      expect(answers).toEqual([]);

      pointerPress('Block');
      await flush();
      tick();
      expect(second).toEqual([true]);
      pointerPress('Run');
      expect(answers).toEqual([]);
      settle();
      pointerPress('Run');
      expect(answers).toEqual(['run']);
    });

    it('lets a window opened inside it take presses at once, and counts its own interval again when that window has gone', () => {
      const answers: Answer[] = [];
      const onDone = vi.fn();
      function Details() {
        const [open, setOpen] = useState(false);
        return (
          <>
            <Button onClick={() => setOpen(true)}>Site details</Button>
            <Dialog open={open} onOpenChange={setOpen} title="Sites" footer={<Button onClick={() => { onDone(); setOpen(false); }}>Done</Button>} />
          </>
        );
      }
      show(<Approval role="dialog" outsidePress="close" onAnswer={(answer) => answers.push(answer)}><Details /></Approval>);
      later();
      pointerPress('Site details');
      expect(onPage('Sites')).toBe(true);
      // The inner window is an ordinary one: it is not held, and the approval's hold is not its hold.
      pointerPress('Done');
      expect(onDone).toHaveBeenCalledTimes(1);
      expect(onPage('Sites')).toBe(false);

      begin('Run');
      end('Run', 2);
      expect(answers).toEqual([]);
      tick();
      pointerPress('Run');
      expect(answers).toEqual([]);
      settle();
      pointerPress('Run');
      expect(answers).toEqual(['run']);
    });

    it('is pressable again after every covering: nothing is left held', async () => {
      const answers: Answer[] = [];
      show(<><Approval onAnswer={(answer) => answers.push(answer)} /><Capture onReady={keepConfirm} /></>);
      for (let round = 0; round < 3; round += 1) {
        later();
        askQuestion();
        later();
        fireEvent.click(by('Cancel'), { detail: 0 });
        await flush();
        tick();
      }
      settle();
      expect(windowOf('Run this command?')).not.toHaveAttribute('data-ds-settling');
      pointerPress('Run');
      expect(answers).toEqual(['run']);
    });
  });

  describe('a question', () => {
    it('takes no pointer press when it has just been asked, and takes one made after the interval', async () => {
      show(<Capture onReady={keepConfirm} />);
      const removed = askQuestion();
      expect(windowOf('Remove this site?')).toHaveAttribute('data-ds-settling', '');
      pointerPress('Remove');
      await flush();
      expect(removed).toEqual([]);
      expect(by('Cancel')).toHaveFocus();

      settle();
      pointerPress('Remove');
      await flush();
      expect(removed).toEqual([true]);
    });

    it('never holds the keyboard', async () => {
      show(<Capture onReady={keepConfirm} />);
      const removed = askQuestion();
      fireEvent.click(by('Remove'), { detail: 0 });
      await flush();
      expect(removed).toEqual([true]);
    });

    it('is held as a window with the role of a question too, and again when it is asked again inside its own fade', () => {
      const stay = keepClosingLayersOnScreen();
      const onQuit = vi.fn();
      const page = (open: boolean) => (
        <Dialog open={open} role="alertdialog" title="Close the window?" footer={<><Button>Minimize</Button><Button variant="primary" onClick={onQuit}>Quit</Button></>} />
      );
      const view = show(page(true));
      pointerPress('Quit');
      expect(onQuit).not.toHaveBeenCalled();
      later();

      view.rerender(page(false));
      const box = windowOf('Close the window?');
      expect(box).toHaveAttribute('data-state', 'closed');
      act(() => { vi.advanceTimersByTime(50); });
      // Asked again while the first asking still fades: the same box is shown again.
      view.rerender(page(true));
      expect(windowOf('Close the window?')).toBe(box);
      expect(box).toHaveAttribute('data-state', 'open');
      pointerPress('Quit');
      expect(onQuit).not.toHaveBeenCalled();
      settle();
      pointerPress('Quit');
      expect(onQuit).toHaveBeenCalledTimes(1);
      stay.mockRestore();
    });

    it('is held again when it returns after it stepped aside for an approval', () => {
      const answers: Answer[] = [];
      const onQuit = vi.fn();
      const page = (command: boolean) => (
        <>
          <Dialog open role="alertdialog" title="Close the window?" footer={<><Button>Minimize</Button><Button variant="primary" onClick={onQuit}>Quit</Button></>} />
          <Approval shown={command} onAnswer={(answer) => answers.push(answer)} />
        </>
      );
      const view = show(page(false));
      later();
      view.rerender(page(true));
      expect(windowOf('Close the window?')).toHaveAttribute('hidden');
      later();
      // The approval is answered by its owner; the question is back at the same spot.
      view.rerender(page(false));
      tick();
      expect(windowOf('Close the window?')).not.toHaveAttribute('hidden');
      begin('Quit');
      end('Quit', 2);
      expect(onQuit).not.toHaveBeenCalled();
      expect(by('Minimize')).toHaveFocus();
      settle();
      pointerPress('Quit');
      expect(onQuit).toHaveBeenCalledTimes(1);
      expect(answers).toEqual([]);
    });
  });

  describe('the question about unsaved input', () => {
    function FormAndApproval({ command, onForm, onAnswer }: { command: boolean; onForm: (open: boolean) => void; onAnswer: (answer: Answer) => void }) {
      const [form, setForm] = useState(true);
      return (
        <>
          <Dialog open={form} onOpenChange={(next) => { onForm(next); setForm(next); }} dirty title="Add a service">
            <input aria-label="Address" defaultValue="https://example.invalid/v1" />
          </Dialog>
          <Approval shown={command} onAnswer={onAnswer} />
        </>
      );
    }

    it('takes no pointer press when an arriving approval has just raised it: nothing is discarded and the approval stays off the page', () => {
      const onForm = vi.fn();
      const answers: Answer[] = [];
      const onAnswer = (answer: Answer) => { answers.push(answer); };
      const view = show(<FormAndApproval command={false} onForm={onForm} onAnswer={onAnswer} />);
      later();
      view.rerender(<FormAndApproval command onForm={onForm} onAnswer={onAnswer} />);
      const question = screen.getByRole('alertdialog', { name: 'Discard these changes?' });
      expect(question).toHaveAttribute('data-ds-settling', '');
      pointerPress('Discard');
      expect(onForm).not.toHaveBeenCalled();
      expect(onPage('Run this command?')).toBe(false);
      expect(by('Keep editing')).toHaveFocus();

      settle();
      expect(question).not.toHaveAttribute('data-ds-settling');
      pointerPress('Discard');
      expect(onForm.mock.calls).toEqual([[false]]);
      expect(onPage('Run this command?')).toBe(true);
      expect(answers).toEqual([]);
    });

    it('allows nothing with the second press of a double press on Discard: the approval that waited behind it is on the page, unanswered', () => {
      const onForm = vi.fn();
      const answers: Answer[] = [];
      const onAnswer = (answer: Answer) => { answers.push(answer); };
      const view = show(<FormAndApproval command={false} onForm={onForm} onAnswer={onAnswer} />);
      view.rerender(<FormAndApproval command onForm={onForm} onAnswer={onAnswer} />);
      expect(onPage('Run this command?')).toBe(false);
      // The question has been on the page for a while.
      later();
      pointerPress('Discard');
      expect(onForm.mock.calls).toEqual([[false]]);
      expect(onPage('Run this command?')).toBe(true);
      // The second press arrives at the same spot: Run is there now.
      begin('Run');
      end('Run', 2);
      expect(answers).toEqual([]);
      expect(onPage('Run this command?')).toBe(true);
      expect(by('Cancel')).toHaveFocus();
      settle();
      pointerPress('Run');
      expect(answers).toEqual(['run']);
    });

    it('is held when the user asks for it too, and a key on Keep editing answers at once', () => {
      const onForm = vi.fn();
      show(<FormAndApproval command={false} onForm={onForm} onAnswer={() => undefined} />);
      later();
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
      expect(screen.getByRole('alertdialog', { name: 'Discard these changes?' })).toHaveAttribute('data-ds-settling', '');
      pointerPress('Discard');
      expect(onForm).not.toHaveBeenCalled();
      expect(by('Keep editing')).toHaveFocus();
      fireEvent.click(by('Keep editing'), { detail: 0 });
      tick();
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(onForm).not.toHaveBeenCalled();
      expect(onPage('Add a service')).toBe(true);
    });

    it('leaves no timer behind when it is answered inside the interval', () => {
      const onForm = vi.fn();
      const view = show(<FormAndApproval command={false} onForm={onForm} onAnswer={() => undefined} />);
      view.rerender(<FormAndApproval command onForm={onForm} onAnswer={() => undefined} />);
      fireEvent.click(by('Keep editing'), { detail: 0 });
      tick();
      view.unmount();
      tick();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  // A window that reads a plan after it has opened: its confirming button is painted by itself,
  // later than the press that opened the window.
  describe('a window whose confirming button appears after a step of its own (settles)', () => {
    function Install({ step, onInstall, onClose = () => undefined }: { step: 'reading' | 'ready'; onInstall: () => void; onClose?: () => void }) {
      return (
        <Dialog
          open
          settles
          settleKey={step}
          title="Install the plugin"
          footer={step === 'ready'
            ? <><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={onInstall}>Install</Button></>
            : <Button onClick={onClose}>Close</Button>}
        />
      );
    }

    it('takes no pointer press when it has just appeared, and one press after the interval answers once', () => {
      const onInstall = vi.fn();
      show(<Install step="ready" onInstall={onInstall} />);
      expect(windowOf('Install the plugin')).toHaveAttribute('data-ds-settling', '');
      pointerPress('Install');
      expect(onInstall).not.toHaveBeenCalled();
      expect(by('Cancel')).toHaveFocus();

      settle();
      expect(windowOf('Install the plugin')).not.toHaveAttribute('data-ds-settling');
      pointerPress('Install');
      expect(onInstall).toHaveBeenCalledTimes(1);
    });

    it('counts again when its step changes: the button painted under the pointer takes no press that began before it could be read', () => {
      const onInstall = vi.fn();
      const view = show(<Install step="reading" onInstall={onInstall} />);
      // The window has been reading for a while.
      later();
      expect(windowOf('Install the plugin')).not.toHaveAttribute('data-ds-settling');
      view.rerender(<Install step="ready" onInstall={onInstall} />);
      expect(windowOf('Install the plugin')).toHaveAttribute('data-ds-settling', '');
      begin('Install');
      end('Install', 2);
      expect(onInstall).not.toHaveBeenCalled();

      act(() => { vi.advanceTimersByTime(TOAST_SETTLE_MS - 1); });
      pointerPress('Install');
      expect(onInstall).not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(1); });
      pointerPress('Install');
      expect(onInstall).toHaveBeenCalledTimes(1);
    });

    it('never holds the keyboard: a key on the confirming button answers at the first moment', () => {
      const onInstall = vi.fn();
      const view = show(<Install step="reading" onInstall={onInstall} />);
      view.rerender(<Install step="ready" onInstall={onInstall} />);
      fireEvent.click(by('Install'), { detail: 0 });
      expect(onInstall).toHaveBeenCalledTimes(1);
    });

    it('is not answered by the repeats of an Enter held since before its step changed', () => {
      const onInstall = vi.fn();
      const view = show(<Install step="reading" onInstall={onInstall} />);
      fireEvent.keyDown(by('Close'), { key: 'Enter', code: 'Enter' });
      view.rerender(<Install step="ready" onInstall={onInstall} />);
      by('Install').focus();
      for (let i = 0; i < 5; i += 1) {
        expect(fireEvent.keyDown(by('Install'), { key: 'Enter', code: 'Enter', repeat: true })).toBe(false);
      }
      expect(onInstall).not.toHaveBeenCalled();
    });

    it('closes on Escape at the first moment', () => {
      const onClose = vi.fn();
      function Page() {
        const [open, setOpen] = useState(true);
        return <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); setOpen(next); }} settles title="Install the plugin" footer={<Button>Install</Button>} />;
      }
      show(<Page />);
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('leaves a window that does not opt in as it is, whatever its settleKey', () => {
      const onSave = vi.fn();
      const page = (step: string) => <Dialog open settleKey={step} title="Rename task" footer={<Button onClick={onSave}>Save</Button>} />;
      const view = show(page('a'));
      view.rerender(page('b'));
      expect(windowOf('Rename task')).not.toHaveAttribute('data-ds-settling');
      pointerPress('Save');
      expect(onSave).toHaveBeenCalledTimes(1);
    });
  });
});

// A key that is held down repeats, and the browser presses the focused button for every Enter
// key-down it is not told to leave alone. A layer that appears while a key is down, or that was
// opened by that key, must not be answered by it.
//
// happy-dom makes no click from a key. `press` and `repeat` below do what Chromium does for a
// button that has the focus: an Enter key-down whose default was not prevented clicks it, and the
// click says detail 0. That Chromium makes no click from a prevented key-down, and none at the
// key-up of a Space whose key-downs on that button were all prevented, is checked in the real shell.
describe('keys held: a key that was down before a layer was shown', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  type Answer = 'cancel' | 'run' | 'refuse';
  const cancelOf = (content: HTMLElement) => content.querySelector<HTMLElement>('[data-approval-cancel]');
  function Approval({ shown = true, settleKey, onAnswer, children }: {
    shown?: boolean;
    settleKey?: unknown;
    onAnswer: (answer: Answer) => void;
    children?: ReactNode;
  }) {
    return (
      <Dialog
        open={shown}
        onOpenChange={(next) => { if (!next) onAnswer('refuse'); }}
        layer="approval"
        role="alertdialog"
        outsidePress="ignore"
        title="Run this command?"
        settleKey={settleKey}
        initialFocus={cancelOf}
        footer={(
          <>
            <Button data-approval-cancel="" onClick={() => onAnswer('cancel')}>Cancel</Button>
            <Button variant="primary" onClick={() => onAnswer('run')}>Run</Button>
          </>
        )}
      >
        {children}
      </Dialog>
    );
  }
  function Capture({ onReady }: { onReady: (confirm: Confirm) => void }) {
    const confirm = useConfirm();
    useEffect(() => { onReady(confirm); }, [confirm, onReady]);
    return null;
  }
  let confirmOf: Confirm | null = null;
  const keepConfirm = (confirm: Confirm) => { confirmOf = confirm; };
  function askQuestion(): boolean[] {
    const heard: boolean[] = [];
    const confirm = confirmOf;
    if (!confirm) throw new Error('Capture did not render');
    act(() => { void confirm({ title: 'Remove this site?', confirmLabel: 'Remove', tone: 'danger' }).then((answer) => { heard.push(answer); }); });
    return heard;
  }

  const by = (name: string) => screen.getByRole('button', { name });
  const focused = () => (document.activeElement instanceof HTMLElement ? document.activeElement : document.body);
  // One key-down on what has the focus. Returns false when its default was prevented.
  const keyDown = (key: string, repeat: boolean, code = key === ' ' ? 'Space' : key) => {
    const target = focused();
    const went = fireEvent.keyDown(target, { key, code, repeat });
    if (went && key === 'Enter' && target instanceof HTMLButtonElement) fireEvent.click(target, { detail: 0 });
    return went;
  };
  const press = (key: string, code?: string) => keyDown(key, false, code);
  const repeat = (key: string, code?: string) => keyDown(key, true, code);
  const release = (key: string, code = key === ' ' ? 'Space' : key) => fireEvent.keyUp(focused(), { key, code });
  const later = () => act(() => { vi.advanceTimersByTime(TOAST_SETTLE_MS * 10); });
  const tick = () => act(() => { vi.advanceTimersByTime(0); });
  const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
  const show = (ui: ReactNode) => render(ui, { wrapper: DesignSystemProvider });
  const onPage = (title: string) => Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]'))
    .some((element) => element.querySelector('h2')?.textContent === title && !element.hasAttribute('hidden'));

  describe('what stays as it is', () => {
    it('answers an approval with the first press of Enter on the focused Cancel, at the first moment', () => {
      const answers: Answer[] = [];
      show(<Approval onAnswer={(answer) => answers.push(answer)} />);
      expect(by('Cancel')).toHaveFocus();
      expect(press('Enter')).toBe(true);
      expect(answers).toEqual(['cancel']);
    });

    it('refuses an approval with one press of Escape right after it appeared, at the first moment', () => {
      const answers: Answer[] = [];
      show(<Approval onAnswer={(answer) => answers.push(answer)} />);
      expect(by('Cancel')).toHaveFocus();
      press('Escape');
      expect(answers).toEqual(['refuse']);
    });

    it('closes a window with one press of Escape, and leaves one only its own buttons may close open', () => {
      const onPlain = vi.fn();
      const onKept = vi.fn();
      const view = show(<Dialog open onOpenChange={onPlain} title="Rename task"><Button>Save</Button></Dialog>);
      press('Escape');
      expect(onPlain.mock.calls).toEqual([[false]]);
      view.unmount();
      show(<Dialog open onOpenChange={onKept} dismissible={false} title="Before you start"><Button>Agree</Button></Dialog>);
      press('Escape');
      release('Escape');
      press('Escape');
      expect(onKept).not.toHaveBeenCalled();
    });

    it('asks about unsaved input with one press of Escape, and takes the question back with the next press', () => {
      const onForm = vi.fn();
      show(<Dialog open onOpenChange={onForm} dirty title="Add a service"><input aria-label="Address" /></Dialog>);
      press('Escape');
      release('Escape');
      expect(screen.getByRole('alertdialog', { name: 'Discard these changes?' })).toBeInTheDocument();
      press('Escape');
      tick();
      expect(screen.queryByRole('alertdialog', { name: 'Discard these changes?' })).toBeNull();
      expect(onForm).not.toHaveBeenCalled();
    });

    it('answers a question with cancel on one press of Escape', async () => {
      show(<Capture onReady={keepConfirm} />);
      const heard = askQuestion();
      press('Escape');
      await flush();
      expect(heard).toEqual([false]);
    });

    it('takes a click that comes with no key and no pointer (assistive technology) while a key is down from before', () => {
      const answers: Answer[] = [];
      const onAnswer = (answer: Answer) => { answers.push(answer); };
      const view = show(<Approval shown={false} onAnswer={onAnswer} />);
      press('Enter');
      view.rerender(<Approval onAnswer={onAnswer} />);
      fireEvent.click(by('Run'), { detail: 0 });
      expect(answers).toEqual(['run']);
    });

    it('lets Backspace, Delete, an arrow, a letter and Tab pressed inside a window repeat', () => {
      const heard: string[] = [];
      show(<Dialog open title="Rename task"><input aria-label="Name" onKeyDown={(event) => heard.push(event.key)} /></Dialog>);
      screen.getByRole('textbox', { name: 'Name' }).focus();
      // The field hears each of them (the window itself turns a Tab round at its last control).
      for (const key of ['Backspace', 'Delete', 'ArrowLeft', 'a', 'Tab']) {
        const code = key === 'a' ? 'KeyA' : key;
        press(key, code);
        repeat(key, code);
        repeat(key, code);
        release(key, code);
      }
      expect(heard).toEqual(['Backspace', 'Delete', 'ArrowLeft', 'a', 'Tab'].flatMap((key) => [key, key, key]));
      // A key the window does not use keeps its default: the field deletes, moves and types.
      expect(press('Backspace')).toBe(true);
      expect(repeat('Backspace')).toBe(true);
      expect(press('a', 'KeyA')).toBe(true);
      expect(repeat('a', 'KeyA')).toBe(true);
    });

    it('lets ArrowDown pressed inside a list opened in a window walk through the list (the list is a portal of its own)', async () => {
      vi.useRealTimers();
      const user = userEvent.setup();
      show(
        <Dialog open title="Settings">
          <Select value="a" onValueChange={() => undefined} label="Language" options={[{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }, { value: 'c', label: 'Gamma' }]} />
        </Dialog>,
      );
      screen.getByRole('combobox', { name: 'Language' }).focus();
      await user.keyboard('{Enter}');
      await waitFor(() => expect(screen.getByRole('option', { name: 'Alpha' })).toHaveFocus());
      press('ArrowDown');
      await waitFor(() => expect(screen.getByRole('option', { name: 'Beta' })).toHaveFocus());
      repeat('ArrowDown');
      await waitFor(() => expect(screen.getByRole('option', { name: 'Gamma' })).toHaveFocus());
    });

    it('closes the question about unsaved input with the first press of Enter on Keep editing', () => {
      const onForm = vi.fn();
      show(<Dialog open onOpenChange={onForm} dirty title="Add a service"><input aria-label="Address" /></Dialog>);
      press('Escape');
      expect(by('Keep editing')).toHaveFocus();
      press('Enter');
      tick();
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(onForm).not.toHaveBeenCalled();
    });

    it('answers a question with the first press of Enter on its Cancel', async () => {
      show(<Capture onReady={keepConfirm} />);
      const heard = askQuestion();
      expect(by('Cancel')).toHaveFocus();
      press('Enter');
      await flush();
      expect(heard).toEqual([false]);
    });
  });

  describe('an approval', () => {
    it('is not answered by an Enter that was down when it arrived; the key answers once it is released and pressed again', () => {
      const answers: Answer[] = [];
      const onAnswer = (answer: Answer) => { answers.push(answer); };
      const view = show(<Approval shown={false} onAnswer={onAnswer} />);
      press('Enter');
      view.rerender(<Approval onAnswer={onAnswer} />);
      expect(by('Cancel')).toHaveFocus();
      for (let i = 0; i < 20; i += 1) expect(repeat('Enter')).toBe(false);
      expect(answers).toEqual([]);
      expect(onPage('Run this command?')).toBe(true);
      expect(by('Cancel')).toHaveFocus();

      release('Enter');
      expect(answers).toEqual([]);
      expect(press('Enter')).toBe(true);
      expect(answers).toEqual(['cancel']);
    });

    it('is not answered by a Space that was down when it arrived', () => {
      const answers: Answer[] = [];
      const onAnswer = (answer: Answer) => { answers.push(answer); };
      const view = show(<Approval shown={false} onAnswer={onAnswer} />);
      press(' ');
      view.rerender(<Approval onAnswer={onAnswer} />);
      for (let i = 0; i < 5; i += 1) expect(repeat(' ')).toBe(false);
      expect(answers).toEqual([]);
    });

    it('drops the repeats of any key that was down when it arrived, before a control inside hears them', () => {
      const heard: string[] = [];
      const page = (shown: boolean) => (
        <Approval shown={shown} onAnswer={() => undefined}>
          <input aria-label="Reason" onKeyDown={(event) => heard.push(event.key)} />
        </Approval>
      );
      const view = show(page(false));
      press('Tab');
      press('ArrowDown');
      press('a', 'KeyA');
      view.rerender(page(true));
      screen.getByRole('textbox', { name: 'Reason' }).focus();
      expect(repeat('Tab')).toBe(false);
      expect(repeat('ArrowDown')).toBe(false);
      expect(repeat('a', 'KeyA')).toBe(false);
      expect(heard).toEqual([]);
      // Released and pressed again: the same keys work, and repeat.
      release('ArrowDown');
      expect(press('ArrowDown')).toBe(true);
      expect(repeat('ArrowDown')).toBe(true);
      expect(heard).toEqual(['ArrowDown', 'ArrowDown']);
    });

    it('takes the key again after a key-up it never heard: the next press is a first press', () => {
      const answers: Answer[] = [];
      const onAnswer = (answer: Answer) => { answers.push(answer); };
      const view = show(<Approval shown={false} onAnswer={onAnswer} />);
      press('Enter');
      view.rerender(<Approval onAnswer={onAnswer} />);
      expect(repeat('Enter')).toBe(false);
      // Released while another application had the focus.
      fireEvent.blur(window);
      expect(press('Enter')).toBe(true);
      expect(answers).toEqual(['cancel']);
    });

    it('is not answered by the repeats of an Enter or a Space whose first press the page never heard: its buttons drop them', () => {
      const answers: Answer[] = [];
      show(<Approval onAnswer={(answer) => answers.push(answer)} />);
      expect(repeat('Enter')).toBe(false);
      expect(repeat(' ')).toBe(false);
      expect(answers).toEqual([]);
    });

    it('is not answered by the key that answered the approval before it', () => {
      const answers: string[] = [];
      const page = (first: boolean, second: boolean) => (
        <>
          <Dialog key="1" open={first} onOpenChange={() => undefined} layer="approval" role="alertdialog" outsidePress="ignore" title="First command" initialFocus={cancelOf}
            footer={<Button data-approval-cancel="" onClick={() => answers.push('first: cancel')}>Cancel</Button>} />
          <Dialog key="2" open={second} onOpenChange={() => undefined} layer="approval" role="alertdialog" outsidePress="ignore" title="Second command" initialFocus={cancelOf}
            footer={<Button data-approval-cancel="" onClick={() => answers.push('second: cancel')}>Cancel</Button>} />
        </>
      );
      const view = show(page(true, true));
      later();
      expect(onPage('First command')).toBe(true);
      press('Enter');
      expect(answers).toEqual(['first: cancel']);
      view.rerender(page(false, true));
      tick();
      later();
      expect(onPage('Second command')).toBe(true);
      expect(by('Cancel')).toHaveFocus();
      for (let i = 0; i < 5; i += 1) expect(repeat('Enter')).toBe(false);
      expect(answers).toEqual(['first: cancel']);
    });

    it('drops, from the moment it is uncovered, the repeats of a key that was pressed while a question was over it', async () => {
      const heard: string[] = [];
      show(
        <>
          <Approval onAnswer={() => undefined}><input aria-label="Reason" onKeyDown={(event) => heard.push(event.key)} /></Approval>
          <Capture onReady={keepConfirm} />
        </>,
      );
      later();
      askQuestion();
      // Pressed on the question, and still down when the question has gone.
      expect(press('ArrowDown')).toBe(true);
      fireEvent.click(by('Remove'), { detail: 0 });
      await flush();
      tick();
      screen.getByRole('textbox', { name: 'Reason' }).focus();
      expect(repeat('ArrowDown')).toBe(false);
      expect(heard).toEqual([]);
    });

    it('drops, from the moment the meaning of its buttons changes, the repeats of a key that was down then', () => {
      const heard: string[] = [];
      const page = (stage: number) => (
        <Approval settleKey={stage} onAnswer={() => undefined}>
          <input aria-label="Reason" onKeyDown={(event) => heard.push(event.key)} />
        </Approval>
      );
      const view = show(page(0));
      later();
      screen.getByRole('textbox', { name: 'Reason' }).focus();
      expect(press('ArrowDown')).toBe(true);
      expect(repeat('ArrowDown')).toBe(true);
      view.rerender(page(1));
      expect(repeat('ArrowDown')).toBe(false);
      expect(heard).toEqual(['ArrowDown', 'ArrowDown']);
    });
  });

  describe('a window', () => {
    it('is not acted on by the Enter that opened it', () => {
      const onSave = vi.fn();
      const heard: string[] = [];
      function Page() {
        const [open, setOpen] = useState(false);
        return (
          <>
            <Button onClick={() => setOpen(true)}>Open</Button>
            <Dialog open={open} onOpenChange={setOpen} title="Rename task">
              <button type="button" onKeyDown={(event) => heard.push(event.key)} onClick={onSave}>Save</button>
            </Dialog>
          </>
        );
      }
      show(<Page />);
      by('Open').focus();
      press('Enter');
      expect(by('Save')).toHaveFocus();
      for (let i = 0; i < 5; i += 1) expect(repeat('Enter')).toBe(false);
      expect(onSave).not.toHaveBeenCalled();
      expect(heard).toEqual([]);
      release('Enter');
      press('Enter');
      expect(onSave).toHaveBeenCalledTimes(1);
    });

    it('drops, when it returns after standing aside for an approval, the repeats of a key that was pressed on the approval', () => {
      const heard: string[] = [];
      const answers: Answer[] = [];
      const onAnswer = (answer: Answer) => { answers.push(answer); };
      const page = (command: boolean) => (
        <>
          <Dialog open busy title="Install"><input aria-label="Name" onKeyDown={(event) => heard.push(event.key)} /></Dialog>
          <Approval shown={command} onAnswer={onAnswer} />
        </>
      );
      const view = show(page(false));
      later();
      screen.getByRole('textbox', { name: 'Name' }).focus();
      view.rerender(page(true));
      later();
      expect(by('Cancel')).toHaveFocus();
      // The press that answers the approval stays down.
      press('Enter');
      expect(answers).toEqual(['cancel']);
      view.rerender(page(false));
      tick();
      later();
      expect(onPage('Install')).toBe(true);
      screen.getByRole('textbox', { name: 'Name' }).focus();
      expect(repeat('Enter')).toBe(false);
      expect(heard).toEqual([]);
    });
  });

  describe('the question about unsaved input', () => {
    const heard: string[] = [];
    beforeEach(() => { heard.length = 0; });
    function Form({ command }: { command: boolean }) {
      return (
        <>
          <Dialog open onOpenChange={() => undefined} dirty title="Add a service">
            <input aria-label="Address" defaultValue="https://example.invalid/v1" onKeyDown={(event) => heard.push(event.key)} />
          </Dialog>
          <Approval shown={command} onAnswer={() => undefined} />
        </>
      );
    }

    it('is not answered by a key that was down when an arriving approval raised it', () => {
      const view = show(<Form command={false} />);
      later();
      screen.getByRole('textbox', { name: 'Address' }).focus();
      press(' ');
      view.rerender(<Form command />);
      expect(by('Keep editing')).toHaveFocus();
      for (let i = 0; i < 5; i += 1) expect(repeat(' ')).toBe(false);
      expect(screen.getByRole('alertdialog', { name: 'Discard these changes?' })).toBeInTheDocument();
      release(' ');
      press('Enter');
      tick();
      expect(screen.queryByRole('alertdialog', { name: 'Discard these changes?' })).toBeNull();
    });

    it('leaves the window alone once it is answered: the Enter that chose Keep editing does nothing in the field the focus returns to', () => {
      show(<Form command={false} />);
      later();
      screen.getByRole('textbox', { name: 'Address' }).focus();
      press('Escape');
      release('Escape');
      expect(by('Keep editing')).toHaveFocus();
      press('Enter');
      tick();
      later();
      screen.getByRole('textbox', { name: 'Address' }).focus();
      expect(repeat('Enter')).toBe(false);
      // The field heard the Escape that asked, and nothing since.
      expect(heard).toEqual(['Escape']);
    });
  });

  // Radix hears Escape on the document and asks the top layer. A held Escape repeats: each repeat
  // would refuse, close or ask again. One press of Escape acts once; its repeats act on nothing.
  describe('a held Escape', () => {
    it('does not refuse an approval that arrives while it is down; released and pressed again, it refuses', () => {
      const answers: Answer[] = [];
      const onAnswer = (answer: Answer) => { answers.push(answer); };
      const view = show(<Approval shown={false} onAnswer={onAnswer} />);
      press('Escape');
      view.rerender(<Approval onAnswer={onAnswer} />);
      expect(by('Cancel')).toHaveFocus();
      for (let i = 0; i < 20; i += 1) repeat('Escape');
      expect(answers).toEqual([]);
      expect(onPage('Run this command?')).toBe(true);
      expect(by('Cancel')).toHaveFocus();

      release('Escape');
      expect(answers).toEqual([]);
      press('Escape');
      expect(answers).toEqual(['refuse']);
    });

    it('refuses with the next press after a key-up the page never heard', () => {
      const answers: Answer[] = [];
      const onAnswer = (answer: Answer) => { answers.push(answer); };
      const view = show(<Approval shown={false} onAnswer={onAnswer} />);
      press('Escape');
      view.rerender(<Approval onAnswer={onAnswer} />);
      repeat('Escape');
      expect(answers).toEqual([]);
      // Released while another application had the focus.
      fireEvent.blur(window);
      press('Escape');
      expect(answers).toEqual(['refuse']);
    });

    it('refuses with the next press even when the window never reported losing the focus', () => {
      const answers: Answer[] = [];
      const onAnswer = (answer: Answer) => { answers.push(answer); };
      const view = show(<Approval shown={false} onAnswer={onAnswer} />);
      press('Escape');
      view.rerender(<Approval onAnswer={onAnswer} />);
      repeat('Escape');
      press('Escape');
      expect(answers).toEqual(['refuse']);
    });

    it('does not refuse an approval with repeats whose first press the page never heard', () => {
      const answers: Answer[] = [];
      show(<Approval onAnswer={(answer) => answers.push(answer)} />);
      for (let i = 0; i < 5; i += 1) repeat('Escape');
      expect(answers).toEqual([]);
    });

    it('does not refuse the approval that follows the one it refused', () => {
      const answers: string[] = [];
      const page = (first: boolean, second: boolean) => (
        <>
          <Dialog key="1" open={first} onOpenChange={(next) => { if (!next) answers.push('first: refuse'); }} layer="approval" role="alertdialog" outsidePress="ignore" title="First command" initialFocus={cancelOf}
            footer={<Button data-approval-cancel="">Cancel</Button>} />
          <Dialog key="2" open={second} onOpenChange={(next) => { if (!next) answers.push('second: refuse'); }} layer="approval" role="alertdialog" outsidePress="ignore" title="Second command" initialFocus={cancelOf}
            footer={<Button data-approval-cancel="">Cancel</Button>} />
        </>
      );
      const view = show(page(true, true));
      later();
      expect(onPage('First command')).toBe(true);
      press('Escape');
      expect(answers).toEqual(['first: refuse']);
      view.rerender(page(false, true));
      // While the first one fades, and once the second one is on the page.
      for (let i = 0; i < 3; i += 1) repeat('Escape');
      tick();
      later();
      expect(onPage('Second command')).toBe(true);
      for (let i = 0; i < 5; i += 1) repeat('Escape');
      expect(answers).toEqual(['first: refuse']);
      release('Escape');
      press('Escape');
      expect(answers).toEqual(['first: refuse', 'second: refuse']);
    });

    it('does not refuse the approval under the question it cancelled', async () => {
      const answers: Answer[] = [];
      show(
        <>
          <Approval onAnswer={(answer) => answers.push(answer)} />
          <Capture onReady={keepConfirm} />
        </>,
      );
      later();
      const heard = askQuestion();
      press('Escape');
      await flush();
      expect(heard).toEqual([false]);
      // While the question fades, and once the approval is uncovered.
      repeat('Escape');
      tick();
      later();
      for (let i = 0; i < 5; i += 1) repeat('Escape');
      expect(answers).toEqual([]);
      release('Escape');
      press('Escape');
      expect(answers).toEqual(['refuse']);
    });

    it('does not close a window that opens while it is down, nor answer a question asked then', async () => {
      const onWindow = vi.fn();
      const page = (open: boolean) => (
        <>
          <Dialog open={open} onOpenChange={onWindow} title="Rename task"><Button>Save</Button></Dialog>
          <Capture onReady={keepConfirm} />
        </>
      );
      const view = show(page(false));
      press('Escape');
      view.rerender(page(true));
      for (let i = 0; i < 5; i += 1) repeat('Escape');
      expect(onWindow).not.toHaveBeenCalled();
      const heard = askQuestion();
      for (let i = 0; i < 5; i += 1) repeat('Escape');
      await flush();
      expect(heard).toEqual([]);
      expect(onWindow).not.toHaveBeenCalled();
      release('Escape');
      press('Escape');
      await flush();
      expect(heard).toEqual([false]);
      expect(onWindow).not.toHaveBeenCalled();
    });

    it('closes one window per press: the window around the one it closed stays', () => {
      const onOuter = vi.fn();
      function Page() {
        const [inner, setInner] = useState(true);
        return (
          <Dialog open onOpenChange={onOuter} title="Connector">
            <Button>Edit</Button>
            <Dialog open={inner} onOpenChange={setInner} title="Edit connector"><Button>Save</Button></Dialog>
          </Dialog>
        );
      }
      show(<Page />);
      later();
      expect(onPage('Edit connector')).toBe(true);
      press('Escape');
      // While the inner window fades, and once it has gone.
      for (let i = 0; i < 3; i += 1) repeat('Escape');
      tick();
      later();
      expect(onPage('Edit connector')).toBe(false);
      for (let i = 0; i < 5; i += 1) repeat('Escape');
      expect(onOuter).not.toHaveBeenCalled();
      release('Escape');
      press('Escape');
      expect(onOuter.mock.calls).toEqual([[false]]);
    });

    it('asks about unsaved input once, and the question stays on the page', () => {
      const onForm = vi.fn();
      show(<Dialog open onOpenChange={onForm} dirty title="Add a service"><input aria-label="Address" /></Dialog>);
      later();
      press('Escape');
      expect(by('Keep editing')).toHaveFocus();
      // Each repeat used to take the question back, and the next one to ask it again.
      for (let i = 0; i < 6; i += 1) {
        repeat('Escape');
        tick();
        expect(screen.getByRole('alertdialog', { name: 'Discard these changes?' })).toBeInTheDocument();
      }
      expect(by('Keep editing')).toHaveFocus();
      expect(onForm).not.toHaveBeenCalled();
    });

    it('does nothing more to a window only its own buttons may close', () => {
      const onKept = vi.fn();
      show(<Dialog open onOpenChange={onKept} dismissible={false} title="Before you start"><Button>Agree</Button></Dialog>);
      press('Escape');
      for (let i = 0; i < 3; i += 1) repeat('Escape');
      expect(onKept).not.toHaveBeenCalled();
    });
  });

  describe('a question', () => {
    it('is not answered by the Enter that asked it', async () => {
      const heard: boolean[] = [];
      function Page() {
        const confirm = useConfirm();
        return <Button onClick={() => { void confirm({ title: 'Remove this site?', confirmLabel: 'Remove', tone: 'danger' }).then((answer) => { heard.push(answer); }); }}>Delete</Button>;
      }
      show(<Page />);
      by('Delete').focus();
      press('Enter');
      await flush();
      expect(by('Cancel')).toHaveFocus();
      for (let i = 0; i < 5; i += 1) expect(repeat('Enter')).toBe(false);
      await flush();
      expect(heard).toEqual([]);
      release('Enter');
      press('Enter');
      await flush();
      expect(heard).toEqual([false]);
    });
  });
});
