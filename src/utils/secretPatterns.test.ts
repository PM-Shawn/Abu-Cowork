import { describe, expect, it } from 'vitest';
import { redactTraceSecrets } from './secretPatterns';
import { scrubSecrets } from '../core/diagnostic/scrub';

describe('redactTraceSecrets', () => {
  it.each([
    ['key sk-abcdefghijkl end', 'key [REDACTED] end'],
    ['key sk-ant-abcdef123456 end', 'key [REDACTED] end'],
    ['Authorization: Bearer abcdefgh', '[REDACTED]'],
    ['jwt eyJabcdefgh.eyJabcdefgh.abcdefgh end', 'jwt [REDACTED] end'],
    ['password=hunter2', '[REDACTED]'],
  ])('redacts %s', (text, expected) => expect(redactTraceSecrets(text)).toBe(expected));

  it('keeps a word that only starts like a key', () => {
    expect(redactTraceSecrets('desk-lamp-12345678901234')).toBe('desk-lamp-12345678901234');
  });
});

describe('one threshold everywhere', () => {
  it('the diagnostic bundle redacts the 15-character key the trace redacts', () => {
    const text = 'rejected sk-abcdefghijkl';
    expect(redactTraceSecrets(text)).not.toContain('sk-abc');
    expect(scrubSecrets(text)).not.toContain('sk-abc');
  });
});
