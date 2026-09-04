// @vitest-environment happy-dom
/**
 * 「市场」 for the Connectors tab: the curated catalog of MCP servers Abu knows
 * how to configure, plus the servers an installed plugin brought with it.
 *
 * The two groups differ in exactly one way, and it is the thing a user can get
 * wrong here: a catalog server the user configured is theirs to remove, while a
 * plugin's server is not — it arrived with a package and leaves when that
 * package is uninstalled, from the Plugins tab. Removing one here would strand
 * the plugin's install record describing a server that is gone. A catalog row
 * in that state keeps 移除 visible but disabled, naming the owner, rather than
 * silently dropping the item from an otherwise identical menu.
 *
 * 「添加」 never writes a server: a catalog entry carries env-var *keys* with
 * empty values (a token slot, not a token), so it hands the entry to the
 * add-server form and lets the user fill them in.
 */

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { launchTrial } = vi.hoisted(() => ({ launchTrial: vi.fn() }));
vi.mock('@/components/toolbox/useTrialLauncher', () => ({ useTrialLauncher: () => launchTrial }));

import { format, getI18n } from '@/i18n';
import { BUILTIN_REGISTRY, getEntryDescription } from '@/core/agent/mcpDiscovery';
import type { MCPServerEntry } from '@/stores/mcpStore';
import { useMCPStore } from '@/stores/mcpStore';
import { usePluginStore } from '@/stores/pluginStore';
import type { InstalledPlugin } from '@/core/plugin/installedStore';
import ConnectorCatalog from './ConnectorCatalog';

const tb = () => getI18n().toolbox;

const serverEntry = (name: string, command = 'npx'): MCPServerEntry => ({
  config: { name, command, args: [], enabled: true },
  status: 'disconnected',
  tools: [],
});

const plugin = (name: string, mcpServers: string[]): InstalledPlugin => ({
  key: `market/${name}`,
  marketplace: 'market',
  name,
  version: '1.0.0',
  installedAt: '2026-01-01T00:00:00.000Z',
  contributed: { skills: [], mcpServers },
});

function rowFor(name: string): HTMLElement {
  const row = screen.getAllByTestId('connector-row').find((el) => within(el).queryByText(name));
  if (!row) throw new Error(`no connector-row for ${name}`);
  return row;
}

function openMenu(name: string): HTMLElement {
  const row = rowFor(name);
  fireEvent.click(within(row).getByTestId('connector-item-menu'));
  return row;
}

const noop = () => {};

beforeEach(() => {
  vi.clearAllMocks();
  useMCPStore.setState({ servers: {}, isLoading: false });
  usePluginStore.setState({ installed: [] });
});

describe('ConnectorCatalog · 精选连接器', () => {
  it('lists every catalog entry under its heading, with the localized description', () => {
    render(<ConnectorCatalog searchQuery="" onPrefillAdd={noop} onManage={noop} />);
    expect(screen.getByText(tb().connectorsMarketTitle)).toBeTruthy();
    expect(screen.getAllByTestId('connector-row')).toHaveLength(BUILTIN_REGISTRY.length);
    for (const entry of BUILTIN_REGISTRY) {
      expect(within(rowFor(entry.name)).getByText(getEntryDescription(entry.name))).toBeTruthy();
    }
  });

  it('offers 添加 — and only 添加 — for an entry with no configured server', () => {
    const onPrefillAdd = vi.fn();
    render(<ConnectorCatalog searchQuery="" onPrefillAdd={onPrefillAdd} onManage={noop} />);
    const row = rowFor('github');
    expect(within(row).queryByTestId('connector-item-menu')).toBeNull();
    const add = within(row).getByTestId('connector-add-button');
    expect(add.textContent).toBe(tb().connectorsAdd);
    fireEvent.click(add);
    expect(onPrefillAdd).toHaveBeenCalledTimes(1);
    expect(onPrefillAdd.mock.calls[0][0]).toMatchObject({
      name: 'github',
      command: 'npx',
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' },
    });
  });

  it('swaps 添加 for the ··· menu once that server exists', () => {
    useMCPStore.setState({ servers: { github: serverEntry('github') } });
    render(<ConnectorCatalog searchQuery="" onPrefillAdd={noop} onManage={noop} />);
    const row = openMenu('github');
    expect(within(row).queryByTestId('connector-add-button')).toBeNull();
    expect(within(row).getByTestId('connector-item-menu-trial').textContent).toBe(tb().menuTrial);
    expect(within(row).getByTestId('connector-item-menu-manage').textContent).toBe(tb().menuManage);
    expect(within(row).getByTestId('connector-item-menu-remove').textContent).toBe(tb().menuRemove);
  });

  it('disconnects before removing, so no live client outlives its config', async () => {
    useMCPStore.setState({ servers: { github: serverEntry('github') } });
    const order: string[] = [];
    const disconnectServer = vi.spyOn(useMCPStore.getState(), 'disconnectServer')
      .mockImplementation(async () => { order.push('disconnect'); });
    const removeServer = vi.spyOn(useMCPStore.getState(), 'removeServer')
      .mockImplementation(() => { order.push('remove'); });

    render(<ConnectorCatalog searchQuery="" onPrefillAdd={noop} onManage={noop} />);
    fireEvent.click(within(openMenu('github')).getByTestId('connector-item-menu-remove'));

    await waitFor(() => expect(removeServer).toHaveBeenCalledWith('github'));
    expect(disconnectServer).toHaveBeenCalledWith('github');
    expect(order).toEqual(['disconnect', 'remove']);
  });

  it('still removes the config when the disconnect fails', async () => {
    useMCPStore.setState({ servers: { github: serverEntry('github') } });
    vi.spyOn(useMCPStore.getState(), 'disconnectServer').mockRejectedValue(new Error('client already gone'));
    const removeServer = vi.spyOn(useMCPStore.getState(), 'removeServer').mockImplementation(() => {});

    render(<ConnectorCatalog searchQuery="" onPrefillAdd={noop} onManage={noop} />);
    fireEvent.click(within(openMenu('github')).getByTestId('connector-item-menu-remove'));

    await waitFor(() => expect(removeServer).toHaveBeenCalledWith('github'));
  });

  it('hands 管理 back to the host so the 我的 editor opens on that server', () => {
    useMCPStore.setState({ servers: { github: serverEntry('github') } });
    const onManage = vi.fn();
    render(<ConnectorCatalog searchQuery="" onPrefillAdd={noop} onManage={onManage} />);
    fireEvent.click(within(openMenu('github')).getByTestId('connector-item-menu-manage'));
    expect(onManage).toHaveBeenCalledWith('github');
  });

  it('gives the trial launcher the server name and its catalog description', () => {
    useMCPStore.setState({ servers: { github: serverEntry('github') } });
    render(<ConnectorCatalog searchQuery="" onPrefillAdd={noop} onManage={noop} />);
    fireEvent.click(within(openMenu('github')).getByTestId('connector-item-menu-trial'));
    expect(launchTrial).toHaveBeenCalledWith({
      name: 'github',
      description: getEntryDescription('github'),
    });
  });

  /**
   * Thirteen buttons all named 「添加」 are indistinguishable to a screen reader
   * (and to any name-based query): the row's name is visible text, not part of
   * the control. Each button carries the connector it adds.
   */
  it('names every 添加 button after the connector it adds', () => {
    const onPrefillAdd = vi.fn();
    render(<ConnectorCatalog searchQuery="" onPrefillAdd={onPrefillAdd} onManage={noop} />);
    const add = screen.getByRole('button', { name: format(tb().connectorAddLabel, { name: 'github' }) });
    expect(add.textContent).toBe(tb().connectorsAdd);
    fireEvent.click(add);
    expect(onPrefillAdd.mock.calls[0][0]).toMatchObject({ name: 'github' });
  });

  it('narrows the catalog by name, description and keyword', () => {
    render(<ConnectorCatalog searchQuery="postgres" onPrefillAdd={noop} onManage={noop} />);
    expect(screen.getAllByTestId('connector-row')).toHaveLength(1);
    expect(screen.getByText('postgres')).toBeTruthy();
  });
});

describe('ConnectorCatalog · 插件带来的连接器', () => {
  beforeEach(() => {
    useMCPStore.setState({
      servers: {
        'weather-mcp': serverEntry('weather-mcp'),
        'hand-rolled': serverEntry('hand-rolled'),
      },
    });
    usePluginStore.setState({ installed: [plugin('weather', ['weather-mcp'])] });
  });

  it('groups a plugin-contributed server on its own, naming the owning plugin', () => {
    render(<ConnectorCatalog searchQuery="" onPrefillAdd={noop} onManage={noop} />);
    expect(screen.getByText(tb().connectorsFromPlugins)).toBeTruthy();
    const group = screen.getByTestId('connectors-from-plugins');
    const rows = within(group).getAllByTestId('connector-row');
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText('weather-mcp')).toBeTruthy();
    expect(within(rows[0]).getByText(new RegExp(format(tb().mcpFromPlugin, { name: 'weather' })))).toBeTruthy();
  });

  it('leaves a hand-configured server out of 市场 entirely — it belongs to 我的', () => {
    render(<ConnectorCatalog searchQuery="" onPrefillAdd={noop} onManage={noop} />);
    expect(screen.queryByText('hand-rolled')).toBeNull();
  });

  it('offers 立即试用 / 管理 but never 移除 on a plugin-owned server', () => {
    render(<ConnectorCatalog searchQuery="" onPrefillAdd={noop} onManage={noop} />);
    const group = screen.getByTestId('connectors-from-plugins');
    fireEvent.click(within(group).getByTestId('connector-item-menu'));
    expect(within(group).getByTestId('connector-item-menu-trial')).toBeTruthy();
    expect(within(group).getByTestId('connector-item-menu-manage')).toBeTruthy();
    expect(within(group).queryByTestId('connector-item-menu-remove')).toBeNull();
  });

  /**
   * A plugin is free to contribute a server named after a catalog entry. The
   * catalog row then describes a server the user does not own, so its 移除 must
   * not work — but dropping the item outright leaves the user hunting for an
   * action that was there a moment ago on an identical-looking row. It stays,
   * disabled, saying who owns the server, and the row says so too.
   */
  it('disables 移除 on a catalog row whose server a plugin owns, and names the owner', () => {
    useMCPStore.setState({ servers: { github: serverEntry('github') } });
    usePluginStore.setState({ installed: [plugin('gh-pack', ['github'])] });
    render(<ConnectorCatalog searchQuery="" onPrefillAdd={noop} onManage={noop} />);
    const provenance = format(tb().mcpFromPlugin, { name: 'gh-pack' });
    const row = rowFor('github');
    // The row itself explains the disabled action, not just the tooltip.
    expect(within(row).getByText(provenance)).toBeTruthy();
    openMenu('github');
    expect(within(row).getByTestId('connector-item-menu-manage')).toBeTruthy();
    const remove = within(row).getByTestId('connector-item-menu-remove');
    expect(remove.getAttribute('aria-disabled')).toBe('true');
    expect(remove.getAttribute('title')).toBe(provenance);
  });

  it('never removes through the disabled 移除', () => {
    useMCPStore.setState({ servers: { github: serverEntry('github') } });
    usePluginStore.setState({ installed: [plugin('gh-pack', ['github'])] });
    const removeServer = vi.spyOn(useMCPStore.getState(), 'removeServer').mockImplementation(() => {});
    render(<ConnectorCatalog searchQuery="" onPrefillAdd={noop} onManage={noop} />);
    fireEvent.click(within(openMenu('github')).getByTestId('connector-item-menu-remove'));
    expect(removeServer).not.toHaveBeenCalled();
  });

  it('hides the plugin group when no plugin contributed a server', () => {
    usePluginStore.setState({ installed: [] });
    render(<ConnectorCatalog searchQuery="" onPrefillAdd={noop} onManage={noop} />);
    expect(screen.queryByTestId('connectors-from-plugins')).toBeNull();
  });
});
