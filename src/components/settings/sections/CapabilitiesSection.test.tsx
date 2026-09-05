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

/** Every dropdown trigger inside a row or card, in document order. */
function policyCells(row: HTMLElement): HTMLElement[] {
  return within(row).getAllByRole('button').filter(
    (b) => b.getAttribute('aria-expanded') !== null,
  );
}

/** The ONE policy dropdown of a row — and an assertion that there is only one,
 *  since the 2026-09-04 ruling collapsed the attended/automatic columns into a
 *  single setting. */
function policySelect(row: HTMLElement): HTMLElement {
  const cells = policyCells(row);
  expect(cells).toHaveLength(1);
  return cells[0];
}

/** The OPEN dropdown belonging to a trigger. It is portalled to `document.body`
 *  (so a menu is never clipped by the card below it), which is why nothing here
 *  can be found by searching inside the row the trigger sits in. */
function openedMenu(trigger: HTMLElement): HTMLElement {
  const dropdown = document.getElementById(trigger.getAttribute('aria-controls') ?? '');
  if (!dropdown) throw new Error('dropdown not open');
  return dropdown;
}

/** One option of the open menu, by its accessible name. */
function openedOption(trigger: HTMLElement, name: RegExp | string): HTMLElement {
  return within(openedMenu(trigger)).getByRole('button', { name });
}

/** Read the OPEN dropdown, not the row: a closed trigger also renders its
 *  current value as button text and would match by name. Only the option
 *  LABEL is returned — the description is a child element, the label is the
 *  option button's own text. */
function openedOptionLabels(trigger: HTMLElement): string[] {
  const dropdown = openedMenu(trigger);
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
  const dropdown = openedMenu(trigger);
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

    expect(await screen.findByRole('heading', { name: 'My Chrome' })).toBeInTheDocument();
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

    // ...and the older one contradicts it afterwards. It is history: the page
    // still describes a connected channel, so it offers to disconnect it and
    // has stopped offering to go install anything.
    slowFirstProbe.resolve(EXTENSION_MISSING);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Disconnect My Chrome' })).toBeInTheDocument();
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

    expect(await screen.findByRole('heading', { name: 'My Chrome' })).toBeInTheDocument();
    expect(screen.queryByText('Check connection')).not.toBeInTheDocument();
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

  /*
    U5 — "Disconnect" is a claim about state, and the state it claims is the
    HANDSHAKE LATCH, not the live connection. Three cases, three offers:

      never handshaked → no disconnect (the complaint: "I never installed
        anything, why am I being offered a disconnect?"); go install one.
      handshaked, now lost → disconnect stays, alongside the check button.
        It is the only way to turn the listener off, and a page whose every
        button demands a repair strands anyone who just wants it off.
      connected → disconnect, obviously.
  */
  describe('disconnect follows the handshake latch', () => {
    it('offers none on a machine that never handshaked', async () => {
      mcpManagerMock.callTool.mockResolvedValue(EXTENSION_MISSING);
      const user = userEvent.setup();
      render(<CapabilitiesSection />);

      await openDetail(user, 'My Chrome');
      expect(await screen.findByRole('heading', { name: 'My Chrome' })).toBeInTheDocument();

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Open install windows' })).toBeInTheDocument();
      });
      expect(screen.queryByRole('button', { name: 'Disconnect My Chrome' }))
        .not.toBeInTheDocument();
      expect(screen.getByText('Not connected')).toBeInTheDocument();
    });

    it('keeps it after a connection that worked and then broke', async () => {
      // Handshaked in a previous mount of this process, then the extension
      // stopped answering — which is what the latch is for.
      setChromeExtensionHandshaked(true);
      mcpManagerMock.callTool.mockResolvedValue(EXTENSION_MISSING);
      const user = userEvent.setup();
      render(<CapabilitiesSection />);

      await openDetail(user, 'My Chrome');
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Disconnect My Chrome' })).toBeInTheDocument();
      });
      // ...reported as a fault, not as "never set up", and the repair path is
      // still there beside it.
      expect(screen.getByText('Setup required')).toBeInTheDocument();
      expect(screen.getByText(/connection was lost/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Check connection' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Open install windows' })).toBeInTheDocument();

      // And it still disconnects through the same two calls it always did.
      await user.click(screen.getByRole('button', { name: 'Disconnect My Chrome' }));
      await waitFor(() => {
        expect(mcpManagerMock.disconnectServer).toHaveBeenCalledWith('abu-browser-bridge');
      });
      expect(useMCPStore.getState().servers['abu-browser-bridge'].config.enabled).toBe(false);
    });
  });

  /*
    U6 — and the mirror image: someone who already has the extension attached
    is not shown how to install one. The install block, its numbered steps and
    the developer-mode warning that belongs to step 2 all belong to the
    not-connected state only.
  */
  it('shows install steps only while the extension is missing', async () => {
    mcpManagerMock.callTool.mockResolvedValue(EXTENSION_MISSING);
    const user = userEvent.setup();
    const { unmount } = render(<CapabilitiesSection />);

    await openDetail(user, 'My Chrome');
    expect(await screen.findByText('Install the extension')).toBeInTheDocument();
    expect(screen.getByText(/local extension rather than the Chrome Web Store/))
      .toBeInTheDocument();
    expect(screen.getByText(/read and interact with pages on all websites/))
      .toBeInTheDocument();

    unmount();
    setChromeExtensionHandshaked(false);
    mcpManagerMock.callTool.mockResolvedValue(EXTENSION_ATTACHED);
    const connectedUser = userEvent.setup();
    render(<CapabilitiesSection />);
    await openDetail(connectedUser, 'My Chrome');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Disconnect My Chrome' })).toBeInTheDocument();
    });
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.queryByText('Install the extension')).not.toBeInTheDocument();
    expect(screen.queryByText(/local extension rather than the Chrome Web Store/))
      .not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open install windows' }))
      .not.toBeInTheDocument();
    // The permission cards are what a connected user is here for.
    expect(screen.getByText('Action permissions')).toBeInTheDocument();
    expect(screen.getByText('Site permissions')).toBeInTheDocument();
  });

  /*
    U1 — every detail page is header line, then ONE status row, then cards.
    A working built-in browser has no state to report that its own title does
    not already carry and nothing to switch, so it renders no row at all —
    the badge/`Its own session` pair used to say what the line above it says.
  */
  it('drops the status row on a working built-in browser and keeps it on a broken one', async () => {
    const user = userEvent.setup();
    mcpManagerMock.connectedServers.add('abu-browser');
    render(<CapabilitiesSection />);
    await openBuiltinBrowser(user);

    expect(screen.getByRole('heading', { name: 'Abu built-in browser' })).toBeInTheDocument();
    expect(screen.queryByText('Ready')).not.toBeInTheDocument();
    expect(screen.queryByText('Its own session')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    // ...but nothing about the page's actual job went with it.
    expect(screen.getByText('Action permissions')).toBeInTheDocument();

    // A disconnected runtime is the opposite: the row is the only place the
    // fault and its retry can live.
    cleanup();
    mcpManagerMock.connectedServers.delete('abu-browser');
    const brokenUser = userEvent.setup();
    render(<CapabilitiesSection />);
    await openBuiltinBrowser(brokenUser);

    expect(screen.getByText('Setup required')).toBeInTheDocument();
    expect(screen.getByText(/built-in browser runtime is disconnected/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  /*
    U7 — Computer Use gets the same skeleton. "Off" is reported by the row like
    any other state instead of by a callout arguing the user into enabling it,
    and the row's single button is the one that changes that state. What
    enabling DOES is untouched: the same store action, from a button in a new
    place.
  */
  it('reports Computer Use on the same status row and enables through the same action', async () => {
    useSettingsStore.setState({ computerUseEnabled: false });
    const user = userEvent.setup();
    render(<CapabilitiesSection />);
    await openDetail(user, 'Computer Use');

    // Header line is the capability's one-liner, not the old setup paragraph.
    expect(screen.getByText('Reads the screen and operates the interface')).toBeInTheDocument();
    expect(screen.queryByText(/needs two separate system permissions/)).not.toBeInTheDocument();
    expect(screen.queryByText(/cannot enable Computer Use by itself/)).not.toBeInTheDocument();
    // ...and the long closing statement is gone with it.
    expect(screen.queryByText(/Sensitive apps and dangerous key combinations/))
      .not.toBeInTheDocument();

    expect(screen.getByText('Off')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Turn off Computer Use' }))
      .not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Enable' }));
    await waitFor(() => {
      expect(useSettingsStore.getState().computerUseEnabled).toBe(true);
    });

    // On: same row, opposite verb, and no second "Enable" left anywhere.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Turn off Computer Use' })).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: 'Enable' })).not.toBeInTheDocument();
    // The model card and the two permission rows are what the page is for.
    expect(screen.getByText('Current model')).toBeInTheDocument();
    expect(screen.getAllByText('View screen').length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: 'Turn off Computer Use' }));
    expect(useSettingsStore.getState().computerUseEnabled).toBe(false);
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

    expect(screen.getByRole('heading', { name: 'Computer Use' })).toBeInTheDocument();
    expect(screen.queryByText('Enable Computer Use')).not.toBeInTheDocument();
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
    await user.click(await screen.findByRole('button', { name: 'Return to task' }));

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

    expect(await screen.findByRole('heading', { name: 'My Chrome' })).toBeInTheDocument();
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

      const trigger = within(row as HTMLElement).getByRole('button', { name: 'Always allow' });
      await user.click(trigger);
      await user.click(openedOption(trigger, /^Blocked/));

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

      // Short enough to wrap inside the 208px menu rather than running past
      // two lines — the menu hugs its trigger now, so a long description is
      // the reader's problem instead of the layout's.
      expect(openedOptionDescriptions(trigger)).toEqual([
        'Stops asking on this site; payment pages still stop',
        'Abu never acts on this site, automatic tasks included',
      ]);
    });

    /*
      F1 — the list is an ENTRY point, not only a record of dialogs already
      answered. Before this, the only road to 「始终允许」 ran through the
      confirmation dialog, so preparing a scheduled task meant running it
      attended, being refused, clicking allow, and re-running.

      Everything below goes through the SAME store setter the rows use, so
      these tests are also what pins that the add row is not a second,
      differently-behaved writer.
    */
    describe('adding a site from the list', () => {
      // Earlier tests in this file leave verdicts behind; every assertion here
      // is about the exact contents of the map, so it starts empty.
      beforeEach(() => {
        useSettingsStore.setState({ browserSitePermissions: {} });
      });

      /** The verdict select of the ADD row — named for its job, so it never
       *  collides with a per-site row's select (which is named by its value). */
      const addVerdictSelect = () =>
        screen.getByRole('button', { name: /^Permission for the added site/ });

      /** Type an address, pick a verdict, press the button. */
      async function addSite(user: User, url: string, verdict?: RegExp) {
        await user.clear(screen.getByLabelText('Site address'));
        await user.type(screen.getByLabelText('Site address'), url);
        if (verdict) {
          await user.click(addVerdictSelect());
          await user.click(openedOption(addVerdictSelect(), verdict));
        }
        await user.click(screen.getByRole('button', { name: 'Add' }));
      }

      it('normalizes what was typed the way the gate resolves a live tab', async () => {
        const user = userEvent.setup();
        render(<CapabilitiesSection />);
        await openSitePermissions(user);

        // Path, query and fragment are not part of a verdict's identity...
        await addSite(user, 'https://example.com/reports?q=1#top');
        // ...nor is case, userinfo, a default port, or a FQDN trailing dot
        // (`evil.com.` and `evil.com` are one host over DNS, and storing them
        // as two keys is how one spelling slips past the other's verdict).
        await addSite(user, 'https://EVIL.com./login');
        await addSite(user, 'https://user:pass@third.example.com:443/');
        // A non-default port IS part of the identity, and http is a different
        // origin from https — neither is folded away.
        await addSite(user, 'http://example.com/');
        await addSite(user, 'https://example.com:8443/');

        expect(useSettingsStore.getState().browserSitePermissions).toEqual({
          'https://example.com': 'allowed',
          'https://evil.com': 'allowed',
          'https://third.example.com': 'allowed',
          'http://example.com': 'allowed',
          'https://example.com:8443': 'allowed',
        });
      });

      it('refuses anything that is not an http(s) address, and writes nothing', async () => {
        const user = userEvent.setup();
        render(<CapabilitiesSection />);
        await openSitePermissions(user);

        for (const bad of ['not a url', 'file:///etc/passwd', 'chrome://settings', 'about:blank']) {
          await addSite(user, bad);
          expect(
            screen.getByText('Enter a full web address, for example https://example.com'),
          ).toBeInTheDocument();
          expect(useSettingsStore.getState().browserSitePermissions).toEqual({});
        }

        // A bare hostname is the likely typo, and it is still a refusal rather
        // than a guess about which scheme the user meant.
        await addSite(user, 'example.com');
        expect(useSettingsStore.getState().browserSitePermissions).toEqual({});
      });

      it('updates an origin that is already listed instead of duplicating it', async () => {
        useSettingsStore.setState({
          browserSitePermissions: { 'https://example.com': 'allowed' },
        });
        const user = userEvent.setup();
        render(<CapabilitiesSection />);
        await openSitePermissions(user);

        // Same origin, spelled differently, with the other verdict.
        await addSite(user, 'https://example.com/some/page', /^Blocked/);

        expect(useSettingsStore.getState().browserSitePermissions).toEqual({
          'https://example.com': 'denied',
        });
        expect(screen.getAllByTitle('https://example.com')).toHaveLength(1);
      });

      /*
        The one refusal that is a SECURITY property rather than input
        validation: a standing "always allow" for a bank is the exact artifact
        `highRiskSites.ts` exists to prevent, and the confirmation dialog
        already withholds it there (`allowPersistentGrant: false`). Typing the
        address by hand must not be the way around that.
      */
      it('will not let a high-risk origin be added as always-allow', async () => {
        const user = userEvent.setup();
        render(<CapabilitiesSection />);
        await openSitePermissions(user);

        await addSite(user, 'https://www.paypal.com');

        expect(useSettingsStore.getState().browserSitePermissions).toEqual({});
        expect(screen.getByText(/cannot be set to Always allow/)).toBeInTheDocument();

        // BLOCKING one is still offered: this rule only ever tightens.
        await addSite(user, 'https://www.paypal.com', /^Blocked/);
        expect(useSettingsStore.getState().browserSitePermissions).toEqual({
          'https://www.paypal.com': 'denied',
        });
      });

      it('shows the new site in the list and in the card summary, and clears the field', async () => {
        const user = userEvent.setup();
        render(<CapabilitiesSection />);
        await openSitePermissions(user);

        // The empty state is what a first-time user actually meets, and it now
        // points at the row above it rather than only at the dialog.
        expect(screen.getByText(/Add one above/)).toBeInTheDocument();

        await addSite(user, 'https://reports.example.com');

        expect(screen.getByTitle('https://reports.example.com')).toBeInTheDocument();
        expect(screen.getByLabelText('Site address')).toHaveValue('');
        expect(screen.queryByText(/Add one above/)).toBeNull();

        // ...and the count on the card one level up, which is where a user
        // checks what a scheduled task can reach.
        await user.click(screen.getByRole('button', { name: 'Abu built-in browser' }));
        expect(screen.getByRole('button', { name: 'Site permissions' })).toHaveTextContent(
          '1 allowed · 0 blocked',
        );
      });

      it('submits on Enter, without reaching for the button', async () => {
        const user = userEvent.setup();
        render(<CapabilitiesSection />);
        await openSitePermissions(user);

        await user.type(screen.getByLabelText('Site address'), 'https://typed.example.com{Enter}');

        expect(useSettingsStore.getState().browserSitePermissions).toEqual({
          'https://typed.example.com': 'allowed',
        });
      });
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

  // The operation-class policy rows + the automatic-tasks master switch.
  // ONE dropdown per class since the 2026-09-04 ruling («不应该分在不在场，只要
  // 得到了用户允许，都能做»): the permission is one value, and the run mode only
  // decides how it is carried out.
  describe('browser operation policy', () => {
    beforeEach(() => {
      useSettingsStore.setState({
        browserOperationPolicy: DEFAULT_BROWSER_OPERATION_POLICY,
        allowUnattendedBrowser: false,
      });
    });

    it('renders one dropdown per class plus a separate scripting card, with the shipped defaults', async () => {
      const user = userEvent.setup();
      render(<CapabilitiesSection />);
      await openBuiltinBrowser(user);

      const grid = permissionCard('Action permissions');
      // The column headings are gone with the columns. 'Automatic tasks' still
      // names the master-switch card, so it is asserted absent from THIS card.
      expect(within(grid).queryByText('While you are here')).toBeNull();
      expect(within(grid).queryByText('Automatic tasks')).toBeNull();
      expect(within(grid).getByText('View pages')).toBeInTheDocument();
      expect(within(grid).getByText('Click and fill in')).toBeInTheDocument();
      expect(within(grid).queryByText('Run scripts (advanced)')).not.toBeInTheDocument();
      // One control per row, not two.
      expect(policyCells(grid)).toHaveLength(2);

      const scriptCard = permissionCard('Run scripts (advanced)');
      expect(scriptCard).not.toBe(grid);
      expect(scriptCard).toHaveTextContent('Lets Abu run code inside the page.');
      expect(policySelect(scriptCard)).toHaveTextContent('Ask every time');
    });

    /*
      The column that used to grey out with the master switch off is gone, and
      with it the reason to disable anything: the value the user picks here
      describes what Abu may do, and the switch decides separately whether an
      automatic run may act on it at all. Greying the control now would hide a
      setting that is still in force for the session the user is sitting in.
    */
    it('leaves every policy dropdown live while the master switch is off', async () => {
      const user = userEvent.setup();
      render(<CapabilitiesSection />);
      await openBuiltinBrowser(user);

      const readOnlyRow = within(permissionCard('Action permissions'))
        .getByText('View pages').closest('li') as HTMLElement;

      expect(policySelect(readOnlyRow)).not.toBeDisabled();
      expect(policySelect(permissionCard('Run scripts (advanced)'))).not.toBeDisabled();
    });

    it('writes a changed row to the store', async () => {
      const user = userEvent.setup();
      render(<CapabilitiesSection />);
      await openBuiltinBrowser(user);

      const interactiveRow = within(permissionCard('Action permissions'))
        .getByText('Click and fill in').closest('li') as HTMLElement;
      const cell = policySelect(interactiveRow);

      await user.click(cell);
      await user.click(openedOption(cell, /^Deny/));

      expect(useSettingsStore.getState().browserOperationPolicy.interactive).toBe('deny');
      // The neighbouring rows are untouched — the classes stay independent.
      expect(useSettingsStore.getState().browserOperationPolicy.readOnly).toBe('allow');
      expect(useSettingsStore.getState().browserOperationPolicy.scripting).toBe('ask');
    });

    /**
     * The zero-semantic-change pin. Pulling scripting out of the grid moved
     * the control to another card; it must still write `scripting` through the
     * same store action, with the same three-state vocabulary.
     */
    it('keeps the split-out scripting card wired to the same store setter', async () => {
      const user = userEvent.setup();
      render(<CapabilitiesSection />);
      await openBuiltinBrowser(user);

      const cell = policySelect(permissionCard('Run scripts (advanced)'));

      await user.click(cell);
      await user.click(openedOption(cell, /^Allow/));
      expect(useSettingsStore.getState().browserOperationPolicy.scripting).toBe('allow');

      await user.click(cell);
      await user.click(openedOption(cell, /^Ask every time/));
      expect(useSettingsStore.getState().browserOperationPolicy.scripting).toBe('ask');
      // And the rows it used to share a table with are untouched.
      expect(useSettingsStore.getState().browserOperationPolicy.readOnly).toBe('allow');
      expect(useSettingsStore.getState().browserOperationPolicy.interactive).toBe('allow');
    });

    /*
      One setting, two execution contexts — so each option says what it means
      in BOTH, on one line. Before the collapse there were two columns and two
      descriptions per state; what did not change is that the explanation
      travels with the choice instead of sitting in a paragraph above the
      control.

      «Ask every time» is the one that carries a real second fact: attended it
      is a dialog, and in an automatic task it is an IM approval at the channel
      the automation itself named (`core/im/approvalTarget.ts`), refused when
      none is bound. Promising only a dialog would promise something nobody is
      there to answer.

      «Allow» is the one that is NOT the same on every row (2026-09-05 F8).
      Reading a page under it really is unconditional; clicking and scripting
      are scoped to the sites carrying a standing 「始终允许」 verdict, and a
      site with no verdict still opens a confirmation. One shared 「不再询问」
      was true for exactly one of the three rows, so the wording now splits.
    */
    it('says what each state means in both execution contexts, and scopes 「允许」 per row', async () => {
      const user = userEvent.setup();
      render(<CapabilitiesSection />);
      await openBuiltinBrowser(user);

      const rows = ['View pages', 'Click and fill in'].map((label) => (
        within(permissionCard('Action permissions')).getByText(label).closest('li') as HTMLElement
      ));

      // Reading is the one row whose 「允许」 asks nothing, anywhere.
      const readOnlyCell = policySelect(rows[0]);
      await user.click(readOnlyCell);
      expect(openedOptionLabels(readOnlyCell)).toEqual(['Allow', 'Ask every time', 'Deny']);
      expect(openedOptionDescriptions(readOnlyCell)).toEqual([
        'Never asks again',
        'Asks you here, and over IM in automatic tasks',
        'Abu will not do this kind of thing',
      ]);
      await user.click(readOnlyCell);

      // The two rows that ACT say where their 「允许」 applies.
      for (const row of [rows[1], permissionCard('Run scripts (advanced)')]) {
        const cell = policySelect(row);
        await user.click(cell);
        expect(openedOptionLabels(cell)).toEqual(['Allow', 'Ask every time', 'Deny']);
        expect(openedOptionDescriptions(cell)).toEqual([
          'Never asks again on allowed sites',
          'Asks you here, and over IM in automatic tasks',
          'Abu will not do this kind of thing',
        ]);
        await user.click(cell);
      }

      // The two facts the merged sentence had to keep: it must not promise
      // only a dialog, and it must name the automatic-task channel.
      const cell = policySelect(rows[1]);
      await user.click(cell);
      const ask = openedOptionDescriptions(cell)[openedOptionLabels(cell).indexOf('Ask every time')];
      expect(ask).not.toMatch(/dialog/i);
      expect(ask).toMatch(/IM/);
      expect(ask).toMatch(/automatic tasks/);
      // ...and the withdrawn per-column strings are gone from the surface.
      expect(openedOptionDescriptions(cell)).not.toContain('Only on sites set to Always allow');
    });

    it('writes the scripting allow to the store and warns, once, directly under that select', async () => {
      // Shipped defaults, master switch included: since 2026-09-04 R1 the line
      // is about this row, not about the switch.
      const user = userEvent.setup();
      render(<CapabilitiesSection />);
      await openBuiltinBrowser(user);

      const scriptCard = permissionCard('Run scripts (advanced)');
      const cell = policySelect(scriptCard);
      // Nothing to warn about until the user chooses it.
      expect(within(scriptCard).queryByText(/Elevated risk/)).toBeNull();

      await user.click(cell);
      await user.click(openedOption(cell, /^Allow/));

      expect(useSettingsStore.getState().browserOperationPolicy.scripting).toBe('allow');
      const warning = within(scriptCard).getByText(/Elevated risk/);
      expect(warning.textContent).toMatch(/Always allow/);
      // ONE line — not a banner plus an ⓘ plus a dialog.
      expect(within(scriptCard).getAllByText(/Elevated risk/)).toHaveLength(1);
      // ...and it belongs to the scripting card, not to the rows above it.
      expect(within(permissionCard('Action permissions')).queryByText(/Elevated risk/)).toBeNull();

      // Choosing something else takes the warning away with it.
      await user.click(cell);
      await user.click(openedOption(cell, /^Deny/));
      expect(within(scriptCard).queryByText(/Elevated risk/)).toBeNull();
    });

    /*
      This line used to be gated on the automatic-tasks master switch (security
      review of 52e47a40): an ATTENDED script was asked about every time
      whatever this row said, so an 'allow' stored with the switch off was an
      intention rather than a live risk, and a warning that fires when nothing
      can happen is how a reader learns to ignore these lines.

      2026-09-04 R1 ended that premise — 「允许」 now really stops asking on
      「始终允许」 sites while the user is watching. The risk is live the moment
      the row reads allow, on either side of the switch, and the sentence has
      to describe BOTH execution contexts rather than scoping itself to
      automatic tasks.
    */
    it('shows the risk warning whenever the row says allow, master switch or not', async () => {
      useSettingsStore.setState({
        allowUnattendedBrowser: false,
        browserOperationPolicy: { ...DEFAULT_BROWSER_OPERATION_POLICY, scripting: 'allow' },
      });
      const user = userEvent.setup();
      render(<CapabilitiesSection />);
      await openBuiltinBrowser(user);

      const scriptCard = permissionCard('Run scripts (advanced)');
      // The value really is stored, and the control really is showing it...
      expect(policySelect(scriptCard)).toHaveTextContent('Allow');
      // ...and with the switch OFF the warning is there anyway, because an
      // attended script can now run unprompted on an always-allowed site.
      const warning = within(scriptCard).getByText(/Elevated risk/);
      expect(within(scriptCard).getAllByText(/Elevated risk/)).toHaveLength(1);
      // It names the scope that actually applies — and BOTH contexts it
      // applies in. Scoping the sentence to automatic tasks alone is what made
      // the old copy false for the person sitting in front of the app.
      expect(warning.textContent).toMatch(/Always allow/);
      expect(warning.textContent).toMatch(/here/);
      expect(warning.textContent).toMatch(/automatic tasks/i);

      // Turning the switch on changes nothing about this line.
      await user.click(within(permissionCard('Automatic tasks')).getByRole('switch'));

      expect(useSettingsStore.getState().allowUnattendedBrowser).toBe(true);
      expect(within(permissionCard('Run scripts (advanced)')).getAllByText(/Elevated risk/))
        .toHaveLength(1);
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

      // Origin-level, and the copy still says so: entering the site is not the
      // same as every page on it being reachable (M8).
      expect(screen.getByText(/may enter 1 site/)).toBeInTheDocument();
      // Shortened on a user ruling (2026-09-04: no long lines on this page).
      // The two facts that had to survive the trim are the COUNT and the
      // per-page refusal — dropping the latter would leave the line reading
      // like a blanket grant over every page of those sites.
      expect(screen.getByText(/payment \/ transfer pages are still refused/))
        .toBeInTheDocument();
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
      // Only the master-switch card is called 自动任务 now: the column headings
      // went with the columns, and 你在场时 has no surface left at all.
      expect(screen.getAllByText('自动任务').length).toBe(1);
      expect(screen.queryByText('你在场时')).toBeNull();
      expect(permissionCard('运行脚本（高级）')).toHaveTextContent('让阿布在页面里执行代码');
      expect(screen.queryByText(/登录失效/)).toBeNull();

      await user.click(screen.getByRole('button', { name: '返回能力' }));
      await openDetail(user, '我的 Chrome');
      expect(await screen.findByText(/登录失效/)).toBeInTheDocument();
    });
  });
});
