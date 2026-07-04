/// <reference types="@testing-library/jest-dom" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PetSection from './PetSection';
import { useSettingsStore } from '@/stores/settingsStore';

// Local proxy so each test controls resolve/reject independently.
const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      settings: {
        petEnable: 'Desktop Pet',
        petEnableDesc: 'Show a floating pet on your desktop',
      },
    },
  }),
}));

describe('PetSection', () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
  });

  afterEach(cleanup);

  describe('toggling on (petOpen false → true)', () => {
    it('calls pet_show and sets petOpen=true', async () => {
      useSettingsStore.setState({ petOpen: false });
      const user = userEvent.setup();
      render(<PetSection />);

      const toggle = screen.getByRole('switch');
      await user.click(toggle);

      expect(invoke).toHaveBeenCalledWith('pet_show');
      expect(useSettingsStore.getState().petOpen).toBe(true);
    });
  });

  describe('toggling off (petOpen true → false)', () => {
    it('calls pet_hide and sets petOpen=false', async () => {
      useSettingsStore.setState({ petOpen: true });
      const user = userEvent.setup();
      render(<PetSection />);

      const toggle = screen.getByRole('switch');
      await user.click(toggle);

      expect(invoke).toHaveBeenCalledWith('pet_hide');
      expect(useSettingsStore.getState().petOpen).toBe(false);
    });
  });

  describe('reject path on turn-on', () => {
    it('does not set petOpen=true when pet_show rejects', async () => {
      useSettingsStore.setState({ petOpen: false });
      invoke.mockRejectedValueOnce(new Error('tauri error'));
      const user = userEvent.setup();
      render(<PetSection />);

      const toggle = screen.getByRole('switch');
      await user.click(toggle);

      expect(invoke).toHaveBeenCalledWith('pet_show');
      expect(useSettingsStore.getState().petOpen).toBe(false);
    });
  });
});
