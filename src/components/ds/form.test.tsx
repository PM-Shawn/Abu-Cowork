// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Checkbox } from './checkbox';
import { RadioGroup } from './radio-group';
import { SegmentedControl } from './segmented-control';
import { SettingRow } from './setting-row';
import { Slider } from './slider';
import { Switch } from './switch';
import { TextArea } from './text-area';
import { TextField } from './text-field';

describe('form controls', () => {
  it('TextField types text and reports an invalid value', async () => {
    const user = userEvent.setup();
    render(<><TextField aria-label="Name" /><TextField aria-label="Key" invalid /></>);
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Abu');
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Abu');
    expect(screen.getByRole('textbox', { name: 'Key' })).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('textbox', { name: 'Name' })).not.toHaveAttribute('aria-invalid');
  });

  it('TextArea is a multi-line field with three rows by default', () => {
    render(<TextArea aria-label="Notes" />);
    expect(screen.getByRole('textbox', { name: 'Notes' })).toHaveAttribute('rows', '3');
  });

  it('Checkbox toggles from its label and shows the mixed state', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<><Checkbox label="Attachments" checked={false} onCheckedChange={onCheckedChange} /><Checkbox label="Some" checked="indeterminate" onCheckedChange={() => undefined} /></>);
    await user.click(screen.getByText('Attachments'));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    expect(screen.getByRole('checkbox', { name: 'Some' })).toHaveAttribute('aria-checked', 'mixed');
  });

  it('Switch toggles with the keyboard', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [on, setOn] = useState(false);
      return <Switch label="Notify when done" checked={on} onCheckedChange={setOn} />;
    }
    render(<Harness />);
    const control = screen.getByRole('switch', { name: 'Notify when done' });
    control.focus();
    await user.keyboard(' ');
    expect(control).toHaveAttribute('aria-checked', 'true');
  });

  it('RadioGroup moves the choice with arrow keys', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [value, setValue] = useState('a');
      return <RadioGroup label="Density" value={value} onValueChange={setValue} options={[{ value: 'a', label: 'Comfortable' }, { value: 'b', label: 'Compact' }]} />;
    }
    render(<Harness />);
    screen.getByRole('radio', { name: 'Comfortable' }).focus();
    // Radix moves focus on a timer and checks the option only while the arrow key is still down.
    await user.keyboard('{ArrowDown>}');
    await waitFor(() => expect(screen.getByRole('radio', { name: 'Compact' })).toBeChecked());
    await user.keyboard('{/ArrowDown}');
    expect(screen.getByRole('radio', { name: 'Compact' })).toHaveFocus();
  });

  it('Slider steps with arrow keys', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<Slider label="Volume" value={40} onValueChange={onValueChange} />);
    screen.getByRole('slider', { name: 'Volume' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(onValueChange).toHaveBeenCalledWith(41);
  });

  it('SegmentedControl is a radio group that never ends up empty', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<SegmentedControl label="Appearance" value="system" onValueChange={onValueChange} options={[{ value: 'system', label: 'System' }, { value: 'dark', label: 'Dark' }]} />);
    expect(screen.getByRole('group', { name: 'Appearance' })).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'System' }));
    expect(onValueChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(onValueChange).toHaveBeenCalledWith('dark');
  });

  it('SettingRow labels its control', () => {
    render(<SettingRow title="Follow system appearance" description="Changes with your computer." htmlFor="follow"><Switch id="follow" checked={false} onCheckedChange={() => undefined} /></SettingRow>);
    expect(screen.getByRole('switch', { name: 'Follow system appearance' })).toBeInTheDocument();
    expect(screen.getByText('Changes with your computer.')).toBeInTheDocument();
  });
});
