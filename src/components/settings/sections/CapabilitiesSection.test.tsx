// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CapabilitiesSection from './CapabilitiesSection';
import { initLanguage } from '@/i18n';
import { useSettingsStore } from '@/stores/settingsStore';
import { useMCPStore } from '@/stores/mcpStore';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import type { SkillMetadata } from '@/types';
import type { ProviderInstance } from '@/types/provider';
import { DEFAULT_BROWSER_OPERATION_POLICY } from '@/core/permissions/browserToolPolicy';
import {
  hasChromeExtensionHandshaked,
  setChromeExtensionHandshaked,
} from '@/core/capabilityPlugins/chromeHandshakeLatch';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));
vi.mock('@/utils/platform', () => ({
  isMacOS: () => true,
}));

const ensureMCPServerMock = vi.hoisted(() => vi.fn());
const resolveMCPCompanionResourceMock = vi.hoisted(() => vi.fn());
vi.mock('@/core/agent/mcpDiscovery', () => ({
  ensureMCPServer: (...args: unknown[]) => ensureMCPServerMock(...args),
  resolveMCPCompanionResource: (...args: unknown[]) =>
    resolveMCPCompanionResourceMock(...args),
}));

const mcpManagerMock = vi.hoisted(() => ({
  callTool: vi.fn(),
  disconnectServer: vi.fn(),
  isConnected: vi.fn(),
  subscribe: vi.fn(),
  listeners: new Set<() => void>(),
  connectedServers: new Set<string>(),
}));
vi.mock('@/core/mcp/client', () => ({
  mcpManager: mcpManagerMock,
}));

function setElectronHost(enabled: boolean) {
  const runtime = globalThis as typeof globalThis & {
    __ABU_SHELL__?: { mainSupervisesSidecar?: boolean };
  };
  runtime.__ABU_SHELL__ = enabled
    ? { mainSupervisesSidecar: true }
    : undefined;
}

/** The overview card for a capability: a button whose accessible name starts
 *  with the capability name and continues with its current status. */
function findCapabilityCard(title: string): HTMLElement {
  return screen.getByRole('button', {
    name: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
  });
}

type User = ReturnType<typeof userEvent.setup>;

/** Overview → a capability's own page, the way a user gets there: the card
 *  row IS the control (user ruling 2026-09-04 — no named buttons). */
async function openDetail(user: User, cardTitle: string) {
  await user.click(findCapabilityCard(cardTitle));
}

const openBuiltinBrowser = (user: User) => openDetail(user, 'Abu built-in browser');

/** Built-in browser page → the site verdict list (one more drill-in). */
async function openSitePermissions(user: User) {
  await openBuiltinBrowser(user);
  // The site card drills in the same way every other row does: the row IS
  // the control, no text button.
  await user.click(screen.getByRole('button', { name: 'Site permissions' }));
}

/** A settings card by its heading. Matched on the heading element so a card
 *  title that also appears as a column header stays unambiguous. */
function permissionCard(title: string): HTMLElement {
  const heading = screen.getAllByText(title).find((el) => el.tagName === 'H4');
  if (!heading) throw new Error(`Card not found: ${title}`);
  return heading.closest('div.rounded-lg.border') as HTMLElement;
}

/** Resolve a probe on demand, so a test can control which reply lands first. */
function deferredProbe() {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((r) => { resolve = r; });
  return { promise, resolve };
}

const EXTENSION_ATTACHED = 'Browser extension is connected and ready.';
const EXTENSION_MISSING =
  'Browser extension is not connected. Please install and enable the Abu Browser Extension.';

/** The two policy cells of one row, in column order (you are here, automatic). */
function policyCells(row: HTMLElement): HTMLElement[] {
  return within(row).getAllByRole('button').filter(
    (b) => b.getAttribute('aria-expanded') !== null,
  );
}

/** Read the OPEN dropdown, not the row: a closed trigger also renders its
 *  current value as button text and would match by name. Only the option
 *  LABEL is returned — the description is a child element, the label is the
 *  option button's own text. */
function openedOptionLabels(trigger: HTMLElement): string[] {
  const dropdown = document.getElementById(trigger.getAttribute('aria-controls') ?? '');
  if (!dropdown) throw new Error('dropdown not open');
  return within(dropdown).getAllByRole('button').map((b) =>
    Array.from(b.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join('')
      .trim(),
  );
}

/** Every description the OPEN dropdown offers, in option order. */
function openedOptionDescriptions(trigger: HTMLElement): string[] {
  const dropdown = document.getElementById(trigger.getAttribute('aria-controls') ?? '');
  if (!dropdown) throw new Error('dropdown not open');
  return within(dropdown)
    .getAllByRole('button')
    .map((b) => b.querySelector('span.block')?.textContent ?? '');
}

function makeModelProvider(overrides: Partial<ProviderInstance>): ProviderInstance {
  return {
    id: 'computer-model-test',
    source: 'builtin',
    name: 'Computer Model Test',
    enabled: true,
    apiFormat: 'openai-compatible',
    baseUrl: 'https://example.com/v1',
    apiKey: 'test-key',
    models: [{ id: 'deepseek-chat', label: 'DeepSeek Chat' }],
    status: 'verified',
    sortOrder: 0,
    ...overrides,
  };
}

describe('CapabilitiesSection', () => {
  beforeEach(() => {
    initLanguage('en-US');
    setElectronHost(true);
    invoke.mockReset();
    ensureMCPServerMock.mockReset();
    ensureMCPServerMock.mockResolvedValue({
      status: 'connected',
      message: 'connected',
      extensionPath: '/resources/browser-extension',
    });
    resolveMCPCompanionResourceMock.mockReset();
    resolveMCPCompanionResourceMock.mockResolvedValue('/resources/browser-extension');
    mcpManagerMock.callTool.mockReset();
    mcpManagerMock.disconnectServer.mockReset();
    mcpManagerMock.disconnectServer.mockResolvedValue(undefined);
    mcpManagerMock.isConnected.mockReset();
    mcpManagerMock.subscribe.mockReset();
    mcpManagerMock.listeners.clear();
    mcpManagerMock.connectedServers.clear();
    mcpManagerMock.connectedServers.add('abu-browser-bridge');
    // Module-scoped on purpose (it must survive the dialog closing), so it is
    // shared state between tests and has to be reset like any other.
    setChromeExtensionHandshaked(false);
    mcpManagerMock.callTool.mockResolvedValue('Browser extension is connected and ready.');
    mcpManagerMock.isConnected.mockImplementation(
      (name: string) => mcpManagerMock.connectedServers.has(name),
    );
    mcpManagerMock.subscribe.mockImplementation((listener: () => void) => {
      mcpManagerMock.listeners.add(listener);
      return () => mcpManagerMock.listeners.delete(listener);
    });
    invoke.mockImplementation((command: string) => {
      if (command === 'check_macos_permissions') {
        return Promise.resolve({
          screen_recording: true,
          accessibility: false,
        });
      }
      if (command === 'capture_screen') {
        return Promise.resolve({ base64: '', width: 1, height: 1 });
      }
      return Promise.resolve(undefined);
    });

    const defaultProvider = makeModelProvider({
      models: [{ id: 'gpt-4o', label: 'GPT-4o' }],
    });
    useSettingsStore.setState({
      computerUseEnabled: true,
      providers: [defaultProvider],
      activeModel: { providerId: defaultProvider.id, modelId: 'gpt-4o' },
      capabilitySetupTarget: null,
      disabledSkills: ['disabled-skill'],
      systemSettingsOpen: true,
      viewMode: 'chat',
      activeToolboxTab: 'skills',
    });
    useMCPStore.setState({
      servers: {
        'abu-browser-bridge': {
          config: {
            name: 'abu-browser-bridge',
            command: 'abu-chrome-bridge-runtime',
            args: [],
            enabled: true,
          },
          status: 'connected',
          tools: [],
        },
      },
      isLoading: false,
    });
    useDiscoveryStore.setState({
      skills: [
        { name: 'enabled-skill' },
        { name: 'disabled-skill' },
      ] as SkillMetadata[],
      agents: [],
      isLoading: false,
    });
  });

  afterEach(() => {
    cleanup();
    setElectronHost(false);
  });

  // The overview is three channel cards and nothing else: one badge, one line,
  // one named button each. Every rule lives on the capability's own page.
  it('keeps the built-in browser, My Chrome, and Computer Use states distinct', async () => {
    render(<CapabilitiesSection />);

    const builtinCard = findCapabilityCard('Abu built-in browser');
    const chromeCard = findCapabilityCard('My Chrome');
    const computerCard = findCapabilityCard('Computer Use');

    // A lost built-in runtime is something the user has to act on, so it takes
    // the same badge as any other unfinished capability; the line underneath
    // is what says WHAT went wrong.
    expect(within(builtinCard).getByText('Setup required')).toBeInTheDocument();
    expect(builtinCard).toHaveTextContent('built-in browser runtime is disconnected');
    await waitFor(() => {
      expect(within(chromeCard).getByText('Ready')).toBeInTheDocument();
      expect(within(computerCard).getByText('Setup required')).toBeInTheDocument();
    });
    // Ready channels show their standing one-liner, not a status sentence.
    expect(chromeCard).toHaveTextContent('Reuses the Chrome tabs you are already signed in to');

    // Permission detail belongs to the detail page, not the overview.
    expect(screen.queryByText('View screen')).not.toBeInTheDocument();
    expect(screen.queryByText('Action permissions')).not.toBeInTheDocument();
    expect(screen.queryByText('Site permissions')).not.toBeInTheDocument();
  });

  // The three badge tones, on the same page, at the same time.
  it('reports exactly three outcome badges across the three cards', async () => {
    useSettingsStore.setState({ computerUseEnabled: false });
    render(<CapabilitiesSection />);

    await waitFor(() => {
      expect(within(findCapabilityCard('My Chrome')).getByText('Ready')).toBeInTheDocument();
    });
    expect(within(findCapabilityCard('Abu built-in browser')).getByText('Setup required'))
      .toBeInTheDocument();
    expect(within(findCapabilityCard('Computer Use')).getByText('Off')).toBeInTheDocument();
  });

  /*
    User ruling 2026-09-04: the card row IS the control. One target, one
    affordance, no per-card button wording to compare — so the card must be a
    real button (focusable, named, keyboard-operable), not a div with onClick,
    and it must carry no nested control that could swallow the click.
  */
  it('makes the whole card row the single control that drills in', async () => {
    const user = userEvent.setup();
    render(<CapabilitiesSection />);

    const builtinCard = findCapabilityCard('Abu built-in browser');
    expect(builtinCard.tagName).toBe('BUTTON');
    expect(within(builtinCard).queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Manage' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect Chrome' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start setup' })).not.toBeInTheDocument();

    // Reachable by keyboard, since it is the only way in.
    builtinCard.focus();
    expect(builtinCard).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByText('Action permissions')).toBeInTheDocument();
  });

  // The badge is the reason the row exists. A screen reader that hears only
  // "My Chrome" learns nothing the surrounding page did not already say.
  it('names each card by its capability AND its current status', async () => {
    useSettingsStore.setState({ computerUseEnabled: false });
    mcpManagerMock.callTool.mockResolvedValue(EXTENSION_MISSING);
    render(<CapabilitiesSection />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'My Chrome · Not connected' }))
        .toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Abu built-in browser · Setup required' }))
      .toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Computer Use · Off' })).toBeInTheDocument();
  });

  it('walks into the site list and back out through the breadcrumb', async () => {
    useSettingsStore.setState({
      browserSitePermissions: { 'https://example.com': 'allowed' },
    });
    const user = userEvent.setup();
    render(<CapabilitiesSection />);

    await openSitePermissions(user);
    expect(screen.getByTitle('https://example.com')).toBeInTheDocument();

    // One step up: back to the built-in browser page, not all the way out.
    await user.click(screen.getByRole('button', { name: 'Abu built-in browser' }));
    expect(screen.getByText('Action permissions')).toBeInTheDocument();
    expect(screen.queryByTitle('https://example.com')).not.toBeInTheDocument();

    // Root segment: back to the overview.
    await user.click(screen.getByRole('button', { name: 'Back to Capabilities' }));
    expect(findCapabilityCard('My Chrome')).toBeInTheDocument();
    expect(screen.queryByText('Action permissions')).not.toBeInTheDocument();
  });

  it('shows DeepSeek without vision as structured mode instead of unavailable', async () => {
    const provider = makeModelProvider({});
    useSettingsStore.setState({
      providers: [provider],
      activeModel: { providerId: provider.id, modelId: 'deepseek-chat' },
    });

    const user = userEvent.setup();
    render(<CapabilitiesSection />);
    await waitFor(() => {
      expect(within(findCapabilityCard('Computer Use')).getByText('Setup required'))
        .toBeInTheDocument();
    });

    // The model tier gates the permissions, so it moved in with them.
    await openDetail(user, 'Computer Use');
    expect(screen.getByText(/deepseek-chat · Structured mode/)).toBeInTheDocument();
    expect(screen.getByText(/No image input/)).toBeInTheDocument();
  });

  it('marks an undeclared custom endpoint as not verified and not ready', async () => {
    const provider = makeModelProvider({
      source: 'custom',
      models: [{ id: 'private-proxy-model', label: 'Private Proxy' }],
    });
    useSettingsStore.setState({
      providers: [provider],
      activeModel: { providerId: provider.id, modelId: 'private-proxy-model' },
    });

    const user = userEvent.setup();
    render(<CapabilitiesSection />);
    const computerCard = findCapabilityCard('Computer Use');

    await waitFor(() => {
      expect(within(computerCard).getByText('Setup required')).toBeInTheDocument();
    });
    expect(computerCard).toHaveTextContent('Confirm its model capabilities');

    await openDetail(user, 'Computer Use');
    expect(screen.getByText(/private-proxy-model · Not verified/)).toBeInTheDocument();
  });

  it('guides the local Chrome extension setup without exposing MCP configuration', async () => {
    mcpManagerMock.callTool.mockResolvedValue(
      'Browser extension is not connected. Please install and enable the Abu Browser Extension.',
    );
    const user = userEvent.setup();
    render(<CapabilitiesSection />);

    await openDetail(user, 'My Chrome');

    expect(await screen.findByText('Connect My Chrome')).toBeInTheDocument();
    await waitFor(() => {
      expect(ensureMCPServerMock).toHaveBeenCalledWith('abu-browser-bridge');
    });
    expect(resolveMCPCompanionResourceMock).toHaveBeenCalledWith('abu-browser-bridge');
    expect(screen.getByText(/local extension rather than the Chrome Web Store/)).toBeInTheDocument();
    expect(screen.queryByText('Advanced settings')).not.toBeInTheDocument();
    expect(screen.queryByText(/MCP configuration/)).not.toBeInTheDocument();
  });

  it('keeps Skill and MCP implementation concepts out of the capability overview', () => {
    render(<CapabilitiesSection />);

    expect(screen.queryByText('1 skill(s) enabled')).not.toBeInTheDocument();
    expect(screen.queryByText(/connector\(s\)/)).not.toBeInTheDocument();
  });

  it('does not report My Chrome ready when its MCP process has no extension', async () => {
    mcpManagerMock.callTool.mockResolvedValue(
      'Browser extension is not connected. Please install and enable the Abu Browser Extension.',
    );
    render(<CapabilitiesSection />);

    const chromeCard = findCapabilityCard('My Chrome');
    await waitFor(() => {
      expect(within(chromeCard).getByText('Not connected')).toBeInTheDocument();
    });
    // Never connected is not a fault, so the card's one line is spent on what
    // connecting would buy rather than on restating the badge beside it.
    expect(chromeCard).toHaveTextContent('Reuses the Chrome tabs you are already signed in to');
  });

  /*
    The card that was promoted to the first screen has to describe a
    never-installed extension the same way at every moment of startup. Before
    the fix, the local bridge coming up read as an amber "setup required ·
    connection lost" and then settled to a grey "not connected" once the probe
    answered — which of the two a user saw was a race between the bridge and
    the probe.
  */
  it.each(['disconnected', 'error'] as const)(
    'shows a never-installed extension as not connected while the bridge is %s',
    async (bridgeStatus) => {
      mcpManagerMock.callTool.mockResolvedValue(
        'Browser extension is not connected. Please install and enable the Abu Browser Extension.',
      );
      useMCPStore.setState((state) => ({
        servers: {
          ...state.servers,
          'abu-browser-bridge': {
            ...state.servers['abu-browser-bridge'],
            status: bridgeStatus,
          },
        },
      }));
      render(<CapabilitiesSection />);

      const chromeCard = findCapabilityCard('My Chrome');
      await waitFor(() => {
        expect(within(chromeCard).getByText('Not connected')).toBeInTheDocument();
      });
      // Never "connection lost": nothing has ever connected to lose.
      expect(chromeCard).not.toHaveTextContent('disconnected');
      expect(chromeCard).toHaveTextContent('Reuses the Chrome tabs you are already signed in to');
    },
  );

  // While the bridge is actively coming up the badge is the transient
  // "checking" — a loading state, not a fourth outcome, and specifically not
  // the amber fault the old derivation showed here.
  it('shows a connecting bridge as checking, never as a fault', () => {
    useMCPStore.setState((state) => ({
      servers: {
        ...state.servers,
        'abu-browser-bridge': {
          ...state.servers['abu-browser-bridge'],
          status: 'connecting',
        },
      },
    }));
    render(<CapabilitiesSection />);

    const chromeCard = findCapabilityCard('My Chrome');
    expect(within(chromeCard).getAllByText('Checking').length).toBeGreaterThan(0);
    expect(within(chromeCard).queryByText('Setup required')).not.toBeInTheDocument();
  });

  // ...and it stays that way once the bridge finishes coming up and the probe
  // answers, which is the same state described the same way.
  it('keeps a never-installed extension as not connected once the probe answers', async () => {
    mcpManagerMock.callTool.mockResolvedValue(
      'Browser extension is not connected. Please install and enable the Abu Browser Extension.',
    );
    render(<CapabilitiesSection />);

    const chromeCard = findCapabilityCard('My Chrome');
    await waitFor(() => {
      expect(within(chromeCard).getByText('Not connected')).toBeInTheDocument();
    });
    // Give every pending probe a chance to land and contradict it.
    await waitFor(() => {
      expect(within(chromeCard).getByText('Not connected')).toBeInTheDocument();
    });
    expect(within(chromeCard).queryByText('Setup required')).not.toBeInTheDocument();
  });

  /*
    R1 — the probe that outlived its bridge.

    A probe started while the bridge was up can land after the bridge has
    died. Its sequence number is still the newest, so the staleness guard
    waves it through; it reports `true`; and because the derivation now tests
    "is the extension attached" BEFORE the bridge's own runtime status, a dead
    bridge would render as ready and latch the handshake on the way. The
    bridge status used to backstop this on its own. It no longer can, so the
    status effect has to invalidate in-flight probes when the bridge goes
    away — the same thing an explicit disconnect does.

    Mutation: drop the `chromeProbeSeqRef.current += 1` from that early
    return and this test goes red.
  */
  it('ignores a probe that resolves after its bridge went away', async () => {
    const inFlight = deferredProbe();
    mcpManagerMock.callTool.mockReturnValue(inFlight.promise);
    const { rerender } = render(<CapabilitiesSection />);

    // The probe is out, launched while the bridge was connected.
    await waitFor(() => {
      expect(mcpManagerMock.callTool).toHaveBeenCalled();
    });

    // The bridge dies underneath it.
    useMCPStore.setState((state) => ({
      servers: {
        ...state.servers,
        'abu-browser-bridge': {
          ...state.servers['abu-browser-bridge'],
          status: 'error',
          error: 'bridge died',
        },
      },
    }));
    rerender(<CapabilitiesSection />);

    // ...and only now does the old probe come back, saying all is well.
    inFlight.resolve(EXTENSION_ATTACHED);
    await waitFor(() => {
      expect(findCapabilityCard('My Chrome')).toBeInTheDocument();
    });

    const chromeCard = findCapabilityCard('My Chrome');
    expect(within(chromeCard).queryByText('Ready')).not.toBeInTheDocument();
    // ...and it must not have latched the handshake on its way past, which
    // would turn every later "not connected" into an amber fault.
    expect(hasChromeExtensionHandshaked()).toBe(false);
  });

  /*
    R2 — the staleness guard itself. Two probes overlap; the NEWEST answer is
    the true one even when it comes back first.

    Mutation: delete the `seq !== chromeProbeSeqRef.current` early return and
    this test goes red.
  */
  it('keeps the newest probe result when an older probe answers last', async () => {
    const slowFirstProbe = deferredProbe();
    const fastSecondProbe = deferredProbe();
    mcpManagerMock.callTool
      .mockReturnValueOnce(slowFirstProbe.promise)
      .mockReturnValueOnce(fastSecondProbe.promise);

    const user = userEvent.setup();
    render(<CapabilitiesSection />);
    await waitFor(() => {
      expect(mcpManagerMock.callTool).toHaveBeenCalledTimes(1);
    });

    // A second, newer probe: the user asks to check the connection.
    await openDetail(user, 'My Chrome');
    await user.click(await screen.findByRole('button', { name: 'Check connection' }));
    await waitFor(() => {
      expect(mcpManagerMock.callTool).toHaveBeenCalledTimes(2);
    });

    // The newer probe answers first...
    fastSecondProbe.resolve(EXTENSION_ATTACHED);
    await waitFor(() => {
      expect(hasChromeExtensionHandshaked()).toBe(true);
    });

    // ...and the older one contradicts it afterwards. It is history.
    slowFirstProbe.resolve(EXTENSION_MISSING);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: 'Check connection' })).not.toBeInTheDocument();
  });

  /*
    R3 — the latch is scoped to the process, not to the component. Settings
    unmounts every time the dialog closes, and a connection that genuinely
    broke must not read as "never connected" again just because the user
    closed and reopened the dialog.
  */
  describe('handshake latch scope', () => {
    it('survives the settings dialog closing and reopening', async () => {
      const { unmount } = render(<CapabilitiesSection />);
      await waitFor(() => {
        expect(hasChromeExtensionHandshaked()).toBe(true);
      });

      unmount();
      expect(hasChromeExtensionHandshaked()).toBe(true);

      // Reopened, with the extension now gone: this is a LOST connection, and
      // the remounted page has to still know that.
      mcpManagerMock.callTool.mockResolvedValue(EXTENSION_MISSING);
      render(<CapabilitiesSection />);
      const chromeCard = findCapabilityCard('My Chrome');
      await waitFor(() => {
        expect(within(chromeCard).getByText('Setup required')).toBeInTheDocument();
      });
      expect(within(chromeCard).queryByText('Not connected')).not.toBeInTheDocument();
    });

    it('starts false in a fresh process and clears on an explicit disconnect', async () => {
      // Nothing has run yet in this test: the module default is the
      // fresh-process value, and it is never read back from storage.
      expect(hasChromeExtensionHandshaked()).toBe(false);

      const user = userEvent.setup();
      render(<CapabilitiesSection />);
      await waitFor(() => {
        expect(hasChromeExtensionHandshaked()).toBe(true);
      });

      await openDetail(user, 'My Chrome');
      await user.click(screen.getByRole('button', { name: 'Disconnect My Chrome' }));

      await waitFor(() => {
        expect(hasChromeExtensionHandshaked()).toBe(false);
      });
    });
  });

  /*
    R4 — the button that would not hide. `hidden={!capabilityEnabled}` was
    defeated by Tailwind v4's layer order (`.inline-flex` in `@layer
    utilities` outranks preflight's `[hidden] { display: none }`), so this
    button offered to check a connection for a bridge that is not enabled.
    Conditional rendering is what makes it actually absent — assert absence
    from the DOM, since a CSS-only fix would still leave it present.
  */
  it('offers no connection check while the Chrome capability is disabled', async () => {
    mcpManagerMock.callTool.mockResolvedValue(EXTENSION_MISSING);
    useMCPStore.setState((state) => ({
      servers: {
        ...state.servers,
        'abu-browser-bridge': {
          ...state.servers['abu-browser-bridge'],
          config: { ...state.servers['abu-browser-bridge'].config, enabled: false },
          status: 'disconnected',
        },
      },
    }));
    useSettingsStore.setState({ capabilitySetupTarget: 'chrome' });
    render(<CapabilitiesSection />);

    expect(await screen.findByText('Connect My Chrome')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check connection' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument();
    // The way forward is the explicit opt-in, which is present.
    expect(screen.getByRole('button', { name: 'Connect Chrome' })).toBeInTheDocument();
  });

  it('lets the user disconnect My Chrome without entering MCP settings', async () => {
    const user = userEvent.setup();
    render(<CapabilitiesSection />);

    await waitFor(() => {
      expect(within(findCapabilityCard('My Chrome')).getByText('Ready')).toBeInTheDocument();
    });
    await openDetail(user, 'My Chrome');
    await user.click(screen.getByRole('button', { name: 'Disconnect My Chrome' }));

    await waitFor(() => {
      expect(useMCPStore.getState().servers['abu-browser-bridge']).toMatchObject({
        config: { enabled: false },
        status: 'disconnected',
      });
    });
    expect(mcpManagerMock.disconnectServer).toHaveBeenCalledWith('abu-browser-bridge');
  });

  it('keeps My Chrome disconnect available when the enabled runtime has failed', async () => {
    useMCPStore.setState((state) => ({
      servers: {
        ...state.servers,
        'abu-browser-bridge': {
          ...state.servers['abu-browser-bridge'],
          status: 'error',
          error: 'bridge failed',
        },
      },
    }));
    const user = userEvent.setup();
    render(<CapabilitiesSection />);

    await openDetail(user, 'My Chrome');

    expect(await screen.findByRole('button', { name: 'Disconnect My Chrome' }))
      .toBeInTheDocument();
  });

  it('refreshes built-in browser status when the existing MCP runtime connects', async () => {
    render(<CapabilitiesSection />);

    const builtinCard = findCapabilityCard('Abu built-in browser');
    expect(within(builtinCard).getByText('Setup required')).toBeInTheDocument();

    mcpManagerMock.connectedServers.add('abu-browser');
    mcpManagerMock.listeners.forEach((listener) => listener());

    await waitFor(() => {
      expect(within(builtinCard).getByText('Ready')).toBeInTheDocument();
    });
  });

  it('shows an in-progress Chrome bridge as checking instead of disconnected', () => {
    useMCPStore.setState((state) => ({
      servers: {
        ...state.servers,
        'abu-browser-bridge': {
          ...state.servers['abu-browser-bridge'],
          status: 'reconnecting',
        },
      },
    }));

    render(<CapabilitiesSection />);

    const chromeCard = findCapabilityCard('My Chrome');
    expect(within(chromeCard).getAllByText('Checking').length).toBeGreaterThan(0);
    expect(within(chromeCard).queryByText('Setup required')).not.toBeInTheDocument();
  });

  it('enables Computer Use through guided setup while keeping partial permission visible', async () => {
    useSettingsStore.setState({ computerUseEnabled: false });
    const user = userEvent.setup();
    render(<CapabilitiesSection />);

    await openDetail(user, 'Computer Use');

    expect(screen.getByText('Enable Computer Use')).toBeInTheDocument();
    expect(useSettingsStore.getState().computerUseEnabled).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Enable' }));

    await waitFor(() => {
      expect(useSettingsStore.getState().computerUseEnabled).toBe(true);
    });
    // The setup rows, the guided step, and the model card each name the two
    // permissions, so count is not the assertion — presence is.
    expect(screen.getAllByText('View screen').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Control interface').length).toBeGreaterThan(0);
    expect(screen.getByText('Step 2 of 2')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back to Capabilities' }));
    expect(findCapabilityCard('Computer Use')).toHaveTextContent('Setup required');
    expect(findCapabilityCard('Computer Use')).toHaveTextContent(
      'Abu can view the screen but cannot control the interface yet.',
    );
  });

  it('does not let an in-flight permission refresh undo Computer Use disable', async () => {
    const user = userEvent.setup();
    let permissionCheckCount = 0;
    let resolvePending!: (value: {
      screen_recording: boolean;
      accessibility: boolean;
    }) => void;
    const pendingPermissionCheck = new Promise<{
      screen_recording: boolean;
      accessibility: boolean;
    }>((resolve) => {
      resolvePending = resolve;
    });
    invoke.mockImplementation((command: string) => {
      if (command !== 'check_macos_permissions') return Promise.resolve(undefined);
      permissionCheckCount += 1;
      if (permissionCheckCount === 1) {
        return Promise.resolve({
          screen_recording: true,
          accessibility: true,
        });
      }
      return pendingPermissionCheck;
    });

    render(<CapabilitiesSection />);
    await openDetail(user, 'Computer Use');
    await user.click(screen.getByRole('button', { name: 'Turn off Computer Use' }));

    expect(useSettingsStore.getState().computerUseEnabled).toBe(false);
    resolvePending({
      screen_recording: true,
      accessibility: true,
    });
    await waitFor(() => {
      expect(useSettingsStore.getState().computerUseEnabled).toBe(false);
    });
  });

  it('opens the exact Computer Use guide from a task without enabling it', async () => {
    useSettingsStore.setState({
      capabilitySetupTarget: 'computer',
      computerUseEnabled: false,
    });
    const user = userEvent.setup();
    render(<CapabilitiesSection />);

    expect(await screen.findByText('The current task needs Computer Use'))
      .toBeInTheDocument();
    expect(useSettingsStore.getState().computerUseEnabled).toBe(false);
    expect(useSettingsStore.getState().capabilitySetupTarget).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Enable' }));
    expect(useSettingsStore.getState().computerUseEnabled).toBe(true);
  });

  it('returns to the requesting task after guided Computer Use setup completes', async () => {
    useSettingsStore.setState({
      capabilitySetupTarget: 'computer',
      computerUseEnabled: false,
      systemSettingsOpen: true,
    });
    invoke.mockImplementation((command: string) => {
      if (command === 'check_macos_permissions') {
        return Promise.resolve({
          screen_recording: true,
          accessibility: true,
        });
      }
      return Promise.resolve(undefined);
    });
    const user = userEvent.setup();

    render(<CapabilitiesSection />);

    expect(await screen.findByText('The current task needs Computer Use'))
      .toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Enable' }));
    expect(await screen.findByText('Computer Use is ready')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Return to task' }));

    expect(useSettingsStore.getState().systemSettingsOpen).toBe(false);
    expect(useSettingsStore.getState().capabilitySetupTarget).toBeNull();
  });

  it('uses the Electron floating permission guide and resumes the requesting task', async () => {
    useSettingsStore.setState({
      capabilitySetupTarget: 'computer',
      computerUseEnabled: false,
      systemSettingsOpen: true,
    });
    invoke.mockImplementation((command: string) => {
      if (command === 'check_macos_permissions') {
        return Promise.resolve({
          screen_recording: true,
          accessibility: false,
        });
      }
      if (command === 'computer_use_permission_guide_show') {
        return Promise.resolve({
          status: 'complete',
          permissions: {
            screenRead: true,
            uiControl: true,
          },
          error: null,
        });
      }
      return Promise.resolve(undefined);
    });
    const user = userEvent.setup();
    render(<CapabilitiesSection />);

    expect(await screen.findByText('The current task needs Computer Use'))
      .toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Enable' }));
    await user.click(screen.getByRole('button', { name: 'Open System Settings' }));

    await waitFor(() => {
      expect(useSettingsStore.getState().systemSettingsOpen).toBe(false);
    });
    expect(invoke).toHaveBeenCalledWith(
      'computer_use_permission_guide_show',
      expect.objectContaining({
        requestedByTask: true,
        permissions: expect.objectContaining({
          screenRead: true,
          uiControl: false,
          screenReadStatus: 'granted',
          uiControlStatus: 'not-determined',
          restartRequired: false,
        }),
        strings: expect.objectContaining({
          title: 'Enable Computer Use',
          allow: 'Allow',
          developmentIdentity: expect.stringContaining('Electron'),
        }),
      }),
    );
  });

  it('shows only Accessibility for an AX-only task setup', async () => {
    useSettingsStore.setState({ computerUseEnabled: true });
    invoke.mockImplementation((command: string) => {
      if (command === 'check_macos_permissions') {
        return Promise.resolve({
          screen_recording: false,
          accessibility: false,
        });
      }
      return Promise.resolve(undefined);
    });

    render(<CapabilitiesSection
      setupTarget="computer"
      requestedByTask
      setupOnly
      computerUseRequirements={{ screenRead: false, uiControl: true }}
    />);

    expect((await screen.findAllByText('Control interface')).length).toBeGreaterThan(0);
    // The setup ROWS drop the permission this task does not need; the model
    // card still reports both, because both describe the model's own tier.
    expect(screen.queryAllByText('View screen')).toHaveLength(1);
    expect(screen.getByText('Required permission')).toBeInTheDocument();
  });

  it('keeps background permission checks silent and advances the active step', async () => {
    useSettingsStore.setState({
      capabilitySetupTarget: 'computer',
      computerUseEnabled: true,
    });
    invoke.mockImplementation((command: string) => {
      if (command === 'check_macos_permissions') {
        return Promise.resolve({
          screen_recording: false,
          accessibility: false,
        });
      }
      return Promise.resolve(undefined);
    });

    render(<CapabilitiesSection />);

    expect(await screen.findByText('Step 1 of 2')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText('Checking')).not.toBeInTheDocument();
    });

    let resolveBackgroundCheck!: (value: {
      screen_recording: boolean;
      accessibility: boolean;
    }) => void;
    const backgroundCheck = new Promise<{
      screen_recording: boolean;
      accessibility: boolean;
    }>((resolve) => {
      resolveBackgroundCheck = resolve;
    });
    invoke.mockImplementation((command: string) => {
      if (command === 'check_macos_permissions') return backgroundCheck;
      return Promise.resolve(undefined);
    });

    const checksBeforeFocus = invoke.mock.calls.filter(
      ([command]) => command === 'check_macos_permissions',
    ).length;
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => {
      const checksAfterFocus = invoke.mock.calls.filter(
        ([command]) => command === 'check_macos_permissions',
      ).length;
      expect(checksAfterFocus).toBeGreaterThan(checksBeforeFocus);
    });
    expect(screen.queryByText('Checking')).not.toBeInTheDocument();
    expect(screen.getByText('Step 1 of 2')).toBeInTheDocument();

    resolveBackgroundCheck({
      screen_recording: true,
      accessibility: false,
    });
    expect(await screen.findByText('Step 2 of 2')).toBeInTheDocument();
    expect(screen.queryByText('Checking')).not.toBeInTheDocument();
  });

  it('opens the exact My Chrome guide from a task and waits for explicit reconnect consent', async () => {
    mcpManagerMock.callTool.mockResolvedValue(
      'Browser extension is not connected. Please install and enable the Abu Browser Extension.',
    );
    useMCPStore.setState((state) => ({
      servers: {
        ...state.servers,
        'abu-browser-bridge': {
          ...state.servers['abu-browser-bridge'],
          config: {
            ...state.servers['abu-browser-bridge'].config,
            enabled: false,
          },
          status: 'disconnected',
        },
      },
    }));
    useSettingsStore.setState({ capabilitySetupTarget: 'chrome' });
    const user = userEvent.setup();

    render(<CapabilitiesSection />);

    expect(await screen.findByText('Connect My Chrome')).toBeInTheDocument();
    expect(screen.getByText('The current task needs My Chrome')).toBeInTheDocument();
    expect(ensureMCPServerMock).not.toHaveBeenCalled();
    expect(useMCPStore.getState().servers['abu-browser-bridge'].config.enabled).toBe(false);
    expect(useSettingsStore.getState().capabilitySetupTarget).toBeNull();
    expect(screen.getByText(/local extension rather than the Chrome Web Store/))
      .toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Connect Chrome' }));
    await waitFor(() => {
      expect(ensureMCPServerMock).toHaveBeenCalledWith('abu-browser-bridge');
    });
    expect(useMCPStore.getState().servers['abu-browser-bridge'].config.enabled).toBe(true);
  });

  it('keeps guided Computer Use opt-in functional in the legacy Tauri shell', async () => {
    setElectronHost(false);
    useSettingsStore.setState({ computerUseEnabled: false });
    const user = userEvent.setup();
    render(<CapabilitiesSection />);

    const builtinCard = findCapabilityCard('Abu built-in browser');
    // Nothing to set up in this shell, so it reads as not connected, and the
    // line underneath says the client does not offer it.
    expect(within(builtinCard).getByText('Not connected')).toBeInTheDocument();
    expect(builtinCard).toHaveTextContent('not available in this client');

    await openDetail(user, 'Computer Use');
    expect(useSettingsStore.getState().computerUseEnabled).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Enable' }));
    await waitFor(() => {
      expect(useSettingsStore.getState().computerUseEnabled).toBe(true);
    });
    expect(invoke).toHaveBeenCalledWith('check_macos_permissions');
  });

  // Settings is the one place where every standing site verdict has to be
  // visible AND changeable: the dialog can only write a verdict for the site
  // it is currently asking about, so tightening a site the user already
  // allowed is otherwise impossible without wiping it and waiting to be asked.
  describe('browser site permissions list', () => {
    it('lists both verdicts and switches an allowed site to blocked', async () => {
      useSettingsStore.setState({
        browserSitePermissions: {
          'https://allowed.example.com': 'allowed',
          'https://blocked.example.com': 'denied',
        },
      });
      const user = userEvent.setup();
      render(<CapabilitiesSection />);
      await openSitePermissions(user);

      const row = screen.getByTitle('https://allowed.example.com').closest('li');
      expect(row).not.toBeNull();
      expect(within(row as HTMLElement).getByRole('button', { name: 'Always allow' }))
        .toBeInTheDocument();
      expect(screen.getByTitle('https://blocked.example.com')).toBeInTheDocument();

      await user.click(within(row as HTMLElement).getByRole('button', { name: 'Always allow' }));
      await user.click(within(row as HTMLElement).getByRole('button', { name: /^Blocked/ }));

      expect(useSettingsStore.getState().browserSitePermissions).toEqual({
        'https://allowed.example.com': 'denied',
        'https://blocked.example.com': 'denied',
      });
    });

    it('removes a verdict entirely, restoring ask-every-time', async () => {
      useSettingsStore.setState({
        browserSitePermissions: { 'https://example.com': 'denied' },
      });
      const user = userEvent.setup();
      render(<CapabilitiesSection />);
      await openSitePermissions(user);

      const row = screen.getByTitle('https://example.com').closest('li');
      await user.click(within(row as HTMLElement).getByRole('button', { name: 'Remove' }));

      expect(useSettingsStore.getState().browserSitePermissions).toEqual({});
    });

    // The explanation is where the choice is, not behind a hover target.
    it('explains each verdict inside the dropdown that sets it', async () => {
      useSettingsStore.setState({
        browserSitePermissions: { 'https://example.com': 'allowed' },
      });
      const user = userEvent.setup();
      render(<CapabilitiesSection />);
      await openSitePermissions(user);

      const row = screen.getByTitle('https://example.com').closest('li') as HTMLElement;
      const trigger = within(row).getByRole('button', { name: 'Always allow' });
      await user.click(trigger);

      expect(openedOptionDescriptions(trigger)).toEqual([
        'This site stops asking each time; payment / transfer pages are still stopped',
        'Abu never acts on this site, automatic tasks included',
      ]);
    });

    // The card the user drills in FROM has to say how many verdicts are
    // waiting behind it, and that both channels answer to the same list.
    it('summarizes the list on the card that leads to it', async () => {
      useSettingsStore.setState({
        browserSitePermissions: {
          'https://a.example.com': 'allowed',
          'https://b.example.com': 'allowed',
          'https://c.example.com': 'denied',
        },
      });
      const user = userEvent.setup();
      render(<CapabilitiesSection />);
      await openBuiltinBrowser(user);

      expect(screen.getByRole('button', { name: 'Site permissions' })).toHaveTextContent(
        '2 allowed · 1 blocked · shared by the built-in browser and Chrome',
      );
    });
  });

  // The operation-class policy grid + its master switch. The switch overrides
  // the automatic-tasks column entirely, so the column must not offer live
  // controls while it is off.
  describe('browser operation policy', () => {
    beforeEach(() => {
      useSettingsStore.setState({
        browserOperationPolicy: DEFAULT_BROWSER_OPERATION_POLICY,
        allowUnattendedBrowser: false,
      });
    });

    // Two ordinary classes in the grid; scripting is its own card. The split
    // must not change which setter a cell writes through — that is the whole
    // point of the refactor being cosmetic.
    it('renders a 2x2 matrix plus a separate scripting card, with the shipped defaults', async () => {
      const user = userEvent.setup();
      render(<CapabilitiesSection />);
      await openBuiltinBrowser(user);

      const grid = permissionCard('Action permissions');
      expect(within(grid).getByText('While you are here')).toBeInTheDocument();
      expect(within(grid).getByText('Automatic tasks')).toBeInTheDocument();
      expect(within(grid).getByText('View pages')).toBeInTheDocument();
      expect(within(grid).getByText('Click and fill in')).toBeInTheDocument();
      expect(within(grid).queryByText('Run scripts (advanced)')).not.toBeInTheDocument();

      const scriptCard = permissionCard('Run scripts (advanced)');
      expect(scriptCard).not.toBe(grid);
      expect(scriptCard).toHaveTextContent('Lets Abu run code inside the page.');
      // attended = ask, unattended = deny (the product default table)
      const [scriptAttended, scriptUnattended] = policyCells(scriptCard);
      expect(scriptAttended).toHaveTextContent('Ask every time');
      expect(scriptUnattended).toHaveTextContent('Deny');
    });

    it('disables the automatic-tasks column while the master switch is off', async () => {
      const user = userEvent.setup();
      render(<CapabilitiesSection />);
      await openBuiltinBrowser(user);

      const readOnlyRow = within(permissionCard('Action permissions'))
        .getByText('View pages').closest('li') as HTMLElement;
      const [attendedCell, unattendedCell] = policyCells(readOnlyRow);

      expect(attendedCell).not.toBeDisabled();
      expect(unattendedCell).toBeDisabled();

      // Same rule in the split-out card — it is the same column.
      const [, scriptUnattended] = policyCells(permissionCard('Run scripts (advanced)'));
      expect(scriptUnattended).toBeDisabled();
    });

    it('writes a changed matrix cell to the store', async () => {
      useSettingsStore.setState({ allowUnattendedBrowser: true });
      const user = userEvent.setup();
      render(<CapabilitiesSection />);
      await openBuiltinBrowser(user);

      const interactiveRow = within(permissionCard('Action permissions'))
        .getByText('Click and fill in').closest('li') as HTMLElement;
      const [, unattendedCell] = policyCells(interactiveRow);

      await user.click(unattendedCell);
      await user.click(within(interactiveRow).getByRole('button', { name: /^Deny/ }));

      expect(useSettingsStore.getState().browserOperationPolicy.unattended.interactive).toBe('deny');
      // The other column is untouched — the two run modes are independent.
      expect(useSettingsStore.getState().browserOperationPolicy.attended.interactive).toBe('allow');
    });

    /**
     * The zero-semantic-change pin. Pulling scripting out of the grid moved
     * the control to another card; it must still write `scripting` on the same
     * run mode, with the same three-state vocabulary, through the same store
     * action it did while it was a grid row.
     */
    it('keeps the split-out scripting card wired to the same store setter', async () => {
      useSettingsStore.setState({ allowUnattendedBrowser: true });
      const user = userEvent.setup();
      render(<CapabilitiesSection />);
      await openBuiltinBrowser(user);

      const scriptCard = permissionCard('Run scripts (advanced)');
      const [attendedCell, unattendedCell] = policyCells(scriptCard);

      await user.click(attendedCell);
      await user.click(within(scriptCard).getByRole('button', { name: /^Allow/ }));
      expect(useSettingsStore.getState().browserOperationPolicy.attended.scripting).toBe('allow');
      expect(useSettingsStore.getState().browserOperationPolicy.unattended.scripting).toBe('deny');

      await user.click(unattendedCell);
      await user.click(within(scriptCard).getByRole('button', { name: /^Ask every time/ }));
      expect(useSettingsStore.getState().browserOperationPolicy.unattended.scripting).toBe('ask');
      // And the grid rows it used to share a table with are untouched.
      expect(useSettingsStore.getState().browserOperationPolicy.attended.readOnly).toBe('allow');
      expect(useSettingsStore.getState().browserOperationPolicy.attended.interactive).toBe('allow');
    });

    // The automatic-tasks scripting cell has no "allow": a site grant minted
    // from a human approving a click must never buy silent page scripting.
    it('offers only ask/deny for automatic scripting, all three elsewhere', async () => {
      useSettingsStore.setState({ allowUnattendedBrowser: true });
      const user = userEvent.setup();
      render(<CapabilitiesSection />);
      await openBuiltinBrowser(user);

      const [scriptAttended, scriptUnattended] = policyCells(
        permissionCard('Run scripts (advanced)'),
      );

      await user.click(scriptUnattended);
      expect(openedOptionLabels(scriptUnattended)).toEqual(['Ask every time', 'Deny']);

      // The attended half of the same class still offers all three.
      await user.keyboard('{Escape}');
      await user.click(scriptAttended);
      expect(openedOptionLabels(scriptAttended)).toEqual(['Allow', 'Ask every time', 'Deny']);
      expect(openedOptionDescriptions(scriptAttended)).toEqual([
        'Never asks again',
        'Confirms with a dialog before each action',
        'Abu will not do this kind of thing',
      ]);
    });

    it('toggles the automatic-tasks master switch', async () => {
      const user = userEvent.setup();
      render(<CapabilitiesSection />);
      await openBuiltinBrowser(user);

      const card = permissionCard('Automatic tasks');
      await user.click(within(card).getByRole('switch'));

      expect(useSettingsStore.getState().allowUnattendedBrowser).toBe(true);
    });

    /**
     * U6 — the two browser channels do not protect an automatic run equally:
     * only the built-in one can refuse BEFORE acting on an expired session,
     * because the extension channel has no `webRequest` to see the 401 with.
     * It is now one sentence, and it is attached to the channel it is about
     * instead of being read by everyone including the people it cannot apply
     * to.
     */
    it('warns about the Chrome channel only on the Chrome page', async () => {
      const user = userEvent.setup();
      render(<CapabilitiesSection />);

      await openBuiltinBrowser(user);
      expect(screen.queryByText(/expired sign-in/)).toBeNull();

      await user.click(screen.getByRole('button', { name: 'Back to Capabilities' }));
      await openDetail(user, 'My Chrome');

      const caveat = await screen.findByText(/expired sign-in/);
      expect(caveat.textContent).toMatch(/Chrome channel/);
      expect(caveat.textContent).toMatch(/sites you trust/);
      // Same shared cards on both pages otherwise.
      expect(screen.getByText('Action permissions')).toBeInTheDocument();
      expect(screen.getByText('Site permissions')).toBeInTheDocument();
    });
  });

  /**
   * U5 authorization visibility. "Allowed" is also what a run with nobody
   * watching acts on, and this list never said so — the user had to hold the
   * master switch, the site verdicts and the high-risk rule in their head to
   * answer "which sites would my nightly task touch?". The per-row
   * reachable/attended-only pair was dropped as restatement; the summary and
   * the high-risk flag, which say something a row cannot, stayed.
   */
  describe('automatic-task reach of the site list', () => {
    function withSites(
      sitePermissions: Record<string, 'allowed' | 'denied'>,
      allowUnattendedBrowser: boolean,
    ) {
      useSettingsStore.setState({
        browserSitePermissions: sitePermissions,
        allowUnattendedBrowser,
        browserOperationPolicy: DEFAULT_BROWSER_OPERATION_POLICY,
      });
    }

    it('says how many sites an automatic task may enter', async () => {
      withSites({ 'https://reports.example.com': 'allowed' }, true);
      const user = userEvent.setup();
      render(<CapabilitiesSection />);
      await openSitePermissions(user);

      // Origin-level, and the copy says so: entering the site is not the
      // same as every page on it being reachable (M8).
      expect(screen.getByText(/may enter 1 site/)).toBeInTheDocument();
      // Not an absolute promise: the classifier is deliberately incomplete
      // (its own module doc says so), so the copy says "recognizes" (M8).
      expect(screen.getByText(/each page is still judged on its own/)).toBeInTheDocument();
      expect(screen.getByText(/recognizes as payment/)).toBeInTheDocument();
      // The row itself no longer restates "an allowed site is allowed".
      const row = screen.getByTitle('https://reports.example.com').closest('li') as HTMLElement;
      expect(row).not.toHaveTextContent('Unattended');
      expect(row).not.toHaveTextContent('Only while you are here');
    });

    it('says the same site is out of reach while the master switch is off', async () => {
      withSites({ 'https://reports.example.com': 'allowed' }, false);
      const user = userEvent.setup();
      render(<CapabilitiesSection />);
      await openSitePermissions(user);

      expect(screen.getByText(/master switch is off/)).toBeInTheDocument();
    });

    // The one per-row fact the row cannot imply on its own.
    it('flags an allowed site that is high-risk anyway, and leaves it out of the count', async () => {
      withSites({ 'https://www.paypal.com': 'allowed' }, true);
      const user = userEvent.setup();
      render(<CapabilitiesSection />);
      await openSitePermissions(user);

      expect(screen.getByText('High-risk · asks every time')).toBeInTheDocument();
      expect(screen.getByText(/cannot act on any site right now/)).toBeInTheDocument();
    });

    it('puts no high-risk tag on a blocked site', async () => {
      withSites({ 'https://blocked.example.com': 'denied' }, true);
      const user = userEvent.setup();
      render(<CapabilitiesSection />);
      await openSitePermissions(user);

      expect(screen.queryByText('High-risk · asks every time')).not.toBeInTheDocument();
    });
  });

  // Structural parity of the two locales is a typecheck property
  // (`TranslationDict`); what a render test can add is that the Chinese page
  // actually reaches the same screens with the same shape.
  describe('zh-CN', () => {
    it('renders the overview and both browser detail pages in Chinese', async () => {
      initLanguage('zh-CN');
      const user = userEvent.setup();
      render(<CapabilitiesSection />);

      expect(findCapabilityCard('阿布内置浏览器')).toHaveTextContent('需要设置');
      await waitFor(() => {
        expect(within(findCapabilityCard('我的 Chrome')).getByText('已就绪')).toBeInTheDocument();
      });

      await openDetail(user, '阿布内置浏览器');
      expect(screen.getByText('操作权限')).toBeInTheDocument();
      expect(screen.getByText('只看页面')).toBeInTheDocument();
      expect(screen.getByText('点击和填写')).toBeInTheDocument();
      // Card title + two column headers (matrix and scripting card).
      expect(screen.getAllByText('自动任务').length).toBe(3);
      expect(screen.getAllByText('你在场时').length).toBe(2);
      expect(permissionCard('运行脚本（高级）')).toHaveTextContent('让阿布在页面里执行代码');
      expect(screen.queryByText(/登录失效/)).toBeNull();

      await user.click(screen.getByRole('button', { name: '返回能力' }));
      await openDetail(user, '我的 Chrome');
      expect(await screen.findByText(/登录失效/)).toBeInTheDocument();
    });
  });
});
