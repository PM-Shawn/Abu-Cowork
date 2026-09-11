// @vitest-environment happy-dom
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import InstallDisclosureDialog from './InstallDisclosureDialog';
import { formatServerCommand } from './serverCommand';
import type { InstallDisclosure } from '@/core/plugin/installer';
import { getI18n } from '@/i18n';

const disclosure: InstallDisclosure = {
  key: 'weather@official',
  name: 'weather',
  marketplace: 'official',
  version: '1.2.0',
  manifest: { name: 'weather', version: '1.2.0' } as InstallDisclosure['manifest'],
  sourceDir: '/m/official/plugins/weather',
  skills: ['forecast', 'radar'],
  mcpServers: [
    {
      name: 'weather-mcp',
      command: 'npx',
      args: ['-y', '@acme/weather-mcp', '--verbose'],
    },
    { name: 'remote-weather', url: 'https://mcp.example.com/sse' },
  ],
  capabilities: ['network'],
  agents: [],
  ignoredPayloads: [],
};

function renderDialog(overrides: Partial<React.ComponentProps<typeof InstallDisclosureDialog>> = {}) {
  const props = {
    open: true,
    entryName: 'weather',
    state: { kind: 'ready', disclosure } as const,
    installing: false,
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  render(<InstallDisclosureDialog {...props} />);
  return props;
}

describe('formatServerCommand', () => {
  it('joins command and args the way a shell shows them, and falls back to the url', () => {
    expect(formatServerCommand({ command: 'node', args: ['server.js', '--port', '3000'] })).toBe(
      'node server.js --port 3000',
    );
    expect(formatServerCommand({ command: 'node' })).toBe('node');
    expect(formatServerCommand({ url: 'https://x/sse' })).toBe('https://x/sse');
  });
});

describe('InstallDisclosureDialog', () => {
  it('shows each MCP server with its complete executable command line', () => {
    renderDialog();

    const servers = screen.getAllByTestId('plugin-disclosure-server');
    expect(servers).toHaveLength(2);
    // The whole point of the screen: the literal command, not "1 connector".
    expect(servers[0]).toHaveTextContent('weather-mcp');
    expect(servers[0]).toHaveTextContent('npx -y @acme/weather-mcp --verbose');
    expect(servers[1]).toHaveTextContent('https://mcp.example.com/sse');
  });

  it('discloses the skills, source package and declared capabilities', () => {
    renderDialog();

    expect(screen.getByText('forecast')).toBeInTheDocument();
    expect(screen.getByText('radar')).toBeInTheDocument();
    expect(screen.getByText('/m/official/plugins/weather')).toBeInTheDocument();
    expect(screen.getByText('network')).toBeInTheDocument();
  });


  it('lists the agents the install will add, with what each one is for', () => {
    // A plugin that ships a team is worth installing for the team; a count
    // would not tell the user who is joining.
    renderDialog({
      state: {
        kind: 'ready',
        disclosure: {
          ...disclosure,
          agents: [
            { name: 'reviewer', description: 'Reviews a diff' },
            { name: 'planner', description: 'Breaks work into steps' },
          ],
        },
      } as const,
    });

    const rows = screen.getAllByTestId('plugin-disclosure-agent');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('reviewer');
    expect(rows[0]).toHaveTextContent('Reviews a diff');
    expect(rows[1]).toHaveTextContent('planner');
    expect(rows[1]).toHaveTextContent('Breaks work into steps');
  });

  it('says nothing about agents when the package ships none', () => {
    // Most plugins ship no agents; an empty 代理 group would be noise on every
    // other install screen.
    renderDialog();
    expect(screen.queryByTestId('plugin-disclosure-agent')).toBeNull();
    expect(screen.queryByText(getI18n().toolbox.pluginsDisclosureAgents)).toBeNull();
  });

  it('greys out a skipped agent and says why, one short reason per row', () => {
    // The install proceeds without these three; the screen has to be honest
    // that they will not arrive rather than listing them as incoming.
    const tb = getI18n().toolbox;
    renderDialog({
      state: {
        kind: 'ready',
        disclosure: {
          ...disclosure,
          agents: [
            { name: 'reviewer', description: 'Reviews a diff' },
            { name: 'planner', description: 'Plans', conflict: 'exists' },
            { name: '../evil', description: 'Escapes', conflict: 'unsafe-name' },
            { name: 'hollow', description: 'Empty', conflict: 'empty-prompt' },
          ],
        },
      } as const,
    });

    const rows = screen.getAllByTestId('plugin-disclosure-agent');
    expect(rows).toHaveLength(4);

    // The one that actually installs is not marked as skipped.
    expect(rows[0].getAttribute('aria-disabled')).toBeNull();

    expect(rows[1].getAttribute('aria-disabled')).toBe('true');
    expect(rows[1]).toHaveTextContent(tb.pluginsDisclosureAgentExists);
    expect(rows[2].getAttribute('aria-disabled')).toBe('true');
    expect(rows[2]).toHaveTextContent(tb.pluginsDisclosureAgentUnsafeName);
    expect(rows[3].getAttribute('aria-disabled')).toBe('true');
    expect(rows[3]).toHaveTextContent(tb.pluginsDisclosureAgentEmptyPrompt);
  });

  it('still offers the install when every agent is skipped', () => {
    // A conflict skips one agent; it does not block the package, whose skills
    // and connectors install exactly as disclosed.
    renderDialog({
      state: {
        kind: 'ready',
        disclosure: {
          ...disclosure,
          agents: [{ name: 'planner', description: 'Plans', conflict: 'exists' }],
        },
      } as const,
    });

    const confirm = screen.getByTestId('plugin-install-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
  });

  it('never files agents under the payloads Abu ignores', () => {
    // `agents` left IGNORED_PAYLOAD_DIRS when the installer learned to install
    // them; a stale "not used by Abu" line would contradict the group above it.
    renderDialog({
      state: {
        kind: 'ready',
        disclosure: {
          ...disclosure,
          agents: [{ name: 'reviewer', description: 'Reviews a diff' }],
          ignoredPayloads: ['commands', 'hooks'],
        },
      } as const,
    });

    const notice = screen.getByTestId('plugin-disclosure-ignored');
    // The LIST the sentence interpolates is what must never name agents. The
    // sentence itself now does name them — as a payload that still installs.
    expect(notice.textContent).toContain('commands、hooks');
    expect(notice.textContent).not.toMatch(/agents、|、agents/);
  });

  it('flags payload types Abu does not consume so nothing silently disappears', () => {
    renderDialog({
      state: { kind: 'ready', disclosure: { ...disclosure, ignoredPayloads: ['commands', 'hooks'] } } as const,
    });
    const notice = screen.getByTestId('plugin-disclosure-ignored');
    expect(notice.textContent).toContain('commands');
    expect(notice.textContent).toContain('hooks');
  });

  it('shows no ignored-payload notice when the plugin only ships supported payloads', () => {
    renderDialog();
    expect(screen.queryByTestId('plugin-disclosure-ignored')).toBeNull();
  });

  it('names the symlinks the install will refuse, so nothing goes missing silently', () => {
    // The user is approving a package that will land incomplete on purpose —
    // `copyPluginDir` neither follows nor recreates a link.
    renderDialog({
      state: {
        kind: 'ready',
        disclosure: { ...disclosure, skippedSymlinks: ['.cursor/skills', 'data/x'] },
      } as const,
    });
    const notice = screen.getByTestId('plugin-disclosure-symlinks');
    expect(notice.textContent).toContain('.cursor/skills');
    expect(notice.textContent).toContain('data/x');
  });

  it('joins the refused link paths with the separator the locale owns', () => {
    // `、` is right in Chinese and wrong in English; the list punctuation
    // belongs to the locale, not to this component.
    const tb = getI18n().toolbox;
    renderDialog({
      state: {
        kind: 'ready',
        disclosure: { ...disclosure, skippedSymlinks: ['.cursor/skills', 'data/x'] },
      } as const,
    });

    const notice = screen.getByTestId('plugin-disclosure-symlinks');
    expect(notice.textContent).toContain(
      `.cursor/skills${tb.pluginsDisclosureSymlinkSeparator}data/x`,
    );
  });

  it('says nothing about links when the package ships none', () => {
    renderDialog();
    expect(screen.queryByTestId('plugin-disclosure-symlinks')).toBeNull();
  });

  it('warns that an unverified artifact carries no signature', () => {
    // The organization path skips verification entirely when the bound console
    // advertises no signing key. The consent screen has to say so.
    renderDialog({ state: { kind: 'ready', disclosure, unsigned: true } as const });
    expect(screen.getByTestId('plugin-disclosure-unsigned')).toBeInTheDocument();
  });

  it('puts the signing warning above the payload sections', () => {
    // The dialog scrolls. "We cannot confirm who built this" decides whether
    // to read the rest at all, so it must not sit below the fold under the
    // source / skills / servers / capabilities list.
    renderDialog({ state: { kind: 'ready', disclosure, unsigned: true } as const });

    const warning = screen.getByTestId('plugin-disclosure-unsigned');
    const firstPayloadSection = screen.getByText('/m/official/plugins/weather');
    expect(warning.compareDocumentPosition(firstPayloadSection)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('stays silent about signing on a path that has no signing concept', () => {
    // Personal / marketplace installs are never signed; a warning there would
    // be noise, so the flag is optional and off by default.
    renderDialog();
    expect(screen.queryByTestId('plugin-disclosure-unsigned')).toBeNull();
  });

  it('only reports a decision when the user acts on it', () => {
    const props = renderDialog();
    expect(props.onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('plugin-install-confirm'));
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
  });

  it('renders an unsupported remote source as an explanation, not a crash, and offers no install action', () => {
    renderDialog({ state: { kind: 'unsupported', sourceKind: 'git-subdir' }, entryName: 'cool-plugin' });

    const notice = screen.getByTestId('plugin-unsupported-notice');
    expect(notice).toBeInTheDocument();
    expect(notice.textContent).toContain('cool-plugin');
    // No confirm button at all — there is nothing to install.
    expect(screen.queryByTestId('plugin-install-confirm')).toBeNull();
  });

  it('renders a plan failure with its reason instead of throwing', () => {
    renderDialog({ state: { kind: 'error', message: 'No plugin manifest found in /m/x' } });

    expect(screen.getByText(/No plugin manifest found in \/m\/x/)).toBeInTheDocument();
    expect(screen.queryByTestId('plugin-install-confirm')).toBeNull();
  });

  it('lets the caller retitle a refusal that is not a read failure', () => {
    // A policy denial is a refusal, not a corrupt package — the caller owns the
    // heading so an administrator's block does not read as a broken download.
    renderDialog({
      state: { kind: 'error', message: '策略禁止的连接器：b。请联系组织管理员。', title: '管理员策略禁止安装' },
    });

    expect(screen.getByText('管理员策略禁止安装')).toBeInTheDocument();
    expect(screen.queryByText('读取插件包失败')).toBeNull();
    expect(screen.getByText(/策略禁止的连接器：b/)).toBeInTheDocument();
    expect(screen.queryByTestId('plugin-install-confirm')).toBeNull();
  });

  it('renders nothing when closed', () => {
    renderDialog({ open: false });
    expect(screen.queryByTestId('plugin-install-disclosure')).toBeNull();
  });
});

it('requires secret configuration before approval and clears it for a new preview', () => {
  const props = { open: true, entryName: 'weather', installing: false, onCancel: vi.fn(), onConfirm: vi.fn(), state: { kind: 'ready' as const, disclosure: { ...disclosure, preparedToken: 'first', manifest: { name: 'weather', mcpServers: { weather: { env: { TOKEN: '${config.TOKEN}' } } } } } } };
  const { rerender } = render(<InstallDisclosureDialog {...props} />);
  expect(screen.getByTestId('plugin-install-confirm')).toBeDisabled();
  const input = screen.getByLabelText('TOKEN');
  expect(input).toHaveAttribute('type', 'password');
  fireEvent.change(input, { target: { value: 'fake-local-test-token' } });
  fireEvent.click(screen.getByTestId('plugin-install-confirm'));
  expect(props.onConfirm).toHaveBeenCalledWith({ TOKEN: 'fake-local-test-token' });
  rerender(<InstallDisclosureDialog {...props} state={{ ...props.state, disclosure: { ...props.state.disclosure, preparedToken: 'second' } }} />);
  expect(screen.getByLabelText('TOKEN')).toHaveValue('');
  expect(screen.getByTestId('plugin-install-confirm')).toBeDisabled();
});

it('omits empty skill and connector categories from the installation preview', () => {
  render(<InstallDisclosureDialog open entryName="empty" installing={false} onConfirm={vi.fn()} onCancel={vi.fn()}
    state={{ kind: 'ready', disclosure: { key: 'empty@market', name: 'empty', version: '1', marketplace: 'market', sourceDir: '/source', manifest: { name: 'empty' }, skills: [], mcpServers: [], agents: [], ignoredPayloads: [] } }} />);
  expect(screen.queryByText(getI18n().toolbox.pluginsDisclosureSkills)).not.toBeInTheDocument();
  expect(screen.queryByText(getI18n().toolbox.pluginsDisclosureServers)).not.toBeInTheDocument();
});
