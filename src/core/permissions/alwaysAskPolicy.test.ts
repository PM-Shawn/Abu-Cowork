import { describe, expect, it } from 'vitest';
import { isAlwaysAskAction, mayOfferPersistentGrant } from './alwaysAskPolicy';

// The floor exists so a *caller* mistake cannot become a permanent grant.
// Every test here is written from that angle: the caller asks for
// persistence, and the floor decides whether it survives.
describe('alwaysAskPolicy', () => {
  describe('isAlwaysAskAction', () => {
    it('treats danger- and block-level actions as always-ask', () => {
      expect(isAlwaysAskAction({ level: 'danger' })).toBe(true);
      expect(isAlwaysAskAction({ level: 'block' })).toBe(true);
    });

    it('treats self-extension as always-ask regardless of its danger level', () => {
      expect(isAlwaysAskAction({ level: 'safe', kind: 'self-extension' })).toBe(true);
      expect(isAlwaysAskAction({ level: 'warn', kind: 'self-extension' })).toBe(true);
    });

    it('leaves ordinary warn/safe actions eligible for persistence', () => {
      expect(isAlwaysAskAction({ level: 'warn', kind: 'browser' })).toBe(false);
      expect(isAlwaysAskAction({ level: 'safe', kind: 'command' })).toBe(false);
    });
  });

  describe('mayOfferPersistentGrant', () => {
    it('only ever lowers the caller ceiling — never raises it', () => {
      // Caller said no → still no, whatever the classification.
      expect(mayOfferPersistentGrant({ level: 'safe', kind: 'browser' })).toBe(false);
      expect(
        mayOfferPersistentGrant({ level: 'safe', kind: 'browser', allowPersistentGrant: false }),
      ).toBe(false);
    });

    it('lets the ordinary browser case through (the whole point of site grants)', () => {
      expect(
        mayOfferPersistentGrant({ level: 'warn', kind: 'browser', allowPersistentGrant: true }),
      ).toBe(true);
    });

    it('refuses persistence for a danger-level action even when the caller allowed it', () => {
      expect(
        mayOfferPersistentGrant({ level: 'danger', kind: 'browser', allowPersistentGrant: true }),
      ).toBe(false);
      expect(
        mayOfferPersistentGrant({ level: 'block', kind: 'browser', allowPersistentGrant: true }),
      ).toBe(false);
    });

    it('refuses persistence for self-extension even when the caller allowed it', () => {
      expect(
        mayOfferPersistentGrant({
          level: 'warn',
          kind: 'self-extension',
          allowPersistentGrant: true,
        }),
      ).toBe(false);
    });
  });
});
