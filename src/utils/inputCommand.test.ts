import { describe, expect, it } from 'vitest';
import { mergeDraftPrefill, splitInputCommand } from './inputCommand';

describe('input command boundaries', () => {
  it.each(['/', '@'] as const)('preserves multiline %s bodies', (prefix) => {
    const body = '  first\nsecond\n';
    expect(splitInputCommand(`${prefix}writer ${body}`)?.body).toBe(body);
    expect(splitInputCommand(`${prefix}writer first\n  second\n`)).toEqual({ prefix, name: 'writer', body: 'first\n  second\n' });
    expect(splitInputCommand(`${prefix}writer\n  code`)).toEqual({ prefix, name: 'writer', body: '\n  code' });
  });
  it('supports Unicode names and empty bodies without parsing ordinary prose', () => {
    expect(splitInputCommand(' /写作 ')).toEqual({ prefix: '/', name: '写作', body: '' });
    expect(splitInputCommand('/')).toBeNull();
    expect(splitInputCommand('hello /writer')).toBeNull();
  });
  it('appends templates without dropping or duplicating drafts', () => {
    expect(mergeDraftPrefill('draft\n  body', 'template')).toBe('draft\n  body\ntemplate');
    expect(mergeDraftPrefill('draft', '')).toBe('draft');
    expect(mergeDraftPrefill('', 'template')).toBe('template');
    expect(mergeDraftPrefill('same', 'same')).toBe('same');
  });
});
