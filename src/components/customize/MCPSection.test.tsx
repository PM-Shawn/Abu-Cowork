// @vitest-environment happy-dom
/**
 * 「我的」 for the Connectors tab. `sourceFilter="mine"` narrows the list to the
 * servers the user configured by hand: a plugin's server belongs to the package
 * that brought it, and presenting it here as the user's own would invite a
 * removal this list cannot honour. Everything that came from outside — the
 * curated catalog and plugin-contributed servers — lives in 「市场」
 * (ConnectorCatalog), so 「我的」 also drops the un-installed catalog cards.
 *
 * `prefill` is the other half of 「市场」's 「添加」: a catalog entry carries
 * env-var *keys* with empty values, so the add-server form opens filled in and
 * the user supplies the secrets — nothing is written behind their back.
 */

import { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { getI18n } from '@/i18n';
import type { MCPServerEntry } from '@/stores/mcpStore';
import { useMCPStore } from '@/stores/mcpStore';
import { usePluginStore } from '@/stores/pluginStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { InstalledPlugin } from '@/core/plugin/installedStore';
import type { ConnectorPrefill } from '@/components/toolbox/connectors/connectorPrefill';
import { buildConnectorCatalog } from '@/components/toolbox/connectors/connectorPrefill';
import MCPSection from './MCPSection';

const tb = () => getI18n().toolbox;

const serverEntry = (name: string): MCPServerEntry => ({
  config: { name, command: 'npx', args: [], enabled: true },
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

beforeEach(() => {
  vi.clearAllMocks();
  useMCPStore.setState({ servers: {}, isLoading: false });
  usePluginStore.setState({ installed: [] });
  useSettingsStore.setState({ extensionsSearchQuery: '' });
});

describe('MCPSection · sourceFilter="mine"', () => {
  it('keeps the servers the user configured and drops the plugin-owned ones', () => {
    useMCPStore.setState({
      servers: {
        'hand-rolled': serverEntry('hand-rolled'),
        'weather-mcp': serverEntry('weather-mcp'),
      },
    });
    usePluginStore.setState({ installed: [plugin('weather', ['weather-mcp'])] });

    render(<MCPSection sourceFilter="mine" />);
    expect(screen.getByText('hand-rolled')).toBeTruthy();
    expect(screen.queryByText('weather-mcp')).toBeNull();
  });

  it('keeps a catalog-named server the user configured themselves', () => {
    useMCPStore.setState({ servers: { github: serverEntry('github') } });
    render(<MCPSection sourceFilter="mine" />);
    expect(screen.getByText('github')).toBeTruthy();
  });

  /**
   * Under 「我的」 the custom/template split is meaningless — everything left is
   * the user's. Sorting a configured `github` into the 「市场」 group would file
   * the user's own server under a heading that says it came from elsewhere.
   */
  it('renders one ungrouped list — no 市场 heading over the user\u2019s own servers', () => {
    useMCPStore.setState({
      servers: { github: serverEntry('github'), 'hand-rolled': serverEntry('hand-rolled') },
    });
    render(<MCPSection sourceFilter="mine" />);
    expect(screen.getByText('github')).toBeTruthy();
    expect(screen.getByText('hand-rolled')).toBeTruthy();
    expect(screen.queryByText(tb().exampleServers)).toBeNull();
    expect(screen.queryByText(tb().myServers)).toBeNull();
  });

  /**
   * `abu-browser-bridge` fell through both lists: a template name (so not
   * "custom") that the Electron host filters out of the template list (so not
   * an example either). One list cannot lose it.
   */
  it('keeps a configured server that belongs to neither of the old two groups', () => {
    // The Electron command host is what drops the bridge from the template list.
    vi.stubEnv('ABU_ELECTRON_COMMAND_HOST', '1');
    try {
      useMCPStore.setState({ servers: { 'abu-browser-bridge': serverEntry('abu-browser-bridge') } });
      render(<MCPSection sourceFilter="mine" />);
      expect(screen.getByText('abu-browser-bridge')).toBeTruthy();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('still narrows the ungrouped list by the extensions search box', () => {
    useMCPStore.setState({
      servers: { github: serverEntry('github'), 'hand-rolled': serverEntry('hand-rolled') },
    });
    useSettingsStore.setState({ extensionsSearchQuery: 'hand' });
    render(<MCPSection sourceFilter="mine" />);
    expect(screen.getByText('hand-rolled')).toBeTruthy();
    expect(screen.queryByText('github')).toBeNull();
  });

  it('says 还没有你添加的连接器 when every server came from a plugin', () => {
    useMCPStore.setState({ servers: { 'weather-mcp': serverEntry('weather-mcp') } });
    usePluginStore.setState({ installed: [plugin('weather', ['weather-mcp'])] });

    render(<MCPSection sourceFilter="mine" />);
    expect(screen.getByText(tb().connectorsMineEmptyTitle)).toBeTruthy();
  });

  it('drops the un-installed catalog cards — 「市场」 owns those now', () => {
    render(<MCPSection sourceFilter="mine" />);
    expect(screen.getByText(tb().connectorsMineEmptyTitle)).toBeTruthy();
    expect(screen.queryByText(tb().exampleServers)).toBeNull();
  });

  /**
   * Every catalog name is now a template name, so a server installed from
   * 「市场」 is filed under 「市场」 in the unfiltered view. It used to leak into
   * 「我的」 whenever the registry knew a name the hand-kept template array did
   * not — `sequential-thinking` was one such name, and a user who installed it
   * from 「市场」 found it filed as their own hand-rolled server.
   */
  it('files a catalog-installed server under 市场, never under 我的', () => {
    useMCPStore.setState({ servers: { 'sequential-thinking': serverEntry('sequential-thinking') } });
    render(<MCPSection />);
    expect(screen.queryByText(tb().myServers)).toBeNull();
    expect(screen.getByText(tb().exampleServers)).toBeTruthy();
    expect(screen.getByText('sequential-thinking')).toBeTruthy();
  });

  it('still shows every source when no filter is given', () => {
    useMCPStore.setState({
      servers: {
        'hand-rolled': serverEntry('hand-rolled'),
        'weather-mcp': serverEntry('weather-mcp'),
      },
    });
    usePluginStore.setState({ installed: [plugin('weather', ['weather-mcp'])] });

    render(<MCPSection />);
    expect(screen.getByText('hand-rolled')).toBeTruthy();
    expect(screen.getByText('weather-mcp')).toBeTruthy();
  });
});

describe('MCPSection · prefill', () => {
  const entry: ConnectorPrefill = {
    name: 'github',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' },
    transport: 'stdio',
  };

  it('fills the add-server form from the catalog entry, secrets left blank', async () => {
    render(<MCPSection sourceFilter="mine" showAddForm prefill={entry} />);

    await waitFor(() => {
      expect(screen.getByDisplayValue('github')).toBeTruthy();
    });
    expect(screen.getByDisplayValue('-y @modelcontextprotocol/server-github')).toBeTruthy();
    expect(screen.getByDisplayValue('{"GITHUB_PERSONAL_ACCESS_TOKEN":""}')).toBeTruthy();
  });

  it('adds nothing on its own — the user still has to save', () => {
    const addServer = vi.spyOn(useMCPStore.getState(), 'addServer');
    render(<MCPSection sourceFilter="mine" showAddForm prefill={entry} />);
    expect(addServer).not.toHaveBeenCalled();
    expect(useMCPStore.getState().servers.github).toBeUndefined();
  });

  /**
   * The two catalogs 「市场」 unions are not both stdio — a marketplace template
   * may be an HTTP endpoint. Hardcoding stdio would have opened the form on the
   * wrong transport with an empty command the user cannot fill.
   */
  it('opens on the HTTP transport when the connector is one', async () => {
    const http: ConnectorPrefill = {
      name: 'remote-mcp',
      command: '',
      args: [],
      env: {},
      transport: 'http',
      url: 'https://mcp.example.com/sse',
    };
    render(<MCPSection sourceFilter="mine" showAddForm prefill={http} />);
    await waitFor(() => expect(screen.getByDisplayValue('https://mcp.example.com/sse')).toBeTruthy());
    expect(screen.getByDisplayValue('remote-mcp')).toBeTruthy();
  });

  it('leaves the form alone while it is closed', () => {
    render(<MCPSection sourceFilter="mine" showAddForm={false} prefill={entry} />);
    expect(screen.queryByDisplayValue('github')).toBeNull();
  });
});

describe('MCPSection · focusServer', () => {
  it('opens the detail for the named server so 「市场」的 管理 lands somewhere', async () => {
    useMCPStore.setState({ servers: { 'hand-rolled': serverEntry('hand-rolled') } });
    render(<MCPSection sourceFilter="mine" focusServer="hand-rolled" />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'hand-rolled' })).toBeTruthy());
  });

  it('ignores a server that is not configured', () => {
    render(<MCPSection sourceFilter="mine" focusServer="never-existed" />);
    expect(screen.queryByRole('heading')).toBeNull();
  });
});

/**
 * A prefill is an *offer*, not a standing instruction. The add-server form is
 * also the edit form, so an offer that stays armed will overwrite whatever the
 * user opens next: 「编辑 postgres」 becomes 「添加 github」, silently, with the
 * edit target dropped. One prefill therefore applies exactly once, and never to
 * a form that is already editing a server.
 */
describe('MCPSection · prefill does not hijack the form', () => {
  const entry: ConnectorPrefill = {
    name: 'github',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' },
    transport: 'stdio',
  };

  /** A host that owns `showAddForm` the way ToolboxModal will. */
  function Host({ initialOpen = false }: { initialOpen?: boolean }) {
    const [open, setOpen] = useState(initialOpen);
    return (
      <>
        <button data-testid="host-open" onClick={() => setOpen(true)}>open</button>
        <MCPSection
          sourceFilter="mine"
          showAddForm={open}
          onAddFormChange={setOpen}
          prefill={entry}
          focusServer="my-db"
        />
      </>
    );
  }

  it('leaves an edit alone — 编辑 my-db must not become 添加 github', async () => {
    useMCPStore.setState({
      servers: {
        'my-db': {
          config: { name: 'my-db', command: 'psql', args: ['--local'], enabled: true },
          status: 'disconnected',
          tools: [],
        },
      },
    });
    render(<Host />);

    // 「市场」's 管理 opened the detail; the user clicks its edit pencil.
    await waitFor(() => expect(screen.getByRole('heading', { name: 'my-db' })).toBeTruthy());
    fireEvent.click(screen.getByTitle(tb().skillEdit));

    const name = await screen.findByPlaceholderText(tb().serverName);
    expect((name as HTMLInputElement).value).toBe('my-db');
    expect(screen.getByText(tb().skillEdit, { selector: 'h2' })).toBeTruthy();
  });

  it('applies once — reopening the form manually starts blank', async () => {
    render(<Host initialOpen />);

    await waitFor(() => {
      expect((screen.getByPlaceholderText(tb().serverName) as HTMLInputElement).value).toBe('github');
    });
    fireEvent.click(screen.getByText(getI18n().common.cancel));
    fireEvent.click(screen.getByTestId('host-open'));

    await waitFor(() => expect(screen.getByPlaceholderText(tb().serverName)).toBeTruthy());
    expect((screen.getByPlaceholderText(tb().serverName) as HTMLInputElement).value).toBe('');
  });
});

/**
 * Every 「市场」 row is one catalog entry, and an entry carries install
 * affordances the plain add-server form has no notion of: a labeled secret
 * field with a hint, a configurable argument with a placeholder, a setup note,
 * a longer default timeout. Handing such an entry to the plain form throws all
 * of that away — the user gets the raw arg and an env JSON blob with nothing
 * explaining either. So every prefill names its template, and 「添加」 opens the
 * template install flow — the same one 「安装」 has always used.
 */
describe('MCPSection · prefill from a template', () => {
  const postgres: ConnectorPrefill = {
    name: 'postgres',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres', ''],
    env: {},
    transport: 'stdio',
    templateId: 'postgres',
  };

  /** A host that owns `showAddForm` and withdraws the offer on close, as Task 7 will. */
  function Host({ initial }: { initial: ConnectorPrefill | null }) {
    const [open, setOpen] = useState(true);
    const [offer, setOffer] = useState<ConnectorPrefill | null>(initial);
    return (
      <>
        <button data-testid="offer-slack" onClick={() => setOffer({
          name: 'slack', command: 'npx', args: ['-y', 'slack-mcp'], env: {}, transport: 'stdio',
        })}>slack</button>
        <MCPSection
          sourceFilter="mine"
          showAddForm={open}
          onAddFormChange={(o) => { setOpen(o); if (!o) setOffer(null); }}
          prefill={offer}
        />
      </>
    );
  }

  it('opens the template install UI, not the plain form', async () => {
    render(<Host initial={postgres} />);
    // Only the template path renders a configurable argument's placeholder.
    await waitFor(() => expect(screen.getByPlaceholderText('postgresql://user:pass@localhost:5432/db')).toBeTruthy());
    expect(screen.getByText(tb().serverArgs)).toBeTruthy();
    expect(screen.queryByPlaceholderText(tb().serverName)).toBeNull();
  });

  it('installs through the template path, carrying the value the user typed', async () => {
    const addServer = vi.spyOn(useMCPStore.getState(), 'addServer').mockImplementation(() => {});
    vi.spyOn(useMCPStore.getState(), 'connectServer').mockResolvedValue(undefined);
    render(<Host initial={postgres} />);

    const arg = await screen.findByPlaceholderText('postgresql://user:pass@localhost:5432/db');
    fireEvent.change(arg, { target: { value: 'postgresql://me@localhost:5432/mine' } });
    fireEvent.click(screen.getByText(tb().install));

    await waitFor(() => expect(addServer).toHaveBeenCalledWith(expect.objectContaining({
      name: 'postgres',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://me@localhost:5432/mine'],
    })));
  });

  it('keeps a template secret’s label and placeholder, which the form has nowhere to put', async () => {
    render(<Host initial={{ name: 'sentry', command: 'npx', args: [], env: { SENTRY_ACCESS_TOKEN: '' }, transport: 'stdio', templateId: 'sentry' }} />);
    await waitFor(() => expect(screen.getByText('SENTRY_ACCESS_TOKEN')).toBeTruthy());
    expect(screen.getByPlaceholderText('sntrys_...')).toBeTruthy();
  });

  /** A prefill that names no template at all still opens the plain form. */
  it('keeps the plain form for a prefill that names no template', async () => {
    render(<Host initial={{ name: 'github', command: 'npx', args: ['-y', 'server-github'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' }, transport: 'stdio' }} />);
    await waitFor(() => {
      expect((screen.getByPlaceholderText(tb().serverName) as HTMLInputElement).value).toBe('github');
    });
  });

  /** A template id nothing resolves (a host filtered it out) must still add the connector. */
  it('falls back to the plain form when the named template is not available here', async () => {
    render(<Host initial={{ ...postgres, templateId: 'no-such-template' }} />);
    await waitFor(() => {
      expect((screen.getByPlaceholderText(tb().serverName) as HTMLInputElement).value).toBe('postgres');
    });
  });

  /**
   * Electron provisions `abu-browser-bridge` itself and drops it from the
   * host's template list, so its 「市场」 row — which names a template like
   * every other row — resolves to nothing here and falls back to the plain
   * form, opened on the host-resolved command rather than the npx one.
   */
  it('opens the plain form when this host filtered the named template out', async () => {
    process.env.ABU_ELECTRON_COMMAND_HOST = '1';
    try {
      const bridge = buildConnectorCatalog('zh-CN').find((item) => item.name === 'abu-browser-bridge');
      expect(bridge?.templateId).toBe('abu-browser-bridge');
      render(<Host initial={bridge ?? null} />);
      await waitFor(() => {
        expect((screen.getByPlaceholderText(tb().serverName) as HTMLInputElement).value).toBe('abu-browser-bridge');
      });
      expect(screen.getByDisplayValue(bridge!.command)).toBeTruthy();
    } finally {
      delete process.env.ABU_ELECTRON_COMMAND_HOST;
    }
  });

  /** A spent offer blocks only its own name — the next connector still applies. */
  it('applies a different connector offered while the form is still open', async () => {
    render(<Host initial={{ name: 'github', command: 'npx', args: [], env: {}, transport: 'stdio' }} />);
    await waitFor(() => {
      expect((screen.getByPlaceholderText(tb().serverName) as HTMLInputElement).value).toBe('github');
    });
    fireEvent.click(screen.getByTestId('offer-slack'));
    await waitFor(() => {
      expect((screen.getByPlaceholderText(tb().serverName) as HTMLInputElement).value).toBe('slack');
    });
  });
});
