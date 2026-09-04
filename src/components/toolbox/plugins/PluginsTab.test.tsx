// @vitest-environment happy-dom
/**
 * PluginsTab is now a router, not a container with its own navigation: the
 * 市场 | 我的 choice is made above it (ToolboxModal owns the sub-nav) and
 * arrives as a prop. These tests pin that contract — which panel each source
 * mounts, that the old 已安装/插件市场 sub-tabs are gone, and that the tab
 * still renders when no `source` is passed (ToolboxModal is wired separately).
 */

import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/core/plugin/installedStore', () => ({
  readInstalled: vi.fn().mockResolvedValue([]),
  upsertInstalled: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/core/plugin/skillRoots', () => ({ pluginMcpServerNames: vi.fn().mockResolvedValue([]) }));
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
vi.mock('./InstalledPluginList', () => ({
  default: (props: Record<string, unknown>) => (
    <div data-testid="stub-installed-list" data-mode={String(props.mode)} />
  ),
}));

import { usePluginStore } from '@/stores/pluginStore';
import PluginsTab from './PluginsTab';

beforeEach(() => {
  vi.clearAllMocks();
  usePluginStore.setState({ marketplaces: [], installed: [], loading: false, error: null });
});

describe('PluginsTab', () => {
  it('mounts the marketplace browser for source="market"', async () => {
    render(<PluginsTab searchQuery="" source="market" />);
    const browser = await screen.findByTestId('stub-marketplace-browser');
    expect(browser).toHaveAttribute('data-home', '/Users/testuser');
    expect(screen.queryByTestId('stub-installed-list')).toBeNull();
  });

  it('mounts the authored-only installed list for source="mine"', async () => {
    render(<PluginsTab searchQuery="" source="mine" />);
    const list = await screen.findByTestId('stub-installed-list');
    expect(list).toHaveAttribute('data-mode', 'authored');
    expect(screen.queryByTestId('stub-marketplace-browser')).toBeNull();
  });

  it('defaults to the market panel when no source is passed', async () => {
    // ToolboxModal passes `source` in a separate change; until then the tab
    // must still render something rather than a blank panel.
    render(<PluginsTab searchQuery="" />);
    await screen.findByTestId('stub-marketplace-browser');
  });

  it('no longer renders the 已安装 / 插件市场 sub-tabs', async () => {
    render(<PluginsTab searchQuery="" source="market" />);
    await screen.findByTestId('stub-marketplace-browser');
    await waitFor(() =>
      expect(screen.queryByText(/^(已安装|Installed)$/)).toBeNull(),
    );
    expect(screen.queryByText(/^(插件市场|Marketplace)$/)).toBeNull();
  });
});
