// @vitest-environment happy-dom
import { render, screen, waitFor } from '@testing-library/react';
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

import { usePluginStore } from '@/stores/pluginStore';
import PluginsTab from './PluginsTab';

beforeEach(() => {
  vi.clearAllMocks();
  usePluginStore.setState({ marketplaces: [], installed: [], loading: false, error: null });
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
