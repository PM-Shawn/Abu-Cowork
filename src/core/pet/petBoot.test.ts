import { describe, it, expect } from 'vitest';
import { resolvePetBootAction } from './petBoot';

describe('resolvePetBootAction', () => {
  it('unlocked + open → show', () => {
    expect(resolvePetBootAction(true, true)).toBe('show');
  });

  it('unlocked + closed → none', () => {
    expect(resolvePetBootAction(true, false)).toBe('none');
  });

  it('locked + open → hide (stale intent)', () => {
    expect(resolvePetBootAction(false, true)).toBe('hide');
  });

  it('locked + closed → none', () => {
    expect(resolvePetBootAction(false, false)).toBe('none');
  });
});
