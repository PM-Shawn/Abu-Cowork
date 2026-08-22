/**
 * Keyboard helpers for the chat composer.
 *
 * Lives outside ChatInput.tsx so the two behaviors users actually complained
 * about — "Enter fires while my IME is still composing" and "the caret jumps
 * after Option+Enter" — can be unit-tested without mounting the composer.
 */

/**
 * True while an IME composition owns this key event, i.e. the keystroke is
 * the user talking to their input method, not to us.
 *
 * Three signals, because no single one covers every platform we ship on:
 *
 *  - `nativeEvent.isComposing` — the standard flag. Chromium sets it on
 *    keydown fired inside a composition session.
 *  - `keyCode === 229` — what Windows IMEs (搜狗 / 微信 / 微软拼音) report for
 *    every composition keydown. Some of them never set `isComposing`, so on
 *    Windows this is the signal that actually fires. Deprecated on the web
 *    platform but still the only reliable Windows IME tell.
 *  - `composing` — our own compositionstart/compositionend flag. WebKit fires
 *    `compositionend` BEFORE the Enter keydown that committed the candidate,
 *    so ChatInput resets the flag one macrotask late and this keeps that
 *    keydown guarded.
 *
 * Matches what ChatGPT's desktop composer does (`isComposing || keyCode === 229`),
 * plus our WebKit-ordering fallback.
 */
export function isImeComposing(
  e: Pick<React.KeyboardEvent, 'keyCode'> & { nativeEvent: Pick<KeyboardEvent, 'isComposing'> },
  composing: boolean,
): boolean {
  return composing || e.nativeEvent.isComposing || e.keyCode === 229;
}

/**
 * Insert a newline at the caret and return the resulting value.
 *
 * `setRangeText` mutates the DOM node synchronously and we place the caret
 * ourselves, so the caller can push the same value into React state without
 * the caret ever being wrong in between. The previous implementation set
 * state first and restored the caret in a `requestAnimationFrame`, which lost
 * the race against fast typing — characters typed before the frame ran landed
 * at the old offset and came out reordered (firsthand: typing 第三行 right
 * after Option+Enter produced 三行第).
 *
 * The caret is assigned explicitly rather than via `selectionMode: 'end'`,
 * whose jsdom implementation disagrees with the spec — keeping the two engines
 * we run on (Chromium in the app, jsdom in unit tests) on one behavior.
 */
export function insertNewlineAtCursor(textarea: HTMLTextAreaElement): string {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  textarea.setRangeText('\n', start, end);
  textarea.selectionStart = start + 1;
  textarea.selectionEnd = start + 1;
  return textarea.value;
}
