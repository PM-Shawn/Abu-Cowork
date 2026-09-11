import { describe, it, expect } from 'vitest';
import { PET_POSITION_EVENT, parsePetPosition } from './petPositionSync';

describe('petPositionSync', () => {
  it('uses the event name the Electron boundary lets the pet window emit', () => {
    // electron/securityBoundary.cjs RESTRICTED_EMITTED_EVENTS['pet'] lists it.
    expect(PET_POSITION_EVENT).toBe('pet-position-changed');
  });

  describe('parsePetPosition', () => {
    it('accepts finite physical coordinates, including edge-snapped negatives', () => {
      expect(parsePetPosition({ x: 480, y: 360 })).toEqual({ x: 480, y: 360 });
      expect(parsePetPosition({ x: -64, y: 0 })).toEqual({ x: -64, y: 0 });
    });

    it('drops extra fields', () => {
      expect(parsePetPosition({ x: 1, y: 2, label: 'main' })).toEqual({ x: 1, y: 2 });
    });

    it('rejects anything that is not two finite numbers', () => {
      for (const bad of [
        null,
        undefined,
        7,
        'x',
        {},
        { x: 1 },
        { x: '1', y: 2 },
        { x: Number.NaN, y: 2 },
        { x: 1, y: Number.POSITIVE_INFINITY },
      ]) {
        expect(parsePetPosition(bad)).toBeNull();
      }
    });
  });
});
