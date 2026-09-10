/**
 * Unit tests for `sandboxBlockClass` — the reader that maps the host's
 * `[sandbox-blocked] <reasons>` line back to a violation class, so callers
 * can react per class instead of treating every block as a blocked write.
 */
import { describe, it, expect } from 'vitest';
import { sandboxBlockClass } from './blockClass';

describe('sandboxBlockClass', () => {
  it('returns null when stderr carries no annotation', () => {
    expect(sandboxBlockClass('zsh:1: operation not permitted: ps')).toBeNull();
    expect(sandboxBlockClass('')).toBeNull();
  });

  it('reads the exec class', () => {
    expect(
      sandboxBlockClass('[sandbox-blocked] command execution blocked by sandbox policy (exec)\n\nzsh:1: operation not permitted: ps'),
    ).toBe('exec');
  });

  it('reads the write class', () => {
    expect(sandboxBlockClass('[sandbox-blocked] file write blocked by sandbox policy\n\noperation not permitted')).toBe('write');
  });

  it('reads the read class', () => {
    expect(sandboxBlockClass('[sandbox-blocked] file read blocked by sandbox policy\n\noperation not permitted')).toBe('read');
  });

  it('reads the network class', () => {
    expect(sandboxBlockClass('[sandbox-blocked] network access blocked by sandbox policy\n\noperation not permitted')).toBe('network');
    expect(sandboxBlockClass('[sandbox-blocked] DNS resolution blocked — network isolation is active')).toBe('network');
  });

  it('reads the unclassified fallback', () => {
    expect(sandboxBlockClass('[sandbox-blocked] blocked by sandbox policy (unclassified)\n\noperation not permitted')).toBe('unclassified');
  });

  it('does not claim a class from an unrecognised reason', () => {
    expect(sandboxBlockClass('[sandbox-blocked] access denied — possibly blocked by sandbox policy')).toBe('unclassified');
  });

  it('only reads the annotation line, not the raw stderr below it', () => {
    expect(
      sandboxBlockClass('[sandbox-blocked] file write blocked by sandbox policy\n\nsh: cannot create /x: operation not permitted'),
    ).toBe('write');
  });
});
