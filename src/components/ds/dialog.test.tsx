// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Button } from './button';
import { useConfirm } from './confirm-context';
import { Dialog, DialogClose } from './dialog';
import { DesignSystemProvider } from './provider';

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
    const user = userEvent.setup();
    render(<TwoDialogs />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'Open first' }));
    await user.click(screen.getByRole('button', { name: 'Open second' }));
    const second = screen.getByRole('dialog', { name: 'Second' });
    await new Promise((resolve) => { setTimeout(resolve, 20); });
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

  it('marks its content as an open layer and dims the window behind it', async () => {
    const user = userEvent.setup();
    render(<RenameDialog />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    expect(screen.getByRole('dialog')).toHaveAttribute('data-ds-layer');
    expect(document.querySelector('.bg-scrim')).not.toBeNull();
  });
});
