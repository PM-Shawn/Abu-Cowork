// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { focusComposer } from './composerFocus';

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
