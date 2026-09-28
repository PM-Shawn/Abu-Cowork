// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { useEffect } from 'react';
import { act, render as renderTree, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { useConfirm, type Confirm } from './confirm-context';
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

  it('fails fast outside DesignSystemProvider', () => {
    expect(() => render('bare')).toThrow(/DesignSystemProvider/);
  });
});
