import { describe, it, expect } from 'vitest';
import { mergeComposerAppend } from './ChatInput';

describe('mergeComposerAppend — window.sendPrompt draft merge (C1)', () => {
  it('appends with a newline separator when the draft is non-empty', () => {
    expect(mergeComposerAppend('user was typing', 'widget follow-up')).toBe('user was typing\nwidget follow-up');
  });

  it('uses the addition verbatim when the draft is empty', () => {
    expect(mergeComposerAppend('', 'widget follow-up')).toBe('widget follow-up');
  });

  it('treats a whitespace-only draft as empty (no leading blank line)', () => {
    expect(mergeComposerAppend('   \n  ', 'widget follow-up')).toBe('widget follow-up');
  });

  it('never clobbers the existing draft — the original text is preserved as a prefix', () => {
    const prev = 'important draft I do not want to lose';
    expect(mergeComposerAppend(prev, 'x')).toContain(prev);
  });
});
