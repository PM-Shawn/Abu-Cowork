// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { focusComposer, focusComposerAfterPageChange, focusComposerFromWindow, setComposerFieldFocus } from './composerFocus';

function composer(disabled = false) {
  const field = document.createElement('textarea');
  field.setAttribute('data-chat-composer', '');
  field.disabled = disabled;
  document.body.append(field);
  return field;
}

// The message field once it holds a skill tag: an editable text box.
function editableComposer(disabled = false) {
  const field = document.createElement('div');
  field.setAttribute('role', 'textbox');
  field.setAttribute('data-chat-composer', '');
  field.setAttribute('contenteditable', String(!disabled));
  if (disabled) field.setAttribute('aria-disabled', 'true');
  document.body.append(field);
  return field;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('focusComposer', () => {
  it('puts the focus in a message field that holds a skill tag and says so', () => {
    const field = editableComposer();

    expect(focusComposer()).toBe(true);
    expect(document.activeElement).toBe(field);
  });

  it('skips a message field with a skill tag that takes no input', () => {
    editableComposer(true);

    expect(focusComposer()).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });

  it('gives the focus through the way the field named for itself, which places its caret', () => {
    const field = editableComposer();
    const focus = vi.fn(() => field.focus());
    setComposerFieldFocus(field, focus);

    expect(focusComposer()).toBe(true);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(field);
  });

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

describe('focusComposerFromWindow', () => {
  it('puts the focus in a message field that holds a skill tag when no control has it', () => {
    const field = editableComposer();

    focusComposerFromWindow();
    expect(document.activeElement).toBe(field);
  });

  it('takes the focus from no control that has it', () => {
    editableComposer();
    const other = document.createElement('button');
    document.body.append(other);
    other.focus();

    focusComposerFromWindow();
    expect(document.activeElement).toBe(other);
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

  it('puts the focus in a message field that holds a skill tag on the next frame', () => {
    const field = editableComposer();

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
