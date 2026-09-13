// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';
import { useSettingsStore } from '@/stores/settingsStore';
import SystemSettingsDialog from './SystemSettingsDialog';

const platformMock = vi.hoisted(() => ({ mac: false }));
vi.mock('@/utils/platform', () => ({
  isMacOS: () => platformMock.mac,
  isWindows: () => !platformMock.mac,
}));

vi.mock('@/components/settings/SystemSettingsModal', () => ({
  default: () => <div>settings-view</div>,
}));

/**
 * macOS paints its traffic lights natively over the top 44px of the window
 * (`trafficLightPosition: { x: 20, y: 27 }` in `electron/windowChrome.cjs`,
 * `h-11` chrome overlay in `WindowTitleBar.tsx`). A dialog card centred on the
 * whole viewport starts at 5vh ≈ 40px on the default 800px-tall window and its
 * corner lands under the green light. The card must therefore be laid out
 * below that band on macOS, while Windows keeps its full-viewport centring.
 */
describe('SystemSettingsDialog — macOS chrome safe area', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    useSettingsStore.setState({ systemSettingsOpen: true });
  });

  afterEach(() => {
    cleanup();
    useSettingsStore.setState({ systemSettingsOpen: false });
  });

  it('reserves the traffic-light band on macOS', () => {
    platformMock.mac = true;
    const { container } = render(<SystemSettingsDialog />);
    const scrim = container.querySelector('[data-abu-settings-dialog]');
    expect(scrim).not.toBeNull();
    expect(scrim).toHaveClass('pt-12');
    expect(scrim).toHaveClass('inset-0');
  });

  it('keeps full-viewport centring on Windows', () => {
    platformMock.mac = false;
    const { container } = render(<SystemSettingsDialog />);
    const scrim = container.querySelector('[data-abu-settings-dialog]');
    expect(scrim).not.toBeNull();
    expect(scrim).not.toHaveClass('pt-12');
    expect(scrim).toHaveClass('inset-0');
  });

  it('sizes the card from the padded box so it never spills into the reserved band', () => {
    platformMock.mac = true;
    const { container } = render(<SystemSettingsDialog />);
    const card = container.querySelector('[data-abu-settings-dialog] > div');
    expect(card).toHaveClass('h-full');
    expect(card).toHaveClass('max-h-[840px]');
    expect(card).not.toHaveClass('h-[min(840px,90vh)]');
  });
});
