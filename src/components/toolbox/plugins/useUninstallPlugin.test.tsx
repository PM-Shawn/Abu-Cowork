// @vitest-environment happy-dom
/**
 * Uninstall is not idempotent: the second call for the same key finds the
 * package directory already gone and rejects, which surfaces as an error toast
 * for an uninstall that actually succeeded.
 *
 * The question closes on confirm while the row stays until the store updates, so
 * a fast user can reopen `···` → 卸载 → 确认 on the very same plugin before the
 * first call settles. These tests pin the in-flight guard that makes the second
 * confirm a no-op — and pin that the guard is released afterwards, so a plugin
 * reinstalled later can still be uninstalled again.
 */

import { StrictMode, useEffect, useState, type ReactElement } from 'react';
import { render as renderBare, screen, fireEvent, act } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { Button } from '@/components/ds/button';
import { DesignSystemProvider } from '@/components/ds/provider';
import { getI18n, format } from '@/i18n';
import type { InstalledPlugin } from '@/core/plugin/installedStore';
import { usePluginStore } from '@/stores/pluginStore';
import { useToastStore } from '@/stores/toastStore';
import { useAppStore } from '@/stores/appStore';
import { DEFAULT_APP_CONFIG } from '@/data/defaultAppConfig';
import { useUninstallPlugin } from './useUninstallPlugin';

// The question is a design-system confirmation, so the owner renders inside the provider like the app does.
const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });
const tb = () => getI18n().toolbox;

const plugin = (key: string, name: string): InstalledPlugin => ({
  key,
  marketplace: 'official',
  name,
  version: '1.2.0',
  installedAt: '2026-08-31T00:00:00.000Z',
  contributed: { skills: ['forecast'], mcpServers: ['weather-mcp'], agents: [], teams: [] },
});

const weather = plugin('weather@official', 'weather');
const radar = plugin('radar@official', 'radar');

const order: string[] = [];
const uninstall = vi.fn();
const addToast = vi.fn();
const closed = vi.fn(() => { order.push('onClose'); });

/** A page that owns the hook: its buttons ask, and `onClose` is its own step once a question has ended. */
function Owner({ first = null, onClose = closed }: { first?: InstalledPlugin | null; onClose?: () => void }) {
  const { ask, asking } = useUninstallPlugin('/Users/tester', onClose);
  // A page that asks as soon as it is on screen.
  useEffect(() => { if (first) ask(first); }, [first, ask]);
  return (
    <div data-asking={asking}>
      <Button onClick={() => ask(weather)}>open-weather</Button>
      {/* A new object for the same install, as an owner that reads it from the store again would pass. */}
      <Button onClick={() => ask({ ...weather })}>open-weather-again</Button>
      <Button onClick={() => ask(radar)}>open-radar</Button>
    </div>
  );
}

/** Mirrors a real page: it stays mounted, or leaves the screen with its hook. */
function Harness({ mounted = true }: { mounted?: boolean }) {
  const [first, setFirst] = useState<InstalledPlugin | null>(null);
  const [shown, setShown] = useState(mounted);
  return (
    <div>
      <Button onClick={() => setShown(false)}>unmount</Button>
      <Button onClick={() => { setFirst(weather); setShown(true); }}>mount-with-weather</Button>
      {shown && <Owner first={first} />}
    </div>
  );
}

const asking = () => document.querySelector('[data-asking]')?.getAttribute('data-asking');

const question = () => screen.queryByRole('alertdialog');
const confirmButton = () => screen.getByRole('button', { name: tb().pluginsUninstall });
const flush = () => act(async () => {});

async function ask(which: 'weather' | 'radar' = 'weather') {
  fireEvent.click(screen.getByText(`open-${which}`));
  await flush();
}

/** Ask about `which` and press 卸载. */
async function openAndConfirm(which: 'weather' | 'radar' = 'weather') {
  await ask(which);
  fireEvent.click(confirmButton());
  await flush();
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
  order.length = 0;
  uninstall.mockImplementation(async () => { order.push('uninstall'); });
  usePluginStore.setState({ uninstall, installed: [weather, radar] });
  useToastStore.setState({ addToast });
});

describe('useUninstallPlugin', () => {
  it('asks first, then forgets the target and only then uninstalls, with the home directory and the key', async () => {
    render(<Harness />);
    expect(asking()).toBe('false');
    await ask();
    expect(screen.getByText(tb().pluginsUninstallTitle)).toBeInTheDocument();
    expect(uninstall).not.toHaveBeenCalled();
    // The owner reads this as "my question is on the page".
    expect(asking()).toBe('true');

    fireEvent.click(confirmButton());
    await flush();

    expect(asking()).toBe('false');
    expect(order).toEqual(['onClose', 'uninstall']);
    expect(uninstall).toHaveBeenCalledExactlyOnceWith('/Users/tester', weather.key);
    expect(screen.queryByText(tb().pluginsUninstallTitle)).toBeNull();
  });

  it('uninstalls nothing when the question is cancelled or dismissed with Escape', async () => {
    render(<Harness />);
    await ask();
    fireEvent.click(screen.getByRole('button', { name: getI18n().common.cancel }));
    await flush();
    expect(closed).toHaveBeenCalledTimes(1);

    await ask();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await flush();
    expect(closed).toHaveBeenCalledTimes(2);
    expect(uninstall).not.toHaveBeenCalled();
    expect(question()).toBeNull();
  });

  it('uninstalls once when the same plugin is confirmed twice before the first call settles', async () => {
    const first = deferred();
    uninstall.mockReturnValueOnce(first.promise);

    render(<Harness />);
    await openAndConfirm();
    await openAndConfirm();

    expect(uninstall).toHaveBeenCalledTimes(1);
    expect(uninstall).toHaveBeenCalledWith('/Users/tester', weather.key);
    expect(addToast).not.toHaveBeenCalled();
  });

  it('closes the question when 卸载 is confirmed for a plugin that is already being uninstalled', async () => {
    uninstall.mockReturnValueOnce(deferred().promise);

    render(<Harness />);
    await openAndConfirm();
    await openAndConfirm();

    expect(closed).toHaveBeenCalledTimes(2);
    expect(question()).toBeNull();
    expect(uninstall).toHaveBeenCalledTimes(1);
  });

  it('still uninstalls a DIFFERENT plugin while one call is in flight', async () => {
    uninstall.mockReturnValueOnce(deferred().promise).mockReturnValueOnce(deferred().promise);

    render(<Harness />);
    await openAndConfirm('weather');
    await openAndConfirm('radar');

    expect(uninstall).toHaveBeenCalledTimes(2);
    expect(uninstall).toHaveBeenLastCalledWith('/Users/tester', radar.key);
  });

  it('releases the key once the call settles, so a later uninstall still runs', async () => {
    const first = deferred();
    uninstall.mockReturnValueOnce(first.promise).mockResolvedValueOnce(undefined);

    render(<Harness />);
    await openAndConfirm();
    await act(async () => { first.resolve(); });

    await openAndConfirm();
    expect(uninstall).toHaveBeenCalledTimes(2);
  });

  it('counts the agents it will delete alongside the skills and connectors', async () => {
    // Uninstall now also removes ~/.abu/agents/<name>, which lives outside the
    // package directory; the confirmation names every kind of collateral.
    const withAgents: InstalledPlugin = {
      ...weather,
      contributed: { skills: ['forecast'], mcpServers: ['weather-mcp'], agents: ['reviewer', 'planner'], teams: [] },
    };
    render(<Owner first={withAgents} onClose={() => {}} />);
    await flush();

    expect(
      screen.getByText(
        format(tb().pluginsUninstallMessage, { name: 'weather', skills: 1, servers: 1, agents: 2 }),
      ),
    ).toBeInTheDocument();
  });

  it('says an app leaves the switcher and its conversations stay, and names the teams going with it', async () => {
    // Removing an app is a bigger step than removing a plugin: the switcher
    // loses an entry and a package team disappears from 专家. The user sees
    // both, plus the reassurance that the conversations survive.
    const shopApp: InstalledPlugin = {
      ...weather,
      key: 'shop@official',
      name: 'shop',
      contributed: { skills: ['product-listing'], mcpServers: ['shop-api'], agents: ['advisor'], teams: ['store-ops'] },
    };
    useAppStore.setState({
      installedApps: [{ appId: shopApp.key, name: '店铺运营', config: DEFAULT_APP_CONFIG, pluginKey: shopApp.key, pluginVersion: '1.0.0' }],
    });
    render(<Owner first={shopApp} onClose={() => {}} />);
    await flush();

    const dialog = screen.getByText(new RegExp(format(tb().pluginsUninstallTeamsNote, { teams: 1 }).trim()));
    expect(dialog).toHaveTextContent(tb().pluginsUninstallAppNote.trim());
    useAppStore.setState({ installedApps: [] });
  });

  it('keeps the app sentence out of a plain plugin uninstall', async () => {
    render(<Owner first={weather} onClose={() => {}} />);
    await flush();
    expect(question()).not.toBeNull();
    expect(screen.queryByText(new RegExp(tb().pluginsUninstallAppNote.trim()))).toBeNull();
    expect(screen.queryByText(new RegExp(format(tb().pluginsUninstallTeamsNote, { teams: 0 }).trim()))).toBeNull();
  });

  it('releases the key on failure too, and reports the failure once', async () => {
    const first = deferred();
    uninstall.mockReturnValueOnce(first.promise).mockResolvedValueOnce(undefined);

    render(<Harness />);
    await openAndConfirm();
    await openAndConfirm(); // swallowed by the guard — must not add a second toast
    await act(async () => { first.reject(new Error('directory is gone')); });

    expect(addToast).toHaveBeenCalledTimes(1);
    expect(addToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error',
      title: tb().pluginsUninstallFailed,
      message: 'directory is gone',
    }));

    await openAndConfirm();
    expect(uninstall).toHaveBeenCalledTimes(2);
  });
});

describe('useUninstallPlugin: one question per target, answered against what is installed now', () => {
  it('does nothing but close when the plugin is no longer installed at the moment of the answer', async () => {
    render(<Harness />);
    await ask();
    // Removed from somewhere else while the question was on screen.
    act(() => { usePluginStore.setState({ installed: [radar] }); });

    fireEvent.click(confirmButton());
    await flush();

    expect(uninstall).not.toHaveBeenCalled();
    expect(addToast).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('asks once when the owner hands over the same install again as a new object', async () => {
    render(<Harness />);
    await ask();
    fireEvent.click(screen.getByText('open-weather-again'));
    await flush();

    // A second question would have answered the first one with "cancel" and closed it.
    expect(closed).not.toHaveBeenCalled();
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);

    fireEvent.click(confirmButton());
    await flush();
    expect(uninstall).toHaveBeenCalledTimes(1);
  });

  it('asks once when it mounts with a target under StrictMode, where effects run twice', async () => {
    // The provider is already up, as it is in the app when a page mounts.
    render(<StrictMode><Harness mounted={false} /></StrictMode>);
    fireEvent.click(screen.getByText('mount-with-weather'));
    await flush();

    expect(closed).not.toHaveBeenCalled();
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);

    fireEvent.click(confirmButton());
    await flush();
    expect(uninstall).toHaveBeenCalledExactlyOnceWith('/Users/tester', weather.key);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('uninstalls nothing when the page that asked has gone before the answer', async () => {
    render(<Harness />);
    await ask();
    fireEvent.click(screen.getByText('unmount'));
    await flush();

    // The question outlives the page; answering it now is answering nobody.
    fireEvent.click(confirmButton());
    await flush();

    expect(uninstall).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
  });

  it('moves the question to another plugin without closing the new one', async () => {
    render(<Harness />);
    await ask('weather');
    await ask('radar');

    // The first question was replaced; that must not forget the target that is being asked about now.
    expect(closed).not.toHaveBeenCalled();
    expect(question()).toHaveTextContent(format(tb().pluginsUninstallMessage, { name: 'radar', skills: 1, servers: 1, agents: 0 }));

    fireEvent.click(confirmButton());
    await flush();
    expect(uninstall).toHaveBeenCalledExactlyOnceWith('/Users/tester', radar.key);
  });

  it('names the plugin and uses the danger action', async () => {
    render(<Harness />);
    await ask();
    expect(question()).toHaveAccessibleName(tb().pluginsUninstallTitle);
    expect(question()).toHaveTextContent('weather');
    expect(confirmButton().className).toContain('text-danger');
  });
});
