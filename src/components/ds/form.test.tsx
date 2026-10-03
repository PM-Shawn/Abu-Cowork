// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { createRef, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from './button';
import { Checkbox } from './checkbox';
import { Combobox, MultiCombobox, type ComboboxOption } from './combobox';
import { Dialog } from './dialog';
import { HiddenFileInput } from './file-input';
import { AppIcons } from './icons';
import { Popover } from './popover';
import { DesignSystemProvider } from './provider';
import { RadioGroup } from './radio-group';
import { SegmentedControl } from './segmented-control';
import { SettingGroup, SettingRow } from './setting-row';
import { Slider } from './slider';
import { Switch } from './switch';
import { TextArea } from './text-area';
import { TextField } from './text-field';

// Every icon the components under test render, in order: the check of a combobox row is
// the probe that tells which rows rendered.
const iconRenders = vi.hoisted(() => ({ icons: [] as unknown[] }));
vi.mock('./icon', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./icon')>();
  return {
    ...actual,
    Icon: (props: Parameters<typeof actual.Icon>[0]) => {
      iconRenders.icons.push(props.icon);
      return actual.Icon(props);
    },
  };
});

// happy-dom does not implement the scrolling call cmdk makes while moving the highlight.
beforeAll(() => {
  Element.prototype.scrollIntoView ??= () => undefined;
});

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

  it('a busy Switch keeps the focus and takes no press', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Switch aria-label="Connect" busy checked={false} onCheckedChange={onCheckedChange} />);
    const control = screen.getByRole('switch', { name: 'Connect' });
    expect(control).toHaveAttribute('aria-disabled', 'true');
    expect(control).not.toBeDisabled();

    control.focus();
    await user.keyboard(' ');
    await user.keyboard('{Enter}');
    fireEvent.click(control);

    expect(onCheckedChange).not.toHaveBeenCalled();
    expect(control).toHaveAttribute('aria-checked', 'false');
    expect(control).toHaveFocus();
  });

  it('a Switch that stops being busy takes the next press, with the focus still on it', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    const view = render(<Switch aria-label="Connect" busy checked={false} onCheckedChange={onCheckedChange} />);
    const control = screen.getByRole('switch', { name: 'Connect' });
    control.focus();
    view.rerender(<Switch aria-label="Connect" checked onCheckedChange={onCheckedChange} />);

    expect(control).toHaveFocus();
    expect(control).not.toHaveAttribute('aria-disabled');
    await user.keyboard(' ');
    expect(onCheckedChange).toHaveBeenCalledExactlyOnceWith(false);
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

const EXPERTS: ComboboxOption[] = [
  { value: 'ada', label: 'Ada', description: 'Writes and reviews code', icon: <span>AD</span> },
  { value: 'lin', label: 'Lin', description: 'Plans the work' },
  { value: 'sol', label: 'Sol', keywords: ['design'] },
  { value: 'retired', label: 'Retired expert', disabled: true },
];

const COMBOBOX_TEXT = { placeholder: 'Choose experts', searchPlaceholder: 'Search experts', emptyText: 'No matching expert' };

// A dialog that unmounts gives the focus back from a timer. Unmounting here, with the fake
// clock still on, runs that timer now; left to the shared cleanup it would be a real timer
// that fires in the next test and takes the focus out of the list that test has just opened.
async function leaveNoFocusTimerBehind() {
  cleanup();
  await act(() => vi.runOnlyPendingTimersAsync());
  vi.useRealTimers();
}

function Members({ initial = [] }: { initial?: string[] }) {
  const [values, setValues] = useState(initial);
  return <MultiCombobox label="Members" values={values} onValuesChange={setValues} options={EXPERTS} {...COMBOBOX_TEXT} />;
}

describe('Combobox options with a description and an icon', () => {
  it('names the option by its label alone and describes it with the second line', async () => {
    const user = userEvent.setup();
    render(
      <Combobox label="Lead" value="" onValueChange={() => undefined} options={EXPERTS} {...COMBOBOX_TEXT} />,
      { wrapper: DesignSystemProvider },
    );
    await user.click(screen.getByRole('combobox', { name: 'Lead' }));
    const ada = screen.getByRole('option', { name: 'Ada' });
    expect(ada).toHaveAccessibleName('Ada');
    expect(ada).toHaveAccessibleDescription('Writes and reviews code');
    expect(within(ada).getByText('Writes and reviews code')).toBeVisible();
    expect(within(ada).getByText('AD')).toBeVisible();
    expect(ada).toHaveClass('h-auto');
    const sol = screen.getByRole('option', { name: 'Sol' });
    expect(sol).not.toHaveAttribute('aria-describedby');
    expect(sol).not.toHaveClass('h-auto');
    // An option without a second line keeps the markup it always had.
    expect(sol.innerHTML).toBe('<span class="min-w-0 flex-1 truncate">Sol</span>');
  });

  it('still picks one option and closes', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <Combobox label="Lead" value="lin" onValueChange={onValueChange} options={EXPERTS} {...COMBOBOX_TEXT} />,
      { wrapper: DesignSystemProvider },
    );
    const trigger = screen.getByRole('combobox', { name: 'Lead' });
    expect(trigger).toHaveTextContent('Lin');
    await user.click(trigger);
    // The check of the current choice comes after its name.
    const lin = screen.getByRole('option', { name: 'Lin' });
    expect(lin.lastElementChild?.tagName.toLowerCase()).toBe('svg');
    expect(lin).not.toHaveAttribute('aria-checked');
    expect(screen.getByRole('listbox', { name: 'Lead' })).not.toHaveAttribute('aria-multiselectable');
    await user.click(screen.getByRole('option', { name: 'Ada' }));
    expect(onValueChange).toHaveBeenCalledWith('ada');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('closes on Tab without choosing and keeps the focus on the trigger', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <Combobox label="Lead" value="" onValueChange={onValueChange} options={EXPERTS} {...COMBOBOX_TEXT} />,
      { wrapper: DesignSystemProvider },
    );
    const trigger = screen.getByRole('combobox', { name: 'Lead' });
    await user.click(trigger);
    // fireEvent returns false when the default action was prevented: the browser moves the focus nowhere.
    expect(fireEvent.keyDown(screen.getByRole('combobox', { name: 'Search experts' }), { key: 'Tab', shiftKey: true })).toBe(false);
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onValueChange).not.toHaveBeenCalled();
  });
});

describe('MultiCombobox', () => {
  it('names its trigger with the label and shows the placeholder until something is chosen', () => {
    render(<Members />, { wrapper: DesignSystemProvider });
    const trigger = screen.getByRole('combobox', { name: 'Members' });
    expect(trigger).toHaveAttribute('aria-label', 'Members');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveTextContent('Choose experts');
    expect(trigger).toHaveClass('text-label-placeholder');
    expect(trigger).toHaveClass('min-w-40');
    // The list is on the page only while it is open.
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('shows the chosen names in the order they were chosen, joined and cut off when too long', () => {
    render(<Members initial={['sol', 'ada']} />, { wrapper: DesignSystemProvider });
    const trigger = screen.getByRole('combobox', { name: 'Members' });
    expect(trigger).toHaveTextContent('Sol、Ada');
    expect(trigger).toHaveClass('text-label');
    expect(within(trigger).getByText('Sol、Ada')).toHaveClass('truncate');
  });

  it('adds the highlighted option on Enter and keeps the list open', async () => {
    const user = userEvent.setup();
    const onValuesChange = vi.fn();
    render(
      <MultiCombobox label="Members" values={['ada']} onValuesChange={onValuesChange} options={EXPERTS} {...COMBOBOX_TEXT} />,
      { wrapper: DesignSystemProvider },
    );
    const trigger = screen.getByRole('combobox', { name: 'Members' });
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('{ArrowDown}');
    // Moving the highlight chooses nothing.
    expect(onValuesChange).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    expect(onValuesChange).toHaveBeenCalledTimes(1);
    expect(onValuesChange).toHaveBeenCalledWith(['ada', 'lin']);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('listbox', { name: 'Members' })).toBeInTheDocument();
  });

  it('takes a chosen option out on Enter and keeps the list open', async () => {
    const user = userEvent.setup();
    const onValuesChange = vi.fn();
    render(
      <MultiCombobox label="Members" values={['ada', 'lin']} onValuesChange={onValuesChange} options={EXPERTS} {...COMBOBOX_TEXT} />,
      { wrapper: DesignSystemProvider },
    );
    const trigger = screen.getByRole('combobox', { name: 'Members' });
    await user.click(trigger);
    await user.keyboard('{Enter}');
    expect(onValuesChange).toHaveBeenCalledTimes(1);
    expect(onValuesChange).toHaveBeenCalledWith(['lin']);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  it('toggles with a click, one option at a time, without closing', async () => {
    const user = userEvent.setup();
    render(<Members initial={['ada']} />, { wrapper: DesignSystemProvider });
    const trigger = screen.getByRole('combobox', { name: 'Members' });
    await user.click(trigger);
    await user.click(screen.getByRole('option', { name: 'Sol' }));
    expect(trigger).toHaveTextContent('Ada、Sol');
    await user.click(screen.getByRole('option', { name: 'Ada' }));
    expect(trigger).toHaveTextContent('Sol');
    await user.click(screen.getByRole('option', { name: 'Sol' }));
    expect(trigger).toHaveTextContent('Choose experts');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  it('marks the chosen options for assistive technology and puts a check before their names', async () => {
    const user = userEvent.setup();
    render(<Members initial={['lin']} />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('combobox', { name: 'Members' }));
    // cmdk's aria-selected follows the highlight; a list marked multiselectable would read it as the choice.
    expect(screen.getByRole('listbox', { name: 'Members' })).not.toHaveAttribute('aria-multiselectable');
    const lin = screen.getByRole('option', { name: 'Lin' });
    const ada = screen.getByRole('option', { name: 'Ada' });
    expect(lin).toHaveAttribute('aria-checked', 'true');
    expect(ada).toHaveAttribute('aria-checked', 'false');
    // The first child is the slot of the check: every name starts at the same place.
    expect(lin.firstElementChild?.querySelector('svg')).not.toBeNull();
    expect(ada.firstElementChild?.querySelector('svg')).toBeNull();
    expect(ada.firstElementChild).toHaveClass('size-3.5');
    expect(ada).toHaveAccessibleName('Ada');
    expect(ada).toHaveAccessibleDescription('Writes and reviews code');
    await user.click(ada);
    expect(ada).toHaveAttribute('aria-checked', 'true');
    expect(ada.firstElementChild?.querySelector('svg')).not.toBeNull();
  });

  it('says a highlighted option that is not chosen is not checked, and the chosen one is', async () => {
    const user = userEvent.setup();
    render(<Members initial={['lin']} />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('combobox', { name: 'Members' }));
    const ada = screen.getByRole('option', { name: 'Ada' });
    const lin = screen.getByRole('option', { name: 'Lin' });
    // Move the highlight onto Ada, wherever the list opened.
    for (let press = 0; press < 5 && ada.getAttribute('aria-selected') !== 'true'; press += 1) await user.keyboard('{ArrowDown}');
    expect(ada).toHaveAttribute('aria-selected', 'true');
    expect(ada).toHaveAttribute('aria-checked', 'false');
    expect(lin).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('listbox', { name: 'Members' })).not.toHaveAttribute('aria-multiselectable');
  });

  it('leaves only the options that match what is typed, and says when none does', async () => {
    const user = userEvent.setup();
    render(<Members />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('combobox', { name: 'Members' }));
    const search = screen.getByRole('combobox', { name: 'Search experts' });
    expect(search).toHaveFocus();
    await user.type(search, 'design');
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Sol']);
    await user.keyboard('{Enter}');
    expect(screen.getByRole('combobox', { name: 'Members' })).toHaveTextContent('Sol');
    await user.clear(search);
    await user.type(search, 'zzz');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('No matching expert')).toBeInTheDocument();
  });

  it('cannot be opened while disabled', async () => {
    const user = userEvent.setup();
    render(
      <MultiCombobox label="Members" values={['ada']} onValuesChange={() => undefined} options={EXPERTS} disabled {...COMBOBOX_TEXT} />,
      { wrapper: DesignSystemProvider },
    );
    const trigger = screen.getByRole('combobox', { name: 'Members' });
    expect(trigger).toBeDisabled();
    await user.click(trigger);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('shows a disabled option that cannot be chosen', async () => {
    const user = userEvent.setup();
    const onValuesChange = vi.fn();
    render(
      <MultiCombobox label="Members" values={[]} onValuesChange={onValuesChange} options={EXPERTS} {...COMBOBOX_TEXT} />,
      { wrapper: DesignSystemProvider },
    );
    await user.click(screen.getByRole('combobox', { name: 'Members' }));
    const retired = screen.getByRole('option', { name: 'Retired expert' });
    expect(retired).toHaveAttribute('aria-disabled', 'true');
    await user.click(retired);
    expect(onValuesChange).not.toHaveBeenCalled();
  });

  it('closes on Tab and keeps the focus on the trigger, like Escape', async () => {
    const user = userEvent.setup();
    const onValuesChange = vi.fn();
    render(
      <MultiCombobox label="Members" values={[]} onValuesChange={onValuesChange} options={EXPERTS} {...COMBOBOX_TEXT} />,
      { wrapper: DesignSystemProvider },
    );
    const trigger = screen.getByRole('combobox', { name: 'Members' });
    await user.click(trigger);
    const search = screen.getByRole('combobox', { name: 'Search experts' });
    expect(search).toHaveFocus();
    // fireEvent returns false when the default action was prevented: the browser moves the focus nowhere.
    expect(fireEvent.keyDown(search, { key: 'Tab' })).toBe(false);
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(onValuesChange).not.toHaveBeenCalled();
  });

  it('closes when another popover opens', async () => {
    const user = userEvent.setup();
    function Page({ popoverOpen }: { popoverOpen: boolean }) {
      return (
        <>
          <Members />
          <Popover open={popoverOpen} trigger={<Button>Details</Button>}>Popover body</Popover>
        </>
      );
    }
    const { rerender } = render(<Page popoverOpen={false} />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('combobox', { name: 'Members' }));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    rerender(<Page popoverOpen />);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByText('Popover body')).toBeInTheDocument();
  });

  it('sits on the popover level on the page, opaque and clear of the window drag region', async () => {
    const user = userEvent.setup();
    render(<Members />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('combobox', { name: 'Members' }));
    const layer = screen.getByRole('listbox').closest('[data-ds-layer]');
    expect(layer).toHaveClass('z-popover');
    expect(layer).toHaveClass('bg-raised');
    expect(layer).toHaveAttribute('data-electron-no-drag');
  });

  it('renders only the row whose choice changed', async () => {
    const user = userEvent.setup();
    render(<Members initial={['ada', 'sol']} />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('combobox', { name: 'Members' }));
    await user.keyboard('{ArrowDown}');
    iconRenders.icons.length = 0;
    await user.keyboard('{Enter}');
    expect(screen.getByRole('combobox', { name: 'Members' })).toHaveTextContent('Ada、Sol、Lin');
    // Ada and Sol were chosen already: their rows, and their checks, did not render again.
    expect(iconRenders.icons.filter((icon) => icon === AppIcons.done)).toHaveLength(1);
  });

  describe('Escape', () => {
    // Radix restores focus from a timer once the closed list has unmounted.
    beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
    afterEach(leaveNoFocusTimerBehind);

    it('closes the list and returns the focus to the trigger', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<Members initial={['ada']} />, { wrapper: DesignSystemProvider });
      const trigger = screen.getByRole('combobox', { name: 'Members' });
      await user.click(trigger);
      await user.keyboard('{Escape}');
      await act(() => vi.runOnlyPendingTimersAsync());
      expect(screen.queryByRole('listbox')).toBeNull();
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
      expect(trigger).toHaveFocus();
      expect(trigger).toHaveTextContent('Ada');
    });

    it('closes only the list when it is open inside a dialog, where it sits on the dialog level', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const onOpenChange = vi.fn();
      render(
        <Dialog open onOpenChange={onOpenChange} title="New team"><Members /></Dialog>,
        { wrapper: DesignSystemProvider },
      );
      const trigger = screen.getByRole('combobox', { name: 'Members' });
      await user.click(trigger);
      const layer = screen.getByRole('listbox').closest('[data-ds-layer]');
      expect(layer).toHaveClass('z-dialog');
      expect(layer).not.toHaveClass('z-popover');
      await user.keyboard('{Enter}');
      await user.keyboard('{Escape}');
      await act(() => vi.runOnlyPendingTimersAsync());
      expect(screen.queryByRole('listbox')).toBeNull();
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(screen.getByRole('dialog', { name: 'New team' })).toBeInTheDocument();
      expect(trigger).toHaveFocus();
      expect(trigger).toHaveTextContent('Ada');
    });
  });

  describe('Tab inside a dialog', () => {
    beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
    afterEach(leaveNoFocusTimerBehind);

    // A Tab the page does not prevent is the browser's to handle: it moves the focus on,
    // here to the page behind the dialog, while the dialog's own focus trap is paused by the open list.
    function pressTab(target: HTMLElement, shiftKey: boolean, browserDestination: HTMLElement) {
      if (fireEvent.keyDown(target, { key: 'Tab', shiftKey })) browserDestination.focus();
    }

    it.each([
      { place: 'first', shiftKey: true },
      { place: 'last', shiftKey: false },
    ])('keeps the focus on the trigger when it is the $place control of the dialog', async ({ place, shiftKey }) => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const onOpenChange = vi.fn();
      render(
        <>
          <Button>Behind the dialog</Button>
          <Dialog open onOpenChange={onOpenChange} title="New team">
            {place === 'last' && <Button>Rename</Button>}
            <Members />
            {place === 'first' && <Button>Save</Button>}
          </Dialog>
        </>,
        { wrapper: DesignSystemProvider },
      );
      const dialog = screen.getByRole('dialog', { name: 'New team' });
      const trigger = screen.getByRole('combobox', { name: 'Members' });
      await user.click(trigger);
      const search = screen.getByRole('combobox', { name: 'Search experts' });
      expect(search).toHaveFocus();
      pressTab(search, shiftKey, screen.getByRole('button', { name: 'Behind the dialog', hidden: true }));
      await act(() => vi.runOnlyPendingTimersAsync());
      expect(screen.queryByRole('listbox')).toBeNull();
      expect(trigger).toHaveFocus();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
      expect(screen.getByRole('dialog', { name: 'New team' })).toBeInTheDocument();
      expect(onOpenChange).not.toHaveBeenCalled();
    });
  });
});
