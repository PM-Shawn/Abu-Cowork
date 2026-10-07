// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { useState } from 'react';
import ReactDOM from 'react-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Button } from './button';
import { Combobox } from './combobox';
import { AppIcons } from './icons';
import { Popover } from './popover';
import { DesignSystemProvider } from './provider';
import { Select } from './select';

// happy-dom does not implement the pointer-capture and scrolling calls Radix Select and
// cmdk make while moving the highlight.
beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
});

const MODELS = [
  { value: 'sonnet', label: 'Claude Sonnet 5' },
  { value: 'opus', label: 'Claude Opus 5' },
  { value: 'deepseek', label: 'DeepSeek V4 Pro', keywords: ['ds'] },
];

function SelectHarness() {
  const [value, setValue] = useState('sonnet');
  return <Select label="Model" value={value} onValueChange={setValue} options={MODELS} />;
}

function ComboboxHarness() {
  const [value, setValue] = useState('');
  return (
    <Combobox
      label="Model"
      value={value}
      onValueChange={setValue}
      options={MODELS}
      placeholder="Choose a model"
      searchPlaceholder="Search models"
      emptyText="No matching model"
    />
  );
}

describe('Select', () => {
  it('opens from the keyboard and picks an option', async () => {
    const user = userEvent.setup();
    render(<SelectHarness />, { wrapper: DesignSystemProvider });
    const trigger = screen.getByRole('combobox', { name: 'Model' });
    expect(trigger).toHaveTextContent('Claude Sonnet 5');
    trigger.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('listbox').closest('[data-ds-layer]')).not.toBeNull();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(trigger).toHaveTextContent('Claude Opus 5');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('stays open inside a popover without closing it', async () => {
    const user = userEvent.setup();
    render(<Popover trigger={<Button>Details</Button>}><SelectHarness /></Popover>, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('button', { name: 'Details' }));
    // An open Select hides everything outside its list from screen readers, so keep the element.
    const trigger = screen.getByRole('combobox', { name: 'Model' });
    trigger.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(trigger).toBeInTheDocument();
  });
});

const TURNS = [
  { value: '50', label: '50 turns' },
  { value: '100', label: '100 turns' },
];

const ACCESS = [
  { value: 'allow', label: 'Allow', tone: 'success' as const },
  { value: 'ask', label: 'Ask every time', description: 'Abu asks before it opens a site.' },
  { value: 'block', label: 'Block', tone: 'danger' as const },
  { value: 'custom', label: 'Custom', icon: AppIcons.settings },
];

// Radix gives each option text a generated id.
function withoutIds(html: string): string {
  return html.replace(/ id="[^"]*"/g, '');
}

describe('Select keyboard', () => {
  it.each([
    ['a letter', MODELS, 'sonnet', 'd'],
    ['a capital letter', MODELS, 'sonnet', 'D'],
    ['a digit', TURNS, '100', '5'],
  ] as const)('never changes its value from %s typed while it is closed', async (_name, options, value, key) => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<Select label="Setting" value={value} onValueChange={onValueChange} options={[...options]} />, { wrapper: DesignSystemProvider });
    const trigger = screen.getByRole('combobox', { name: 'Setting' });
    trigger.focus();
    await user.keyboard(key);
    expect(onValueChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('only opens on ArrowDown, only moves the highlight with more arrows, and chooses on Enter', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<Select label="Model" value="sonnet" onValueChange={onValueChange} options={MODELS} />, { wrapper: DesignSystemProvider });
    screen.getByRole('combobox', { name: 'Model' }).focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(onValueChange).not.toHaveBeenCalled();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(onValueChange).not.toHaveBeenCalled();
    expect(screen.getByRole('option', { name: 'DeepSeek V4 Pro' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith('deepseek');
  });

  it('opens on Space and on Enter without choosing anything', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<Select label="Model" value="sonnet" onValueChange={onValueChange} options={MODELS} />, { wrapper: DesignSystemProvider });
    screen.getByRole('combobox', { name: 'Model' }).focus();
    await user.keyboard(' ');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('still jumps to a typed option inside the open list, and chooses it only on Enter', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<Select label="Model" value="sonnet" onValueChange={onValueChange} options={MODELS} />, { wrapper: DesignSystemProvider });
    screen.getByRole('combobox', { name: 'Model' }).focus();
    await user.keyboard('{Enter}');
    await user.keyboard('d');
    await waitFor(() => expect(screen.getByRole('option', { name: 'DeepSeek V4 Pro' })).toHaveFocus());
    expect(onValueChange).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    expect(onValueChange).toHaveBeenCalledWith('deepseek');
  });
});

describe('Select options', () => {
  it('shows a description only in the open list and keeps it out of the option name', async () => {
    const user = userEvent.setup();
    render(<Select label="Site access" value="ask" onValueChange={() => undefined} options={ACCESS} />, { wrapper: DesignSystemProvider });
    const trigger = screen.getByRole('combobox', { name: 'Site access' });
    expect(trigger).toHaveTextContent(/^Ask every time$/);
    expect(screen.queryByText('Abu asks before it opens a site.')).toBeNull();
    await user.click(trigger);
    const option = screen.getByRole('option', { name: 'Ask every time' });
    expect(option).toHaveAccessibleDescription('Abu asks before it opens a site.');
    expect(option).toHaveClass('h-auto');
    expect(option).toHaveClass('items-start');
    expect(trigger).toHaveTextContent(/^Ask every time$/);
    // An option without a description keeps the one-line height and is not described.
    const plain = screen.getByRole('option', { name: 'Allow' });
    expect(plain).not.toHaveAttribute('aria-describedby');
    expect(plain).not.toHaveClass('h-auto');
  });

  it('shows a status icon in the option and in the trigger', async () => {
    const user = userEvent.setup();
    render(<Select label="Site access" value="allow" onValueChange={() => undefined} options={ACCESS} />, { wrapper: DesignSystemProvider });
    const trigger = screen.getByRole('combobox', { name: 'Site access' });
    expect(trigger.querySelectorAll('svg.text-success')).toHaveLength(1);
    await user.click(trigger);
    expect(screen.getByRole('option', { name: 'Allow' }).querySelectorAll('svg.text-success')).toHaveLength(1);
    expect(screen.getByRole('option', { name: 'Block' }).querySelectorAll('svg.text-danger')).toHaveLength(1);
    expect(trigger.querySelectorAll('svg.text-success')).toHaveLength(1);
  });

  it('shows a plain icon in the option and in the trigger', async () => {
    const user = userEvent.setup();
    render(<Select label="Site access" value="custom" onValueChange={() => undefined} options={ACCESS} />, { wrapper: DesignSystemProvider });
    const trigger = screen.getByRole('combobox', { name: 'Site access' });
    expect(trigger.querySelectorAll('svg.text-label-secondary')).toHaveLength(1);
    await user.click(trigger);
    expect(screen.getByRole('option', { name: 'Custom' }).querySelectorAll('svg.text-label-secondary')).toHaveLength(1);
  });

  it('starts a description under the name when the option has an icon, and centers the check mark on the name line', async () => {
    const user = userEvent.setup();
    const options = [
      { value: 'allow', label: 'Allow', tone: 'success' as const, description: 'Abu opens the site without asking.' },
      { value: 'custom', label: 'Custom', icon: AppIcons.settings, description: 'You choose for each site.' },
      { value: 'ask', label: 'Ask every time', description: 'Abu asks before it opens a site.' },
      { value: 'block', label: 'Block', tone: 'danger' as const },
    ];
    function Harness() {
      const [value, setValue] = useState('allow');
      return <Select label="Site access" value={value} onValueChange={setValue} options={options} />;
    }
    render(<Harness />, { wrapper: DesignSystemProvider });
    const trigger = screen.getByRole('combobox', { name: 'Site access' });
    await user.click(trigger);
    // 22px: the 14px icon plus the 8px gap before the name.
    expect(screen.getByText('Abu opens the site without asking.')).toHaveClass('pl-5.5');
    expect(screen.getByText('You choose for each site.')).toHaveClass('pl-5.5');
    expect(screen.getByText('Abu asks before it opens a site.')).not.toHaveClass('pl-5.5');
    // The chosen described option: its check mark moves down with the name line.
    const chosen = screen.getByRole('option', { name: 'Allow' });
    expect(chosen.lastElementChild).toHaveClass('absolute');
    expect(chosen.lastElementChild).toHaveClass('mt-0.5');
    // Without a description the row is one centered line, so the check mark is not moved.
    await user.click(screen.getByRole('option', { name: 'Block' }));
    await user.click(trigger);
    const plain = screen.getByRole('option', { name: 'Block' });
    expect(plain.lastElementChild).toHaveClass('absolute');
    expect(plain.lastElementChild).not.toHaveClass('mt-0.5');
  });

  it('jumps to an option with an icon by the first letter of its name', async () => {
    const user = userEvent.setup();
    render(<Select label="Site access" value="allow" onValueChange={() => undefined} options={ACCESS} />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('combobox', { name: 'Site access' }));
    await user.keyboard('b');
    await waitFor(() => expect(screen.getByRole('option', { name: 'Block' })).toHaveFocus());
  });

  it('fills the width of its container when asked, and keeps its own minimum width otherwise', () => {
    const { unmount } = render(<Select label="Model" fullWidth value="sonnet" onValueChange={() => undefined} options={MODELS} />, { wrapper: DesignSystemProvider });
    const wide = screen.getByRole('combobox', { name: 'Model' });
    expect(wide).toHaveClass('w-full');
    expect(wide).toHaveClass('flex');
    expect(wide).not.toHaveClass('min-w-32');
    expect(wide).not.toHaveClass('inline-flex');
    unmount();
    render(<Select label="Model" value="sonnet" onValueChange={() => undefined} options={MODELS} />, { wrapper: DesignSystemProvider });
    const narrow = screen.getByRole('combobox', { name: 'Model' });
    expect(narrow).toHaveClass('min-w-32');
    expect(narrow).toHaveClass('inline-flex');
    expect(narrow).not.toHaveClass('w-full');
  });

  it('keeps the markup of an option without a description, an icon or a status', async () => {
    const user = userEvent.setup();
    render(<Select label="Model" value="sonnet" onValueChange={() => undefined} options={MODELS} />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('combobox', { name: 'Model' }));
    expect(withoutIds(screen.getByRole('option', { name: 'Claude Opus 5' }).innerHTML)).toBe('<span>Claude Opus 5</span>');
    // The chosen option adds only its check mark after the text.
    const chosen = screen.getByRole('option', { name: 'Claude Sonnet 5' });
    expect(chosen.children).toHaveLength(2);
    expect(withoutIds(chosen.children[0].outerHTML)).toBe('<span>Claude Sonnet 5</span>');
    expect(chosen.children[1]).toHaveClass('absolute');
    expect(chosen).toHaveClass('h-6');
  });
});

describe('Select: picking the chosen option again', () => {
  function renderAccess(value = 'custom') {
    const onValueChange = vi.fn();
    const onReselect = vi.fn();
    render(<Select label="Site access" value={value} onValueChange={onValueChange} onReselect={onReselect} options={ACCESS} />, { wrapper: DesignSystemProvider });
    return { onValueChange, onReselect, trigger: screen.getByRole('combobox', { name: 'Site access' }) };
  }

  it('reports a click on the chosen option through onReselect only', async () => {
    const user = userEvent.setup();
    const { onValueChange, onReselect, trigger } = renderAccess();
    await user.click(trigger);
    await user.click(screen.getByRole('option', { name: 'Custom' }));
    expect(onReselect).toHaveBeenCalledOnce();
    expect(onReselect).toHaveBeenCalledWith('custom');
    expect(onValueChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it.each(['{Enter}', ' '])('reports the chosen option picked with the key "%s"', async (key) => {
    const user = userEvent.setup();
    const { onValueChange, onReselect, trigger } = renderAccess();
    trigger.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('option', { name: 'Custom' })).toHaveFocus());
    await user.keyboard(key);
    expect(onReselect).toHaveBeenCalledOnce();
    expect(onReselect).toHaveBeenCalledWith('custom');
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('reports another option through onValueChange only', async () => {
    const user = userEvent.setup();
    const { onValueChange, onReselect, trigger } = renderAccess();
    await user.click(trigger);
    await user.click(screen.getByRole('option', { name: 'Block' }));
    expect(onValueChange).toHaveBeenCalledOnce();
    expect(onValueChange).toHaveBeenCalledWith('block');
    expect(onReselect).not.toHaveBeenCalled();
  });

  it('reports nothing when the list is browsed and closed with Escape on the chosen option', async () => {
    const user = userEvent.setup();
    const { onValueChange, onReselect, trigger } = renderAccess();
    trigger.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('option', { name: 'Custom' })).toHaveFocus());
    await user.keyboard('{ArrowUp}{ArrowDown}{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onReselect).not.toHaveBeenCalled();
    expect(onValueChange).not.toHaveBeenCalled();
    // The next time the list closes without a choice, an earlier key on the chosen option does not count.
    await user.keyboard('{Enter}');
    await user.keyboard('{Tab}{Escape}');
    expect(onReselect).not.toHaveBeenCalled();
  });

  it('reports nothing when the list is closed by a click outside it', async () => {
    // The page ignores the pointer while the list is open; the click still lands outside the list.
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const { onValueChange, onReselect, trigger } = renderAccess();
    await user.click(trigger);
    await user.hover(screen.getByRole('option', { name: 'Custom' }));
    await user.click(document.body);
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(onReselect).not.toHaveBeenCalled();
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('reports nothing for a key that is repeating because it is held down', async () => {
    const user = userEvent.setup();
    const { onValueChange, onReselect, trigger } = renderAccess();
    trigger.focus();
    await user.keyboard('{Enter}');
    const chosen = screen.getByRole('option', { name: 'Custom' });
    await waitFor(() => expect(chosen).toHaveFocus());
    // Radix picks on any Enter; a held key must neither open the window behind the option nor write again.
    fireEvent.keyDown(chosen, { key: 'Enter', repeat: true });
    expect(onReselect).not.toHaveBeenCalled();
    expect(onValueChange).not.toHaveBeenCalled();
  });
});

describe('Select: while it is closed', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('mounts no list and no portal, however many options it has', () => {
    const createPortal = vi.spyOn(ReactDOM, 'createPortal');
    render(
      <>
        <Select label="Site access" value="allow" onValueChange={() => undefined} options={ACCESS} />
        <Select label="Model" value="opus" onValueChange={() => undefined} options={MODELS} />
        <Select label="Unchosen" value="" placeholder="Choose a model" onValueChange={() => undefined} options={MODELS} />
      </>,
      { wrapper: DesignSystemProvider },
    );
    expect(createPortal).not.toHaveBeenCalled();
    expect(screen.queryByRole('option', { hidden: true })).toBeNull();
    // The closed select still shows the chosen option: its mark and its name, never its description.
    const access = screen.getByRole('combobox', { name: 'Site access' });
    expect(access).toHaveTextContent(/^Allow$/);
    expect(access.querySelectorAll('svg.text-success')).toHaveLength(1);
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveTextContent(/^Claude Opus 5$/);
    const unchosen = screen.getByRole('combobox', { name: 'Unchosen' });
    expect(unchosen).toHaveTextContent(/^Choose a model$/);
    expect(unchosen).toHaveAttribute('data-placeholder');
  });

  it('shows its placeholder while it holds a value that no option has, and hands that value to nobody', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <Select label="Model" value="retired-model" placeholder="Choose a model" onValueChange={onValueChange} options={MODELS} />,
      { wrapper: DesignSystemProvider },
    );
    const box = screen.getByRole('combobox', { name: 'Model' });
    expect(box).toHaveTextContent(/^Choose a model$/);
    expect(box).toHaveAttribute('data-placeholder');
    expect(onValueChange).not.toHaveBeenCalled();

    // No option is marked as chosen, and a pick is reported as any other.
    await user.click(box);
    expect(screen.getAllByRole('option').map((option) => option.getAttribute('aria-selected'))).toEqual(['false', 'false', 'false']);
    await user.click(screen.getByRole('option', { name: 'Claude Opus 5' }));
    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith('opus');
  });

  it('shows the same mark and name in the closed select as in the list, and follows the value', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [value, setValue] = useState('ask');
      return <Select label="Site access" value={value} onValueChange={setValue} options={ACCESS} />;
    }
    render(<Harness />, { wrapper: DesignSystemProvider });
    const trigger = screen.getByRole('combobox', { name: 'Site access' });
    expect(trigger).toHaveTextContent(/^Ask every time$/);
    expect(trigger.querySelector('svg.text-success, svg.text-danger, svg.text-label-secondary')).toBeNull();
    await user.click(trigger);
    const inList = screen.getByRole('option', { name: 'Custom' }).querySelector('span.inline-flex')!.outerHTML;
    await user.click(screen.getByRole('option', { name: 'Custom' }));
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(trigger).toHaveTextContent(/^Custom$/);
    expect(trigger.querySelector('span.inline-flex')!.outerHTML).toBe(inList);
  });

  it('shows nothing for a value that is not among the options', () => {
    render(<Select label="Model" value="gone" onValueChange={() => undefined} options={MODELS} />, { wrapper: DesignSystemProvider });
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveTextContent(/^$/);
  });
});

describe('Select: after the list has closed', () => {
  it('calls onCloseAutoFocus once the list has gone, then takes the focus back', async () => {
    const user = userEvent.setup();
    const listGone = vi.fn(() => screen.queryByRole('listbox') === null);
    render(<Select label="Model" value="sonnet" onValueChange={() => undefined} onCloseAutoFocus={() => { listGone(); }} options={MODELS} />, { wrapper: DesignSystemProvider });
    const trigger = screen.getByRole('combobox', { name: 'Model' });
    await user.click(trigger);
    expect(listGone).not.toHaveBeenCalled();
    await user.click(screen.getByRole('option', { name: 'Claude Opus 5' }));
    await waitFor(() => expect(listGone).toHaveBeenCalledOnce());
    expect(listGone).toHaveReturnedWith(true);
    expect(trigger).toHaveFocus();
  });

  it('leaves the focus alone when onCloseAutoFocus prevents the default', async () => {
    const user = userEvent.setup();
    const onCloseAutoFocus = vi.fn((event: Event) => event.preventDefault());
    render(<Select label="Model" value="sonnet" onValueChange={() => undefined} onCloseAutoFocus={onCloseAutoFocus} options={MODELS} />, { wrapper: DesignSystemProvider });
    const trigger = screen.getByRole('combobox', { name: 'Model' });
    await user.click(trigger);
    await user.click(screen.getByRole('option', { name: 'Claude Opus 5' }));
    await waitFor(() => expect(onCloseAutoFocus).toHaveBeenCalledOnce());
    expect(trigger).not.toHaveFocus();
  });
});

describe('Combobox', () => {
  it('filters as the user types and picks with Enter', async () => {
    const user = userEvent.setup();
    render(<ComboboxHarness />, { wrapper: DesignSystemProvider });
    const trigger = screen.getByRole('combobox', { name: 'Model' });
    expect(trigger).toHaveTextContent('Choose a model');
    await user.click(trigger);
    await user.type(screen.getByRole('combobox', { name: 'Search models' }), 'opus');
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Claude Opus 5']);
    await user.keyboard('{Enter}');
    expect(trigger).toHaveTextContent('Claude Opus 5');
  });

  it('dims only disabled options and names its list with the label', async () => {
    const user = userEvent.setup();
    render(<ComboboxHarness />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('combobox', { name: 'Model' }));
    expect(screen.getByRole('listbox', { name: 'Model' })).toBeInTheDocument();
    // cmdk writes data-disabled="false" on enabled items, so only the =true form may dim.
    const option = screen.getByRole('option', { name: 'Claude Opus 5' });
    expect(option).toHaveAttribute('data-disabled', 'false');
    expect(option).not.toHaveClass('data-[disabled]:opacity-40');
    expect(option).toHaveClass('data-[disabled=true]:opacity-40');
  });

  it('shows a disabled option that cannot be picked', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <Combobox
        label="Model"
        value=""
        onValueChange={onValueChange}
        options={[...MODELS, { value: 'retired', label: 'Retired model', disabled: true }]}
        placeholder="Choose a model"
        searchPlaceholder="Search models"
        emptyText="No matching model"
      />,
      { wrapper: DesignSystemProvider },
    );
    await user.click(screen.getByRole('combobox', { name: 'Model' }));
    const retired = screen.getByRole('option', { name: 'Retired model' });
    expect(retired).toHaveAttribute('aria-disabled', 'true');
    expect(retired).toHaveAttribute('data-disabled', 'true');
    await user.click(retired);
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('matches keywords and says when nothing matches', async () => {
    const user = userEvent.setup();
    render(<ComboboxHarness />, { wrapper: DesignSystemProvider });
    await user.click(screen.getByRole('combobox', { name: 'Model' }));
    const search = screen.getByRole('combobox', { name: 'Search models' });
    await user.type(search, 'ds');
    expect(screen.getByRole('option', { name: 'DeepSeek V4 Pro' })).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, 'zzz');
    expect(screen.getByText('No matching model')).toBeInTheDocument();
  });
});

// A list picks on the key-down of Enter. The key that opened it is still down when it shows.
describe('keys held when a list opens', () => {
  const down = (target: Element, key: string, code = key) => fireEvent.keyDown(target, { key, code });
  const repeat = (target: Element, key: string, code = key) => fireEvent.keyDown(target, { key, code, repeat: true });
  const up = (target: Element, key: string, code = key) => fireEvent.keyUp(target, { key, code });
  const focused = () => document.activeElement as HTMLElement;

  it('Select: the Enter that opened the list picks nothing and leaves it open; pressed again, it picks', async () => {
    const onValueChange = vi.fn();
    render(<Select label="Model" value="" onValueChange={onValueChange} options={MODELS} placeholder="Choose" />, { wrapper: DesignSystemProvider });
    const trigger = screen.getByRole('combobox', { name: 'Model' });
    trigger.focus();
    down(trigger, 'Enter');
    const first = await screen.findByRole('option', { name: 'Claude Sonnet 5' });
    first.focus();
    for (let i = 0; i < 5; i += 1) expect(repeat(focused(), 'Enter')).toBe(false);
    expect(onValueChange).not.toHaveBeenCalled();
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    up(focused(), 'Enter');
    down(focused(), 'Enter');
    expect(onValueChange.mock.calls).toEqual([['sonnet']]);
  });

  it('Select: an ArrowDown pressed inside the open list and held walks through it', async () => {
    const user = userEvent.setup();
    render(<SelectHarness />, { wrapper: DesignSystemProvider });
    screen.getByRole('combobox', { name: 'Model' }).focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('option', { name: 'Claude Sonnet 5' })).toHaveFocus());
    down(focused(), 'ArrowDown');
    await waitFor(() => expect(screen.getByRole('option', { name: 'Claude Opus 5' })).toHaveFocus());
    expect(repeat(focused(), 'ArrowDown')).toBe(false);
    await waitFor(() => expect(screen.getByRole('option', { name: 'DeepSeek V4 Pro' })).toHaveFocus());
  });

  it('Combobox: the Enter that opened the list picks nothing; pressed again, it picks the highlighted option', async () => {
    const onValueChange = vi.fn();
    render(
      <Combobox label="Model" value="" onValueChange={onValueChange} options={MODELS} placeholder="Choose a model" searchPlaceholder="Search models" emptyText="No matching model" />,
      { wrapper: DesignSystemProvider },
    );
    const trigger = screen.getByRole('combobox', { name: 'Model' });
    trigger.focus();
    down(trigger, 'Enter');
    // The browser makes the click that opens the list from that key-down.
    fireEvent.click(trigger, { detail: 0 });
    const search = await screen.findByRole('combobox', { name: 'Search models' });
    search.focus();
    for (let i = 0; i < 5; i += 1) expect(repeat(search, 'Enter')).toBe(false);
    expect(onValueChange).not.toHaveBeenCalled();
    expect(search).toBeInTheDocument();
    up(search, 'Enter');
    // Arrows pressed in the list repeat.
    down(search, 'ArrowDown');
    repeat(search, 'ArrowDown');
    expect(screen.getByRole('option', { name: 'DeepSeek V4 Pro' })).toHaveAttribute('aria-selected', 'true');
    down(search, 'Enter');
    expect(onValueChange.mock.calls).toEqual([['deepseek']]);
  });
});
