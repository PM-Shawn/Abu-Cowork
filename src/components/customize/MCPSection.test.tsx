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

import { useState, type ReactElement } from 'react';
import { act, render as renderBare, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { Button } from '@/components/ds/button';
import { DesignSystemProvider } from '@/components/ds/provider';

// The detail window is a design-system dialog, so the section renders inside the provider like the app does.
const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });

// How many times each card of the shelf rendered, by its id.
const cardRenders = vi.hoisted(() => ({ byId: {} as Record<string, number> }));
vi.mock('@/components/toolbox/ToolCard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/toolbox/ToolCard')>();
  return {
    ...actual,
    default: (props: Parameters<typeof actual.default>[0]) => {
      cardRenders.byId[props.item.id] = (cardRenders.byId[props.item.id] ?? 0) + 1;
      return actual.default(props);
    },
  };
});

import { getI18n, setLanguage } from '@/i18n';
import type { MCPServerEntry } from '@/stores/mcpStore';
import { useMCPStore } from '@/stores/mcpStore';
import { usePluginStore } from '@/stores/pluginStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { DEFAULT_SOURCES, useExtensionSourceStore } from '@/stores/extensionSourceStore';
import type { InstalledPlugin } from '@/core/plugin/installedStore';
import type { ConnectorPrefill } from '@/components/toolbox/connectors/connectorPrefill';
import { buildConnectorCatalog } from '@/components/toolbox/connectors/connectorPrefill';
import { getMCPTemplates, getMCPTemplatesForHost } from '@/data/marketplace/mcp';
import { mcpManager } from '@/core/mcp/client';
import { useToastStore } from '@/stores/toastStore';
import { useChatStore } from '@/stores/chatStore';
import { useProjectStore } from '@/stores/projectStore';
import { parseArgs } from '@/utils/argsParser';
import { toolCountLabel } from './toolCountLabel';
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
  contributed: { skills: [], mcpServers, agents: [], teams: [] },
});

// The store as it is before any test puts a spy on one of its actions. A spy lives on the state
// object it was put on, and every store update copies it into the next one: each test starts
// from this one instead.
const pristineMcpStore = useMCPStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  cardRenders.byId = {};
  useMCPStore.setState({ ...pristineMcpStore, servers: {}, isLoading: false }, true);
  usePluginStore.setState({ installed: [] });
  useSettingsStore.setState({ extensionsSearchQueries: { plugins: '', skills: '', mcp: '' } });
  useExtensionSourceStore.setState({ sources: { ...DEFAULT_SOURCES } });
});

// A spy on a store action stays on the store until it is taken off.
afterEach(() => {
  vi.restoreAllMocks();
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
   * still has its catalog card there — the shelf a thing was taken from keeps
   * showing it. `sequential-thinking` is one such name.
   */
  it('keeps a catalog-installed server on the 市场 shelf, and says which cards are added', () => {
    useMCPStore.setState({ servers: { 'sequential-thinking': serverEntry('sequential-thinking') } });
    render(<MCPSection />);
    expect(screen.getByText('sequential-thinking')).toBeTruthy();
    // The dot is the whole difference between the two kinds of card here: an
    // added server has one, a catalog entry the user has not added has none.
    expect(screen.getByTestId('mcp-status-sequential-thinking')).toBeTruthy();
    expect(screen.queryByTestId('mcp-status-github')).toBeNull();
  });

  // The card and the detail read the same state off the same function, so a
  // server can never be 「连接出错」 in one place and 「未连接」 in the other.
  it.each([
    ['connected' as const, undefined, () => tb().connected],
    ['connecting' as const, undefined, () => tb().connecting],
    ['disconnected' as const, undefined, () => tb().disconnected],
    ['error' as const, undefined, () => tb().connectionError],
    // An error with no message still reads as an error: the label follows
    // `status`, not the presence of `error` text.
    ['error' as const, '', () => tb().connectionError],
    ['disconnected' as const, 'stale message', () => tb().disconnected],
  ])('reads %s back on the card, not just on / off', (status, error, label) => {
    useMCPStore.setState({ servers: {
      'sequential-thinking': { ...serverEntry('sequential-thinking'), status, error },
    } });
    render(<MCPSection />);
    // A shape with the state as its name: the colour never carries it alone.
    const badge = screen.getByTestId('mcp-status-sequential-thinking');
    expect(within(badge).getByRole('img', { name: label() })).toBeInTheDocument();
    expect(badge).toHaveAttribute('title', error || label());
  });

  // Switching a connector off has to outlive the session: the startup pass
  // (`connectAllEnabled`) reconnects everything still marked enabled, so a
  // disconnect that only changed `status` came back on the next launch — and
  // nothing else in the app ever wrote `enabled: false` for a non-plugin
  // server, which is why `provisionFirstPartyMCPServers`' "an explicit disable
  // is preserved" could never actually be reached.
  it('remembers a connector the user switched off', async () => {
    useMCPStore.setState({ servers: {
      'hand-rolled': { ...serverEntry('hand-rolled'), status: 'connected' },
    } });
    render(<MCPSection source="mine" />);
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => {
      expect(useMCPStore.getState().servers['hand-rolled'].config.enabled).toBe(false);
    });
  });

  it('switches it back on when the user reconnects', async () => {
    useMCPStore.setState({ servers: {
      'hand-rolled': { ...serverEntry('hand-rolled'), config: { name: 'hand-rolled', command: 'npx', args: [], enabled: false }, status: 'disconnected' },
    } });
    render(<MCPSection source="mine" />);
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => {
      expect(useMCPStore.getState().servers['hand-rolled'].config.enabled).toBe(true);
    });
  });

  it('shows the same dot on 我的', () => {
    useMCPStore.setState({ servers: { 'hand-rolled': { ...serverEntry('hand-rolled'), status: 'connected' } } });
    render(<MCPSection source="mine" />);
    expect(within(screen.getByTestId('mcp-status-hand-rolled')).getByRole('img', { name: tb().connected })).toBeInTheDocument();
  });

  it('puts the added connectors first on 市场', () => {
    // `github` sits before `sequential-thinking` in the catalog, so a shelf
    // that kept catalog order would list it first.
    useMCPStore.setState({ servers: { 'sequential-thinking': serverEntry('sequential-thinking') } });
    render(<MCPSection />);
    const order = screen.getAllByTestId(/^mcp-card-/).map((el) => el.getAttribute('data-testid'));
    expect(order[0]).toBe('mcp-card-sequential-thinking');
    expect(order.indexOf('mcp-card-github')).toBeGreaterThan(0);
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
    await waitFor(() => expect(screen.getByRole('heading', { name: `hand-rolled ${tb().connectors}` })).toBeTruthy());
    // The window is named after the connector.
    expect(screen.getByRole('dialog', { name: 'hand-rolled' })).toBeInTheDocument();
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
        <Button data-testid="host-open" onClick={() => setOpen(true)}>open</Button>
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
    await waitFor(() => expect(screen.getByRole('heading', { name: `my-db ${tb().connectors}` })).toBeTruthy());
    await userEvent.click(screen.getByTestId('mcp-detail-menu'));
    fireEvent.click(screen.getByRole('menuitem', { name: tb().skillEdit }));

    const name = await screen.findByPlaceholderText(tb().serverName);
    expect((name as HTMLInputElement).value).toBe('my-db');
    expect(screen.getByRole('dialog', { name: tb().skillEdit })).toBeInTheDocument();
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
        <Button data-testid="offer-slack" onClick={() => setOffer({
          name: 'slack', command: 'npx', args: ['-y', 'slack-mcp'], env: {}, transport: 'stdio',
        })}>slack</Button>
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
  it('does not offer independent removal of a plugin-owned connector', async () => {
    useMCPStore.setState({ servers: { 'weather-mcp': serverEntry('weather-mcp') } });
    usePluginStore.setState({ installed: [plugin('weather', ['weather-mcp'])] });
    render(<MCPSection />);
    fireEvent.click(screen.getByText('weather-mcp'));
    const remove = screen.getByRole('button', { name: getI18n().common.delete });
    expect(remove).toBeDisabled();
    // The reason is on the element around the button: a disabled button shows no title of its own.
    expect(remove.parentElement).toHaveAttribute('title', tb().mcpFromPlugin.replace('{name}', 'weather'));
    await userEvent.click(screen.getByTestId('mcp-detail-menu'));
    fireEvent.click(screen.getByRole('menuitem', { name: tb().skillEdit }));
    // The chosen action runs once the menu has gone.
    expect(await screen.findByPlaceholderText(tb().serverName)).toBeDisabled();
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

  it.each(['connecting', 'reconnecting'] as const)('keeps the switch focusable and takes no press while %s', async status => {
    const connect = vi.spyOn(useMCPStore.getState(), 'connectServer').mockResolvedValue(undefined);
    const disconnect = vi.spyOn(useMCPStore.getState(), 'disconnectServer').mockResolvedValue(undefined);
    useMCPStore.setState({ servers: { local: { ...serverEntry('local'), status } } });
    render(<MCPSection source="mine" />);
    const toggle = screen.getByRole('switch');
    // Busy, never disabled: a disabled control would drop the keyboard focus onto the window.
    expect(toggle).toHaveAttribute('aria-disabled', 'true');
    expect(toggle).not.toBeDisabled();

    toggle.focus();
    fireEvent.click(toggle);
    await userEvent.keyboard(' ');
    await userEvent.keyboard('{Enter}');

    expect(toggle).toHaveFocus();
    expect(connect).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
    connect.mockRestore();
    disconnect.mockRestore();
  });

  it('keeps the focus on the detail window\'s switch while it disconnects, and takes no second press', async () => {
    let finish!: () => void;
    const disconnect = vi.spyOn(useMCPStore.getState(), 'disconnectServer').mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const connect = vi.spyOn(useMCPStore.getState(), 'connectServer').mockResolvedValue(undefined);
    useMCPStore.setState({ servers: { local: { ...serverEntry('local'), status: 'connected' } } });
    render(<MCPSection source="mine" />);
    fireEvent.click(screen.getByTestId('mcp-card-local'));
    const toggle = within(screen.getByTestId('mcp-server-toggle-connection')).getByRole('switch');

    toggle.focus();
    await userEvent.keyboard(' ');
    await waitFor(() => expect(disconnect).toHaveBeenCalledTimes(1));
    expect(toggle).toHaveAttribute('aria-disabled', 'true');
    expect(toggle).not.toBeDisabled();
    expect(toggle).toHaveFocus();

    // A second press while the first is running starts nothing.
    await userEvent.keyboard(' ');
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(connect).not.toHaveBeenCalled();

    await act(async () => { finish(); });
    await waitFor(() => expect(toggle).not.toHaveAttribute('aria-disabled'));
    expect(toggle).toHaveFocus();
    disconnect.mockRestore();
    connect.mockRestore();
  });
});

it('shows logs as a separate detail view and returns to the connector', async () => {
  useMCPStore.setState({ servers: { local: serverEntry('local') } });
  render(<MCPSection focusServer="local" />);
  await waitFor(() => expect(screen.getByTestId('mcp-detail-menu')).toBeTruthy());
  await userEvent.click(screen.getByTestId('mcp-detail-menu'));
  fireEvent.click(screen.getByRole('menuitem', { name: tb().viewLogs }));
  // The chosen action runs once the menu has gone.
  expect(await screen.findByTestId('mcp-logs-view')).toBeVisible();
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

/**
 * A connector runs a command on this machine with arguments and environment
 * variables, or talks to an address with headers. What the page hands to the
 * store and the host is fixed here: the same calls, with the same values, in
 * the same order.
 */
const ENV_VALUE = 'mcp-env-not-a-secret';
const HEADER_VALUE = 'mcp-header-not-a-secret';

/** The page with its add window open, owned from outside as the extensions page owns it. */
function FormHost({ focusServer }: { focusServer?: string }) {
  const [open, setOpen] = useState(true);
  return <MCPSection source="mine" showAddForm={open} onAddFormChange={setOpen} focusServer={focusServer} />;
}

const field = (placeholder: string) => screen.getByPlaceholderText(placeholder) as HTMLInputElement;
const type = (placeholder: string, value: string) => fireEvent.change(field(placeholder), { target: { value } });
const submitButton = (label: string) => screen.getByText(label, { selector: 'button' }) as HTMLButtonElement;
const ENV_PLACEHOLDER = '{"API_KEY": "..."}';

/** Every place on the page that shows the value, apart from the `value` of a field it was typed into. */
function placesShowing(value: string): string[] {
  const found: string[] = [];
  for (const element of Array.from(document.body.querySelectorAll('*'))) {
    const isField = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
    for (const attribute of Array.from(element.attributes)) {
      if (isField && attribute.name === 'value') continue;
      if (attribute.value.includes(value)) found.push(`${element.tagName.toLowerCase()}[${attribute.name}]`);
    }
    if (isField) continue;
    for (const node of Array.from(element.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE && node.textContent?.includes(value)) found.push(`${element.tagName.toLowerCase()} text`);
    }
  }
  return found;
}

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;
function watchConsole() {
  const spies = CONSOLE_METHODS.map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
  const text = (arg: unknown) => {
    if (typeof arg === 'string') return arg;
    try { return JSON.stringify(arg) ?? String(arg); } catch { return String(arg); }
  };
  return (value: string) => spies.flatMap((spy) => spy.mock.calls).map((args) => args.map(text).join(' ')).filter((line) => line.includes(value));
}

function spyOnConnections() {
  const store = useMCPStore.getState();
  return {
    connect: vi.spyOn(store, 'connectServer').mockResolvedValue(undefined),
    disconnect: vi.spyOn(store, 'disconnectServer').mockResolvedValue(undefined),
  };
}

describe('MCPSection · the connection switch and the keyboard', () => {
  const ARROWS = ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'];
  // The keys go to the switch: it takes the focus right before them, with no pause in between
  // (a window an earlier test left open gives the focus back on a timer).
  const user = () => userEvent.setup({ delay: null });
  async function press(target: HTMLElement, keys: string) {
    target.focus();
    await user().keyboard(keys);
  }
  /** The keys the switch itself heard. */
  function listen(target: HTMLElement): string[] {
    const heard: string[] = [];
    target.addEventListener('keydown', (event) => heard.push(event.key));
    return heard;
  }

  it.each(['connected', 'disconnected'] as const)('changes a %s card only on Enter, Space or a click, never on an arrow key', async (status) => {
    const { connect, disconnect } = spyOnConnections();
    const operation = status === 'connected' ? disconnect : connect;
    useMCPStore.setState({ servers: { local: { ...serverEntry('local'), status } } });
    render(<MCPSection source="mine" />);
    const toggle = screen.getByRole('switch');
    const heard = listen(toggle);

    await press(toggle, ARROWS.map((key) => `{${key}}`).join(''));
    expect(heard).toEqual(ARROWS);
    expect(connect).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();

    await press(toggle, '{Enter}');
    await waitFor(() => expect(operation).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('switch')).not.toHaveAttribute('aria-disabled'));
    await press(screen.getByRole('switch'), ' ');
    await waitFor(() => expect(operation).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('switch')).not.toHaveAttribute('aria-disabled'));
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(operation).toHaveBeenCalledTimes(3));

    expect(operation.mock.calls).toEqual([['local'], ['local'], ['local']]);
    expect(status === 'connected' ? connect : disconnect).not.toHaveBeenCalled();
    // The card did not open its window.
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('leaves the switch of the detail window alone on an arrow key', async () => {
    const { connect, disconnect } = spyOnConnections();
    useMCPStore.setState({ servers: { local: { ...serverEntry('local'), status: 'connected' } } });
    render(<MCPSection source="mine" focusServer="local" />);
    const holder = await screen.findByTestId('mcp-server-toggle-connection');
    const toggle = holder.querySelector<HTMLElement>('[role="switch"]')!;
    const heard = listen(toggle);

    await press(toggle, ARROWS.map((key) => `{${key}}`).join(''));
    expect(heard).toEqual(ARROWS);
    expect(disconnect).not.toHaveBeenCalled();
    expect(holder).toHaveAttribute('data-connected', 'true');

    await press(toggle, ' ');
    await waitFor(() => expect(disconnect).toHaveBeenCalledTimes(1));
    expect(disconnect).toHaveBeenCalledWith('local');
    expect(connect).not.toHaveBeenCalled();
  });
});

describe('MCPSection · test connection', () => {
  const config = { name: 'local', command: 'node', args: ['server.js'], env: { TOKEN: ENV_VALUE }, enabled: true };
  type TestResult = Awaited<ReturnType<typeof mcpManager.testConnection>>;

  function startTest() {
    let finish: (result: TestResult) => void = () => {};
    const test = vi.spyOn(mcpManager, 'testConnection').mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const addToast = vi.spyOn(useToastStore.getState(), 'addToast').mockImplementation(() => {});
    const clearServerError = vi.spyOn(useMCPStore.getState(), 'clearServerError');
    useMCPStore.setState({ servers: { local: { config, status: 'disconnected', tools: [] } } });
    render(<MCPSection source="mine" focusServer="local" />);
    return { test, addToast, clearServerError, finish: (result: TestResult) => act(async () => { finish(result); }) };
  }

  it('probes the server with its own config once, takes no second press while it runs, then says the result', async () => {
    const { test, addToast, clearServerError, finish } = startTest();
    const button = await screen.findByRole('button', { name: tb().testConnection });
    fireEvent.click(button);
    expect(test).toHaveBeenCalledTimes(1);
    expect(test).toHaveBeenCalledWith(config);

    fireEvent.click(screen.getByRole('button', { name: tb().testConnection }));
    expect(test).toHaveBeenCalledTimes(1);
    expect(addToast).not.toHaveBeenCalled();

    await finish({ success: true, toolCount: 2, appToolCount: 0 });
    expect(addToast).toHaveBeenCalledTimes(1);
    expect(addToast).toHaveBeenCalledWith({
      type: 'success',
      title: 'local',
      message: `${tb().testSuccess} · ${toolCountLabel(getI18n(), 2, 0)}`,
    });
    expect(clearServerError).toHaveBeenCalledWith('local');

    // The probe has ended: the button takes a press again.
    fireEvent.click(screen.getByRole('button', { name: tb().testConnection }));
    expect(test).toHaveBeenCalledTimes(2);
  });

  it('says why a probe failed and leaves the stored error alone', async () => {
    const { addToast, clearServerError, finish } = startTest();
    fireEvent.click(await screen.findByRole('button', { name: tb().testConnection }));
    await finish({ success: false, error: 'connection refused' });
    expect(addToast).toHaveBeenCalledWith({ type: 'error', title: 'local', message: 'connection refused' });
    expect(clearServerError).not.toHaveBeenCalled();
  });
});

describe('MCPSection · what a template install writes', () => {
  it('masks the secret field and hands the store exactly what was typed, then connects', async () => {
    const template = getMCPTemplates().find((item) => item.id === 'brave-search')!;
    const addServer = vi.spyOn(useMCPStore.getState(), 'addServer').mockImplementation(() => {});
    const { connect } = spyOnConnections();
    const said = watchConsole();
    render(<MCPSection source="market" />);
    fireEvent.click(screen.getByText(template.name));

    const key = await screen.findByPlaceholderText('BSA...') as HTMLInputElement;
    expect(key.type).toBe('password');
    fireEvent.change(key, { target: { value: ENV_VALUE } });
    expect(placesShowing(ENV_VALUE)).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: tb().install }));
    await waitFor(() => expect(connect).toHaveBeenCalledWith(template.name));
    expect(addServer).toHaveBeenCalledTimes(1);
    expect(addServer).toHaveBeenCalledWith({
      name: template.name,
      command: template.command ?? 'npx',
      args: [...(template.defaultArgs ?? [])],
      env: { BRAVE_API_KEY: ENV_VALUE },
      enabled: true,
      timeout: template.defaultTimeout,
    });
    expect(addServer.mock.invocationCallOrder[0]).toBeLessThan(connect.mock.invocationCallOrder[0]);
    expect(placesShowing(ENV_VALUE)).toEqual([]);
    expect(said(ENV_VALUE)).toEqual([]);
  });

  it('keeps a configurable argument in a plain field', async () => {
    render(<MCPSection source="market" />);
    fireEvent.click(screen.getByText('postgres'));
    const arg = await screen.findByPlaceholderText('postgresql://user:pass@localhost:5432/db') as HTMLInputElement;
    expect(arg.type).toBe('text');
  });
});

describe('MCPSection · the add window', () => {
  it('offers 添加 only once a name and a command, or a name and an address, are typed', () => {
    render(<FormHost />);
    const add = () => submitButton(tb().add);
    expect(add().disabled).toBe(true);
    type(tb().serverName, 'my-server');
    expect(add().disabled).toBe(true);
    type(tb().serverCommand, 'node');
    expect(add().disabled).toBe(false);
    type(tb().serverName, '   ');
    expect(add().disabled).toBe(true);
    type(tb().serverName, 'my-server');
    type(tb().serverCommand, '  ');
    expect(add().disabled).toBe(true);

    fireEvent.click(screen.getByText(tb().transportHttp));
    expect(add().disabled).toBe(true);
    type(tb().serverUrlPlaceholder, 'http://127.0.0.1:9/mcp');
    expect(add().disabled).toBe(false);
  });

  it('offers 添加 in JSON mode only once something is pasted', () => {
    render(<FormHost />);
    fireEvent.click(screen.getByText(tb().jsonMode));
    expect(submitButton(tb().add).disabled).toBe(true);
    fireEvent.change(document.querySelector('textarea')!, { target: { value: '   ' } });
    expect(submitButton(tb().add).disabled).toBe(true);
    fireEvent.change(document.querySelector('textarea')!, { target: { value: '{}' } });
    expect(submitButton(tb().add).disabled).toBe(false);
  });

  it('adds a local command with exactly the command, arguments and environment typed, then connects it', async () => {
    const addServer = vi.spyOn(useMCPStore.getState(), 'addServer');
    const { connect } = spyOnConnections();
    render(<FormHost />);
    type(tb().serverName, '  my-server ');
    type(tb().serverCommand, ' node ');
    type(tb().serverArgs, 'server.js --port 8080 "two words"');
    type(ENV_PLACEHOLDER, `{"TOKEN":"${ENV_VALUE}"}`);
    fireEvent.click(submitButton(tb().add));

    await waitFor(() => expect(connect).toHaveBeenCalledWith('my-server'));
    expect(addServer).toHaveBeenCalledTimes(1);
    expect(addServer).toHaveBeenCalledWith({
      name: 'my-server',
      transport: 'stdio',
      enabled: true,
      command: 'node',
      args: parseArgs('server.js --port 8080 "two words"'),
      env: { TOKEN: ENV_VALUE },
    });
    expect(addServer.mock.invocationCallOrder[0]).toBeLessThan(connect.mock.invocationCallOrder[0]);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(useExtensionSourceStore.getState().sources.mcp).toBe('mine');
    // The window has closed and the new connector's own window is open; the card shows the command line as typed.
    await waitFor(() => expect(screen.queryByPlaceholderText(tb().serverName)).toBeNull());
    expect(screen.getByRole('heading', { name: `my-server ${tb().connectors}` })).toBeTruthy();
    expect(screen.getByText('node server.js --port 8080 two words')).toBeTruthy();
  });

  it('adds a remote service with exactly the address and headers typed, then connects it', async () => {
    const addServer = vi.spyOn(useMCPStore.getState(), 'addServer');
    const { connect } = spyOnConnections();
    render(<FormHost />);
    type(tb().serverName, 'remote');
    fireEvent.click(screen.getByText(tb().transportHttp));
    type(tb().serverUrlPlaceholder, ' http://127.0.0.1:9/mcp ');
    type(tb().serverHeadersPlaceholder, `{"Authorization":"Bearer ${HEADER_VALUE}"}`);
    fireEvent.click(submitButton(tb().add));

    await waitFor(() => expect(connect).toHaveBeenCalledWith('remote'));
    expect(addServer).toHaveBeenCalledTimes(1);
    expect(addServer).toHaveBeenCalledWith({
      name: 'remote',
      transport: 'http',
      enabled: true,
      url: 'http://127.0.0.1:9/mcp',
      headers: { Authorization: `Bearer ${HEADER_VALUE}` },
    });
    expect(screen.getByText('http://127.0.0.1:9/mcp')).toBeTruthy();
  });

  it('adds the command without an environment when the Env text is not JSON', async () => {
    const addServer = vi.spyOn(useMCPStore.getState(), 'addServer');
    spyOnConnections();
    render(<FormHost />);
    type(tb().serverName, 'my-server');
    type(tb().serverCommand, 'node');
    type(ENV_PLACEHOLDER, 'TOKEN=value');
    fireEvent.click(submitButton(tb().add));
    await waitFor(() => expect(addServer).toHaveBeenCalledTimes(1));
    expect(addServer).toHaveBeenCalledWith({ name: 'my-server', transport: 'stdio', enabled: true, command: 'node', args: [] });
  });

  it('refuses a name that is taken and adds nothing', () => {
    const addServer = vi.spyOn(useMCPStore.getState(), 'addServer');
    useMCPStore.setState({ servers: { taken: serverEntry('taken') } });
    render(<FormHost />);
    type(tb().serverName, 'taken');
    type(tb().serverCommand, 'node');
    fireEvent.click(submitButton(tb().add));
    expect(addServer).not.toHaveBeenCalled();
    expect(screen.getByText(tb().serverNameExists.replace('{name}', 'taken'))).toBeTruthy();
    expect(field(tb().serverName).value).toBe('taken');
  });

  it('adds every server of a pasted JSON config as written, and connects each', async () => {
    const addServer = vi.spyOn(useMCPStore.getState(), 'addServer');
    const { connect } = spyOnConnections();
    render(<FormHost />);
    fireEvent.click(screen.getByText(tb().jsonMode));
    fireEvent.change(document.querySelector('textarea')!, { target: { value: JSON.stringify({
      mcpServers: {
        first: { command: 'node', args: ['a.js'], env: { TOKEN: ENV_VALUE } },
        second: { url: 'http://127.0.0.1:9/mcp', headers: { 'X-Key': HEADER_VALUE } },
      },
    }) } });
    fireEvent.click(submitButton(tb().add));

    await waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    expect(addServer.mock.calls).toEqual([
      [{ name: 'first', enabled: true, transport: 'stdio', command: 'node', args: ['a.js'], env: { TOKEN: ENV_VALUE } }],
      [{ name: 'second', enabled: true, transport: 'http', url: 'http://127.0.0.1:9/mcp', headers: { 'X-Key': HEADER_VALUE } }],
    ]);
    expect(connect.mock.calls).toEqual([['first'], ['second']]);
    expect(useExtensionSourceStore.getState().sources.mcp).toBe('mine');
  });

  it('shows Env and Headers values nowhere but in the fields they were typed into, and logs none', async () => {
    spyOnConnections();
    const said = watchConsole();
    render(<FormHost />);
    type(tb().serverName, 'remote');
    type(tb().serverCommand, 'node');
    type(ENV_PLACEHOLDER, `{"TOKEN":"${ENV_VALUE}"}`);
    expect(field(ENV_PLACEHOLDER).type).toBe('text');
    expect(placesShowing(ENV_VALUE)).toEqual([]);

    fireEvent.click(screen.getByText(tb().transportHttp));
    type(tb().serverUrlPlaceholder, 'http://127.0.0.1:9/mcp');
    type(tb().serverHeadersPlaceholder, `{"Authorization":"Bearer ${HEADER_VALUE}"}`);
    expect(field(tb().serverHeadersPlaceholder).type).toBe('text');
    expect(placesShowing(HEADER_VALUE)).toEqual([]);

    fireEvent.click(submitButton(tb().add));
    await screen.findByRole('heading', { name: `remote ${tb().connectors}` });
    expect(useMCPStore.getState().servers.remote.config.headers).toEqual({ Authorization: `Bearer ${HEADER_VALUE}` });
    expect(placesShowing(HEADER_VALUE)).toEqual([]);
    expect(placesShowing(ENV_VALUE)).toEqual([]);
    expect(said(HEADER_VALUE)).toEqual([]);
    expect(said(ENV_VALUE)).toEqual([]);
  });
});

describe('MCPSection · editing a connector', () => {
  const openEdit = async (name: string) => {
    await waitFor(() => expect(screen.getByTestId('mcp-detail-menu')).toBeTruthy());
    await userEvent.click(screen.getByTestId('mcp-detail-menu'));
    fireEvent.click(screen.getByRole('menuitem', { name: tb().skillEdit }));
    await waitFor(() => expect(field(tb().serverName).value).toBe(name));
  };

  it('saves under the same name: disconnects, writes the config, connects again', async () => {
    const store = useMCPStore.getState();
    const { connect, disconnect } = spyOnConnections();
    const rename = vi.spyOn(store, 'renameServer');
    const update = vi.spyOn(store, 'updateServer');
    useMCPStore.setState({ servers: { 'my-db': { config: { name: 'my-db', command: 'psql', args: ['--local'], env: { TOKEN: ENV_VALUE }, enabled: true }, status: 'disconnected', tools: [] } } });
    render(<MCPSection source="mine" focusServer="my-db" />);
    await openEdit('my-db');
    // The stored environment is in its field and nowhere else on the page.
    expect(field(ENV_PLACEHOLDER).value).toBe(`{"TOKEN":"${ENV_VALUE}"}`);
    expect(placesShowing(ENV_VALUE)).toEqual([]);

    type(tb().serverCommand, 'pg-mcp');
    fireEvent.click(submitButton(getI18n().common.save));

    await waitFor(() => expect(connect).toHaveBeenCalledWith('my-db'));
    expect(rename).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith('my-db', {
      name: 'my-db', transport: 'stdio', enabled: true, command: 'pg-mcp', args: ['--local'], env: { TOKEN: ENV_VALUE },
    });
    expect(disconnect).toHaveBeenCalledWith('my-db');
    expect(disconnect.mock.invocationCallOrder[0]).toBeLessThan(update.mock.invocationCallOrder[0]);
    expect(update.mock.invocationCallOrder[0]).toBeLessThan(connect.mock.invocationCallOrder[0]);
    expect(placesShowing(ENV_VALUE)).toEqual([]);
  });

  it('saves under a new name: disconnects the old, renames, moves the references, writes, connects the new', async () => {
    const store = useMCPStore.getState();
    const { connect, disconnect } = spyOnConnections();
    const rename = vi.spyOn(store, 'renameServer');
    const update = vi.spyOn(store, 'updateServer');
    const chatReferences = vi.spyOn(useChatStore.getState(), 'renameMCPServerReferences').mockImplementation(() => {});
    const projectReferences = vi.spyOn(useProjectStore.getState(), 'renameMCPServerReferences').mockImplementation(() => {});
    const clearLogs = vi.spyOn(mcpManager, 'clearServerLogs');
    useMCPStore.setState({ servers: { 'my-db': { config: { name: 'my-db', command: 'psql', args: ['--local'], enabled: true }, status: 'disconnected', tools: [] } } });
    render(<MCPSection source="mine" focusServer="my-db" />);
    await openEdit('my-db');

    type(tb().serverName, 'main-db');
    fireEvent.click(submitButton(getI18n().common.save));

    await waitFor(() => expect(connect).toHaveBeenCalledWith('main-db'));
    expect(disconnect).toHaveBeenCalledWith('my-db');
    expect(rename).toHaveBeenCalledWith('my-db', 'main-db');
    expect(chatReferences).toHaveBeenCalledWith('my-db', 'main-db');
    expect(projectReferences).toHaveBeenCalledWith('my-db', 'main-db');
    expect(clearLogs).toHaveBeenCalledWith('my-db');
    expect(update).toHaveBeenCalledWith('main-db', { name: 'main-db', transport: 'stdio', enabled: true, command: 'psql', args: ['--local'] });
    const order = [disconnect, rename, chatReferences, projectReferences, clearLogs, update, connect].map((spy) => spy.mock.invocationCallOrder[0]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(useMCPStore.getState().servers['my-db']).toBeUndefined();
    expect(useMCPStore.getState().servers['main-db'].config.command).toBe('psql');
    // The window of the renamed connector is the one left open.
    await screen.findByRole('heading', { name: `main-db ${tb().connectors}` });
  });
});

// happy-dom reports no animation, so Radix removes a closed layer at once. With this, a closed
// layer has an exit animation: it stays on the page, as it does in the app while it fades out.
function keepClosingLayersOnScreen() {
  const real = window.getComputedStyle.bind(window);
  return vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element, pseudo?: string | null) => {
    const styles = real(element, pseudo);
    return new Proxy(styles, {
      get(target, prop) {
        if (prop === 'animationName') return element.getAttribute('data-state') === 'closed' ? 'exit' : 'enter';
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  });
}

/** The window that is fading out. */
function closingWindow(): HTMLElement {
  const closing = document.querySelector<HTMLElement>('[role="dialog"][data-state="closed"]');
  if (!closing) throw new Error('No window is closing');
  return closing;
}

const card = (name: string) => screen.getByTestId(`mcp-card-${name}`);
const deleteButton = () => screen.getByRole('button', { name: getI18n().common.delete });
const question = () => screen.findByRole('alertdialog', { name: getI18n().common.delete });
const confirmDelete = async () => fireEvent.click(within(await question()).getByRole('button', { name: getI18n().common.delete }));

describe('MCPSection · deleting a connector', () => {
  it('asks first, naming the server, and removes nothing until the answer', async () => {
    const { disconnect } = spyOnConnections();
    const remove = vi.spyOn(useMCPStore.getState(), 'removeServer');
    useMCPStore.setState({ servers: { 'hand-rolled': serverEntry('hand-rolled'), other: serverEntry('other') } });
    render(<MCPSection source="mine" focusServer="hand-rolled" />);
    fireEvent.click(await screen.findByRole('button', { name: getI18n().common.delete }));

    const asked = await question();
    expect(asked).toHaveTextContent('hand-rolled');
    expect(within(asked).getByRole('button', { name: getI18n().common.cancel })).toBeInTheDocument();
    expect(remove).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();

    await confirmDelete();
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    expect(remove).toHaveBeenCalledWith('hand-rolled');
    expect(disconnect).toHaveBeenCalledWith('hand-rolled');
    expect(disconnect.mock.invocationCallOrder[0]).toBeLessThan(remove.mock.invocationCallOrder[0]);
    expect(useMCPStore.getState().servers['hand-rolled']).toBeUndefined();
    expect(useMCPStore.getState().servers.other).toBeDefined();
    // The window closes; it does not move on to another connector.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('removes nothing when the question is cancelled, and keeps the window', async () => {
    const { disconnect } = spyOnConnections();
    const remove = vi.spyOn(useMCPStore.getState(), 'removeServer');
    useMCPStore.setState({ servers: { 'hand-rolled': serverEntry('hand-rolled') } });
    render(<MCPSection source="mine" focusServer="hand-rolled" />);
    fireEvent.click(await screen.findByRole('button', { name: getI18n().common.delete }));
    fireEvent.click(within(await question()).getByRole('button', { name: getI18n().common.cancel }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(remove).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'hand-rolled' })).toBeInTheDocument();
  });

  // A catalog connector that leaves the store hands its window to the catalog entry, so the
  // question is still there to be answered.
  it('removes nothing when the server has left the store by the time of the answer', async () => {
    const { disconnect } = spyOnConnections();
    const remove = vi.spyOn(useMCPStore.getState(), 'removeServer');
    useMCPStore.setState({ servers: { github: serverEntry('github') } });
    render(<MCPSection source="market" focusServer="github" />);
    fireEvent.click(await screen.findByRole('button', { name: getI18n().common.delete }));
    await question();

    act(() => { useMCPStore.setState({ servers: {} }); });
    await confirmDelete();
    await act(async () => { for (let turn = 0; turn < 5; turn += 1) await Promise.resolve(); });

    expect(remove).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
  });

  it.each([
    ['the page has left', (view: ReturnType<typeof render>) => view.rerender(<span>chat</span>)],
    ['the server has left the store, and its window with it', () => act(() => { useMCPStore.setState({ servers: { other: serverEntry('other') } }); })],
  ] as const)('ends the question when %s: nothing is removed', async (_when, leave) => {
    const { disconnect } = spyOnConnections();
    const remove = vi.spyOn(useMCPStore.getState(), 'removeServer');
    useMCPStore.setState({ servers: { 'hand-rolled': serverEntry('hand-rolled'), other: serverEntry('other') } });
    const view = render(<MCPSection source="mine" focusServer="hand-rolled" />);
    fireEvent.click(await screen.findByRole('button', { name: getI18n().common.delete }));
    await question();

    leave(view);

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await act(async () => { for (let turn = 0; turn < 5; turn += 1) await Promise.resolve(); });
    expect(remove).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
    expect(useMCPStore.getState().servers.other).toBeDefined();
  });

  it('asks nothing from a window that is closing', async () => {
    useMCPStore.setState({ servers: { 'hand-rolled': serverEntry('hand-rolled') } });
    render(<MCPSection source="mine" focusServer="hand-rolled" />);
    await screen.findByRole('button', { name: getI18n().common.delete });
    keepClosingLayersOnScreen();
    fireEvent.keyDown(document, { key: 'Escape' });

    // The window still shows the connector it held.
    const closing = closingWindow();
    fireEvent.click(within(closing).getByRole('button', { name: getI18n().common.delete }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('asks once: a second press while the first removal runs does nothing', async () => {
    let finish: () => void = () => {};
    const disconnect = vi.spyOn(useMCPStore.getState(), 'disconnectServer').mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const remove = vi.spyOn(useMCPStore.getState(), 'removeServer');
    useMCPStore.setState({ servers: { 'hand-rolled': serverEntry('hand-rolled') } });
    render(<MCPSection source="mine" focusServer="hand-rolled" />);
    fireEvent.click(await screen.findByRole('button', { name: getI18n().common.delete }));
    await confirmDelete();
    await waitFor(() => expect(disconnect).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());

    fireEvent.click(deleteButton());
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('alertdialog')).toBeNull();

    await act(async () => { finish(); });
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  describe('where the focus goes once the card has gone', () => {
    const three = () => ({ first: serverEntry('first'), second: serverEntry('second'), third: serverEntry('third') });
    async function deleteFromItsWindow(name: string) {
      spyOnConnections();
      card(name).focus();
      fireEvent.click(card(name));
      fireEvent.click(await screen.findByRole('button', { name: getI18n().common.delete }));
      await confirmDelete();
      await waitFor(() => expect(useMCPStore.getState().servers[name]).toBeUndefined());
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    }

    it('goes to the card that took its place', async () => {
      useMCPStore.setState({ servers: three() });
      render(<MCPSection source="mine" />);
      await deleteFromItsWindow('second');
      await waitFor(() => expect(document.activeElement).toBe(card('third')));
    });

    it('goes to the card before it when it was the last one', async () => {
      useMCPStore.setState({ servers: three() });
      render(<MCPSection source="mine" />);
      await deleteFromItsWindow('third');
      await waitFor(() => expect(document.activeElement).toBe(card('second')));
    });

    it('goes to the empty shelf’s own button when no card is left', async () => {
      useMCPStore.setState({ servers: { only: serverEntry('only') } });
      render(<MCPSection source="mine" />);
      await deleteFromItsWindow('only');
      await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('connectors-mine-add')));
    });

    it('goes to the catalog card of a catalog connector on 市场', async () => {
      useMCPStore.setState({ servers: { github: serverEntry('github') } });
      render(<MCPSection source="market" />);
      await deleteFromItsWindow('github');
      await waitFor(() => expect(document.activeElement).toBe(card('github')));
      expect(screen.queryByTestId('mcp-status-github')).toBeNull();
    });
  });
});

describe('MCPSection · the detail window', () => {
  it('goes back to the card when it closes', async () => {
    useMCPStore.setState({ servers: { first: serverEntry('first'), second: serverEntry('second') } });
    render(<MCPSection source="mine" />);
    card('second').focus();
    fireEvent.click(card('second'));
    await screen.findByRole('dialog', { name: 'second' });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(card('second')));
  });

  it('names a catalog entry’s window after the entry', async () => {
    render(<MCPSection source="market" />);
    fireEvent.click(card('github'));
    expect(await screen.findByRole('dialog', { name: 'github' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: `github ${tb().connectors}` })).toBeInTheDocument();
  });

  it('names both switches: the card’s after the connector, the window’s after what it does', async () => {
    useMCPStore.setState({ servers: { local: { ...serverEntry('local'), status: 'connected' } } });
    render(<MCPSection source="mine" />);
    expect(screen.getByRole('switch', { name: 'local' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(card('local'));
    const holder = await screen.findByTestId('mcp-server-toggle-connection');
    expect(holder).toHaveAttribute('title', tb().disconnect);
    expect(within(holder).getByRole('switch', { name: tb().disconnect })).toHaveAttribute('aria-checked', 'true');
  });

  it('says the state with a shape and words, and the error next to it', async () => {
    useMCPStore.setState({ servers: { broken: { ...serverEntry('broken'), status: 'error', error: 'spawn ENOENT' } } });
    render(<MCPSection source="mine" focusServer="broken" />);
    const status = await screen.findByTestId('mcp-detail-status');
    expect(status).toHaveTextContent(tb().connectionError);
    expect(screen.getByRole('alert')).toHaveTextContent('spawn ENOENT');
  });

  it('shows one spinner, with the words, while the server connects', async () => {
    useMCPStore.setState({ servers: { slow: { ...serverEntry('slow'), status: 'connecting' } } });
    render(<MCPSection source="mine" focusServer="slow" />);
    const status = await screen.findByTestId('mcp-detail-status');
    expect(within(status).getByRole('status')).toHaveTextContent(tb().connecting);
    expect(within(screen.getByRole('dialog', { name: 'slow' })).getAllByRole('status')).toHaveLength(1);
  });

  it('lists the tools of a connected server under a heading that folds', async () => {
    useMCPStore.setState({ servers: { local: { ...serverEntry('local'), status: 'connected', tools: [{ name: 'read_rows', description: 'Reads rows' }, { name: 'write_rows' }] as MCPServerEntry['tools'] } } });
    render(<MCPSection source="mine" focusServer="local" />);
    const heading = await screen.findByRole('button', { name: `${tb().agentTools} (2)` });
    expect(heading).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('read_rows')).toBeInTheDocument();
    expect(screen.getByText('Reads rows')).toBeInTheDocument();
    fireEvent.click(heading);
    expect(heading).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps the window under the edit form and returns the focus to the menu button when the form closes', async () => {
    useMCPStore.setState({ servers: { 'my-db': serverEntry('my-db') } });
    render(<MCPSection source="mine" focusServer="my-db" />);
    await waitFor(() => expect(screen.getByTestId('mcp-detail-menu')).toBeTruthy());
    await userEvent.click(screen.getByTestId('mcp-detail-menu'));
    fireEvent.click(screen.getByRole('menuitem', { name: tb().skillEdit }));

    const form = await screen.findByRole('dialog', { name: tb().skillEdit });
    // The connector's own window is still on the page, under the form.
    expect(screen.getByTestId('mcp-detail-menu')).toBeInTheDocument();
    fireEvent.click(within(form).getByRole('button', { name: getI18n().common.cancel }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: tb().skillEdit })).toBeNull());
    expect(screen.getByRole('dialog', { name: 'my-db' })).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('mcp-detail-menu')));
  });

  it('moves the focus to the way back on the logs page, and to the menu button on the way back', async () => {
    useMCPStore.setState({ servers: { local: serverEntry('local') } });
    render(<MCPSection focusServer="local" />);
    await waitFor(() => expect(screen.getByTestId('mcp-detail-menu')).toBeTruthy());
    await userEvent.click(screen.getByTestId('mcp-detail-menu'));
    fireEvent.click(screen.getByRole('menuitem', { name: tb().viewLogs }));

    const back = await screen.findByRole('button', { name: tb().backToDetails });
    await waitFor(() => expect(document.activeElement).toBe(back));
    expect(screen.getByText(tb().noLogs)).toBeInTheDocument();

    fireEvent.click(back);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('mcp-detail-menu')));
  });

  it('shows log lines in the code font, each level with its colour', async () => {
    vi.spyOn(mcpManager, 'getServerLogs').mockReturnValue([
      { timestamp: 1, level: 'info', message: 'listening' },
      { timestamp: 2, level: 'warn', message: 'slow start' },
      { timestamp: 3, level: 'error', message: 'exited' },
    ] as ReturnType<typeof mcpManager.getServerLogs>);
    useMCPStore.setState({ servers: { local: serverEntry('local') } });
    render(<MCPSection focusServer="local" />);
    await waitFor(() => expect(screen.getByTestId('mcp-detail-menu')).toBeTruthy());
    await userEvent.click(screen.getByTestId('mcp-detail-menu'));
    fireEvent.click(screen.getByRole('menuitem', { name: tb().viewLogs }));

    const view = await screen.findByTestId('mcp-logs-view');
    expect(within(view).getByText('listening')).toHaveClass('text-label-secondary');
    expect(within(view).getByText('slow start')).toHaveClass('text-warning');
    expect(within(view).getByText('exited')).toHaveClass('text-danger');
    expect(within(view).getByText('exited').parentElement).toHaveClass('font-code');
    // Colour never stands alone: a warning and an error line carry a shape named after the level.
    expect(within(within(view).getByText('slow start').parentElement as HTMLElement).getByRole('img', { name: 'warn' })).toBeInTheDocument();
    expect(within(within(view).getByText('exited').parentElement as HTMLElement).getByRole('img', { name: 'error' })).toBeInTheDocument();
    expect(within(within(view).getByText('listening').parentElement as HTMLElement).queryByRole('img')).toBeNull();
  });

  describe('while it fades out', () => {
    /** The window of a connected server, closing: it still shows the connector it held. */
    async function closingServerWindow() {
      useMCPStore.setState({ servers: { local: { ...serverEntry('local'), status: 'connected' } } });
      const onAddFormChange = vi.fn();
      render(<MCPSection source="mine" focusServer="local" onAddFormChange={onAddFormChange} />);
      await screen.findByRole('button', { name: tb().testConnection });
      keepClosingLayersOnScreen();
      fireEvent.keyDown(document, { key: 'Escape' });
      const closing = closingWindow();
      expect(within(closing).getByRole('heading', { name: `local ${tb().connectors}` })).toBeInTheDocument();
      return { closing, onAddFormChange };
    }

    it('probes nothing', async () => {
      const test = vi.spyOn(mcpManager, 'testConnection').mockResolvedValue({ success: true, toolCount: 0 });
      const { closing } = await closingServerWindow();
      fireEvent.click(within(closing).getByRole('button', { name: tb().testConnection }));
      await act(async () => { await Promise.resolve(); });
      expect(test).not.toHaveBeenCalled();
    });

    it('switches no connection', async () => {
      const { connect, disconnect } = spyOnConnections();
      const { closing } = await closingServerWindow();
      fireEvent.click(within(closing).getByRole('switch'));
      await act(async () => { await Promise.resolve(); });
      expect(disconnect).not.toHaveBeenCalled();
      expect(connect).not.toHaveBeenCalled();
    });

    it.each([
      ['the edit form', () => tb().skillEdit],
      ['the logs page', () => tb().viewLogs],
    ] as const)('opens %s from its menu no more', async (_what, label) => {
      const { closing, onAddFormChange } = await closingServerWindow();
      await userEvent.click(within(closing).getByTestId('mcp-detail-menu'));
      fireEvent.click(await screen.findByRole('menuitem', { name: label() }));
      // The menu's own fade ends: what was chosen runs now.
      const menu = document.querySelector<HTMLElement>('[role="menu"][data-state="closed"]');
      expect(menu).not.toBeNull();
      vi.useFakeTimers();
      try {
        const ended = new Event('animationend', { bubbles: true });
        Object.defineProperty(ended, 'animationName', { value: 'exit' });
        act(() => { menu!.dispatchEvent(ended); });
        act(() => { vi.runOnlyPendingTimers(); });
      } finally {
        vi.useRealTimers();
      }

      expect(document.querySelector('[role="menu"]')).toBeNull();
      expect(onAddFormChange).not.toHaveBeenCalled();
      expect(screen.queryByPlaceholderText(tb().serverName)).toBeNull();
      expect(screen.queryByTestId('mcp-logs-view')).toBeNull();
      expect(within(closingWindow()).getByTestId('mcp-detail-menu')).toBeInTheDocument();
    });

    it('installs nothing', async () => {
      const template = getMCPTemplatesForHost().find((item) => !item.configurableArgs?.length && !item.requiredEnvVars?.length)!;
      const addServer = vi.spyOn(useMCPStore.getState(), 'addServer').mockImplementation(() => {});
      const { connect } = spyOnConnections();
      render(<MCPSection source="market" />);
      fireEvent.click(card(template.name));
      await screen.findByRole('button', { name: tb().install });
      keepClosingLayersOnScreen();
      fireEvent.keyDown(document, { key: 'Escape' });

      fireEvent.click(within(closingWindow()).getByRole('button', { name: tb().install }));
      await act(async () => { await Promise.resolve(); });
      expect(addServer).not.toHaveBeenCalled();
      expect(connect).not.toHaveBeenCalled();
    });
  });
});

describe('MCPSection · running actions', () => {
  it('keeps 测试连接 focusable and inert while its probe runs', async () => {
    vi.spyOn(mcpManager, 'testConnection').mockReturnValue(new Promise(() => {}));
    useMCPStore.setState({ servers: { local: serverEntry('local') } });
    render(<MCPSection source="mine" focusServer="local" />);
    const button = await screen.findByRole('button', { name: tb().testConnection });
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole('button', { name: tb().testConnection })).toHaveAttribute('aria-disabled', 'true'));
    expect(screen.getByRole('button', { name: tb().testConnection })).not.toBeDisabled();
  });

  it('installs a catalog entry once: no second press while the install runs', async () => {
    const template = getMCPTemplatesForHost().find((item) => !item.configurableArgs?.length && !item.requiredEnvVars?.length)!;
    const addServer = vi.spyOn(useMCPStore.getState(), 'addServer').mockImplementation(() => {});
    vi.spyOn(useMCPStore.getState(), 'connectServer').mockReturnValue(new Promise(() => {}));
    render(<MCPSection source="market" />);
    fireEvent.click(card(template.name));
    const install = await screen.findByRole('button', { name: tb().install });
    fireEvent.click(install);
    await waitFor(() => expect(screen.getByRole('button', { name: tb().install })).toHaveAttribute('aria-disabled', 'true'));
    expect(screen.getByRole('button', { name: tb().install })).not.toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: tb().install }));
    expect(addServer).toHaveBeenCalledTimes(1);
  });

  it('names the secret field of a catalog entry with its label', async () => {
    const template = getMCPTemplates().find((item) => item.id === 'brave-search')!;
    render(<MCPSection source="market" />);
    fireEvent.click(card(template.name));
    const key = await screen.findByPlaceholderText('BSA...');
    expect(key).toHaveClass('font-code');
    expect(screen.getByLabelText(template.requiredEnvVars![0].labelEn ?? template.requiredEnvVars![0].label)).toBe(key);
  });
});

describe('MCPSection · the page and its add window', () => {
  it('opens the add window from the empty shelf and gives the focus back to that button', async () => {
    render(<MCPSection source="mine" />);
    const add = screen.getByTestId('connectors-mine-add');
    add.focus();
    fireEvent.click(add);
    const form = await screen.findByRole('dialog', { name: tb().addCustomServer });
    fireEvent.click(within(form).getByRole('button', { name: getI18n().common.cancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('connectors-mine-add')));
  });

  it('asks before discarding what was typed, and opens blank the next time', async () => {
    function Reopenable() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <Button data-testid="reopen" onClick={() => setOpen(true)}>add</Button>
          <MCPSection source="mine" showAddForm={open} onAddFormChange={setOpen} />
        </>
      );
    }
    render(<Reopenable />);
    type(tb().serverName, 'my-server');
    type(tb().serverCommand, 'node');
    type(ENV_PLACEHOLDER, `{"TOKEN":"${ENV_VALUE}"}`);
    fireEvent.keyDown(document, { key: 'Escape' });
    const asked = await screen.findByRole('alertdialog', { name: getI18n().designSystem.discardTitle });
    expect(field(tb().serverName).value).toBe('my-server');
    fireEvent.click(within(asked).getByRole('button', { name: getI18n().designSystem.discard }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByTestId('reopen'));
    await screen.findByRole('dialog', { name: tb().addCustomServer });
    expect(field(tb().serverName).value).toBe('');
    expect(field(tb().serverCommand).value).toBe('');
    expect(field(ENV_PLACEHOLDER).value).toBe('');
  });

  it('does not ask about a catalog entry it was opened with', async () => {
    function Offered() {
      const [open, setOpen] = useState(true);
      return <MCPSection source="mine" showAddForm={open} onAddFormChange={setOpen} prefill={{ name: 'github', command: 'npx', args: ['-y', 'server-github'], env: { TOKEN: '' }, transport: 'stdio' }} />;
    }
    render(<Offered />);
    await waitFor(() => expect(field(tb().serverName).value).toBe('github'));
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('leaves the focus in the new connector’s window once the add window has closed', async () => {
    spyOnConnections();
    // The page's own 「添加」 button: it stays on the page under the new connector's window.
    function Page() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Button data-testid="page-add" onClick={() => setOpen(true)}>add</Button>
          <MCPSection source="market" showAddForm={open} onAddFormChange={setOpen} />
        </>
      );
    }
    render(<Page />);
    const pageAdd = screen.getByTestId('page-add');
    const focused = vi.spyOn(pageAdd, 'focus');
    pageAdd.focus();
    fireEvent.click(pageAdd);
    await screen.findByRole('dialog', { name: tb().addCustomServer });
    focused.mockClear();
    type(tb().serverName, 'my-server');
    type(tb().serverCommand, 'node');
    fireEvent.click(submitButton(tb().add));

    const detail = await screen.findByRole('dialog', { name: 'my-server' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: tb().addCustomServer })).toBeNull());
    await act(async () => { for (let turn = 0; turn < 5; turn += 1) await Promise.resolve(); });
    // The add window does not hand the focus back to the button under the open window.
    expect(focused).not.toHaveBeenCalled();
    expect(detail.contains(document.activeElement)).toBe(true);
  });

  it('renders no card again while the add window is typed into', () => {
    useMCPStore.setState({ servers: { first: serverEntry('first'), second: serverEntry('second') } });
    function Both() {
      const [open, setOpen] = useState(true);
      return <MCPSection source="market" showAddForm={open} onAddFormChange={setOpen} />;
    }
    render(<Both />);
    const before = { ...cardRenders.byId };
    expect(Object.keys(before).length).toBeGreaterThan(3);
    type(tb().serverName, 'my-server');
    type(tb().serverCommand, 'node');
    type(ENV_PLACEHOLDER, '{"TOKEN":"x"}');
    expect(cardRenders.byId).toEqual(before);
  });

  it('renders only the card whose connection changed', async () => {
    const { connect } = spyOnConnections();
    useMCPStore.setState({ servers: { first: serverEntry('first'), second: serverEntry('second') } });
    render(<MCPSection source="mine" />);
    const before = { ...cardRenders.byId };
    act(() => {
      useMCPStore.setState((state) => ({ servers: { ...state.servers, second: { ...state.servers.second, status: 'error', error: 'boom' } } }));
    });
    expect(cardRenders.byId.second).toBe(before.second + 1);
    expect(cardRenders.byId.first).toBe(before.first);
    expect(connect).not.toHaveBeenCalled();
  });
});
