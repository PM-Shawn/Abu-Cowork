// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { createRef, useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Checkbox } from './checkbox';
import { HiddenFileInput } from './file-input';
import { RadioGroup } from './radio-group';
import { SegmentedControl } from './segmented-control';
import { SettingGroup, SettingRow } from './setting-row';
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

  it('Switch without a visible label takes its name from aria-label', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Switch aria-label="Turn off Computer Use" checked onCheckedChange={onCheckedChange} />);
    const control = screen.getByRole('switch', { name: 'Turn off Computer Use' });
    await user.click(control);
    expect(onCheckedChange).toHaveBeenCalledWith(false);
  });

  it('SettingGroup puts its rows in one bordered box under a heading', () => {
    render(
      <SettingGroup title="Notifications" description="When Abu tells you about a task.">
        <SettingRow title="Sound"><Switch aria-label="Sound" checked onCheckedChange={() => undefined} /></SettingRow>
        <SettingRow title="Badge"><Switch aria-label="Badge" checked onCheckedChange={() => undefined} /></SettingRow>
        <SettingRow title="Banner"><Switch aria-label="Banner" checked onCheckedChange={() => undefined} /></SettingRow>
      </SettingGroup>,
    );
    expect(screen.getByRole('heading', { level: 4, name: 'Notifications' })).toBeInTheDocument();
    expect(screen.getByText('When Abu tells you about a task.')).toBeInTheDocument();
    const box = screen.getByRole('switch', { name: 'Sound' }).closest('.divide-y');
    expect(box).not.toBeNull();
    expect(box).toContainElement(screen.getByRole('switch', { name: 'Badge' }));
    expect(box).toContainElement(screen.getByRole('switch', { name: 'Banner' }));
    expect(box?.children).toHaveLength(3);
    expect(box).toHaveClass('rounded-panel');
    expect(box).toHaveClass('border');
    expect(box).toHaveClass('mt-2');
    expect(box).not.toContainElement(screen.getByRole('heading', { level: 4 }));
  });

  it('SettingGroup without a heading is only the box', () => {
    const { container } = render(
      <SettingGroup>
        <SettingRow title="Sound"><Switch aria-label="Sound" checked onCheckedChange={() => undefined} /></SettingRow>
      </SettingGroup>,
    );
    expect(screen.queryByRole('heading')).toBeNull();
    const box = container.querySelector('.divide-y');
    expect(box).not.toBeNull();
    expect(box).not.toHaveClass('mt-2');
  });

  it('SettingRow centers its control on the row, with or without a description', () => {
    render(
      <>
        <SettingRow title="Sound"><Switch aria-label="Sound" checked onCheckedChange={() => undefined} /></SettingRow>
        <SettingRow title="Badge" description="A dot on the app icon."><Switch aria-label="Badge" checked onCheckedChange={() => undefined} /></SettingRow>
      </>,
    );
    const single = screen.getByText('Sound').parentElement?.parentElement;
    expect(single).toHaveClass('items-center');
    expect(single).not.toHaveClass('items-start');
    const described = screen.getByText('Badge').parentElement?.parentElement;
    expect(described).toHaveClass('items-center');
    expect(described).not.toHaveClass('items-start');
    // The control's box is a flex box: as a plain block it would add a text line's spare
    // height under an inline control (a switch) and push it above the row's center.
    expect(described?.lastElementChild).toHaveClass('flex');
    expect(described?.lastElementChild).toHaveClass('items-center');
  });

  it('SettingRow labels its control', () => {
    render(<SettingRow title="Follow system appearance" description="Changes with your computer." htmlFor="follow"><Switch id="follow" checked={false} onCheckedChange={() => undefined} /></SettingRow>);
    expect(screen.getByRole('switch', { name: 'Follow system appearance' })).toBeInTheDocument();
    expect(screen.getByText('Changes with your computer.')).toBeInTheDocument();
  });

  it('HiddenFileInput is a file input that is never shown or tabbed to, and hands on what it is given', () => {
    const onChange = vi.fn();
    const ref = createRef<HTMLInputElement>();
    const { container } = render(<HiddenFileInput ref={ref} accept="image/*" multiple onChange={onChange} />);
    const input = container.querySelector('input');
    if (!input) throw new Error('No input');

    expect(input).toHaveAttribute('type', 'file');
    expect(input).toHaveClass('hidden');
    expect(input.tabIndex).toBe(-1);
    expect(input).toHaveAttribute('accept', 'image/*');
    expect(input.multiple).toBe(true);
    expect(ref.current).toBe(input);

    fireEvent.change(input, { target: { files: [new File(['made-up'], 'made-up.png', { type: 'image/png' })] } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
