// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Button } from './button';
import { Combobox } from './combobox';
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
