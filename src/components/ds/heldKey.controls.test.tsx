// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
// A control that acts at once acts once per press of Enter or Space; a text field drops a
// repeating Enter only.
//
// happy-dom makes no click from a key. What these cases read is what the browser decides by: a
// key-down whose default was prevented makes no click (Enter), and leaves the button unpressed
// for the key-up (Space). That the browser then makes no click is checked in the real shell.
import type { KeyboardEvent, ReactElement } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Button, IconButton } from './button';
import { Checkbox } from './checkbox';
import { Combobox } from './combobox';
import { Disclosure } from './disclosure';
import { AppIcons } from './icons';
import { Link } from './link';
import { NavItem } from './nav-item';
import { Pressable } from './pressable';
import { DesignSystemProvider } from './provider';
import { Select } from './select';
import { Switch } from './switch';
import { TextArea } from './text-area';
import { TextField } from './text-field';

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
});

const show = (ui: ReactElement) => render(ui, { wrapper: DesignSystemProvider });
// fireEvent returns false once the default was prevented.
const firstPress = (target: Element, key: string, code: string) => fireEvent.keyDown(target, { key, code });
const repeatOf = (target: Element, key: string, code: string) => fireEvent.keyDown(target, { key, code, repeat: true });

type Handler = (event: KeyboardEvent) => void;
const OPTIONS = [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }];

// Controls that pass a caller's key handler on.
const WITH_HANDLER: [string, (onKeyDown: Handler) => ReactElement, () => HTMLElement][] = [
  ['Button', (onKeyDown) => <Button onKeyDown={onKeyDown}>Install</Button>, () => screen.getByRole('button', { name: 'Install' })],
  ['IconButton', (onKeyDown) => <IconButton icon={AppIcons.close} label="Remove" onKeyDown={onKeyDown} />, () => screen.getByRole('button', { name: 'Remove' })],
  ['Pressable', (onKeyDown) => <Pressable aria-label="Open image" onKeyDown={onKeyDown} />, () => screen.getByRole('button', { name: 'Open image' })],
  ['NavItem', (onKeyDown) => <NavItem label="Tasks" onKeyDown={onKeyDown} />, () => screen.getByRole('button', { name: 'Tasks' })],
  ['Link', (onKeyDown) => <Link href="#docs" onKeyDown={onKeyDown}>Docs</Link>, () => screen.getByRole('link', { name: 'Docs' })],
];

// Controls with no key handler of the caller's.
const WITHOUT_HANDLER: [string, () => ReactElement, () => HTMLElement][] = [
  ['Switch', () => <Switch checked={false} onCheckedChange={() => undefined} aria-label="Auto-dispatch" />, () => screen.getByRole('switch', { name: 'Auto-dispatch' })],
  ['Checkbox', () => <Checkbox checked={false} onCheckedChange={() => undefined} label="Remember" />, () => screen.getByRole('checkbox', { name: 'Remember' })],
  ['Disclosure', () => <Disclosure title="More">Body</Disclosure>, () => screen.getByRole('button', { name: 'More' })],
  ['Select, closed', () => <Select value="a" onValueChange={() => undefined} options={OPTIONS} label="Language" />, () => screen.getByRole('combobox', { name: 'Language' })],
  ['Combobox, closed', () => <Combobox value="a" onValueChange={() => undefined} options={OPTIONS} label="Model" placeholder="Pick" searchPlaceholder="Search" emptyText="None" />, () => screen.getByRole('combobox', { name: 'Model' })],
];

describe('a control acts once per press of Enter or Space', () => {
  describe.each(WITH_HANDLER)('%s', (_name, ui, find) => {
    it('drops the repeats of a held Enter and of a held Space, and its own handler does not hear them', () => {
      const onKeyDown = vi.fn();
      show(ui(onKeyDown));
      expect(repeatOf(find(), 'Enter', 'Enter')).toBe(false);
      expect(repeatOf(find(), 'Enter', 'NumpadEnter')).toBe(false);
      expect(repeatOf(find(), ' ', 'Space')).toBe(false);
      expect(onKeyDown).not.toHaveBeenCalled();
    });

    it('takes the first press of each, and its handler hears it', () => {
      const onKeyDown = vi.fn();
      show(ui(onKeyDown));
      expect(firstPress(find(), 'Enter', 'Enter')).toBe(true);
      expect(firstPress(find(), ' ', 'Space')).toBe(true);
      expect(onKeyDown).toHaveBeenCalledTimes(2);
    });

    it('lets every other key repeat', () => {
      const onKeyDown = vi.fn();
      show(ui(onKeyDown));
      expect(repeatOf(find(), 'ArrowDown', 'ArrowDown')).toBe(true);
      expect(repeatOf(find(), 'Tab', 'Tab')).toBe(true);
      expect(onKeyDown).toHaveBeenCalledTimes(2);
    });
  });

  describe.each(WITHOUT_HANDLER)('%s', (_name, ui, find) => {
    it('drops the repeats of a held Enter and of a held Space', () => {
      show(ui());
      expect(repeatOf(find(), 'Enter', 'Enter')).toBe(false);
      expect(repeatOf(find(), ' ', 'Space')).toBe(false);
    });

    it('lets Tab repeat', () => {
      show(ui());
      expect(repeatOf(find(), 'Tab', 'Tab')).toBe(true);
    });
  });

  it.each(['Switch', 'Disclosure', 'Combobox, closed'])('%s takes the first press of Enter and of Space', (name) => {
    const [, ui, find] = WITHOUT_HANDLER.find(([entry]) => entry === name)!;
    show(ui());
    expect(firstPress(find(), 'Enter', 'Enter')).toBe(true);
    expect(firstPress(find(), ' ', 'Space')).toBe(true);
  });

  it('a Checkbox takes the first press of Space (Enter never ticks one)', () => {
    show(<Checkbox checked={false} onCheckedChange={() => undefined} label="Remember" />);
    expect(firstPress(screen.getByRole('checkbox', { name: 'Remember' }), ' ', 'Space')).toBe(true);
  });

  it('a closed Select opens on the first press of Enter and not on a repeat', () => {
    show(<Select value="a" onValueChange={() => undefined} options={OPTIONS} label="Language" />);
    const select = screen.getByRole('combobox', { name: 'Language' });
    repeatOf(select, 'Enter', 'Enter');
    repeatOf(select, ' ', 'Space');
    repeatOf(select, 'ArrowDown', 'ArrowDown');
    expect(screen.queryByRole('listbox')).toBeNull();
    firstPress(select, 'Enter', 'Enter');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('a busy Button drops them too', () => {
    show(<Button busy>Saving</Button>);
    expect(repeatOf(screen.getByRole('button', { name: 'Saving' }), 'Enter', 'Enter')).toBe(false);
  });
});

describe('a text field and a held key', () => {
  it('TextField drops a repeating Enter, and its handler does not hear it', () => {
    const onKeyDown = vi.fn();
    show(<TextField aria-label="Domain" onKeyDown={onKeyDown} />);
    const field = screen.getByRole('textbox', { name: 'Domain' });
    expect(firstPress(field, 'Enter', 'Enter')).toBe(true);
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    expect(repeatOf(field, 'Enter', 'Enter')).toBe(false);
    expect(repeatOf(field, 'Enter', 'NumpadEnter')).toBe(false);
    expect(onKeyDown).toHaveBeenCalledTimes(1);
  });

  it('TextField lets Space, Backspace, Delete and the arrows repeat', () => {
    const onKeyDown = vi.fn();
    show(<TextField aria-label="Domain" onKeyDown={onKeyDown} />);
    const field = screen.getByRole('textbox', { name: 'Domain' });
    for (const [key, code] of [[' ', 'Space'], ['Backspace', 'Backspace'], ['Delete', 'Delete'], ['ArrowLeft', 'ArrowLeft'], ['a', 'KeyA']]) {
      expect(repeatOf(field, key, code)).toBe(true);
    }
    expect(onKeyDown).toHaveBeenCalledTimes(5);
  });

  it('TextField leaves a repeating Enter to an input method that is composing', () => {
    const onKeyDown = vi.fn();
    show(<TextField aria-label="Domain" onKeyDown={onKeyDown} />);
    const field = screen.getByRole('textbox', { name: 'Domain' });
    expect(fireEvent.keyDown(field, { key: 'Enter', code: 'Enter', repeat: true, isComposing: true })).toBe(true);
    expect(fireEvent.keyDown(field, { key: 'Process', code: 'Enter', repeat: true, keyCode: 229 })).toBe(true);
    expect(onKeyDown).toHaveBeenCalledTimes(2);
  });

  it('TextArea lets Enter repeat: a held Enter adds lines', () => {
    show(<TextArea aria-label="Notes" />);
    expect(repeatOf(screen.getByRole('textbox', { name: 'Notes' }), 'Enter', 'Enter')).toBe(true);
  });
});
