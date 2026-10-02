// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { useRef, useState, type ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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

function TwoDialogs({ firstDirty = false }: { firstDirty?: boolean }) {
  const [first, setFirst] = useState(false);
  const [second, setSecond] = useState(false);
  return (
    <>
      <Button onClick={() => setFirst(true)}>Open first</Button>
      <Dialog open={first} onOpenChange={setFirst} title="First" dirty={firstDirty}>
        <Button onClick={() => setSecond(true)}>Open second</Button>
      </Dialog>
      <Dialog open={second} onOpenChange={setSecond} title="Second" />
    </>
  );
}

describe('Dialog', () => {
  afterEach(() => { vi.useRealTimers(); });

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
