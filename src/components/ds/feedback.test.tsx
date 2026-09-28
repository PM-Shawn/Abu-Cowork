// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Toast } from '@/stores/toastStore';
import { Button } from './button';
import { EmptyState } from './empty-state';
import { AppIcons } from './icons';
import { InlineMessage } from './inline-message';
import { LoadError } from './load-error';
import { DesignSystemProvider } from './provider';
import { MAX_VISIBLE_TOASTS, Toaster } from './toaster';

const toast = (n: number, extra: Partial<Toast> = {}): Toast => ({ id: `t${n}`, type: 'success', title: `Saved ${n}`, ...extra });

// Radix also copies each toast into a hidden live region for screen readers, so look
// for titles inside the visible notification area only.
const shown = () => within(screen.getByRole('region'));

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

  it('Toaster runs an action such as Undo and then dismisses the notification', async () => {
    const user = userEvent.setup();
    const onUndo = vi.fn();
    const onDismissed = vi.fn();
    render(
      <ToasterHarness initial={[toast(1, { type: 'info', title: 'Task deleted', actions: [{ label: 'Undo', onClick: onUndo }] })]} onDismissed={onDismissed} />,
      { wrapper: DesignSystemProvider },
    );
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onUndo).toHaveBeenCalledOnce();
    expect(onDismissed).toHaveBeenCalledWith('t1');
    expect(shown().queryByText('Task deleted')).toBeNull();
  });

  it('Toaster closes a notification from its close button', async () => {
    const user = userEvent.setup();
    const onDismissed = vi.fn();
    render(<ToasterHarness initial={[toast(1, { type: 'error', title: 'Upload failed' })]} onDismissed={onDismissed} />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onDismissed).toHaveBeenCalledWith('t1');
  });
});
