import { describe, expect, it } from 'vitest';
import { sanitizeUntrustedPromptField } from './untrustedText';

describe('sanitizeUntrustedPromptField', () => {
  it('flattens whitespace runs and line breaks to single spaces', () => {
    expect(sanitizeUntrustedPromptField('a\n\n b\t c')).toBe('a b c');
  });

  it.each(['​', '⁠', '⁣', '﻿', '‮', ' '])('turns the invisible character %j into a space', (ch) => {
    expect(sanitizeUntrustedPromptField(`a${ch}b`)).toBe('a b');
    expect(sanitizeUntrustedPromptField(ch)).toBe('');
  });

  it('cuts to the limit with an ellipsis', () => {
    expect(sanitizeUntrustedPromptField('x'.repeat(300))).toHaveLength(201);
  });
});
