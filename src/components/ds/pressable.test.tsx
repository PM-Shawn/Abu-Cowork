// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Pressable } from './pressable';

describe('Pressable', () => {
  it('is a real button that the keyboard can press', async () => {
    const onClick = vi.fn();
    render(<Pressable aria-label="Open image" onClick={onClick} />);
    const button = screen.getByRole('button', { name: 'Open image' });
    expect(button).toHaveAttribute('type', 'button');
    button.focus();
    await userEvent.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('adds only the focus ring and the disabled look to the caller classes', () => {
    render(<Pressable aria-label="Tick" className="h-1 w-2 bg-label-tertiary" />);
    const button = screen.getByRole('button', { name: 'Tick' });
    expect(button).toHaveClass('h-1', 'w-2', 'bg-label-tertiary', 'focus-visible:ring-focus', 'disabled:opacity-40');
  });
});
