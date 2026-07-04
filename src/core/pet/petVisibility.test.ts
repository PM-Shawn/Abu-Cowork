import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setPetVisible, hidePet } from './petVisibility';

// Local proxy lets each test control resolve/reject independently.
const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

describe('petVisibility', () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  describe('setPetVisible(true)', () => {
    it('invokes pet_show and returns true on resolve', async () => {
      invoke.mockResolvedValue(undefined);
      const result = await setPetVisible(true);
      expect(invoke).toHaveBeenCalledWith('pet_show');
      expect(result).toBe(true);
    });
  });

  describe('setPetVisible(false)', () => {
    it('invokes pet_hide and returns true on resolve', async () => {
      invoke.mockResolvedValue(undefined);
      const result = await setPetVisible(false);
      expect(invoke).toHaveBeenCalledWith('pet_hide');
      expect(result).toBe(true);
    });
  });

  describe('setPetVisible when invoke rejects', () => {
    it('returns false without throwing', async () => {
      invoke.mockRejectedValue(new Error('window not found'));
      const result = await setPetVisible(true);
      expect(result).toBe(false);
    });
  });

  describe('hidePet()', () => {
    it('invokes pet_hide and returns true on resolve', async () => {
      invoke.mockResolvedValue(undefined);
      const result = await hidePet();
      expect(invoke).toHaveBeenCalledWith('pet_hide');
      expect(result).toBe(true);
    });
  });
});
