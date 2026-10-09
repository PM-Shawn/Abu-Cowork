// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPOSER_TYPING_MS, noteComposerDraft, noteComposerKey, userIsWritingAMessage } from './composerActivity';

describe('userIsWritingAMessage', () => {
  const owner = {};
  let field: HTMLTextAreaElement;
  let elsewhere: HTMLButtonElement;

  // Each test's fake clock starts from nothing again, and the last key is remembered across tests:
  // each test starts later than every test before it.
  let start = 0;
  beforeEach(() => {
    // The clock the helper reads (`performance.now()`) moves only when a test moves it.
    vi.useFakeTimers();
    start += 100_000;
    vi.advanceTimersByTime(start);
    field = document.createElement('textarea');
    field.setAttribute('data-chat-composer', '');
    elsewhere = document.createElement('button');
    document.body.append(field, elsewhere);
  });
  afterEach(() => {
    noteComposerDraft(owner, false);
    field.remove();
    elsewhere.remove();
    vi.useRealTimers();
  });

  it('is false with the focus in an empty message field that no key was pressed in', () => {
    field.focus();
    expect(userIsWritingAMessage()).toBe(false);
  });

  it('is true with the focus in the message field while it holds a draft, however long ago the last key was', () => {
    field.focus();
    noteComposerDraft(owner, true);
    vi.advanceTimersByTime(60_000);
    expect(userIsWritingAMessage()).toBe(true);
    noteComposerDraft(owner, false);
    expect(userIsWritingAMessage()).toBe(false);
  });

  it('is true for one second after a key went down in the message field, and no longer', () => {
    field.focus();
    noteComposerKey();
    vi.advanceTimersByTime(COMPOSER_TYPING_MS - 1);
    expect(userIsWritingAMessage()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(userIsWritingAMessage()).toBe(false);
  });

  it('is false when the focus is anywhere else, with a draft and a key just pressed', () => {
    noteComposerDraft(owner, true);
    noteComposerKey();
    elsewhere.focus();
    expect(userIsWritingAMessage()).toBe(false);
    elsewhere.blur();
    expect(document.activeElement).toBe(document.body);
    expect(userIsWritingAMessage()).toBe(false);
  });

  it('counts the editable box the field becomes with a skill tag, and a control inside it', () => {
    const box = document.createElement('div');
    box.setAttribute('data-chat-composer', '');
    box.tabIndex = 0;
    const inner = document.createElement('button');
    box.append(inner);
    document.body.append(box);
    noteComposerDraft(owner, true);
    box.focus();
    expect(userIsWritingAMessage()).toBe(true);
    inner.focus();
    expect(userIsWritingAMessage()).toBe(true);
    box.remove();
  });

  it('keeps the draft of one message field apart from another\'s', () => {
    const other = {};
    field.focus();
    noteComposerDraft(owner, true);
    noteComposerDraft(other, true);
    noteComposerDraft(owner, false);
    expect(userIsWritingAMessage()).toBe(true);
    noteComposerDraft(other, false);
    expect(userIsWritingAMessage()).toBe(false);
  });
});
