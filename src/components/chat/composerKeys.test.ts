import { describe, expect, it } from 'vitest';
import { insertNewlineAtCursor, isImeComposing, resolveEnterAction } from './composerKeys';
import type { EnterAction } from './composerKeys';

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

describe('resolveEnterAction', () => {
  const press = (mods: Partial<Record<'shiftKey' | 'altKey' | 'metaKey' | 'ctrlKey', boolean>> = {}) => ({
    shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, ...mods,
  });

  /**
   * Exhaustive parity guard.
   *
   * `enter` is the default, so introducing the setting must not change a
   * single keystroke for users who never touch it. Hand-picked cases already
   * missed this once: the send-modifier test originally ran unconditionally
   * and silently turned ⌘+⌥+Enter and ⌘+Shift+Enter from "insert a newline"
   * into "send", on both platforms. Replaying the pre-change logic over every
   * modifier combination is what actually catches that class of regression.
   */
  describe("behavior 'enter' matches the pre-setting behavior for every modifier combo", () => {
    /**
     * handleKeyDown before the setting existed, verbatim:
     *   if (Enter && altKey && !composing)            -> insert newline
     *   if (Enter && !shiftKey && !altKey && !composing) -> send
     *   otherwise                                     -> fall through to the textarea
     */
    const previousBehavior = (e: { shiftKey: boolean; altKey: boolean }): EnterAction =>
      e.altKey ? 'insert' : e.shiftKey ? 'native' : 'send';

    const combos = [
      {}, { shiftKey: true }, { altKey: true }, { metaKey: true }, { ctrlKey: true },
      { metaKey: true, altKey: true }, { metaKey: true, shiftKey: true },
      { ctrlKey: true, altKey: true }, { ctrlKey: true, shiftKey: true },
      { shiftKey: true, altKey: true },
    ];

    for (const isMac of [true, false]) {
      for (const combo of combos) {
        it(`${isMac ? 'macOS' : 'Windows'} ${JSON.stringify(combo)}`, () => {
          const e = press(combo);
          expect(resolveEnterAction(e, { behavior: 'enter', isMac })).toBe(previousBehavior(e));
        });
      }
    }
  });

  describe("behavior 'enter' (default)", () => {
    const enter = { behavior: 'enter' as const, isMac: true };

    it('sends on a bare Enter', () => {
      expect(resolveEnterAction(press(), enter)).toBe('send');
    });

    it('leaves Shift+Enter to the textarea', () => {
      expect(resolveEnterAction(press({ shiftKey: true }), enter)).toBe('native');
    });

    it('inserts on Alt+Enter, which is not a native editing command', () => {
      expect(resolveEnterAction(press({ altKey: true }), enter)).toBe('insert');
    });

    it('still sends on Cmd+Enter, as it always did', () => {
      expect(resolveEnterAction(press({ metaKey: true }), enter)).toBe('send');
    });

    it('sends on Ctrl+Enter on a Mac, because only Shift and Alt ever meant "not a send"', () => {
      expect(resolveEnterAction(press({ ctrlKey: true }), enter)).toBe('send');
    });

    it('inserts, not sends, when the send modifier is held together with Alt', () => {
      expect(resolveEnterAction(press({ metaKey: true, altKey: true }), enter)).toBe('insert');
    });

    it('leaves it to the textarea when the send modifier is held together with Shift', () => {
      expect(resolveEnterAction(press({ metaKey: true, shiftKey: true }), enter)).toBe('native');
    });
  });

  describe("behavior 'newline'", () => {
    const newline = { behavior: 'newline' as const, isMac: true };

    it('lets a bare Enter fall through to the textarea instead of sending', () => {
      expect(resolveEnterAction(press(), newline)).toBe('native');
    });

    it('sends on Cmd+Enter — the only way to send in this mode', () => {
      expect(resolveEnterAction(press({ metaKey: true }), newline)).toBe('send');
    });

    it('keeps Shift+Enter and Alt+Enter inserting newlines', () => {
      expect(resolveEnterAction(press({ shiftKey: true }), newline)).toBe('native');
      expect(resolveEnterAction(press({ altKey: true }), newline)).toBe('insert');
    });
  });

  describe('send modifier follows the platform', () => {
    it('uses Ctrl+Enter off macOS', () => {
      expect(resolveEnterAction(press({ ctrlKey: true }), { behavior: 'newline', isMac: false })).toBe('send');
    });

    it('does not treat the Windows key as a send modifier', () => {
      expect(resolveEnterAction(press({ metaKey: true }), { behavior: 'newline', isMac: false })).toBe('native');
    });

    it('does not treat Ctrl as a send modifier on macOS', () => {
      expect(resolveEnterAction(press({ ctrlKey: true }), { behavior: 'newline', isMac: true })).toBe('native');
    });
  });
});
