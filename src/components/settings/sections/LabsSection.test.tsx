/// <reference types="@testing-library/jest-dom" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LabsSection from './LabsSection';
import { useSettingsStore } from '@/stores/settingsStore';

// Local proxy so each test controls resolve/reject independently.
const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      settings: {
        labs: 'Labs',
        labsDescription: 'Experimental features',
        labsEmpty: 'No experiments',
        labsEmptyHint: 'Check back later',
      },
    },
  }),
  getI18n: () => ({
    settings: {
      petEnable: 'Desktop Pet',
      petEnableDesc: 'Show a floating pet on your desktop',
      labsExpPetWhere: 'Find it under System Settings → Desktop Pet',
    },
  }),
}));

describe('LabsSection', () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
  });

  afterEach(cleanup);

  describe('unlock-only (turning pet ON): no pet_show', () => {
    it('sets labs.pet=true and does NOT invoke pet_show', async () => {
      useSettingsStore.setState({ labs: { pet: false }, petOpen: false });
      const user = userEvent.setup();
      render(<LabsSection />);

      const card = screen.getByText('Desktop Pet').closest('div[class*="rounded-xl"]') as HTMLElement;
      const toggle = within(card).getByRole('switch');
      await user.click(toggle);

      expect(useSettingsStore.getState().labs['pet']).toBe(true);
      expect(invoke).not.toHaveBeenCalledWith('pet_show');
    });
  });

  describe('teardown (turning pet OFF with pet running): pet_hide + petOpen cleared', () => {
    it('calls pet_hide, clears petOpen, and sets labs.pet=false', async () => {
      useSettingsStore.setState({ labs: { pet: true }, petOpen: true });
      const user = userEvent.setup();
      render(<LabsSection />);

      const card = screen.getByText('Desktop Pet').closest('div[class*="rounded-xl"]') as HTMLElement;
      const toggle = within(card).getByRole('switch');
      await user.click(toggle);

      expect(invoke).toHaveBeenCalledWith('pet_hide');
      expect(useSettingsStore.getState().petOpen).toBe(false);
      expect(useSettingsStore.getState().labs['pet']).toBe(false);
    });
  });

  describe('reject path: pet_hide fails → petOpen stays true', () => {
    it('does not clear petOpen when hide rejected', async () => {
      useSettingsStore.setState({ labs: { pet: true }, petOpen: true });
      invoke.mockRejectedValueOnce(new Error('window gone'));
      const user = userEvent.setup();
      render(<LabsSection />);

      const card = screen.getByText('Desktop Pet').closest('div[class*="rounded-xl"]') as HTMLElement;
      const toggle = within(card).getByRole('switch');
      await user.click(toggle);

      expect(invoke).toHaveBeenCalledWith('pet_hide');
      // labs.pet was set to false (the setLabsFlag call succeeds unconditionally)
      expect(useSettingsStore.getState().labs['pet']).toBe(false);
      // petOpen must remain true since the hide failed
      expect(useSettingsStore.getState().petOpen).toBe(true);
    });
  });
});
