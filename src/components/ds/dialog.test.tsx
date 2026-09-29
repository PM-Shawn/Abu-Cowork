// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Button } from './button';
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
