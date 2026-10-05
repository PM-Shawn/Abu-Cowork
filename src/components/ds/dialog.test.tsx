// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { useRef, useState, type ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from './button';
import { Combobox } from './combobox';
import { useConfirm } from './confirm-context';
import { ContextMenu } from './context-menu';
import { Dialog, DialogClose } from './dialog';
import { Menu, MenuItem } from './menu';
import { Popover } from './popover';
import { DesignSystemProvider } from './provider';
import { Select } from './select';

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
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Rename task' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
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
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getByRole('dialog', { name: 'Second' })).toBeInTheDocument();
    expect(onSecondChange).not.toHaveBeenCalled();
  });

  it.each([
    ['Keep editing', async (user: ReturnType<typeof userEvent.setup>) => { await user.click(screen.getByRole('button', { name: 'Keep editing' })); }],
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
    expect(onModalChange).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(onModalChange.mock.calls).toEqual([[true]]);
    await user.keyboard('{Escape}');
    expect(onModalChange.mock.calls).toEqual([[true], [false]]);

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(screen.getByRole('alertdialog', { name: 'Delete this file?' })).toBeInTheDocument();
    expect(onModalChange.mock.calls).toEqual([[true], [false], [true]]);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onModalChange.mock.calls).toEqual([[true], [false], [true], [false]]);
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
