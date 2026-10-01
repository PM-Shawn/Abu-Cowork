// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { useEffect, useState } from 'react';
import { act, render as renderTree, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Button } from './button';
import { useConfirm, type Confirm } from './confirm-context';
import { Dialog } from './dialog';
import { DesignSystemProvider } from './provider';

const DELETE = { title: 'Delete this channel?', message: 'Messages already sent stay in the task.', confirmLabel: 'Delete', tone: 'danger' } as const;

let captured: Confirm | null = null;
function Capture({ onReady }: { onReady: (confirm: Confirm) => void }) {
  const confirm = useConfirm();
  useEffect(() => { onReady(confirm); }, [confirm, onReady]);
  return null;
}

function keep(confirm: Confirm) {
  captured = confirm;
}

function render(ui: 'provider' | 'bare') {
  captured = null;
  return renderTree(<Capture onReady={keep} />, ui === 'provider' ? { wrapper: DesignSystemProvider } : undefined);
}

function EditChannelDialog() {
  const confirm = useConfirm();
  const [name, setName] = useState('');
  const [answer, setAnswer] = useState('none');
  return (
    <>
      <Dialog trigger={<Button>Edit channel</Button>} title="Edit channel" dirty={name !== ''}>
        <input aria-label="Name" value={name} onChange={(event) => setName(event.target.value)} />
        <Button onClick={() => { void confirm(DELETE).then((confirmed) => setAnswer(String(confirmed))); }}>Delete channel</Button>
      </Dialog>
      <output>{`answer ${answer}`}</output>
    </>
  );
}

function ask(): Promise<boolean> {
  if (!captured) throw new Error('Capture did not render');
  let result!: Promise<boolean>;
  act(() => { result = captured!(DELETE); });
  return result;
}

describe('useConfirm', () => {
  it('shows an alert dialog with Cancel first and the specific action second', () => {
    render('provider');
    void ask();
    const dialog = screen.getByRole('alertdialog', { name: 'Delete this channel?' });
    expect(dialog).toHaveTextContent('Messages already sent stay in the task.');
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Cancel', 'Delete']);
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveClass('text-danger');
  });

  it('resolves true on the action', async () => {
    const user = userEvent.setup();
    render('provider');
    const answer = ask();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await expect(answer).resolves.toBe(true);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('resolves false on Cancel and on Escape', async () => {
    const user = userEvent.setup();
    render('provider');
    const cancelled = ask();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await expect(cancelled).resolves.toBe(false);
    const escaped = ask();
    await user.keyboard('{Escape}');
    await expect(escaped).resolves.toBe(false);
  });

  it('answers an earlier request with false when a new one replaces it', async () => {
    render('provider');
    const first = ask();
    void ask();
    await expect(first).resolves.toBe(false);
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
  });

  it('shows over an open dialog with unsaved input and returns to it after the answer', async () => {
    const user = userEvent.setup();
    renderTree(<EditChannelDialog />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'Edit channel' }));
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'draft');
    await user.click(screen.getByRole('button', { name: 'Delete channel' }));
    expect(screen.getByRole('alertdialog', { name: 'Delete this channel?' })).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog', { name: 'Discard these changes?' })).toBeNull();
    // Radix hides the dialog underneath from screen readers while the alert is up.
    expect(screen.getByRole('dialog', { hidden: true })).toHaveAttribute('data-state', 'open');
    expect(screen.getByText('answer none')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('answer true')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Edit channel' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('draft');
  });

  it('answers a pending request with false when a dialog opens without a click', async () => {
    captured = null;
    const tree = (open: boolean) => (
      <>
        <Capture onReady={keep} />
        <Dialog open={open} onOpenChange={() => undefined} title="Shortcut dialog" />
      </>
    );
    const { rerender } = renderTree(tree(false), { wrapper: DesignSystemProvider });
    const answer = ask();
    let settled: boolean | 'pending' = 'pending';
    void answer.then((confirmed) => { settled = confirmed; });
    expect(screen.getByRole('alertdialog', { name: 'Delete this channel?' })).toBeInTheDocument();
    rerender(tree(true));
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Shortcut dialog' })).toBeInTheDocument();
  });

  it('answers a pending request with false when the provider goes away', async () => {
    const { unmount } = render('provider');
    const answer = ask();
    let settled: boolean | 'pending' = 'pending';
    void answer.then((confirmed) => { settled = confirmed; });
    unmount();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it('fails fast outside DesignSystemProvider', () => {
    expect(() => render('bare')).toThrow(/DesignSystemProvider/);
  });
});
