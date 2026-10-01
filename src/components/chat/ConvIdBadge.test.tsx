// @vitest-environment happy-dom
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import ConvIdBadge from './ConvIdBadge';

describe('ConvIdBadge', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the copied words next to the number for a moment after copying', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    // userEvent installs its own clipboard; replace it after setup
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
    render(<ConvIdBadge conversationId="abcdef123456" />, { wrapper: DesignSystemProvider });
    expect(screen.queryByText('Conversation ID copied')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Click to copy conversation ID (attach when reporting bugs)' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('abcdef123456');
    const words = screen.getAllByText('Conversation ID copied').filter((el) => !el.closest('[role="tooltip"]'));
    expect(words).toHaveLength(1);
    expect(words[0]).toHaveClass('text-caption');
    await act(async () => { vi.advanceTimersByTime(1500); });
    expect(screen.queryAllByText('Conversation ID copied').filter((el) => !el.closest('[role="tooltip"]'))).toHaveLength(0);
  });
});
