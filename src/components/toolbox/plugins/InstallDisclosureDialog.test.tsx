// @vitest-environment happy-dom
import type { ReactElement } from 'react';
import { render as renderBare, screen, fireEvent, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import InstallDisclosureDialog from './InstallDisclosureDialog';
import { formatServerCommand } from './serverCommand';
import { DETAIL_WINDOW_CONTENT_HEIGHT } from '../windowHeight';
import { PLUGIN_CONFIG_VALUE_LIMIT } from '@/core/plugin/configuration';
import type { InstallDisclosure } from '@/core/plugin/installer';
import { getI18n } from '@/i18n';

// The window is a design-system dialog, so it renders inside the provider like the app does.
const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });

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

  it('names the team and the expert behind each scene the way the user sees them', () => {
    // Who does the work is the reason to add an app, and the user reads this
    // before anything is installed — so the screen shows the team's name and
    // the expert's name, never `builtin-team:recruiting` or `builtin:HR 招聘官`.
    renderDialog({
      state: {
        kind: 'ready',
        disclosure: {
          ...disclosure,
          teams: [{
            id: 'ops',
            name: { 'zh-CN': '店铺运营小组' },
            leaderRoleId: 'plugin:advisor',
            memberRoleIds: ['plugin:advisor'],
            requirePlanApproval: false,
            description: { 'zh-CN': '看店的人' },
            expertise: [],
            samplePrompts: [],
          }],
          app: {
            version: 1,
            defaultRun: { team: 'builtin-team:recruiting' },
            home: {
              modes: {
                items: [{
                  modeId: 'prepare',
                  title: { 'zh-CN': '岗位准备' },
                  scenes: [
                    { id: 'jd', title: { 'zh-CN': '写 JD' }, templates: [] },
                    { id: 'shop', title: { 'zh-CN': '看店' }, run: { team: 'ops' }, templates: [] },
                    { id: 'ask', title: { 'zh-CN': '问专家' }, run: { expert: 'builtin:HR 招聘官' }, templates: [] },
                  ],
                }],
              },
            },
          },
        },
      } as const,
    });

    const section = screen.getByTestId('plugin-disclosure-app');
    expect(section).toHaveTextContent('招聘专家团');
    expect(section).toHaveTextContent('店铺运营小组');
    expect(section).toHaveTextContent('HR 招聘官');
    expect(section.textContent).not.toContain('builtin-team:');
    expect(section.textContent).not.toContain('builtin:');
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

describe('InstallDisclosureDialog: what the user approves and what they type', () => {
  // Obviously not a secret; the tests look for it everywhere it must not appear.
  const FAKE_TOKEN = 'plugin-config-not-a-secret';
  const FAKE_REGION = 'plugin-config-region-not-a-secret';
  const configured: InstallDisclosure = {
    ...disclosure,
    preparedToken: 'configured',
    manifest: {
      name: 'weather',
      mcpServers: { weather: { env: { TOKEN: '${config.TOKEN}' }, headers: { 'X-Region': '${config.REGION}' } } },
    } as InstallDisclosure['manifest'],
  };
  const ready = { kind: 'ready', disclosure: configured } as const;

  it('masks every configuration field and limits its length', () => {
    renderDialog({ state: ready });
    for (const field of ['REGION', 'TOKEN']) {
      const input = screen.getByLabelText(field);
      expect(input).toHaveAttribute('type', 'password');
      expect(input).toHaveAttribute('autocomplete', 'new-password');
      expect(input).toHaveAttribute('maxlength', String(PLUGIN_CONFIG_VALUE_LIMIT));
    }
  });

  it('shows the command line of every server exactly as formatServerCommand gives it', () => {
    renderDialog();
    const servers = screen.getAllByTestId('plugin-disclosure-server');
    expect(servers.map((server) => server.textContent)).toEqual(
      disclosure.mcpServers.map((server) => `${server.name}${formatServerCommand(server)}`),
    );
    expect(within(servers[0]).getByText('npx -y @acme/weather-mcp --verbose')).toBeInTheDocument();
  });

  it('keeps Install unavailable until every field has something other than spaces', () => {
    const props = renderDialog({ state: ready });
    const confirm = screen.getByTestId('plugin-install-confirm');
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByLabelText('TOKEN'), { target: { value: FAKE_TOKEN } });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText('REGION'), { target: { value: '   ' } });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(props.onConfirm).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('REGION'), { target: { value: FAKE_REGION } });
    expect(confirm).toBeEnabled();
  });

  it('hands over exactly the fields that were filled in', () => {
    const props = renderDialog({ state: ready });
    fireEvent.change(screen.getByLabelText('TOKEN'), { target: { value: FAKE_TOKEN } });
    fireEvent.change(screen.getByLabelText('REGION'), { target: { value: FAKE_REGION } });
    fireEvent.click(screen.getByTestId('plugin-install-confirm'));

    expect(props.onConfirm).toHaveBeenCalledExactlyOnceWith({ TOKEN: FAKE_TOKEN, REGION: FAKE_REGION });
    expect(props.onCancel).not.toHaveBeenCalled();
  });

  it('hands over an empty object for a package that asks for no configuration', () => {
    const props = renderDialog();
    fireEvent.click(screen.getByTestId('plugin-install-confirm'));
    expect(props.onConfirm).toHaveBeenCalledExactlyOnceWith({});
  });

  it('never shows a typed value as text or in a title, a name or a data attribute', () => {
    renderDialog({ state: ready });
    fireEvent.change(screen.getByLabelText('TOKEN'), { target: { value: FAKE_TOKEN } });
    fireEvent.change(screen.getByLabelText('REGION'), { target: { value: FAKE_REGION } });

    expect(document.body.textContent).not.toContain(FAKE_TOKEN);
    expect(document.body.textContent).not.toContain(FAKE_REGION);
    for (const element of document.body.querySelectorAll('*')) {
      for (const attribute of element.attributes) {
        // The value lives in the masked input and nowhere else.
        if (element instanceof HTMLInputElement && attribute.name === 'value') continue;
        expect(attribute.value).not.toContain(FAKE_TOKEN);
        expect(attribute.value).not.toContain(FAKE_REGION);
      }
    }
  });

  it('while installing, neither Install nor Cancel nor Escape does anything', () => {
    const props = renderDialog({ installing: true });
    const confirm = screen.getByTestId('plugin-install-confirm');
    expect(confirm).toHaveTextContent(getI18n().toolbox.pluginsInstalling);

    fireEvent.click(confirm);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    const cancel = screen.getByRole('button', { name: getI18n().common.cancel });
    expect(cancel).toBeDisabled();
    fireEvent.click(cancel);

    expect(props.onConfirm).not.toHaveBeenCalled();
    expect(props.onCancel).not.toHaveBeenCalled();
  });

  it('reports a cancel from the Cancel button and from Escape when nothing is installing', () => {
    const props = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: getI18n().common.cancel }));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(props.onCancel).toHaveBeenCalledTimes(2);
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it('names the button after what the confirmation does', () => {
    const tb = getI18n().toolbox;
    const app = { version: 1, home: { modes: { items: [] } } } as unknown as NonNullable<InstallDisclosure['app']>;
    const cases: [Partial<React.ComponentProps<typeof InstallDisclosureDialog>>, string][] = [
      [{}, tb.pluginsInstall],
      [{ updating: true }, tb.pluginsUpdate],
      [{ updating: true, installing: true }, tb.pluginsUpdating],
      [{ state: { kind: 'ready', disclosure: { ...disclosure, app } } }, tb.pluginsAgreeAndUse],
      [{ authoring: true, state: { kind: 'ready', disclosure: { ...disclosure, app } } }, tb.pluginsInstallAndEnter],
    ];
    for (const [overrides, label] of cases) {
      const view = renderBare(<InstallDisclosureDialog open entryName="weather" installing={false} onConfirm={vi.fn()} onCancel={vi.fn()} state={{ kind: 'ready', disclosure }} {...overrides} />, { wrapper: DesignSystemProvider });
      expect(screen.getByTestId('plugin-install-confirm').textContent).toBe(label);
      view.unmount();
    }
  });
});

describe('InstallDisclosureDialog: the window', () => {
  const tb = () => getI18n().toolbox;

  it('is a window named after what it asks, with one close button', () => {
    renderDialog();
    expect(screen.getByRole('dialog')).toHaveAccessibleName(tb().pluginsDisclosureTitle);
    expect(screen.getByTestId('plugin-install-disclosure')).toBe(screen.getByRole('dialog'));
    expect(screen.getByRole('button', { name: getI18n().common.close })).toBeInTheDocument();
  });

  it('is named for an update and for a source that cannot be installed', () => {
    const update = renderBare(<InstallDisclosureDialog open updating entryName="weather" installing={false} onConfirm={vi.fn()} onCancel={vi.fn()} state={{ kind: 'ready', disclosure }} />, { wrapper: DesignSystemProvider });
    expect(screen.getByRole('dialog')).toHaveAccessibleName(tb().pluginsUpdateDisclosureTitle);
    update.unmount();
    renderDialog({ state: { kind: 'unsupported', sourceKind: 'git-subdir' } });
    expect(screen.getByRole('dialog')).toHaveAccessibleName(tb().pluginsUnsupportedTitle);
  });

  it('has one heading, its title, in the market form and in the draft-preview form', () => {
    const market = renderBare(<InstallDisclosureDialog open entryName="weather" installing={false} onConfirm={vi.fn()} onCancel={vi.fn()} state={{ kind: 'ready', disclosure }} />, { wrapper: DesignSystemProvider });
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([tb().pluginsDisclosureTitle]);
    market.unmount();

    renderDialog({ authoring: true });
    expect(screen.getByRole('dialog')).toHaveAccessibleName(tb().pluginsDisclosureTitle);
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([tb().pluginsDisclosureTitle]);
    expect(screen.getByRole('status')).toHaveTextContent(tb().pluginsValidationPassed);
  });

  it('a draft preview keeps the height of the draft window it replaces: a title row and a content area of fixed height', () => {
    renderDialog({ authoring: true, state: { kind: 'loading' } });
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveClass('max-w-2xl');
    expect(screen.getByRole('heading', { level: 2 }).firstElementChild).toHaveClass('h-11');
    expect(Array.from(dialog.querySelectorAll('div')).some((area) => area.classList.contains(DETAIL_WINDOW_CONTENT_HEIGHT))).toBe(true);
  });

  it('shows one spinner whose words say what is being read', () => {
    renderDialog({ state: { kind: 'loading' } });
    expect(document.querySelectorAll('[data-ds-spinner]')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent(tb().pluginsDisclosureLoading);
    // One way out, named once: the footer's button.
    expect(screen.getAllByRole('button', { name: getI18n().common.close })).toHaveLength(1);
  });

  it('announces a failure and explains an unsupported source without alarm', () => {
    const failed = renderBare(<InstallDisclosureDialog open entryName="weather" installing={false} onConfirm={vi.fn()} onCancel={vi.fn()} state={{ kind: 'error', message: 'No plugin manifest found in /m/x' }} />, { wrapper: DesignSystemProvider });
    expect(screen.getByRole('alert')).toHaveTextContent(tb().pluginsPlanFailed);
    expect(screen.getByRole('alert')).toHaveTextContent('No plugin manifest found in /m/x');
    failed.unmount();
    renderDialog({ state: { kind: 'unsupported', sourceKind: 'git-subdir' }, entryName: 'cool-plugin' });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(within(screen.getByTestId('plugin-unsupported-notice')).getByRole('status')).toHaveTextContent('cool-plugin');
  });

  it('while installing, Install stays focusable and the corner close button is gone', () => {
    renderDialog({ installing: true });
    const confirm = screen.getByTestId('plugin-install-confirm');
    expect(confirm).toHaveAttribute('aria-disabled', 'true');
    expect(confirm).not.toBeDisabled();
    expect(screen.queryByRole('button', { name: getI18n().common.close })).toBeNull();
  });

  it('while it fades out it keeps what it showed, confirms nothing and forgets what was typed', () => {
    const real = window.getComputedStyle.bind(window);
    // A closed layer has an exit animation: it stays on the page, as it does in the app.
    const computedStyle = vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element, pseudo?: string | null) => {
      const styles = real(element, pseudo);
      return new Proxy(styles, {
        get(target, prop) {
          if (prop === 'animationName') return element.getAttribute('data-state') === 'closed' ? 'exit' : 'enter';
          const value = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    });
    const onConfirm = vi.fn();
    const configured: InstallDisclosure = { ...disclosure, preparedToken: 'p', manifest: { name: 'weather', mcpServers: { weather: { env: { TOKEN: '${config.TOKEN}' } } } } as InstallDisclosure['manifest'] };
    const props = { entryName: 'weather', installing: false, onConfirm, onCancel: vi.fn() };
    const view = render(<InstallDisclosureDialog open {...props} state={{ kind: 'ready', disclosure: configured }} />);
    fireEvent.change(screen.getByLabelText('TOKEN'), { target: { value: 'plugin-config-not-a-secret' } });

    // The owner closes the window and its plan goes back to "nothing planned" in one update.
    view.rerender(<InstallDisclosureDialog open={false} {...props} entryName="" state={{ kind: 'loading' }} />);

    const closing = document.querySelector('[role="dialog"][data-state="closed"]');
    expect(closing).not.toBeNull();
    expect(closing).toHaveTextContent('weather-mcp');
    expect(screen.queryByText(tb().pluginsDisclosureLoading)).toBeNull();
    expect((screen.getByLabelText('TOKEN') as HTMLInputElement).value).toBe('');
    view.unmount();

    // A package with nothing to fill in: its Install button is not held back by an empty field.
    const plain = render(<InstallDisclosureDialog open {...props} state={{ kind: 'ready', disclosure }} />);
    plain.rerender(<InstallDisclosureDialog open={false} {...props} entryName="" state={{ kind: 'loading' }} />);
    expect(document.querySelector('[role="dialog"][data-state="closed"]')).not.toBeNull();
    fireEvent.click(screen.getByTestId('plugin-install-confirm'));
    expect(onConfirm).not.toHaveBeenCalled();
    computedStyle.mockRestore();
  });
});

it('omits empty skill and connector categories from the installation preview', () => {
  render(<InstallDisclosureDialog open entryName="empty" installing={false} onConfirm={vi.fn()} onCancel={vi.fn()}
    state={{ kind: 'ready', disclosure: { key: 'empty@market', name: 'empty', version: '1', marketplace: 'market', sourceDir: '/source', manifest: { name: 'empty' }, skills: [], mcpServers: [], agents: [], ignoredPayloads: [] } }} />);
  expect(screen.queryByText(getI18n().toolbox.pluginsDisclosureSkills)).not.toBeInTheDocument();
  expect(screen.queryByText(getI18n().toolbox.pluginsDisclosureServers)).not.toBeInTheDocument();
});
