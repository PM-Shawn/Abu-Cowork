// @vitest-environment happy-dom
import { useState, type ReactElement } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render as renderBare, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AvatarPicker from './AvatarPicker';
import DialogShell from '@/components/team/DialogShell';
import { Dialog } from '@/components/ds/dialog';
import { DesignSystemProvider } from '@/components/ds/provider';
import { AVATAR_ICONS, AVATAR_TINTS, buildAvatarValue } from '@/core/team/avatarPresets';
import { getI18n } from '@/i18n';

// The picker is a design-system popover, so it renders inside the provider like the app does.
const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });

const classes = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/);

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

  it('changes nothing on an arrow key; Enter chooses the focused color', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ControlledPicker initial="icon:code/blue" onChange={onChange} />);
    await user.click(screen.getByTestId('avatar-picker-trigger'));
    screen.getByTestId('avatar-tint-purple').focus();
    await user.keyboard('{ArrowRight}{ArrowLeft}{ArrowDown}{ArrowUp}');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('avatar-tint-blue')).toHaveAttribute('aria-pressed', 'true');
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith('icon:code/purple');
    expect(screen.getByTestId('avatar-tint-purple')).toHaveAttribute('aria-pressed', 'true');
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
    // Focus is back on the trigger, so its name shows; that tooltip is the next layer Escape closes.
    expect(await screen.findByRole('tooltip')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('opens inside that shell on its own overlay, so it is not painted under it', async () => {
    const user = userEvent.setup();
    render(<DialogShell open onClose={vi.fn()} title="Edit team"><AvatarPicker onChange={vi.fn()} /></DialogShell>);
    await user.click(screen.getByTestId('avatar-picker-trigger'));
    const overlay = screen.getByRole('heading', { name: 'Edit team' }).closest('[data-electron-no-drag]')!;
    expect(overlay.contains(screen.getByTestId('avatar-picker'))).toBe(true);
  });

  it('inside a design-system dialog: sits on the dialog level, and Escape closes the picker alone', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<Dialog open onOpenChange={onOpenChange} title="Edit expert"><AvatarPicker onChange={vi.fn()} /></Dialog>);
    const trigger = screen.getByTestId('avatar-picker-trigger');
    await user.click(trigger);
    const layer = screen.getByTestId('avatar-picker').closest('[data-ds-layer]')!;
    expect(classes(layer)).toContain('z-dialog');
    expect(classes(layer)).not.toContain('z-popover');
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('avatar-picker')).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Edit expert' })).toBeInTheDocument();
    expect(trigger).toHaveFocus();
    // One press, one layer: the trigger's tooltip (shown again with the focus), then the dialog.
    expect(await screen.findByRole('tooltip')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('on a page: sits on the popover level and carries its name and test id on the scrolling box', async () => {
    const user = userEvent.setup();
    render(<AvatarPicker onChange={vi.fn()} />);
    await user.click(screen.getByTestId('avatar-picker-trigger'));
    const picker = screen.getByTestId('avatar-picker');
    expect(classes(picker.closest('[data-ds-layer]')!)).toContain('z-popover');
    expect(picker).toHaveAttribute('aria-label', getI18n().avatarPicker.chooseAvatar);
    expect(classes(picker)).toContain('overflow-y-auto');
    expect(screen.getByRole('group', { name: getI18n().avatarPicker.color })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: getI18n().avatarPicker.icon })).toBeInTheDocument();
  });

  it('names every cell and marks the chosen cells with a fill and a check mark, never with the focus ring', async () => {
    const user = userEvent.setup();
    render(<AvatarPicker value="icon:code/purple" onChange={vi.fn()} />);
    const trigger = screen.getByTestId('avatar-picker-trigger');
    expect(trigger.tagName).toBe('BUTTON');
    await user.click(trigger);
    const chosenTint = screen.getByTestId('avatar-tint-purple');
    const otherTint = screen.getByTestId('avatar-tint-blue');
    expect(chosenTint).toHaveAttribute('aria-label', getI18n().avatarPicker.tints.purple);
    expect(chosenTint).toHaveAttribute('title', getI18n().avatarPicker.tints.purple);
    expect(classes(chosenTint)).toContain('bg-fill-selected');
    expect(classes(chosenTint)).not.toContain('ring-focus');
    expect(classes(chosenTint)).not.toContain('ring-2');
    // The chosen color also shows the check mark; the others do not.
    expect(chosenTint.querySelector('svg')).not.toBeNull();
    expect(otherTint.querySelector('svg')).toBeNull();
    expect(classes(otherTint)).not.toContain('bg-fill-selected');
    const chosenIcon = screen.getByTestId('avatar-icon-code');
    const otherIcon = screen.getByTestId('avatar-icon-shield');
    expect(chosenIcon).toHaveAttribute('title', chosenIcon.getAttribute('aria-label')!);
    expect(classes(chosenIcon)).toContain('bg-fill-selected');
    expect(classes(chosenIcon)).not.toContain('ring-focus');
    expect(classes(chosenIcon)).not.toContain('ring-2');
    // The chosen icon carries a check mark of its own, so the grey fill is not its only sign.
    expect(chosenIcon.querySelector('[data-avatar-chosen]')).not.toBeNull();
    expect(otherIcon.querySelector('[data-avatar-chosen]')).toBeNull();
    expect(classes(otherIcon)).not.toContain('bg-fill-selected');
    expect(screen.getByRole('button', { name: getI18n().avatarPicker.defaultAvatar })).toHaveAttribute('aria-pressed', 'false');
  });

  it('opened by keyboard with nothing chosen: the ring is the keyboard focus alone', async () => {
    const user = userEvent.setup();
    render(<AvatarPicker onChange={vi.fn()} />);
    await user.tab();
    expect(screen.getByTestId('avatar-picker-trigger')).toHaveFocus();
    await user.keyboard('{Enter}');
    const focused = document.activeElement as HTMLElement;
    expect(screen.getByTestId('avatar-picker').contains(focused)).toBe(true);
    // The cell the picker opens on is the pending color, so it is focused and pressed at once.
    expect(focused).toBe(screen.getByTestId('avatar-tint-blue'));
    expect(focused).toHaveAttribute('aria-pressed', 'true');
    expect(classes(focused)).toContain('focus-visible:ring-2');
    expect(classes(focused)).toContain('focus-visible:ring-focus');
    expect(classes(focused)).toContain('focus-visible:ring-inset');
    // Without focus the same cell has no ring: its ring classes all sit behind focus-visible.
    expect(classes(focused)).not.toContain('ring-2');
    expect(classes(focused)).not.toContain('ring-focus');
    expect(classes(focused)).not.toContain('ring-inset');
  });

  it('shows the name of the trigger on keyboard focus and carries no native title', async () => {
    const user = userEvent.setup();
    render(<AvatarPicker value="icon:code/purple" onChange={vi.fn()} />);
    const trigger = screen.getByTestId('avatar-picker-trigger');
    expect(trigger).not.toHaveAttribute('title');
    expect(screen.queryByRole('tooltip')).toBeNull();
    await user.tab();
    expect(trigger).toHaveFocus();
    expect(await screen.findByRole('tooltip')).toHaveTextContent(getI18n().avatarPicker.chooseAvatar);
    // The same button still opens the picker and says so.
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('avatar-picker')).toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger.getAttribute('aria-label')).toContain(getI18n().avatarPicker.icons.code);
  });
});
