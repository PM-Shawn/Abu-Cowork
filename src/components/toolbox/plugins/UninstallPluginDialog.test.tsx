// @vitest-environment happy-dom
/**
 * Uninstall is not idempotent: the second call for the same key finds the
 * package directory already gone and rejects, which surfaces as an error toast
 * for an uninstall that actually succeeded.
 *
 * The dialog closes on confirm while the row stays until the store updates, so
 * a fast user can reopen `···` → 卸载 → 确认 on the very same plugin before the
 * first call settles. These tests pin the in-flight guard that makes the second
 * confirm a no-op — and pin that the guard is released afterwards, so a plugin
 * reinstalled later can still be uninstalled again.
 */

import { useState } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { getI18n } from '@/i18n';
import type { InstalledPlugin } from '@/core/plugin/installedStore';
import { usePluginStore } from '@/stores/pluginStore';
import { useToastStore } from '@/stores/toastStore';
import UninstallPluginDialog from './UninstallPluginDialog';

const tb = () => getI18n().toolbox;

const plugin = (key: string, name: string): InstalledPlugin => ({
  key,
  marketplace: 'official',
  name,
  version: '1.2.0',
  installedAt: '2026-08-31T00:00:00.000Z',
  contributed: { skills: ['forecast'], mcpServers: ['weather-mcp'] },
});

const weather = plugin('weather@official', 'weather');
const radar = plugin('radar@official', 'radar');

const uninstall = vi.fn();
const addToast = vi.fn();

/** Mirrors a real owner: the dialog stays mounted, `target` opens and closes it. */
function Harness() {
  const [target, setTarget] = useState<InstalledPlugin | null>(null);
  return (
    <div>
      <button onClick={() => setTarget(weather)}>open-weather</button>
      <button onClick={() => setTarget(radar)}>open-radar</button>
      <UninstallPluginDialog home="/Users/tester" target={target} onClose={() => setTarget(null)} />
    </div>
  );
}

function confirmButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: tb().pluginsUninstall }) as HTMLButtonElement;
}

/** Open the dialog for `plugin` and press 卸载. */
function openAndConfirm(which: 'weather' | 'radar' = 'weather') {
  fireEvent.click(screen.getByText(`open-${which}`));
  fireEvent.click(confirmButton());
}

/** A promise the test settles by hand, so the call is observably in flight. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  usePluginStore.setState({ uninstall });
  useToastStore.setState({ addToast });
});

describe('UninstallPluginDialog', () => {
  it('uninstalls once when the same plugin is confirmed twice before the first call settles', () => {
    const first = deferred();
    uninstall.mockReturnValueOnce(first.promise);

    render(<Harness />);
    openAndConfirm();
    openAndConfirm();

    expect(uninstall).toHaveBeenCalledTimes(1);
    expect(uninstall).toHaveBeenCalledWith('/Users/tester', weather.key);
    expect(addToast).not.toHaveBeenCalled();
  });

  it('disables 卸载 while that plugin is already being uninstalled', () => {
    uninstall.mockReturnValueOnce(deferred().promise);

    render(<Harness />);
    openAndConfirm();
    fireEvent.click(screen.getByText('open-weather'));

    expect(confirmButton().disabled).toBe(true);
  });

  it('still uninstalls a DIFFERENT plugin while one call is in flight', () => {
    uninstall.mockReturnValueOnce(deferred().promise).mockReturnValueOnce(deferred().promise);

    render(<Harness />);
    openAndConfirm('weather');
    openAndConfirm('radar');

    expect(uninstall).toHaveBeenCalledTimes(2);
    expect(uninstall).toHaveBeenLastCalledWith('/Users/tester', radar.key);
  });

  it('releases the key once the call settles, so a later uninstall still runs', async () => {
    const first = deferred();
    uninstall.mockReturnValueOnce(first.promise).mockResolvedValueOnce(undefined);

    render(<Harness />);
    openAndConfirm();
    await act(async () => { first.resolve(); });

    openAndConfirm();
    expect(uninstall).toHaveBeenCalledTimes(2);
  });

  it('releases the key on failure too, and reports the failure once', async () => {
    const first = deferred();
    uninstall.mockReturnValueOnce(first.promise).mockResolvedValueOnce(undefined);

    render(<Harness />);
    openAndConfirm();
    openAndConfirm(); // swallowed by the guard — must not add a second toast
    await act(async () => { first.reject(new Error('directory is gone')); });

    expect(addToast).toHaveBeenCalledTimes(1);
    expect(addToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      title: tb().pluginsUninstallFailed,
      message: 'directory is gone',
    }));

    openAndConfirm();
    expect(uninstall).toHaveBeenCalledTimes(2);
  });
});
