// @vitest-environment happy-dom
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dropsHeldEnter, dropsHeldRepeat, keysDown, oncePerPress, trackKeysDown, useHeldKeys } from './heldKey';

// A key event as a control's handler receives it.
function keyEvent(init: { key: string; code?: string; repeat?: boolean; keyCode?: number; isComposing?: boolean }) {
  return {
    key: init.key,
    code: init.code ?? '',
    repeat: init.repeat ?? false,
    keyCode: init.keyCode ?? 0,
    nativeEvent: { isComposing: init.isComposing ?? false },
    preventDefault: vi.fn(),
  };
}

describe('the keys that are down', () => {
  let stop: () => void;
  beforeEach(() => { stop = trackKeysDown(); });
  afterEach(() => { stop(); });

  it('holds a key from its first key-down to its key-up, by its place on the keyboard', () => {
    fireEvent.keyDown(document.body, { key: 'Enter', code: 'Enter' });
    expect(keysDown.has('Enter')).toBe(true);
    fireEvent.keyDown(document.body, { key: 'Enter', code: 'Enter', repeat: true });
    expect([...keysDown.keys()]).toEqual(['Enter']);
    fireEvent.keyUp(document.body, { key: 'Enter', code: 'Enter' });
    expect(keysDown.has('Enter')).toBe(false);
  });

  it('knows the key by its code when an input method or Shift changes what it types', () => {
    fireEvent.keyDown(document.body, { key: 'Process', code: 'KeyA' });
    expect(keysDown.has('KeyA')).toBe(true);
    // Shift released first: the key-up names another character, the same key.
    fireEvent.keyUp(document.body, { key: 'a', code: 'KeyA' });
    expect(keysDown.size).toBe(0);
  });

  it('falls back to the key name for an event that names no code', () => {
    fireEvent.keyDown(document.body, { key: 'Enter' });
    expect(keysDown.has('Enter')).toBe(true);
    fireEvent.keyUp(document.body, { key: 'Enter' });
    expect(keysDown.size).toBe(0);
  });

  it('does not take a repeat for a press: a key whose first key-down the page never heard is not down', () => {
    fireEvent.keyDown(document.body, { key: 'Enter', code: 'Enter', repeat: true });
    expect(keysDown.size).toBe(0);
  });

  it('gives each press a later number than the one before', () => {
    fireEvent.keyDown(document.body, { key: 'a', code: 'KeyA' });
    fireEvent.keyDown(document.body, { key: 'b', code: 'KeyB' });
    expect(keysDown.get('KeyB')).toBeGreaterThan(keysDown.get('KeyA') ?? Number.NaN);
    fireEvent.keyUp(document.body, { key: 'a', code: 'KeyA' });
    fireEvent.keyDown(document.body, { key: 'a', code: 'KeyA' });
    expect(keysDown.get('KeyA')).toBeGreaterThan(keysDown.get('KeyB') ?? Number.NaN);
  });

  it('forgets every key when the window loses the focus: a key-up that happens elsewhere is never heard', () => {
    fireEvent.keyDown(document.body, { key: 'Enter', code: 'Enter' });
    fireEvent.keyDown(document.body, { key: 'Tab', code: 'Tab' });
    fireEvent.blur(window);
    expect(keysDown.size).toBe(0);
  });

  it('does not forget them when the focus moves between two elements of the page', () => {
    const field = document.createElement('input');
    document.body.append(field);
    field.focus();
    fireEvent.keyDown(field, { key: 'Tab', code: 'Tab' });
    fireEvent.blur(field);
    expect(keysDown.has('Tab')).toBe(true);
    field.remove();
  });

  it('forgets every key when the page is hidden', () => {
    fireEvent.keyDown(document.body, { key: 'Enter', code: 'Enter' });
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    fireEvent(document, new Event('visibilitychange'));
    expect(keysDown.size).toBe(0);
    visibility.mockRestore();
  });

  it('stops listening, and forgets, when the last of its users has gone', () => {
    const second = trackKeysDown();
    fireEvent.keyDown(document.body, { key: 'Enter', code: 'Enter' });
    second();
    expect(keysDown.has('Enter')).toBe(true);
    stop();
    expect(keysDown.size).toBe(0);
    fireEvent.keyDown(document.body, { key: 'Tab', code: 'Tab' });
    expect(keysDown.size).toBe(0);
    // afterEach stops once more: stopping twice does nothing.
  });
});

describe('dropsHeldRepeat: a control acts once per press of Enter or Space', () => {
  it.each([
    ['Enter', { key: 'Enter', code: 'Enter' }],
    ['the keypad Enter', { key: 'Enter', code: 'NumpadEnter' }],
    ['Space', { key: ' ', code: 'Space' }],
    ['Enter named by its key alone', { key: 'Enter' }],
    ['Space named by its key alone', { key: ' ' }],
  ])('drops the repeat of %s', (_name, init) => {
    const event = keyEvent({ ...init, repeat: true });
    expect(dropsHeldRepeat(event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['the first press of Enter', { key: 'Enter', code: 'Enter', repeat: false }],
    ['the first press of Space', { key: ' ', code: 'Space', repeat: false }],
    ['a repeating letter', { key: 'a', code: 'KeyA', repeat: true }],
    ['a repeating arrow', { key: 'ArrowDown', code: 'ArrowDown', repeat: true }],
    ['a repeating Tab', { key: 'Tab', code: 'Tab', repeat: true }],
    ['a repeating Escape', { key: 'Escape', code: 'Escape', repeat: true }],
  ])('leaves %s alone', (_name, init) => {
    const event = keyEvent(init);
    expect(dropsHeldRepeat(event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});

describe('dropsHeldEnter: a text field', () => {
  it('drops a repeating Enter', () => {
    const event = keyEvent({ key: 'Enter', code: 'Enter', repeat: true });
    expect(dropsHeldEnter(event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['the first press of Enter', { key: 'Enter', code: 'Enter', repeat: false }],
    ['a repeating Space', { key: ' ', code: 'Space', repeat: true }],
    ['a repeating Backspace', { key: 'Backspace', code: 'Backspace', repeat: true }],
    ['a repeating arrow', { key: 'ArrowLeft', code: 'ArrowLeft', repeat: true }],
    ['a repeating Enter that belongs to an input method', { key: 'Enter', code: 'Enter', repeat: true, isComposing: true }],
    ['a repeating Enter an input method reports as key code 229', { key: 'Process', code: 'Enter', repeat: true, keyCode: 229 }],
  ])('leaves %s alone', (_name, init) => {
    const event = keyEvent(init);
    expect(dropsHeldEnter(event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});

describe('oncePerPress', () => {
  it('runs the handler for a first press and for other keys, and not for a dropped repeat', () => {
    const handler = vi.fn();
    const wrapped = oncePerPress(handler);
    wrapped(keyEvent({ key: 'Enter', code: 'Enter' }));
    wrapped(keyEvent({ key: 'ArrowDown', code: 'ArrowDown', repeat: true }));
    expect(handler).toHaveBeenCalledTimes(2);
    const repeat = keyEvent({ key: 'Enter', code: 'Enter', repeat: true });
    wrapped(repeat);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(repeat.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('drops the repeat with no handler given', () => {
    const repeat = keyEvent({ key: ' ', code: 'Space', repeat: true });
    oncePerPress()(repeat);
    expect(repeat.preventDefault).toHaveBeenCalledTimes(1);
  });
});

describe('useHeldKeys: a layer and the keys that were down when it was shown', () => {
  let stop: () => void;
  beforeEach(() => { stop = trackKeysDown(); });
  afterEach(() => { cleanup(); stop(); });

  // A container that takes the layer's handlers, with one control in it that hears key-downs.
  function setup() {
    const heard = vi.fn();
    const hook = renderHook(() => useHeldKeys());
    const view = render(createElement('div', { ...hook.result.current.handlers, 'data-testid': 'layer' },
      createElement('input', { 'aria-label': 'Inside', onKeyDown: (event: { key: string }) => heard(event.key) })));
    const inside = view.getByLabelText('Inside');
    inside.focus();
    return { heard, inside, shown: () => act(() => { hook.result.current.mark(); }), hook };
  }
  const down = (target: Element, key: string, code = key) => fireEvent.keyDown(target, { key, code });
  const repeat = (target: Element, key: string, code = key) => fireEvent.keyDown(target, { key, code, repeat: true });
  const up = (target: Element, key: string, code = key) => fireEvent.keyUp(target, { key, code });

  it('drops the repeats of a key that was down before it was shown, and stops them there', () => {
    down(document.body, 'Enter');
    const { heard, inside, shown } = setup();
    shown();
    // fireEvent returns false once the default was prevented.
    expect(repeat(inside, 'Enter')).toBe(false);
    expect(repeat(inside, 'Enter')).toBe(false);
    expect(heard).not.toHaveBeenCalled();
  });

  it('takes the same key again once it was released and pressed anew, repeats included', () => {
    down(document.body, 'Enter');
    const { heard, inside, shown } = setup();
    shown();
    repeat(inside, 'Enter');
    up(inside, 'Enter');
    expect(down(inside, 'Enter')).toBe(true);
    expect(repeat(inside, 'Enter')).toBe(true);
    expect(heard.mock.calls).toEqual([['Enter'], ['Enter']]);
  });

  it('leaves alone the repeats of a key pressed after it was shown', () => {
    down(document.body, 'Enter');
    const { heard, inside, shown } = setup();
    shown();
    expect(down(inside, 'ArrowDown')).toBe(true);
    expect(repeat(inside, 'ArrowDown')).toBe(true);
    expect(repeat(inside, 'ArrowDown')).toBe(true);
    expect(heard.mock.calls).toEqual([['ArrowDown'], ['ArrowDown'], ['ArrowDown']]);
  });

  it('never drops a first press, whatever was down before', () => {
    down(document.body, 'Tab');
    const { heard, inside, shown } = setup();
    shown();
    expect(down(inside, 'Tab')).toBe(true);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('counts again from the moment it is shown again: a key pressed in it earlier and still down is dropped from then on', () => {
    const { heard, inside, shown } = setup();
    shown();
    down(inside, 'Enter');
    expect(repeat(inside, 'Enter')).toBe(true);
    shown();
    expect(repeat(inside, 'Enter')).toBe(false);
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it('leaves alone the repeats of a key it does not know to be down (it went down in a frame or in another window)', () => {
    const { heard, inside, shown } = setup();
    shown();
    expect(repeat(inside, 'Tab')).toBe(true);
    expect(repeat(inside, 'ArrowDown')).toBe(true);
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it('drops the repeat of every key that is down before it was ever shown', () => {
    const { heard, inside } = setup();
    down(inside, 'ArrowDown');
    expect(repeat(inside, 'ArrowDown')).toBe(false);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('works again after a key-up the page never heard: the next press of that key is a first press', () => {
    down(document.body, 'Enter');
    const { heard, inside, shown } = setup();
    shown();
    expect(repeat(inside, 'Enter')).toBe(false);
    // The key is released while another application has the focus; the window comes back.
    fireEvent.blur(window);
    expect(down(inside, 'Enter')).toBe(true);
    expect(repeat(inside, 'Enter')).toBe(true);
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it('works again after a lost key-up even when the window never reported losing the focus', () => {
    down(document.body, 'ArrowDown');
    const { heard, inside, shown } = setup();
    shown();
    expect(repeat(inside, 'ArrowDown')).toBe(false);
    expect(down(inside, 'ArrowDown')).toBe(true);
    expect(repeat(inside, 'ArrowDown')).toBe(true);
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it('keeps a key pressed inside it repeating after the window was away and came back', () => {
    const { heard, inside, shown } = setup();
    shown();
    down(inside, 'ArrowDown');
    expect(repeat(inside, 'ArrowDown')).toBe(true);
    fireEvent.blur(window);
    expect(repeat(inside, 'ArrowDown')).toBe(true);
    expect(heard).toHaveBeenCalledTimes(3);
  });

  // The price of forgetting on a loss of focus: the page no longer knows that the key is held.
  it('no longer drops a key that was down before it was shown once the window has lost the focus with the key still down', () => {
    down(document.body, 'Tab');
    const { heard, inside, shown } = setup();
    shown();
    expect(repeat(inside, 'Tab')).toBe(false);
    fireEvent.blur(window);
    expect(repeat(inside, 'Tab')).toBe(true);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('leaves Escape alone: the layer below the handlers decides what a held Escape does', () => {
    down(document.body, 'Escape');
    const { heard, inside, shown } = setup();
    shown();
    expect(repeat(inside, 'Escape')).toBe(true);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('leaves alone a key that belongs to an input method', () => {
    down(document.body, 'a', 'KeyA');
    const { heard, inside, shown } = setup();
    shown();
    expect(fireEvent.keyDown(inside, { key: 'Process', code: 'KeyA', repeat: true, isComposing: true })).toBe(true);
    expect(fireEvent.keyDown(inside, { key: 'Process', code: 'KeyA', repeat: true, keyCode: 229 })).toBe(true);
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it('keeps the same handlers between renders', () => {
    const { hook } = setup();
    const first = hook.result.current;
    hook.rerender();
    expect(hook.result.current).toBe(first);
  });

  it('marks by itself each time it is told the layer is shown', () => {
    const heard = vi.fn();
    const hook = renderHook(({ shown }: { shown: boolean }) => useHeldKeys(shown), { initialProps: { shown: false } });
    const view = render(createElement('div', hook.result.current.handlers, createElement('input', { 'aria-label': 'Inside', onKeyDown: heard })));
    const inside = view.getByLabelText('Inside');
    down(inside, 'ArrowDown');
    hook.rerender({ shown: true });
    expect(repeat(inside, 'ArrowDown')).toBe(false);
    up(inside, 'ArrowDown');
    down(inside, 'ArrowDown');
    expect(repeat(inside, 'ArrowDown')).toBe(true);
    // Closed and shown again with the key still down.
    hook.rerender({ shown: false });
    hook.rerender({ shown: true });
    expect(repeat(inside, 'ArrowDown')).toBe(false);
  });

  describe('a list whose rows act on a key-down', () => {
    function list(chooses: 'enter' | 'enter-space') {
      const heard = vi.fn();
      const hook = renderHook(() => useHeldKeys(true, chooses));
      const view = render(createElement('div', hook.result.current.handlers,
        createElement('input', { 'aria-label': 'Row', onKeyDown: (event: { key: string }) => heard(event.key) })));
      return { heard, row: view.getByLabelText('Row') };
    }

    it('chooses once per press of Enter or Space: their repeats are dropped though the key went down inside it', () => {
      const { heard, row } = list('enter-space');
      expect(down(row, 'Enter')).toBe(true);
      expect(repeat(row, 'Enter')).toBe(false);
      expect(repeat(row, 'Enter', 'NumpadEnter')).toBe(false);
      expect(down(row, ' ', 'Space')).toBe(true);
      expect(repeat(row, ' ', 'Space')).toBe(false);
      expect(heard.mock.calls).toEqual([['Enter'], [' ']]);
    });

    it('still lets the arrows pressed inside it repeat', () => {
      const { heard, row } = list('enter-space');
      down(row, 'ArrowDown');
      expect(repeat(row, 'ArrowDown')).toBe(true);
      expect(heard).toHaveBeenCalledTimes(2);
    });

    it('with a search box, drops the repeats of Enter only: Space types and repeats', () => {
      const { heard, row } = list('enter');
      down(row, 'Enter');
      expect(repeat(row, 'Enter')).toBe(false);
      down(row, ' ', 'Space');
      expect(repeat(row, ' ', 'Space')).toBe(true);
      expect(heard.mock.calls).toEqual([['Enter'], [' '], [' ']]);
    });
  });
});
