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

function findCapabilityCard(title: string): HTMLElement {
  const heading = screen.getByText(title);
  const card = heading.closest('div.rounded-lg.border');
  if (!card) throw new Error(`Capability card not found: ${title}`);
  return card as HTMLElement;
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

  it('keeps the built-in browser, My Chrome, and Computer Use states distinct', async () => {
    render(<CapabilitiesSection />);

    const builtinCard = findCapabilityCard('Abu built-in browser');
    const chromeCard = findCapabilityCard('My Chrome');
    const computerCard = findCapabilityCard('Computer Use');

    expect(within(builtinCard).getByText('Connection lost')).toBeInTheDocument();
    await waitFor(() => {
      expect(within(chromeCard).getByText('Ready')).toBeInTheDocument();
      expect(within(computerCard).getByText('Permission required')).toBeInTheDocument();
    });
    expect(within(computerCard).getByText('View screen')).toBeInTheDocument();
    expect(within(computerCard).getByText('Allowed')).toBeInTheDocument();
    expect(within(computerCard).getByText('Control interface')).toBeInTheDocument();
    expect(within(computerCard).getByText('Not allowed')).toBeInTheDocument();
  });

  it('shows DeepSeek without vision as structured mode instead of unavailable', async () => {
    const provider = makeModelProvider({});
    useSettingsStore.setState({
      providers: [provider],
      activeModel: { providerId: provider.id, modelId: 'deepseek-chat' },
    });

    render(<CapabilitiesSection />);
    const computerCard = findCapabilityCard('Computer Use');

    expect(within(computerCard).getByText(/deepseek-chat · Structured mode/)).toBeInTheDocument();
    expect(within(computerCard).getByText(/No image input/)).toBeInTheDocument();
    await waitFor(() => {
      expect(within(computerCard).getByText('Permission required')).toBeInTheDocument();
    });
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

    render(<CapabilitiesSection />);
    const computerCard = findCapabilityCard('Computer Use');

    expect(within(computerCard).getByText(/private-proxy-model · Not verified/)).toBeInTheDocument();
    await waitFor(() => {
      expect(within(computerCard).getByText('Setup required')).toBeInTheDocument();
    });
    expect(computerCard).toHaveTextContent('Confirm its model capabilities');
  });

  it('guides the local Chrome extension setup without exposing MCP configuration', async () => {
    mcpManagerMock.callTool.mockResolvedValue(
      'Browser extension is not connected. Please install and enable the Abu Browser Extension.',
    );
    const user = userEvent.setup();
    render(<CapabilitiesSection />);

    const chromeCard = findCapabilityCard('My Chrome');
    await user.click(within(chromeCard).getByRole('button', { name: /Connect Chrome|Manage/ }));

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
      expect(within(chromeCard).getByText('Not connected · Optional')).toBeInTheDocument();
    });
    expect(chromeCard).toHaveTextContent(
      'The Chrome extension is not connected. Select Connect Chrome to continue setup.',
    );
  });

  it('lets the user disconnect My Chrome without entering MCP settings', async () => {
    const user = userEvent.setup();
    render(<CapabilitiesSection />);

    const chromeCard = findCapabilityCard('My Chrome');
    await waitFor(() => {
      expect(within(chromeCard).getByText('Ready')).toBeInTheDocument();
    });
    await user.click(within(chromeCard).getByRole('button', { name: 'Manage' }));
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

    const chromeCard = findCapabilityCard('My Chrome');
    await user.click(within(chromeCard).getByRole('button', { name: 'Connect Chrome' }));

    expect(await screen.findByRole('button', { name: 'Disconnect My Chrome' }))
      .toBeInTheDocument();
  });

  it('refreshes built-in browser status when the existing MCP runtime connects', async () => {
    render(<CapabilitiesSection />);

    const builtinCard = findCapabilityCard('Abu built-in browser');
    expect(within(builtinCard).getByText('Connection lost')).toBeInTheDocument();

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
    expect(within(chromeCard).queryByText('Connection lost')).not.toBeInTheDocument();
  });

  it('enables Computer Use through guided setup while keeping partial permission visible', async () => {
    useSettingsStore.setState({ computerUseEnabled: false });
    const user = userEvent.setup();
    render(<CapabilitiesSection />);

    await user.click(await screen.findByRole('button', { name: 'Start setup' }));

    expect(screen.getByText('Enable Computer Use')).toBeInTheDocument();
    expect(useSettingsStore.getState().computerUseEnabled).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Enable' }));

    await waitFor(() => {
      expect(useSettingsStore.getState().computerUseEnabled).toBe(true);
    });
    expect(screen.getByText('View screen')).toBeInTheDocument();
    expect(screen.getAllByText('Control interface')).toHaveLength(2);
    expect(screen.getByText('Step 2 of 2')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back to Capabilities' }));
    expect(findCapabilityCard('Computer Use')).toHaveTextContent('Permission required');
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
    const computerCard = findCapabilityCard('Computer Use');
    await user.click(await within(computerCard).findByRole('button', { name: 'Manage' }));
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
    expect(screen.queryByText('View screen')).not.toBeInTheDocument();
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
    expect(within(builtinCard).getByText('Unavailable')).toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: 'Start setup' }));
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

      const row = screen.getByTitle('https://allowed.example.com').closest('li');
      expect(row).not.toBeNull();
      expect(within(row as HTMLElement).getByRole('button', { name: 'Always allow' }))
        .toBeInTheDocument();
      expect(screen.getByTitle('https://blocked.example.com')).toBeInTheDocument();

      await user.click(within(row as HTMLElement).getByRole('button', { name: 'Always allow' }));
      await user.click(within(row as HTMLElement).getByRole('button', { name: 'Blocked' }));

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

      const row = screen.getByTitle('https://example.com').closest('li');
      await user.click(within(row as HTMLElement).getByRole('button', { name: 'Remove' }));

      expect(useSettingsStore.getState().browserSitePermissions).toEqual({});
    });
  });

  // The operation-class policy grid + its master switch. The switch overrides
  // the unattended column entirely, so the column must not offer live controls
  // while it is off.
  describe('browser operation policy', () => {
    beforeEach(() => {
      useSettingsStore.setState({
        browserOperationPolicy: DEFAULT_BROWSER_OPERATION_POLICY,
        allowUnattendedBrowser: false,
      });
    });

    it('renders three operation classes for both run modes, with the shipped defaults', () => {
      render(<CapabilitiesSection />);

      const grid = screen.getByText('Browser operation permissions').closest('div.rounded-lg.border') as HTMLElement;
      expect(within(grid).getByText('Attended')).toBeInTheDocument();
      expect(within(grid).getByText('Unattended')).toBeInTheDocument();
      for (const label of [
        'Read-only (viewing page content)',
        'Interaction & navigation (click/fill/navigate)',
        'Scripting (running code on the page)',
      ]) {
        expect(within(grid).getByText(label)).toBeInTheDocument();
      }
      const scriptingRow = within(grid).getByText('Scripting (running code on the page)').closest('li') as HTMLElement;
      // attended = ask, unattended = deny (the product default table)
      expect(within(scriptingRow).getByText('Ask every time')).toBeInTheDocument();
      expect(within(scriptingRow).getByText('Deny')).toBeInTheDocument();
    });

    it('disables the unattended column while the master switch is off', () => {
      render(<CapabilitiesSection />);

      const grid = screen.getByText('Browser operation permissions').closest('div.rounded-lg.border') as HTMLElement;
      const readOnlyRow = within(grid).getByText('Read-only (viewing page content)').closest('li') as HTMLElement;
      const [attendedCell, unattendedCell] = within(readOnlyRow).getAllByRole('button');

      expect(attendedCell).not.toBeDisabled();
      expect(unattendedCell).toBeDisabled();
    });

    it('writes a changed cell to the store', async () => {
      useSettingsStore.setState({ allowUnattendedBrowser: true });
      const user = userEvent.setup();
      render(<CapabilitiesSection />);

      const grid = screen.getByText('Browser operation permissions').closest('div.rounded-lg.border') as HTMLElement;
      const interactiveRow = within(grid).getByText('Interaction & navigation (click/fill/navigate)').closest('li') as HTMLElement;
      const [, unattendedCell] = within(interactiveRow).getAllByRole('button');

      await user.click(unattendedCell);
      await user.click(within(interactiveRow).getByRole('button', { name: 'Deny' }));

      expect(useSettingsStore.getState().browserOperationPolicy.unattended.interactive).toBe('deny');
      // The other column is untouched — the two run modes are independent.
      expect(useSettingsStore.getState().browserOperationPolicy.attended.interactive).toBe('allow');
    });

    // The unattended scripting cell has no "allow": a site grant minted from a
    // human approving a click must never buy silent page scripting.
    it('offers only ask/deny for unattended scripting, all three elsewhere', async () => {
      useSettingsStore.setState({ allowUnattendedBrowser: true });
      const user = userEvent.setup();
      render(<CapabilitiesSection />);

      const grid = screen.getByText('Browser operation permissions').closest('div.rounded-lg.border') as HTMLElement;
      const scriptingRow = within(grid).getByText('Scripting (running code on the page)').closest('li') as HTMLElement;
      const [attendedCell, unattendedCell] = within(scriptingRow).getAllByRole('button');

      // Read the OPEN dropdown, not the row: a closed trigger also renders its
      // current value as button text and would match by name.
      const openedOptions = (trigger: HTMLElement) => {
        const dropdown = document.getElementById(trigger.getAttribute('aria-controls') ?? '');
        if (!dropdown) throw new Error('dropdown not open');
        return within(dropdown).getAllByRole('button').map((b) => b.textContent);
      };

      await user.click(unattendedCell);
      expect(openedOptions(unattendedCell)).toEqual(['Ask every time', 'Deny']);

      // The attended half of the same row still offers all three.
      await user.keyboard('{Escape}');
      await user.click(attendedCell);
      expect(openedOptions(attendedCell)).toEqual(['Allow', 'Ask every time', 'Deny']);
    });

    it('toggles the unattended master switch', async () => {
      const user = userEvent.setup();
      render(<CapabilitiesSection />);

      const grid = screen.getByText('Browser operation permissions').closest('div.rounded-lg.border') as HTMLElement;
      await user.click(within(grid).getByRole('switch'));

      expect(useSettingsStore.getState().allowUnattendedBrowser).toBe(true);
    });
  });

  /**
   * U5 authorization visibility. "Allowed" is also what a run with nobody
   * watching acts on, and this list never said so — the user had to hold the
   * master switch, the site verdicts and the high-risk rule in their head to
   * answer "which sites would my nightly task touch?".
   */
  describe('unattended reach of the site list', () => {
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

    function siteList(): HTMLElement {
      return screen.getByText('Authorized sites').closest('div.rounded-lg.border') as HTMLElement;
    }

    it('marks an allowed ordinary site as reachable unattended, and says how many', () => {
      withSites({ 'https://reports.example.com': 'allowed' }, true);
      render(<CapabilitiesSection />);

      const list = siteList();
      expect(within(list).getByText('Unattended: site allowed')).toBeInTheDocument();
      // Origin-level, and the copy says so: entering the site is not the
      // same as every page on it being reachable (M8).
      expect(within(list).getByText(/may enter 1 site/)).toBeInTheDocument();
      expect(within(list).getByText(/each page is still judged on its own/)).toBeInTheDocument();
    });

    it('says the same site is attended-only while the master switch is off', () => {
      withSites({ 'https://reports.example.com': 'allowed' }, false);
      render(<CapabilitiesSection />);

      const list = siteList();
      expect(within(list).getByText('Only while you are here')).toBeInTheDocument();
      expect(within(list).getByText(/master switch is off/)).toBeInTheDocument();
    });

    it('flags an allowed site that is high-risk anyway, and leaves it out of the count', () => {
      withSites({ 'https://www.paypal.com': 'allowed' }, true);
      render(<CapabilitiesSection />);

      const list = siteList();
      expect(within(list).getByText('High-risk · asks every time')).toBeInTheDocument();
      expect(within(list).getByText(/cannot act on any site right now/)).toBeInTheDocument();
    });

    it('puts no reach tag on a blocked site', () => {
      withSites({ 'https://blocked.example.com': 'denied' }, true);
      render(<CapabilitiesSection />);

      const list = siteList();
      expect(within(list).queryByText('Unattended: site allowed')).not.toBeInTheDocument();
      expect(within(list).queryByText('Only while you are here')).not.toBeInTheDocument();
    });
  });
});
