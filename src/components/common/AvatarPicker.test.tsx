// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AvatarPicker from './AvatarPicker';
import { buildAvatarValue } from '@/core/team/avatarPresets';

describe('AvatarPicker', () => {
  it('returns the selected icon and tint without submitting the form', () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn((event) => event.preventDefault());
    render(<form onSubmit={onSubmit}><AvatarPicker value={undefined} onChange={onChange} /></form>);
    fireEvent.click(screen.getByTestId('avatar-option-code-purple'));
    expect(onChange).toHaveBeenCalledWith(buildAvatarValue('code', 'purple'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('marks the controlled selection with aria-pressed', () => {
    const { rerender } = render(<AvatarPicker value={buildAvatarValue('code', 'purple')} onChange={() => {}} />);
    expect(screen.getByTestId('avatar-option-code-purple')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('avatar-option-code-blue')).toHaveAttribute('aria-pressed', 'false');
    rerender(<AvatarPicker value={buildAvatarValue('code', 'blue')} onChange={() => {}} />);
    expect(screen.getByTestId('avatar-option-code-purple')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('avatar-option-code-blue')).toHaveAttribute('aria-pressed', 'true');
  });

  it('does not rewrite a legacy emoji until the user chooses an avatar', () => {
    const onChange = vi.fn();
    render(<AvatarPicker value="📊" onChange={onChange} />);
    expect(onChange).not.toHaveBeenCalled();
    const reset = screen.getAllByRole('button').at(-1)!;
    fireEvent.click(reset);
    expect(onChange).toHaveBeenCalledWith('');
  });
});
