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

vi.mock('@/core/plugin/operationBridge', async importOriginal => ({ ...(await importOriginal<object>()), archivePluginOperation: vi.fn() }));
vi.mock('@/stores/pluginStore', async importOriginal => ({ ...(await importOriginal<object>()), bootstrapPluginUpdates: vi.fn() }));
import { archivePluginOperation } from '@/core/plugin/operationBridge';
import { getI18n } from '@/i18n';
import { usePluginStore } from '@/stores/pluginStore';
import PluginsTab from './PluginsTab';

beforeEach(() => {
  vi.clearAllMocks();
  usePluginStore.setState({ marketplaces: [], installed: [], loading: false, error: null, recoveryError: null, unreadableOperation: null });
});

describe('PluginsTab', () => {
  it('mounts the marketplace browser for', async () => {
    render(<PluginsTab searchQuery="" />);
    const browser = await screen.findByTestId('stub-marketplace-browser');
    expect(browser).toHaveAttribute('data-home', '/Users/testuser');
    expect(screen.getByTestId('stub-installed-list')).toBeInTheDocument();
  });

  it('mounts the authored-only installed list for', async () => {
    render(<PluginsTab searchQuery="" />);
    const list = await screen.findByTestId('stub-installed-list');
    expect(list).toHaveAttribute('data-home', '/Users/testuser');
    expect(screen.getByTestId('stub-marketplace-browser')).toBeInTheDocument();
  });

  it('defaults to the market panel when no source is passed', async () => {
    // ToolboxModal passes `source` in a separate change; until then the tab
    // must still render something rather than a blank panel.
    render(<PluginsTab searchQuery="" />);
    await screen.findByTestId('stub-marketplace-browser');
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
