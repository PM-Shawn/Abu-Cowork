import { createBrowserPermissionConfig } from '@/core/permissions/browserPermissionConfig';
// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CapabilitiesSection from './CapabilitiesSection';
import { initLanguage } from '@/i18n';
import { useSettingsStore } from '@/stores/settingsStore';
import { useScheduleStore } from '@/stores/scheduleStore';
import { useTriggerStore } from '@/stores/triggerStore';
import { useIMChannelStore } from '@/stores/imChannelStore';
import { useMCPStore } from '@/stores/mcpStore';
import { useDiscoveryStore } from '@/stores/discoveryStore';
import type { SkillMetadata } from '@/types';
import type { ProviderInstance } from '@/types/provider';
import {
  __resetBrowserGrantsForTests,
} from '@/core/permissions/browserToolPolicy';
import {
  hasChromeExtensionHandshaked,
  setChromeExtensionHandshaked,
} from '@/core/capabilityPlugins/chromeHandshakeLatch';

const installationMock = vi.hoisted(() => vi.fn());
vi.mock('@/core/capabilityPlugins/chromeSetup', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/core/capabilityPlugins/chromeSetup')>(),
  getChromeExtensionInstallation: installationMock,
}));
beforeEach(() => installationMock.mockReset().mockResolvedValue('installed'));

const restartAppMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@/core/updates/checker', () => ({
 restartApp: restartAppMock }));

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
    useSettingsStore.setState({ browserPermissionConfigV2: createBrowserPermissionConfig() });
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
      activeExtensionsTab: 'skills',
      // `setState` MERGES, so a case that marks a grant would otherwise leave
      // the mark standing for every case after it.
      browserSiteGrantViaEmbed: {},
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
    // The automation stores are module-level state shared across this file, so
    // a task arranged for the S11 card would otherwise still be there for the
    // next test's counts.
    useScheduleStore.setState({ tasks: {}, showEditor: false, editingTaskId: null } as never);
    useTriggerStore.setState({ triggers: {}, showEditor: false, editingTriggerId: null } as never);
    useIMChannelStore.setState({ channels: {} } as never);
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
      expect(within(chromeCard).getByText('Installed')).toBeInTheDocument();
      expect(within(computerCard).getByText('Setup required')).toBeInTheDocument();
    });
    // Ready channels show their standing one-liner, not a status sentence.
    expect(chromeCard).toHaveTextContent('Reuses the Chrome tabs you are already signed in to');

    // Permission detail belongs to the detail page, not the overview.
    expect(screen.queryByText('View screen')).not.toBeInTheDocument();
    expect(screen.queryByText('Browser permissions')).not.toBeInTheDocument();
    expect(screen.queryByText('Site permissions')).not.toBeInTheDocument();
  });

  // The three badge tones, on the same page, at the same time.
  it('reports exactly three outcome badges across the three cards', async () => {
    useSettingsStore.setState({ computerUseEnabled: false });
    render(<CapabilitiesSection />);

    await waitFor(() => {
      expect(within(findCapabilityCard('My Chrome')).getByText('Installed')).toBeInTheDocument();
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
    expect(screen.getByText('Browser permissions')).toBeInTheDocument();
  });

  // The badge is the reason the row exists. A screen reader that hears only
  // "My Chrome" learns nothing the surrounding page did not already say.
  it('names each card by its capability AND its current status', async () => {
    useSettingsStore.setState({ computerUseEnabled: false });
    mcpManagerMock.callTool.mockResolvedValue(EXTENSION_MISSING);
    render(<CapabilitiesSection />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'My Chrome · Installed' }))
        .toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Abu built-in browser · Setup required' }))
      .toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Computer Use · Off' })).toBeInTheDocument();
  });

  it('walks into the site list and back out through the breadcrumb', async () => {
    useSettingsStore.setState({
      browserPermissionConfigV2: { ...createBrowserPermissionConfig(), sites: { 'https://example.com': { blocked: false, browse: 'allow', upload: 'inherit', script: 'inherit' } } },
    });
    const user = userEvent.setup();
    render(<CapabilitiesSection />);

    await openSitePermissions(user);
    expect(screen.getByTitle('https://example.com')).toBeInTheDocument();

    // One step up: back to the built-in browser page, not all the way out.
    await user.click(screen.getByRole('button', { name: 'Abu built-in browser' }));
    expect(screen.getByText('Browser permissions')).toBeInTheDocument();
    expect(screen.queryByTitle('https://example.com')).not.toBeInTheDocument();

    // Root segment: back to the overview.
    await user.click(screen.getByRole('button', { name: 'Back to Capabilities' }));
    expect(findCapabilityCard('My Chrome')).toBeInTheDocument();
    expect(screen.queryByText('Browser permissions')).not.toBeInTheDocument();
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

  it('guides installation without enabling the bridge just by viewing settings', async () => {
 installationMock.mockResolvedValue('not-installed');
 const user=userEvent.setup(); render(<CapabilitiesSection />); await openDetail(user, 'My Chrome');
 expect(await screen.findByText('Extension not installed')).toBeInTheDocument();
 expect(ensureMCPServerMock).not.toHaveBeenCalled();
 await user.click(screen.getByRole('button', {name:'Install extension'}));
 expect(screen.getByText('Install the Abu extension in Chrome to connect for the first time.')).toBeVisible();
 expect(resolveMCPCompanionResourceMock).toHaveBeenCalledWith('abu-browser-bridge');
 expect(screen.queryByText(/MCP configuration/)).toBeNull();
});

  it.each([
    ['not-installed', 'Extension not installed'],
    ['unknown', 'Unable to verify installation'],
  ] as const)('shows %s metadata even with a live bridge', async (installation, label) => {
    installationMock.mockResolvedValue(installation);
    render(<CapabilitiesSection />);
    await waitFor(() => expect(within(findCapabilityCard('My Chrome')).getByText(label)).toBeVisible());
    expect(within(findCapabilityCard('My Chrome')).queryByText('Installed')).toBeNull();
  });

  it('keeps Skill and MCP implementation concepts out of the capability overview', () => {
    render(<CapabilitiesSection />);

    expect(screen.queryByText('1 skill(s) enabled')).not.toBeInTheDocument();
    expect(screen.queryByText(/connector\(s\)/)).not.toBeInTheDocument();
  });

  it('keeps installation visible when the extension is not connected', async () => {
    mcpManagerMock.callTool.mockResolvedValue(
      'Browser extension is not connected. Please install and enable the Abu Browser Extension.',
    );
    render(<CapabilitiesSection />);

    const chromeCard = findCapabilityCard('My Chrome');
    await waitFor(() => {
      expect(within(chromeCard).getByText('Installed')).toBeInTheDocument();
    });
    // Never connected is not a fault, so the card's one line is spent on what
    // connecting would buy rather than on restating the badge beside it.
    expect(chromeCard).toHaveTextContent('Reuses the Chrome tabs you are already signed in to');
  });

  it.each(['disconnected', 'error'] as const)(
    'keeps an installed extension installed while the bridge is %s',
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
        expect(within(chromeCard).getByText('Installed')).toBeInTheDocument();
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

  it('does not replace installation metadata with a missing-connection probe', async () => {
    mcpManagerMock.callTool.mockResolvedValue(
      'Browser extension is not connected. Please install and enable the Abu Browser Extension.',
    );
    render(<CapabilitiesSection />);

    const chromeCard = findCapabilityCard('My Chrome');
    await waitFor(() => {
      expect(within(chromeCard).getByText('Installed')).toBeInTheDocument();
    });
    // Give every pending probe a chance to land and contradict it.
    await waitFor(() => {
      expect(within(chromeCard).getByText('Installed')).toBeInTheDocument();
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

    render(<CapabilitiesSection />);
    await waitFor(() => {
      expect(mcpManagerMock.callTool).toHaveBeenCalledTimes(1);
    });

    // A new runtime snapshot starts a newer probe while the old one is pending.
    useMCPStore.setState(state => ({ servers: { ...state.servers, 'abu-browser-bridge': { ...state.servers['abu-browser-bridge'] } } }));
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
      expect(within(findCapabilityCard('My Chrome')).getByText('Installed')).toBeInTheDocument();
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

      // Chrome can close between visits without uninstalling the extension.
      mcpManagerMock.callTool.mockResolvedValue(EXTENSION_MISSING);
      render(<CapabilitiesSection />);
      const chromeCard = findCapabilityCard('My Chrome');
      await waitFor(() => {
        expect(within(chromeCard).getByText('Installed')).toBeInTheDocument();
      });
      expect(within(chromeCard).queryByText('Not connected')).not.toBeInTheDocument();
    });

    it('keeps handshake history separate from installation settings', async () => {
 expect(hasChromeExtensionHandshaked()).toBe(false);
 const user=userEvent.setup();render(<CapabilitiesSection />);
 await waitFor(()=>expect(hasChromeExtensionHandshaked()).toBe(true));
 await openDetail(user,'My Chrome');
 expect(await screen.findByText('Installed')).toBeVisible();
 expect(screen.queryByRole('button',{name:'Disconnect My Chrome'})).toBeNull();
 expect(mcpManagerMock.disconnectServer).not.toHaveBeenCalled();
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
    expect(await screen.findByRole('button', { name: 'Connect Chrome' })).toBeInTheDocument();
  });

  it('does not change bridge enablement when opening installation settings', async () => {
 const user=userEvent.setup(); render(<CapabilitiesSection />); await openDetail(user,'My Chrome');
 expect(await screen.findByText('Installed')).toBeVisible();
 expect(useMCPStore.getState().servers['abu-browser-bridge'].config.enabled).toBe(true);
 expect(mcpManagerMock.disconnectServer).not.toHaveBeenCalled();
 expect(screen.queryByRole('button',{name:'Disconnect My Chrome'})).toBeNull();
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
    it('offers installation when metadata confirms no extension regardless of handshake', async () => {
 installationMock.mockResolvedValue('not-installed');mcpManagerMock.callTool.mockResolvedValue(EXTENSION_MISSING);
 const user=userEvent.setup();render(<CapabilitiesSection />);await openDetail(user,'My Chrome');
 expect(await screen.findByText('Extension not installed')).toBeVisible();
 expect(screen.getByRole('button',{name:'Install extension'})).toBeVisible();
 expect(screen.queryByRole('button',{name:'Disconnect My Chrome'})).toBeNull();
});

    it('keeps installed status after Chrome stops answering', async () => {
 setChromeExtensionHandshaked(true);mcpManagerMock.callTool.mockResolvedValue(EXTENSION_MISSING);
 const user=userEvent.setup();render(<CapabilitiesSection />);await openDetail(user,'My Chrome');
 expect(await screen.findByText('Installed')).toBeVisible();
 expect(screen.queryByText('Setup required')).toBeNull();
 expect(screen.queryByRole('button',{name:'Check connection'})).toBeNull();
 expect(mcpManagerMock.disconnectServer).not.toHaveBeenCalled();
});
  });

  /*
    U6 — and the mirror image: someone who already has the extension attached
    is not shown how to install one. The install block, its numbered steps and
    the developer-mode warning that belongs to step 2 all belong to the
    not-connected state only.
  */
  it('collapses installation help for an installed extension even without a live connection', async () => {
 mcpManagerMock.callTool.mockResolvedValue(EXTENSION_MISSING);
 const user=userEvent.setup();render(<CapabilitiesSection />);await openDetail(user,'My Chrome');
 expect(await screen.findByText('Installed')).toBeVisible();
 expect(screen.queryByText(/Load unpacked/)).toBeNull();
 await user.click(screen.getByRole('button',{name:'Installation help'}));
 expect(screen.getByText(/Load unpacked/)).toBeVisible();
 expect(screen.queryByText('Browser permissions')).toBeNull();expect(screen.queryByText('Site permissions')).toBeNull();
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
    expect(screen.getByText('Browser permissions')).toBeInTheDocument();

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
  it('reports Computer Use on the labelled header switch', async () => {
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

    expect(screen.getByRole('switch', { name: 'Enable Computer Use' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByRole('switch', { name: 'Turn off Computer Use' }))
      .not.toBeInTheDocument();

    await user.click(screen.getByRole('switch', { name: 'Enable Computer Use' }));
    await waitFor(() => {
      expect(useSettingsStore.getState().computerUseEnabled).toBe(true);
    });

    // On: same switch, opposite accessible action.
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Turn off Computer Use' })).toBeInTheDocument();
    });
    expect(screen.queryByRole('switch', { name: 'Enable Computer Use' })).not.toBeInTheDocument();
    // The model card and the two permission rows are what the page is for.
    expect(screen.getByText('Current model')).toBeInTheDocument();
    expect(screen.getAllByText('View screen').length).toBeGreaterThan(0);

    await user.click(screen.getByRole('switch', { name: 'Turn off Computer Use' }));
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
    expect(screen.queryByRole('heading', { name: 'Enable Computer Use' })).not.toBeInTheDocument();
    expect(useSettingsStore.getState().computerUseEnabled).toBe(false);

    await user.click(screen.getByRole('switch', { name: 'Enable Computer Use' }));

    await waitFor(() => {
      expect(useSettingsStore.getState().computerUseEnabled).toBe(true);
    });
    // The setup rows, the guided step, and the model card each name the two
    // permissions, so count is not the assertion — presence is.
    expect(screen.getAllByText('View screen').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Control interface').length).toBeGreaterThan(0);
    expect(screen.getByText('1/2 completed')).toBeInTheDocument();

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
    await user.click(screen.getByRole('switch', { name: 'Turn off Computer Use' }));

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

    await user.click(screen.getByRole('switch', { name: 'Enable Computer Use' }));
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
    await user.click(screen.getByRole('switch', { name: 'Enable Computer Use' }));
    await user.click(await screen.findByRole('button', { name: 'Return to task' }));

    expect(useSettingsStore.getState().systemSettingsOpen).toBe(false);
    expect(useSettingsStore.getState().capabilitySetupTarget).toBeNull();
  });

  it('requests the selected native permission and waits for explicit task continuation', async () => {
    useSettingsStore.setState({ capabilitySetupTarget: 'computer', computerUseEnabled: true, systemSettingsOpen: true });
    let controlGranted = false;
    invoke.mockImplementation((command: string) => {
      if (command === 'request_accessibility') { controlGranted = true; return Promise.resolve(true); }
      if (command === 'check_macos_permissions') return Promise.resolve({ screen_recording: true, accessibility: controlGranted });
      return Promise.resolve(undefined);
    });
    const user = userEvent.setup();
    render(<CapabilitiesSection />);
    await user.click(await screen.findByRole('button', { name: 'Grant access' }));
    await screen.findByRole('button', { name: 'Return to task' });
    expect(invoke).toHaveBeenCalledWith('request_accessibility');
    expect(invoke.mock.calls.some(([command]) => command === 'computer_use_permission_guide_show')).toBe(false);
    expect(useSettingsStore.getState().systemSettingsOpen).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Return to task' }));
    expect(useSettingsStore.getState().systemSettingsOpen).toBe(false);
  });

  it('keeps the ordinary detail open when disabled and exposes restart when required', async () => {
    useSettingsStore.setState({ computerUseEnabled: true });
    invoke.mockImplementation((command: string) => command === 'check_macos_permissions'
      ? Promise.resolve({ screen_recording: false, accessibility: true, restart_required: true })
      : Promise.resolve(undefined));
    const user = userEvent.setup();
    render(<CapabilitiesSection />);
    await openDetail(user, 'Computer Use');
    await user.click(await screen.findByRole('button', { name: 'Restart Abu' }));
    expect(restartAppMock).toHaveBeenCalled();
    await user.click(screen.getByRole('switch', { name: 'Turn off Computer Use' }));
    expect(screen.getByRole('heading', { name: 'Computer Use' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Enable Computer Use' })).toHaveAttribute('aria-checked', 'false');
  });

  it('cancels the waiting task when Computer Use is explicitly disabled in its dialog', async () => {
    useSettingsStore.setState({ computerUseEnabled: true });
    const onSetupCancel = vi.fn();
    const user = userEvent.setup();
    render(<CapabilitiesSection setupTarget="computer" requestedByTask setupOnly onSetupCancel={onSetupCancel} />);
    await user.click(screen.getByRole('switch', { name: 'Turn off Computer Use' }));
    expect(onSetupCancel).toHaveBeenCalledOnce();
    expect(useSettingsStore.getState().computerUseEnabled).toBe(false);
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
    // Both the permission card and the model summary omit duplicate permissions.
    expect(screen.queryAllByText('View screen')).toHaveLength(0);
    expect(screen.getByText('0/1 completed')).toBeInTheDocument();
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

    expect(await screen.findByText('0/2 completed')).toBeInTheDocument();
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
    expect(screen.getByText('0/2 completed')).toBeInTheDocument();

    resolveBackgroundCheck({
      screen_recording: true,
      accessibility: false,
    });
    expect(await screen.findByText('1/2 completed')).toBeInTheDocument();
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
    expect(await screen.findByText('Installed')).toBeVisible();
    expect(ensureMCPServerMock).not.toHaveBeenCalled();
    expect(useMCPStore.getState().servers['abu-browser-bridge'].config.enabled).toBe(false);
    expect(useSettingsStore.getState().capabilitySetupTarget).toBeNull();
    expect(screen.queryByText(/Load unpacked/)).toBeNull();

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
    await user.click(screen.getByRole('switch', { name: 'Enable Computer Use' }));
    await waitFor(() => {
      expect(useSettingsStore.getState().computerUseEnabled).toBe(true);
    });
    expect(invoke).toHaveBeenCalledWith('check_macos_permissions');
  });

  // Settings is the one place where every standing site verdict has to be
  // visible AND changeable: the dialog can only write a verdict for the site
  // it is currently asking about, so tightening a site the user already
  // allowed is otherwise impossible without wiping it and waiting to be asked.
  // Permission editing moved to the V2 component suite. The removed blocks
  // exercised deleted product surfaces: master switch, preview and task census.

  describe('zh-CN', () => {
    it('renders the overview and both browser detail pages in Chinese', async () => {
      initLanguage('zh-CN');
      const user = userEvent.setup();
      render(<CapabilitiesSection />);

      expect(findCapabilityCard('阿布内置浏览器')).toHaveTextContent('需要设置');
      await waitFor(() => {
        expect(within(findCapabilityCard('我的 Chrome')).getByText('已安装')).toBeInTheDocument();
      });

      await openDetail(user, '阿布内置浏览器');
      expect(screen.getByText('浏览器权限')).toBeInTheDocument();
      expect(screen.getByText('浏览网页')).toBeInTheDocument();
      expect(screen.getByText('上传文件')).toBeInTheDocument();
      expect(screen.queryByText('自动任务')).toBeNull();
      expect(screen.queryByText('你在场时')).toBeNull();
      expect(screen.getByRole('button', { name: /^运行脚本:/ })).toBeInTheDocument();
      expect(screen.getByText('在网页中执行代码。')).toBeInTheDocument();
      expect(screen.queryByText(/登录失效/)).toBeNull();

      await user.click(screen.getByRole('button', { name: '返回能力' }));
      await openDetail(user, '我的 Chrome');
      expect(await screen.findByText('已安装')).toBeInTheDocument();
      expect(screen.queryByText('浏览器权限')).toBeNull();
    });
  });
});
