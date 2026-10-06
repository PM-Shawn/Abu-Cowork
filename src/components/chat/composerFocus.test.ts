// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { focusComposer, focusComposerAfterPageChange } from './composerFocus';

function composer(disabled = false) {
  const field = document.createElement('textarea');
  field.setAttribute('data-chat-composer', '');
  field.disabled = disabled;
  document.body.append(field);
  return field;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('focusComposer', () => {
  it('puts the focus in the message field and says so', () => {
    const field = composer();

    expect(focusComposer()).toBe(true);
    expect(document.activeElement).toBe(field);
  });

  it('leaves the focus alone when the page has no message field', () => {
    const other = document.createElement('textarea');
    document.body.append(other);
    other.focus();

    expect(focusComposer()).toBe(false);
    expect(document.activeElement).toBe(other);
  });

  it('skips a message field that takes no input', () => {
    composer(true);

    expect(focusComposer()).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });
});

describe('focusComposerAfterPageChange', () => {
  let frames: FrameRequestCallback[];
  const nextFrame = () => frames.splice(0).forEach((frame) => frame(0));

  beforeEach(() => {
    frames = [];
    vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => frames.push(frame));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function layer(attributes: Record<string, string>) {
    const box = document.createElement('div');
    box.setAttribute('data-ds-layer', '');
    for (const [name, value] of Object.entries(attributes)) box.setAttribute(name, value);
    const button = document.createElement('button');
    box.append(button);
    document.body.append(box);
    return button;
  }

  it('puts the focus in the message field on the next frame, not before', () => {
    const field = composer();

    focusComposerAfterPageChange();
    expect(document.activeElement).toBe(document.body);
    nextFrame();
    expect(document.activeElement).toBe(field);
  });

  it('finds the message field that the new page has drawn by the next frame', () => {
    focusComposerAfterPageChange();
    const field = composer();
    nextFrame();
    expect(document.activeElement).toBe(field);
  });

  it('takes the focus from no control that has it', () => {
    composer();
    const other = document.createElement('button');
    document.body.append(other);

    focusComposerAfterPageChange();
    other.focus();
    nextFrame();
    expect(document.activeElement).toBe(other);
  });

  it('leaves the focus alone while a window, a question or an approval is on the page', () => {
    composer();
    layer({ role: 'alertdialog', 'data-state': 'open' });

    focusComposerAfterPageChange();
    nextFrame();
    expect(document.activeElement).toBe(document.body);
  });

  it('leaves the focus alone while a window is still fading out', () => {
    composer();
    layer({ role: 'dialog', 'data-state': 'closed' });

    focusComposerAfterPageChange();
    nextFrame();
    expect(document.activeElement).toBe(document.body);
  });

  it('does not count a window that stepped aside and is hidden', () => {
    const field = composer();
    layer({ role: 'dialog', 'data-state': 'open', hidden: '' });

    focusComposerAfterPageChange();
    nextFrame();
    expect(document.activeElement).toBe(field);
  });
});
