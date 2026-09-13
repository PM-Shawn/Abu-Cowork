// @vitest-environment happy-dom
/**
 * 「我的」 for the Connectors tab. `source="mine"` narrows the list to the
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

import { getI18n, setLanguage } from '@/i18n';
import type { MCPServerEntry } from '@/stores/mcpStore';
import { useMCPStore } from '@/stores/mcpStore';
import { usePluginStore } from '@/stores/pluginStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { DEFAULT_SOURCES, useExtensionSourceStore } from '@/stores/extensionSourceStore';
import type { InstalledPlugin } from '@/core/plugin/installedStore';
import type { ConnectorPrefill } from '@/components/toolbox/connectors/connectorPrefill';
import { buildConnectorCatalog } from '@/components/toolbox/connectors/connectorPrefill';
import { getMCPTemplatesForHost } from '@/data/marketplace/mcp';
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
  contributed: { skills: [], mcpServers, agents: [] },
});

beforeEach(() => {
  vi.clearAllMocks();
  useMCPStore.setState({ servers: {}, isLoading: false });
  usePluginStore.setState({ installed: [] });
  useSettingsStore.setState({ extensionsSearchQueries: { plugins: '', skills: '', mcp: '' } });
  useExtensionSourceStore.setState({ sources: { ...DEFAULT_SOURCES } });
});

describe('MCPSection · source="mine"', () => {
  it('keeps the servers the user configured and drops the plugin-owned ones', () => {
    useMCPStore.setState({
      servers: {
        'hand-rolled': serverEntry('hand-rolled'),
        'weather-mcp': serverEntry('weather-mcp'),
      },
    });
    usePluginStore.setState({ installed: [plugin('weather', ['weather-mcp'])] });

    render(<MCPSection source="mine" />);
    expect(screen.getByText('hand-rolled')).toBeTruthy();
    expect(screen.queryByText('weather-mcp')).toBeNull();
  });

  /**
   * A catalog server the user installed (github, memory, …) is a 市场 item with
   * a switch, exactly like an installed skill — it was on both shelves, which
   * showed one server twice. 「我的」 is only what the user added by hand.
   */
  it('files a catalog-named server under 市场 only, never 我的', () => {
    useMCPStore.setState({ servers: { github: serverEntry('github') } });
    const { rerender } = render(<MCPSection source="mine" />);
    expect(screen.queryByText('github')).toBeNull();
    expect(screen.getByText(tb().connectorsMineEmptyTitle)).toBeTruthy();
    rerender(<MCPSection source="market" />);
    expect(screen.getAllByText('github')).toHaveLength(1);
  });

  it('renders one ungrouped list — no 市场 heading over the user\u2019s own servers', () => {
    useMCPStore.setState({
      servers: { 'my-db': serverEntry('my-db'), 'hand-rolled': serverEntry('hand-rolled') },
    });
    render(<MCPSection source="mine" />);
    expect(screen.getByText('my-db')).toBeTruthy();
    expect(screen.getByText('hand-rolled')).toBeTruthy();
    expect(screen.queryByText(tb().exampleServers)).toBeNull();
    expect(screen.queryByText(tb().myServers)).toBeNull();
  });

  /**
   * `abu-browser-bridge` is Abu's own: the Electron host provisions it and so
   * never OFFERS it to install — but once provisioned it is a shipped server,
   * so it sits on 市场 as an installed card, not under 「我的」 as if the user
   * had added it (and it must not fall through both shelves either).
   */
  it('shows the host-provisioned browser bridge on 市场, not 我的', () => {
    // The Electron command host is what drops the bridge from the template list.
    vi.stubEnv('ABU_ELECTRON_COMMAND_HOST', '1');
    try {
      useMCPStore.setState({ servers: { 'abu-browser-bridge': serverEntry('abu-browser-bridge') } });
      const { rerender } = render(<MCPSection source="mine" />);
      expect(screen.queryByText('abu-browser-bridge')).toBeNull();
      rerender(<MCPSection source="market" />);
      expect(screen.getAllByText('abu-browser-bridge')).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('never offers the browser bridge as an install card on the Electron host', () => {
    vi.stubEnv('ABU_ELECTRON_COMMAND_HOST', '1');
    try {
      render(<MCPSection source="market" />);
      expect(screen.queryByText('abu-browser-bridge')).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('still narrows the ungrouped list by the extensions search box', () => {
    useMCPStore.setState({
      servers: { 'my-db': serverEntry('my-db'), 'hand-rolled': serverEntry('hand-rolled') },
    });
    useSettingsStore.setState({ extensionsSearchQueries: { plugins: '', skills: '', mcp: 'hand' } });
    render(<MCPSection source="mine" />);
    expect(screen.getByText('hand-rolled')).toBeTruthy();
    expect(screen.queryByText('my-db')).toBeNull();
  });

  it('says 还没有你添加的连接器 when every server came from a plugin', () => {
    useMCPStore.setState({ servers: { 'weather-mcp': serverEntry('weather-mcp') } });
    usePluginStore.setState({ installed: [plugin('weather', ['weather-mcp'])] });

    render(<MCPSection source="mine" />);
    expect(screen.getByText(tb().connectorsMineEmptyTitle)).toBeTruthy();
  });

  it('drops the un-installed catalog cards — 「市场」 owns those now', () => {
    render(<MCPSection source="mine" />);
    expect(screen.getByText(tb().connectorsMineEmptyTitle)).toBeTruthy();
    expect(screen.queryByText(tb().exampleServers)).toBeNull();
  });

  /**
   * Every catalog name is a template name, so a server installed from 「市场」
   * still has its catalog card there (marked installed) — the shelf a thing was
   * taken from keeps showing it. `sequential-thinking` is one such name.
   */
  it('keeps a catalog-installed server on the 市场 shelf', () => {
    useMCPStore.setState({ servers: { 'sequential-thinking': serverEntry('sequential-thinking') } });
    render(<MCPSection />);
    expect(screen.getByText('sequential-thinking')).toBeTruthy();
  });

  it('shows each source on its own shelf', () => {
    useMCPStore.setState({
      servers: {
        'hand-rolled': serverEntry('hand-rolled'),
        'weather-mcp': serverEntry('weather-mcp'),
      },
    });
    usePluginStore.setState({ installed: [plugin('weather', ['weather-mcp'])] });

    const { rerender } = render(<MCPSection source="mine" />);
    expect(screen.getByText('hand-rolled')).toBeTruthy();
    expect(screen.queryByText('weather-mcp')).toBeNull();
    rerender(<MCPSection source="market" />);
    expect(screen.getByText('github')).toBeTruthy();
    // A plugin's server is 市场's too — the plugin shipped it, not the user.
    expect(screen.getByText('weather-mcp')).toBeTruthy();
    expect(screen.queryByText('hand-rolled')).toBeNull();
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
    render(<MCPSection source="mine" showAddForm prefill={entry} />);

    await waitFor(() => {
      expect(screen.getByDisplayValue('github')).toBeTruthy();
    });
    expect(screen.getByDisplayValue('-y @modelcontextprotocol/server-github')).toBeTruthy();
    expect(screen.getByDisplayValue('{"GITHUB_PERSONAL_ACCESS_TOKEN":""}')).toBeTruthy();
  });

  it('adds nothing on its own — the user still has to save', () => {
    const addServer = vi.spyOn(useMCPStore.getState(), 'addServer');
    render(<MCPSection source="mine" showAddForm prefill={entry} />);
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
    render(<MCPSection source="mine" showAddForm prefill={http} />);
    await waitFor(() => expect(screen.getByDisplayValue('https://mcp.example.com/sse')).toBeTruthy());
    expect(screen.getByDisplayValue('remote-mcp')).toBeTruthy();
  });

  it('leaves the form alone while it is closed', () => {
    render(<MCPSection source="mine" showAddForm={false} prefill={entry} />);
    expect(screen.queryByDisplayValue('github')).toBeNull();
  });
});

describe('MCPSection · focusServer', () => {
  it('opens the detail for the named server so 「市场」的 管理 lands somewhere', async () => {
    useMCPStore.setState({ servers: { 'hand-rolled': serverEntry('hand-rolled') } });
    render(<MCPSection source="mine" focusServer="hand-rolled" />);
    await waitFor(() => expect(screen.getByRole('heading', { name: /hand-rolled/ })).toBeTruthy());
  });

  it('says the failed status in the app language, not a bare English "Error"', async () => {
    setLanguage('zh-CN');
    try {
      useMCPStore.setState({ servers: { broken: { ...serverEntry('broken'), status: 'error' } } });
      render(<MCPSection source="mine" focusServer="broken" />);
      await waitFor(() => expect(screen.getAllByText('连接出错').length).toBeGreaterThan(0));
      expect(screen.queryByText('Error')).toBeNull();
    } finally {
      setLanguage('system');
    }
  });

  it('ignores a server that is not configured', () => {
    render(<MCPSection source="mine" focusServer="never-existed" />);
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
          source="mine"
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

    // 「市场」's 管理 opened the detail; the user chooses Edit from the detail menu.
    await waitFor(() => expect(screen.getByRole('heading', { name: /my-db/ })).toBeTruthy());
    fireEvent.click(screen.getByTestId('mcp-detail-menu'));
    fireEvent.click(screen.getByRole('menuitem', { name: tb().skillEdit }));

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
          source="mine"
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

/**
 * The template form is the only place a configurable slot or a required secret
 * gets filled in, and the agent-side install (`installMCPServer`) already
 * refuses to write a config with an empty slot. The UI must not be laxer: a
 * blank 「数据库连接串」 would write `args: [..., '']` — a server that cannot
 * start — and a blank key would be dropped by the `Object.keys(env).length > 0`
 * guard, so the later editor would show no env field at all to fix it. The
 * disabled 「安装」 button is the whole signal; no new prose.
 */
describe('MCPSection · template install requires its fields', () => {
  const templatePrefill = (name: string, args: string[]): ConnectorPrefill => ({
    name, command: 'npx', args, env: {}, transport: 'stdio', templateId: name,
  });

  const postgres = templatePrefill('postgres', ['-y', '@modelcontextprotocol/server-postgres', '']);
  const brave = templatePrefill('brave-search', ['-y', '@brave/brave-search-mcp-server']);
  const memory = templatePrefill('memory', ['-y', '@modelcontextprotocol/server-memory']);

  function Host({ initial }: { initial: ConnectorPrefill }) {
    const [open, setOpen] = useState(true);
    return (
      <MCPSection
        source="mine"
        showAddForm={open}
        onAddFormChange={setOpen}
        prefill={initial}
      />
    );
  }

  const installButton = () => screen.getByRole('button', { name: tb().install }) as HTMLButtonElement;

  it('keeps 安装 disabled until the configurable arg is typed, then writes what was typed', async () => {
    const addServer = vi.spyOn(useMCPStore.getState(), 'addServer').mockImplementation(() => {});
    vi.spyOn(useMCPStore.getState(), 'connectServer').mockResolvedValue(undefined);
    render(<Host initial={postgres} />);

    const arg = await screen.findByPlaceholderText('postgresql://user:pass@localhost:5432/db');
    expect(installButton().disabled).toBe(true);

    // Even a click that got through must not write an unstartable config.
    fireEvent.click(installButton());
    expect(addServer).not.toHaveBeenCalled();
    expect(useMCPStore.getState().servers.postgres).toBeUndefined();

    fireEvent.change(arg, { target: { value: 'postgresql://me@localhost:5432/mine' } });
    expect(installButton().disabled).toBe(false);
    fireEvent.click(installButton());
    await waitFor(() => expect(addServer).toHaveBeenCalledWith(expect.objectContaining({
      args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://me@localhost:5432/mine'],
    })));
  });

  it('treats a whitespace-only secret as empty, and carries a real one into env', async () => {
    const addServer = vi.spyOn(useMCPStore.getState(), 'addServer').mockImplementation(() => {});
    vi.spyOn(useMCPStore.getState(), 'connectServer').mockResolvedValue(undefined);
    render(<Host initial={brave} />);

    const key = await screen.findByPlaceholderText('BSA...');
    expect(installButton().disabled).toBe(true);

    fireEvent.change(key, { target: { value: '   ' } });
    expect(installButton().disabled).toBe(true);

    fireEvent.change(key, { target: { value: 'BSA-real-key' } });
    expect(installButton().disabled).toBe(false);
    fireEvent.click(installButton());
    await waitFor(() => expect(addServer).toHaveBeenCalledWith(expect.objectContaining({
      env: { BRAVE_API_KEY: 'BSA-real-key' },
    })));
  });

  it('leaves 安装 enabled for a template that asks for nothing', async () => {
    render(<Host initial={memory} />);
    await waitFor(() => expect(installButton().disabled).toBe(false));
  });

  /**
   * The env branch has always had a label; the configurable-arg branch had only
   * a placeholder, which disappears the moment the user types — leaving a bare
   * box. The registry already derives the label, so render it.
   */
  it('labels the configurable arg, not just placeholders it', async () => {
    setLanguage('zh-CN');
    try {
      render(<Host initial={postgres} />);
      const labelled = await screen.findByLabelText('数据库连接串');
      expect((labelled as HTMLInputElement).placeholder).toBe('postgresql://user:pass@localhost:5432/db');
    } finally {
      setLanguage('system');
    }
  });
});


describe('released connector grouping', () => {
  it('does not offer independent removal of a plugin-owned connector', () => {
    useMCPStore.setState({ servers: { 'weather-mcp': serverEntry('weather-mcp') } });
    usePluginStore.setState({ installed: [plugin('weather', ['weather-mcp'])] });
    render(<MCPSection />);
    fireEvent.click(screen.getByText('weather-mcp'));
    expect(screen.getByTitle(tb().mcpFromPlugin.replace('{name}', 'weather'))).toBeDisabled();
    fireEvent.click(screen.getByTestId('mcp-detail-menu'));
    fireEvent.click(screen.getByRole('menuitem', { name: tb().skillEdit }));
    expect(screen.getByPlaceholderText(tb().serverName)).toBeDisabled();
  });
});

describe('MCP card connection switch', () => {
  it.each(['connected', 'disconnected'] as const)('reuses the %s connection action without opening details', async status => {
    const action = status === 'connected' ? 'disconnectServer' : 'connectServer';
    const operation = vi.spyOn(useMCPStore.getState(), action).mockResolvedValue(undefined);
    useMCPStore.setState({ servers: { local: { ...serverEntry('local'), status } } });
    render(<MCPSection source="mine" />);
    const toggle = screen.getByRole('switch');
    expect(toggle).toHaveAttribute('aria-checked', String(status === 'connected'));
    fireEvent.click(toggle);
    await waitFor(() => expect(operation).toHaveBeenCalledWith('local'));
    expect(screen.getAllByText('local')).toHaveLength(1);
    operation.mockRestore();
  });

  it.each(['connecting', 'reconnecting'] as const)('disables the switch while %s', status => {
    useMCPStore.setState({ servers: { local: { ...serverEntry('local'), status } } });
    render(<MCPSection source="mine" />);
    expect(screen.getByRole('switch')).toBeDisabled();
  });
});

it('shows logs as a separate detail view and returns to the connector', async () => {
  useMCPStore.setState({ servers: { local: serverEntry('local') } });
  render(<MCPSection focusServer="local" />);
  await waitFor(() => expect(screen.getByTestId('mcp-detail-menu')).toBeTruthy());
  fireEvent.click(screen.getByTestId('mcp-detail-menu'));
  fireEvent.click(screen.getByRole('menuitem', { name: tb().viewLogs }));
  expect(screen.getByTestId('mcp-logs-view')).toBeVisible();
  expect(screen.queryByText('Command')).toBeNull();
  expect(screen.queryByRole('button', { name: tb().testConnection })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: tb().backToDetails }));
  expect(screen.queryByTestId('mcp-logs-view')).toBeNull();
  expect(screen.queryByText('Command')).toBeNull();
  expect(screen.getByRole('button', { name: tb().testConnection })).toBeVisible();
});

/**
 * Installing from 「市场」 configures a connector of the user's own, so the
 * shelf follows it to 「我的」 — otherwise 「安装」 appears to do nothing: the
 * new server is on the shelf the user is not looking at.
 */
describe('MCPSection · installing from 市场 lands on 我的', () => {
  it('switches the connectors shelf to 我的 after a template install', async () => {
    // A template with nothing to fill in — the install button is disabled
    // until every configurable slot and secret has a value.
    const template = getMCPTemplatesForHost().find(
      (t) => !t.configurableArgs?.length && !t.requiredEnvVars?.length,
    )!;
    expect(template).toBeDefined();
    const addServer = vi.spyOn(useMCPStore.getState(), 'addServer').mockImplementation(() => {});
    const connectServer = vi.spyOn(useMCPStore.getState(), 'connectServer').mockResolvedValue(undefined);

    render(<MCPSection source="market" />);
    fireEvent.click(screen.getByText(template.name));
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(tb().install) }));

    await waitFor(() => expect(useExtensionSourceStore.getState().sources.mcp).toBe('mine'));
    expect(addServer).toHaveBeenCalledWith(expect.objectContaining({ name: template.name }));
    expect(connectServer).toHaveBeenCalledWith(template.name);
    // Only the connectors tab moves.
    expect(useExtensionSourceStore.getState().sources.skills).toBe('market');
  });
});
