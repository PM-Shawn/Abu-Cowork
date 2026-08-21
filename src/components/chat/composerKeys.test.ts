import { describe, expect, it } from 'vitest';
import { insertNewlineAtCursor, isImeComposing } from './composerKeys';

/** Minimal stand-in for the fields isImeComposing actually reads. */
const keyEvent = (opts: { keyCode?: number; isComposing?: boolean } = {}) => ({
  keyCode: opts.keyCode ?? 13,
  nativeEvent: { isComposing: opts.isComposing ?? false },
});

describe('isImeComposing', () => {
  it('is false for a plain Enter outside any composition', () => {
    expect(isImeComposing(keyEvent(), false)).toBe(false);
  });

  it('honors the standard isComposing flag', () => {
    expect(isImeComposing(keyEvent({ isComposing: true }), false)).toBe(true);
  });

  it('honors keyCode 229, which is all a Windows IME reports', () => {
    // 搜狗 / 微信 / 微软拼音 fire keydown with keyCode 229 and, on some
    // builds, leave isComposing false. Without this arm the composer would
    // send half-typed pinyin on the Enter that commits the candidate.
    expect(isImeComposing(keyEvent({ keyCode: 229, isComposing: false }), false)).toBe(true);
  });

  it('honors our own flag, for WebKit firing compositionend before keydown', () => {
    expect(isImeComposing(keyEvent(), true)).toBe(true);
  });
});

describe('insertNewlineAtCursor', () => {
  const textarea = (value: string, start: number, end = start) => {
    const el = document.createElement('textarea');
    el.value = value;
    document.body.appendChild(el);
    el.setSelectionRange(start, end);
    return el;
  };

  it('inserts at the caret and returns the new value', () => {
    const el = textarea('ABCDEF', 3);
    expect(insertNewlineAtCursor(el)).toBe('ABC\nDEF');
    expect(el.value).toBe('ABC\nDEF');
  });

  it('leaves the caret directly after the newline, synchronously', () => {
    // The regression this guards: the old implementation restored the caret
    // in a requestAnimationFrame, so characters typed before that frame ran
    // landed at the stale offset and came out reordered.
    const el = textarea('ABC', 3);
    insertNewlineAtCursor(el);
    expect(el.selectionStart).toBe(4);
    expect(el.selectionEnd).toBe(4);
  });

  it('replaces the selection rather than duplicating it', () => {
    const el = textarea('ABCDEF', 1, 4);
    expect(insertNewlineAtCursor(el)).toBe('A\nEF');
    expect(el.selectionStart).toBe(2);
  });

  it('appends at the end when the caret sits at the end', () => {
    const el = textarea('AB', 2);
    expect(insertNewlineAtCursor(el)).toBe('AB\n');
    expect(el.selectionStart).toBe(3);
  });
});
