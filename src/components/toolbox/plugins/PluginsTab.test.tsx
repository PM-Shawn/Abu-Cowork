// @vitest-environment happy-dom
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/core/plugin/installedStore', () => ({
  readInstalled: vi.fn().mockResolvedValue([]),
  // The store reads through the result variant so a failed read cannot pass
  // for an empty one (pluginStore module doc).
  readInstalledResult: vi.fn().mockResolvedValue({ ok: true, plugins: [] }),
  upsertInstalled: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/core/permissions/pluginToolPolicy', () => ({ setPluginServerNames: vi.fn() }));
vi.mock('@/core/plugin/builtinMarket', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/plugin/builtinMarket')>()),
  resolveBuiltinMarketDir: vi.fn().mockResolvedValue(null),
}));

// The two panels are exercised by their own suites; here only "which one is
// mounted, with what props" matters, so they are stubbed to record that.
vi.mock('./MarketplaceBrowser', () => ({
  default: (props: Record<string, unknown>) => (
    <div data-testid="stub-marketplace-browser" data-home={String(props.home)} />
  ),
}));
vi.mock('./AuthoredPluginList', () => ({
  default: (props: Record<string, unknown>) => (
    <div data-testid="stub-installed-list" data-home={String(props.home)} />
  ),
}));
// The dialog's own flow (pick a folder, parse its manifest) has its own suite;
// here only what the tab does with the result matters, so the stub just fires
// `onAdded` on demand.
vi.mock('./AddMarketplaceDialog', () => ({
  default: ({ onAdded }: { onAdded?: (name: string) => void }) => (
    <button data-testid="stub-added-marketplace" onClick={() => onAdded?.('demo-market')}>added</button>
  ),
}));

vi.mock('@/core/plugin/operationBridge', async importOriginal => ({ ...(await importOriginal<object>()), archivePluginOperation: vi.fn() }));
vi.mock('@/stores/pluginStore', async importOriginal => ({ ...(await importOriginal<object>()), bootstrapPluginUpdates: vi.fn() }));
import { archivePluginOperation } from '@/core/plugin/operationBridge';
import { getI18n } from '@/i18n';
import { usePluginStore } from '@/stores/pluginStore';
import { DEFAULT_SOURCES, useExtensionSourceStore } from '@/stores/extensionSourceStore';
import PluginsTab from './PluginsTab';

beforeEach(() => {
  vi.clearAllMocks();
  usePluginStore.setState({ marketplaces: [], installed: [], loading: false, error: null, recoveryError: null, unreadableOperation: null });
  useExtensionSourceStore.setState({ sources: { ...DEFAULT_SOURCES } });
});

describe('PluginsTab', () => {
  it('mounts the marketplace browser for 市场', async () => {
    render(<PluginsTab searchQuery="" source="market" />);
    const browser = await screen.findByTestId('stub-marketplace-browser');
    expect(browser).toHaveAttribute('data-home', '/Users/testuser');
    // One shelf at a time: the authored list is 「我的」's.
    expect(screen.queryByTestId('stub-installed-list')).toBeNull();
  });

  it('mounts the authored-only installed list for 我的', async () => {
    render(<PluginsTab searchQuery="" source="mine" />);
    const list = await screen.findByTestId('stub-installed-list');
    expect(list).toHaveAttribute('data-home', '/Users/testuser');
    expect(screen.queryByTestId('stub-marketplace-browser')).toBeNull();
  });

  it('defaults to the market panel when no source is passed', async () => {
    // 市场 is the default shelf on every tab, and a standalone mount must still
    // render something rather than a blank panel.
    render(<PluginsTab searchQuery="" />);
    await screen.findByTestId('stub-marketplace-browser');
  });

  it('jumps to 市场 when a marketplace is added from 我的', async () => {
    // The new market is browsed on 市场, and `requestedMarket` is consumed by
    // MarketplaceBrowser — which 我的 does not mount. Without the jump, adding
    // one from 我的 closes the dialog onto an unchanged authored list: a
    // silent no-op the user reads as a failed add.
    useExtensionSourceStore.getState().setSource('plugins', 'mine');
    render(<PluginsTab searchQuery="" source="mine" />);
    fireEvent.click(await screen.findByTestId('stub-added-marketplace'));
    expect(useExtensionSourceStore.getState().sources.plugins).toBe('market');
    // Only that tab moves — a marketplace add says nothing about the others.
    expect(useExtensionSourceStore.getState().sources.skills).toBe('market');
  });

  it('no longer renders the 已安装 / 插件市场 sub-tabs', async () => {
    render(<PluginsTab searchQuery="" />);
    await screen.findByTestId('stub-marketplace-browser');
    await waitFor(() =>
      expect(screen.queryByText(/^(已安装|Installed)$/)).toBeNull(),
    );
    expect(screen.queryByText(/^(插件市场|Marketplace)$/)).toBeNull();
  });
});

it('archives only after consequence confirmation and retains backup paths afterward', async () => {
  const backup = '/profile/.abu/plugin-packages/market/demo/.abu-plugin-backup-1';
  const archivedPath = '/profile/.abu/plugin-operations/corrupt-1.enc';
  usePluginStore.setState({ recoveryError: 'unreadable', unreadableOperation: { unreadable: true, fingerprint: 'identity', backupPaths: [backup] } });
  vi.mocked(archivePluginOperation).mockResolvedValue({ archivedPath, backupPaths: [backup] });
  render(<PluginsTab searchQuery="" />);
  fireEvent.click(screen.getByRole('button', { name: getI18n().toolbox.pluginsArchiveContinue }));
  expect(screen.getByText(getI18n().toolbox.pluginsArchiveWarning)).toBeVisible();
  expect(archivePluginOperation).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: getI18n().common.cancel }));
  expect(archivePluginOperation).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: getI18n().toolbox.pluginsArchiveContinue }));
  const buttons = screen.getAllByRole('button', { name: getI18n().toolbox.pluginsArchiveContinue });
  fireEvent.click(buttons[buttons.length - 1]);
  await waitFor(() => expect(archivePluginOperation).toHaveBeenCalledExactlyOnceWith('identity'));
  const notice = await screen.findByRole('status');
  expect(within(notice).getByText(archivedPath)).toBeVisible();
  expect(within(notice).getByText(backup)).toBeVisible();
});
