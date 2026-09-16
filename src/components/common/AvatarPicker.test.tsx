// @vitest-environment happy-dom
import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AvatarPicker from './AvatarPicker';
import DialogShell from '@/components/team/DialogShell';
import { AVATAR_ICONS, AVATAR_TINTS, buildAvatarValue } from '@/core/team/avatarPresets';
import { getI18n } from '@/i18n';

function ControlledPicker({ initial = '', onChange }: { initial?: string; onChange: (value: string) => void }) {
  const [value, setValue] = useState(initial);
  return <AvatarPicker value={value} onChange={(next) => { setValue(next); onChange(next); }} />;
}

describe('AvatarPicker', () => {
  it('opens a compact picker with each icon and color only once', () => {
    render(<AvatarPicker value={undefined} onChange={vi.fn()} />);
    expect(screen.queryByTestId('avatar-picker')).toBeNull();
    fireEvent.click(screen.getByTestId('avatar-picker-trigger'));
    expect(screen.getAllByTestId(/^avatar-icon-/)).toHaveLength(AVATAR_ICONS.length);
    expect(screen.getAllByTestId(/^avatar-tint-/)).toHaveLength(AVATAR_TINTS.length);
  });

  it('allows color before icon without submitting the form or writing an incomplete choice', () => {
    const onChange = vi.fn();
    const onSubmit = vi.fn((event) => event.preventDefault());
    render(<form onSubmit={onSubmit}><AvatarPicker onChange={onChange} /></form>);
    fireEvent.click(screen.getByTestId('avatar-picker-trigger'));
    fireEvent.click(screen.getByTestId('avatar-tint-purple'));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('avatar-icon-code'));
    expect(onChange).toHaveBeenCalledWith(buildAvatarValue('code', 'purple'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('keeps the selected icon when changing color and keeps the color when changing icon', () => {
    const onChange = vi.fn();
    render(<ControlledPicker onChange={onChange} />);
    fireEvent.click(screen.getByTestId('avatar-picker-trigger'));
    fireEvent.click(screen.getByTestId('avatar-icon-code'));
    expect(onChange).toHaveBeenLastCalledWith('icon:code/blue');
    fireEvent.click(screen.getByTestId('avatar-tint-purple'));
    expect(onChange).toHaveBeenLastCalledWith('icon:code/purple');
    expect(screen.getByTestId('avatar-icon-code')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByTestId('avatar-icon-shield'));
    expect(onChange).toHaveBeenLastCalledWith('icon:shield/purple');
    expect(screen.getByTestId('avatar-icon-code')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('avatar-icon-shield')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('avatar-tint-purple')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('avatar-picker-trigger').getAttribute('aria-label')).toContain(getI18n().avatarPicker.icons.shield);
    expect(screen.getByTestId('avatar-picker-trigger').getAttribute('aria-label')).toContain(getI18n().avatarPicker.tints.purple);
  });

  it('preserves a legacy emoji on open and can reset a chosen preset to the default', () => {
    const onChange = vi.fn();
    render(<ControlledPicker initial="📊" onChange={onChange} />);
    const trigger = screen.getByTestId('avatar-picker-trigger');
    fireEvent.click(trigger);
    fireEvent.click(screen.getByTestId('avatar-tint-purple'));
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger).toHaveTextContent('📊');
    fireEvent.click(screen.getByTestId('avatar-icon-code'));
    expect(trigger).not.toHaveTextContent('📊');
    fireEvent.click(screen.getByRole('button', { name: getI18n().avatarPicker.defaultAvatar }));
    expect(onChange).toHaveBeenLastCalledWith('');
    expect(trigger.querySelector('[data-avatar-kind="default"]')).not.toBeNull();
  });

  it('closes only the picker on Escape, returns focus, and leaves the parent dialog open', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<DialogShell open onClose={onClose} title="Edit team"><AvatarPicker onChange={vi.fn()} /></DialogShell>);
    const trigger = screen.getByTestId('avatar-picker-trigger');
    await user.click(trigger);
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('avatar-picker')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(trigger).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });
});
