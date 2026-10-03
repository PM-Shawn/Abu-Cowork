// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Dialog } from '@/components/ds/dialog';
import { DesignSystemProvider } from '@/components/ds/provider';
import SandboxSection from './SandboxSection';
import { useSettingsStore } from '@/stores/settingsStore';
import { authorizeWorkspace, getAuthorizedWritablePaths } from '@/core/tools/pathSafety';
import { initLanguage, getI18n } from '@/i18n';
import type { PermissionMode } from '@/core/permissions/permissionMode';

// Platform is the axis under test: the OS-level sandbox UI must render on
// BOTH macOS and Windows (electron/commandHost.cjs sandboxes on both), and
// fall back to the unsupported-platform banner only elsewhere.
const platformState = { current: 'macos' };
vi.mock('@/utils/platform', () => ({
  isMacOS: () => platformState.current === 'macos',
  isWindows: () => platformState.current === 'windows',
}));

const mocks = vi.hoisted(() => ({
  syncNetworkWhitelist: vi.fn(),
  revokeWorkspace: vi.fn(),
}));

vi.mock('@/core/sandbox/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/sandbox/config')>()),
  syncNetworkWhitelist: mocks.syncNetworkWhitelist,
}));

// The real revoke runs; the mock only records the call.
vi.mock('@/core/tools/pathSafety', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/core/tools/pathSafety')>();
  mocks.revokeWorkspace.mockImplementation(actual.revokeWorkspace);
  return { ...actual, revokeWorkspace: mocks.revokeWorkspace };
});

const t = () => getI18n();

function renderSection() {
  return render(<SandboxSection />, { wrapper: DesignSystemProvider });
}

describe('SandboxSection platform gating', () => {
  beforeEach(() => {
    initLanguage('en-US');
    useSettingsStore.setState({
      sandboxEnabled: true,
      networkIsolationEnabled: true,
      networkWhitelist: [],
      allowPrivateNetworks: false,
    });
  });

  afterEach(cleanup);

  describe('macOS', () => {
    beforeEach(() => { platformState.current = 'macos'; });

    it('renders the sandbox toggle with macOS copy, no unsupported banner', () => {
      renderSection();
      expect(screen.getByText(t().settings.sandboxProtection)).toBeInTheDocument();
      expect(screen.getByText(t().settings.sandboxProtectionDescription)).toBeInTheDocument();
      expect(screen.queryByText(t().settings.sandboxMacOSOnly)).not.toBeInTheDocument();
      // App-layer notice is a Windows affordance (there it IS the path
      // defense); macOS keeps its Seatbelt-focused layout without it.
      expect(screen.queryByText(t().settings.sandboxAppLayerProtection)).not.toBeInTheDocument();
    });

    it('shows the macOS disable warning when toggling off', async () => {
      const user = userEvent.setup();
      renderSection();
      await user.click(screen.getByText(t().settings.sandboxProtection));
      expect(screen.getByText(t().settings.sandboxDisableWarning)).toBeInTheDocument();
    });
  });

  describe('Windows', () => {
    beforeEach(() => { platformState.current = 'windows'; });

    it('renders the sandbox toggle (no unsupported banner) with Windows copy', () => {
      renderSection();
      expect(screen.getByText(t().settings.sandboxProtection)).toBeInTheDocument();
      expect(screen.getByText(t().settings.sandboxProtectionDescriptionWindows)).toBeInTheDocument();
      // The old drift: Windows fell into the "not supported" banner while the
      // backend sandboxed anyway. Guard against regressing to that.
      expect(screen.queryByText(t().settings.sandboxMacOSOnly)).not.toBeInTheDocument();
      expect(screen.queryByText(t().settings.sandboxProtectionDescription)).not.toBeInTheDocument();
    });

    it('uses the Windows section description (macOS one claims path isolation)', () => {
      renderSection();
      expect(screen.getByText(t().settings.sandboxDescriptionWindows)).toBeInTheDocument();
      expect(screen.queryByText(t().settings.sandboxDescription)).not.toBeInTheDocument();
    });

    it('keeps the always-visible app-layer protection notice Windows users had', () => {
      renderSection();
      expect(screen.getByText(t().settings.sandboxAppLayerProtection)).toBeInTheDocument();
    });

    it('renders network isolation with the Windows (proxy env var) description', () => {
      renderSection();
      expect(screen.getByText(t().settings.networkIsolation)).toBeInTheDocument();
      expect(screen.getByText(t().settings.networkIsolationDescriptionWindows)).toBeInTheDocument();
      expect(screen.queryByText(t().settings.networkIsolationDescription)).not.toBeInTheDocument();
    });

    it('shows the Windows disable warning when toggling off', async () => {
      const user = userEvent.setup();
      renderSection();
      await user.click(screen.getByText(t().settings.sandboxProtection));
      expect(screen.getByText(t().settings.sandboxDisableWarningWindows)).toBeInTheDocument();
      expect(screen.queryByText(t().settings.sandboxDisableWarning)).not.toBeInTheDocument();
    });
  });

  describe('other platforms (linux)', () => {
    beforeEach(() => { platformState.current = 'linux'; });

    it('shows the unsupported banner and no sandbox toggle', () => {
      renderSection();
      expect(screen.getByText(t().settings.sandboxMacOSOnly)).toBeInTheDocument();
      expect(screen.queryByText(t().settings.sandboxProtection)).not.toBeInTheDocument();
    });
  });
});

describe('SandboxSection permission dropdown', () => {
  const realSetPermissionMode = useSettingsStore.getState().setPermissionMode;
  // Runs the real action, so the closed select shows the saved mode.
  const setPermissionMode = vi.fn(realSetPermissionMode);

  beforeAll(() => {
    // happy-dom lacks the pointer-capture and scroll calls Radix Select makes while opening.
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.setPointerCapture ??= () => undefined;
    Element.prototype.releasePointerCapture ??= () => undefined;
    Element.prototype.scrollIntoView ??= () => undefined;
  });

  afterEach(() => {
    useSettingsStore.setState({ setPermissionMode: realSetPermissionMode });
  });

  beforeEach(() => {
    platformState.current = 'macos';
    initLanguage('zh-CN');
    vi.clearAllMocks();
    useSettingsStore.setState({
      setPermissionMode,
      permissionMode: 'standard',
      sandboxEnabled: true,
      networkIsolationEnabled: false,
      safety: { ...useSettingsStore.getState().safety, enableContentGuard: true },
    });
  });

  afterEach(cleanup);

  const modeCopy = () => ({
    standard: { label: t().settings.permissionModeStandard, description: t().settings.permissionModeStandardDesc },
    smart: { label: t().settings.permissionModeSmart, description: t().settings.permissionModeSmartDesc },
    autonomous: { label: t().settings.permissionModeAutonomous, description: t().settings.permissionModeAutonomousDesc },
  });

  const modeSelect = () => screen.getByRole('combobox', { name: t().settings.permissionMode });

  it('names the current mode and keeps the explanations in the list, which opens without changing anything', async () => {
    const user = userEvent.setup();
    renderSection();
    const copy = modeCopy();
    expect(modeSelect()).toHaveTextContent(copy.standard.label);
    expect(modeSelect().parentElement).toHaveClass('w-56');
    for (const { description } of Object.values(copy)) {
      expect(screen.queryByText(description)).not.toBeInTheDocument();
    }

    await user.click(modeSelect());

    for (const { description } of Object.values(copy)) {
      expect(screen.getByText(description)).toBeVisible();
    }
    expect(setPermissionMode).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().permissionMode).toBe('standard');
  });

  it.each<PermissionMode>(['standard', 'smart', 'autonomous'])('saves %s from the list and leaves protection toggles unchanged', async mode => {
    const user = userEvent.setup();
    renderSection();
    const copy = modeCopy();
    await user.click(modeSelect());
    await user.click(screen.getByRole('option', { name: copy[mode].label }));

    expect(useSettingsStore.getState().permissionMode).toBe(mode);
    // Picking the mode that is already set saves nothing.
    if (mode === 'standard') {
      expect(setPermissionMode).not.toHaveBeenCalled();
    } else {
      expect(setPermissionMode).toHaveBeenCalledOnce();
      expect(setPermissionMode).toHaveBeenCalledWith(mode);
    }
    expect(modeSelect()).toHaveAttribute('aria-expanded', 'false');
    expect(modeSelect()).toHaveTextContent(copy[mode].label);
    expect(useSettingsStore.getState().sandboxEnabled).toBe(true);
    expect(useSettingsStore.getState().networkIsolationEnabled).toBe(false);
    expect(useSettingsStore.getState().safety.enableContentGuard).toBe(true);
  });

  it('only opens and moves the highlight on arrow keys; Enter saves the highlighted mode', async () => {
    const user = userEvent.setup();
    renderSection();
    modeSelect().focus();

    await user.keyboard('{ArrowDown}');
    expect(screen.getAllByRole('option')).toHaveLength(3);
    await user.keyboard('{ArrowDown}');
    expect(setPermissionMode).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().permissionMode).toBe('standard');

    await user.keyboard('{Enter}');
    expect(setPermissionMode).toHaveBeenCalledOnce();
    expect(setPermissionMode).toHaveBeenCalledWith('smart');
  });

  it('leaves the mode alone when the list is browsed and closed with Escape', async () => {
    const user = userEvent.setup();
    renderSection();
    modeSelect().focus();

    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{Escape}');

    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    expect(setPermissionMode).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().permissionMode).toBe('standard');
  });

  it.each(['zh-CN', 'en-US'] as const)('ignores characters typed on the closed select (%s)', async locale => {
    initLanguage(locale);
    const user = userEvent.setup();
    renderSection();
    modeSelect().focus();

    // In English the mode names start with S, S and F.
    await user.keyboard('sfa1');

    expect(setPermissionMode).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().permissionMode).toBe('standard');
  });
});

// What each control on the page does to the store. Queries go by text, switch role and
// placeholder, so the same cases hold for any markup around them.
describe('SandboxSection protection behaviour', () => {
  const WHITELIST_PLACEHOLDER = '*.company.com / 10.0.0.0/8';
  const FOLDER_A = '/Users/test/project-a';
  const FOLDER_B = '/Users/test/project-b';

  const initial = useSettingsStore.getState();
  const realActions = {
    setSandboxEnabled: initial.setSandboxEnabled,
    setContentGuardEnabled: initial.setContentGuardEnabled,
    setNetworkIsolationEnabled: initial.setNetworkIsolationEnabled,
    setNetworkWhitelist: initial.setNetworkWhitelist,
    setAllowPrivateNetworks: initial.setAllowPrivateNetworks,
  };
  // Each spy runs the real action, so the page re-renders as it does in the app.
  const actions = {
    setSandboxEnabled: vi.fn(realActions.setSandboxEnabled),
    setContentGuardEnabled: vi.fn(realActions.setContentGuardEnabled),
    setNetworkIsolationEnabled: vi.fn(realActions.setNetworkIsolationEnabled),
    setNetworkWhitelist: vi.fn(realActions.setNetworkWhitelist),
    setAllowPrivateNetworks: vi.fn(realActions.setAllowPrivateNetworks),
  };

  beforeEach(() => {
    platformState.current = 'macos';
    initLanguage('zh-CN');
    vi.clearAllMocks();
    useSettingsStore.setState({
      ...actions,
      sandboxEnabled: true,
      networkIsolationEnabled: true,
      networkWhitelist: ['a.example.com', 'b.example.com'],
      allowPrivateNetworks: false,
      safety: { ...useSettingsStore.getState().safety, enableContentGuard: true },
    });
  });

  afterEach(() => {
    cleanup();
    for (const path of getAuthorizedWritablePaths()) mocks.revokeWorkspace(path);
    useSettingsStore.setState({ ...realActions });
  });

  const button = (name: string) => screen.getByRole('button', { name });
  const confirmButton = () => screen.queryByRole('button', { name: t().common.confirm });
  const rowOf = (text: string) => screen.getByText(text).parentElement!;
  const domainInput = () => screen.getByPlaceholderText(WHITELIST_PLACEHOLDER);
  const addButton = () => within(domainInput().parentElement!).getByRole('button');

  describe('sandbox protection', () => {
    it('asks before turning off and stays on when the answer is cancel', async () => {
      const user = userEvent.setup();
      renderSection();

      await user.click(screen.getByText(t().settings.sandboxProtection));
      expect(screen.getByText(t().settings.sandboxDisableWarning)).toBeInTheDocument();
      expect(actions.setSandboxEnabled).not.toHaveBeenCalled();

      await user.click(button(t().common.cancel));
      expect(screen.queryByText(t().settings.sandboxDisableWarning)).not.toBeInTheDocument();
      expect(actions.setSandboxEnabled).not.toHaveBeenCalled();
      expect(useSettingsStore.getState().sandboxEnabled).toBe(true);
    });

    it('stays on when the question is dismissed with Escape', async () => {
      const user = userEvent.setup();
      renderSection();

      await user.click(screen.getByText(t().settings.sandboxProtection));
      expect(screen.getByText(t().settings.sandboxDisableWarning)).toBeInTheDocument();
      await user.keyboard('{Escape}');

      expect(screen.queryByText(t().settings.sandboxDisableWarning)).not.toBeInTheDocument();
      expect(actions.setSandboxEnabled).not.toHaveBeenCalled();
      expect(useSettingsStore.getState().sandboxEnabled).toBe(true);
    });

    it('turns off once the question is confirmed', async () => {
      const user = userEvent.setup();
      renderSection();

      await user.click(screen.getByText(t().settings.sandboxProtection));
      await user.click(button(t().common.confirm));

      expect(actions.setSandboxEnabled).toHaveBeenCalledOnce();
      expect(actions.setSandboxEnabled).toHaveBeenCalledWith(false);
      expect(screen.queryByText(t().settings.sandboxDisableWarning)).not.toBeInTheDocument();
    });

    it('turns on without a question', async () => {
      useSettingsStore.setState({ sandboxEnabled: false });
      const user = userEvent.setup();
      renderSection();

      await user.click(screen.getByText(t().settings.sandboxProtection));

      expect(actions.setSandboxEnabled).toHaveBeenCalledOnce();
      expect(actions.setSandboxEnabled).toHaveBeenCalledWith(true);
      expect(confirmButton()).not.toBeInTheDocument();
    });
  });

  describe('content safety scanning', () => {
    it('asks before turning off and stays on when the answer is cancel', async () => {
      const user = userEvent.setup();
      renderSection();

      await user.click(screen.getByText(t().settings.contentGuardTitle));
      expect(screen.getByText(t().settings.contentGuardDisableTitle)).toBeInTheDocument();
      expect(screen.getByText(t().settings.contentGuardDisableMessage)).toBeInTheDocument();
      expect(actions.setContentGuardEnabled).not.toHaveBeenCalled();

      await user.click(button(t().common.cancel));
      expect(screen.queryByText(t().settings.contentGuardDisableTitle)).not.toBeInTheDocument();
      expect(actions.setContentGuardEnabled).not.toHaveBeenCalled();
      expect(useSettingsStore.getState().safety.enableContentGuard).toBe(true);
    });

    it('stays on when the question is dismissed with Escape', async () => {
      const user = userEvent.setup();
      renderSection();

      await user.click(screen.getByText(t().settings.contentGuardTitle));
      expect(screen.getByText(t().settings.contentGuardDisableTitle)).toBeInTheDocument();
      await user.keyboard('{Escape}');

      expect(screen.queryByText(t().settings.contentGuardDisableTitle)).not.toBeInTheDocument();
      expect(actions.setContentGuardEnabled).not.toHaveBeenCalled();
      expect(useSettingsStore.getState().safety.enableContentGuard).toBe(true);
    });

    it('turns off once the question is confirmed', async () => {
      const user = userEvent.setup();
      renderSection();

      await user.click(screen.getByText(t().settings.contentGuardTitle));
      await user.click(button(t().common.confirm));

      expect(actions.setContentGuardEnabled).toHaveBeenCalledOnce();
      expect(actions.setContentGuardEnabled).toHaveBeenCalledWith(false);
      expect(screen.queryByText(t().settings.contentGuardDisableTitle)).not.toBeInTheDocument();
    });

    it('turns on without a question', async () => {
      useSettingsStore.setState({ safety: { ...useSettingsStore.getState().safety, enableContentGuard: false } });
      const user = userEvent.setup();
      renderSection();

      await user.click(screen.getByText(t().settings.contentGuardTitle));

      expect(actions.setContentGuardEnabled).toHaveBeenCalledOnce();
      expect(actions.setContentGuardEnabled).toHaveBeenCalledWith(true);
      expect(confirmButton()).not.toBeInTheDocument();
    });
  });

  describe('network isolation', () => {
    it('flips on each press without a question', async () => {
      const user = userEvent.setup();
      renderSection();

      await user.click(screen.getByText(t().settings.networkIsolation));
      expect(actions.setNetworkIsolationEnabled).toHaveBeenCalledOnce();
      expect(actions.setNetworkIsolationEnabled).toHaveBeenLastCalledWith(false);
      expect(confirmButton()).not.toBeInTheDocument();

      await user.click(screen.getByText(t().settings.networkIsolation));
      expect(actions.setNetworkIsolationEnabled).toHaveBeenCalledTimes(2);
      expect(actions.setNetworkIsolationEnabled).toHaveBeenLastCalledWith(true);
    });

    it('is not offered while the sandbox is off', () => {
      useSettingsStore.setState({ sandboxEnabled: false });
      renderSection();
      expect(screen.queryByText(t().settings.networkIsolation)).not.toBeInTheDocument();
      expect(screen.queryByPlaceholderText(WHITELIST_PLACEHOLDER)).not.toBeInTheDocument();
    });

    it('keeps the allowlist away while it is off', () => {
      useSettingsStore.setState({ networkIsolationEnabled: false });
      renderSection();
      expect(screen.getByText(t().settings.networkIsolation)).toBeInTheDocument();
      expect(screen.queryByText(t().settings.allowPrivateNetworks)).not.toBeInTheDocument();
      expect(screen.queryByPlaceholderText(WHITELIST_PLACEHOLDER)).not.toBeInTheDocument();
    });
  });

  describe('private network addresses', () => {
    it('saves the opposite value, then syncs the running proxy', async () => {
      const user = userEvent.setup();
      renderSection();

      await user.click(screen.getByRole('switch', { name: t().settings.allowPrivateNetworks }));

      expect(actions.setAllowPrivateNetworks).toHaveBeenCalledOnce();
      expect(actions.setAllowPrivateNetworks).toHaveBeenCalledWith(true);
      expect(mocks.syncNetworkWhitelist).toHaveBeenCalledOnce();
      expect(actions.setAllowPrivateNetworks.mock.invocationCallOrder[0])
        .toBeLessThan(mocks.syncNetworkWhitelist.mock.invocationCallOrder[0]);
    });
  });

  describe('domain allowlist', () => {
    it('adds the trimmed entry on Enter, syncs, and empties the field', async () => {
      const user = userEvent.setup();
      renderSection();

      await user.type(domainInput(), '  *.example.com {Enter}');

      expect(actions.setNetworkWhitelist).toHaveBeenCalledOnce();
      expect(actions.setNetworkWhitelist).toHaveBeenCalledWith(['a.example.com', 'b.example.com', '*.example.com']);
      expect(mocks.syncNetworkWhitelist).toHaveBeenCalledOnce();
      expect(actions.setNetworkWhitelist.mock.invocationCallOrder[0])
        .toBeLessThan(mocks.syncNetworkWhitelist.mock.invocationCallOrder[0]);
      expect(domainInput()).toHaveValue('');
      expect(screen.getByText('*.example.com')).toBeInTheDocument();
    });

    it('adds from the add button, which is off for an empty or blank field', async () => {
      const user = userEvent.setup();
      renderSection();

      expect(addButton()).toBeDisabled();
      await user.type(domainInput(), '   ');
      expect(addButton()).toBeDisabled();

      await user.type(domainInput(), '10.0.0.0/8');
      expect(addButton()).toBeEnabled();
      await user.click(addButton());

      expect(actions.setNetworkWhitelist).toHaveBeenCalledOnce();
      expect(actions.setNetworkWhitelist).toHaveBeenCalledWith(['a.example.com', 'b.example.com', '10.0.0.0/8']);
      expect(mocks.syncNetworkWhitelist).toHaveBeenCalledOnce();
      expect(domainInput()).toHaveValue('');
    });

    it('ignores an entry that is already listed', async () => {
      const user = userEvent.setup();
      renderSection();

      await user.type(domainInput(), ' a.example.com{Enter}');

      expect(actions.setNetworkWhitelist).not.toHaveBeenCalled();
      expect(mocks.syncNetworkWhitelist).not.toHaveBeenCalled();
      expect(domainInput()).toHaveValue(' a.example.com');
    });

    it('ignores a blank entry', async () => {
      const user = userEvent.setup();
      renderSection();

      await user.type(domainInput(), '   {Enter}');

      expect(actions.setNetworkWhitelist).not.toHaveBeenCalled();
      expect(mocks.syncNetworkWhitelist).not.toHaveBeenCalled();
    });

    it('stores the entry as typed, with no check of its shape', async () => {
      const user = userEvent.setup();
      renderSection();

      await user.type(domainInput(), 'not a domain{Enter}');

      expect(actions.setNetworkWhitelist).toHaveBeenCalledWith(['a.example.com', 'b.example.com', 'not a domain']);
    });

    it('removes one entry and syncs', async () => {
      const user = userEvent.setup();
      renderSection();

      await user.click(within(rowOf('a.example.com')).getByRole('button'));

      expect(actions.setNetworkWhitelist).toHaveBeenCalledOnce();
      expect(actions.setNetworkWhitelist).toHaveBeenCalledWith(['b.example.com']);
      expect(mocks.syncNetworkWhitelist).toHaveBeenCalledOnce();
      expect(screen.queryByText('a.example.com')).not.toBeInTheDocument();
      expect(screen.getByText('b.example.com')).toBeInTheDocument();
    });
  });

  describe('authorized folders', () => {
    it('revokes one folder at once, without a question', async () => {
      authorizeWorkspace(FOLDER_A);
      authorizeWorkspace(FOLDER_B);
      const user = userEvent.setup();
      renderSection();

      await user.click(within(rowOf(FOLDER_A)).getByRole('button'));

      expect(mocks.revokeWorkspace).toHaveBeenCalledOnce();
      expect(mocks.revokeWorkspace).toHaveBeenCalledWith(FOLDER_A);
      expect(confirmButton()).not.toBeInTheDocument();
      expect(screen.queryByText(FOLDER_A)).not.toBeInTheDocument();
      expect(screen.getByText(FOLDER_B)).toBeInTheDocument();
      expect(getAuthorizedWritablePaths()).toEqual([FOLDER_B]);
    });

    it('says so when no folder is authorized', () => {
      renderSection();
      expect(screen.getByText(t().sandbox.authorizedPaths)).toBeInTheDocument();
      expect(screen.getByText(t().sandbox.authorizedPathsEmpty)).toBeInTheDocument();
    });

    it('is not listed while the sandbox is off', () => {
      authorizeWorkspace(FOLDER_A);
      useSettingsStore.setState({ sandboxEnabled: false });
      renderSection();
      expect(screen.queryByText(t().sandbox.authorizedPaths)).not.toBeInTheDocument();
      expect(screen.queryByText(FOLDER_A)).not.toBeInTheDocument();
    });
  });

  describe('questions', () => {
    it('asks about the sandbox in an alert dialog and gives the focus back to the switch', async () => {
      const user = userEvent.setup();
      renderSection();
      const sandboxSwitch = document.getElementById('setting-sandbox')!;
      expect(sandboxSwitch).toHaveAttribute('role', 'switch');
      sandboxSwitch.focus();

      await user.keyboard(' ');
      expect(screen.getByRole('alertdialog', { name: t().settings.sandbox })).toBeInTheDocument();
      await user.keyboard('{Escape}');

      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(sandboxSwitch).toHaveFocus();
      expect(actions.setSandboxEnabled).not.toHaveBeenCalled();
    });

    it('leaves the sandbox alone when it was turned off while the question was open', async () => {
      const user = userEvent.setup();
      renderSection();

      await user.click(screen.getByText(t().settings.sandboxProtection));
      act(() => useSettingsStore.setState({ sandboxEnabled: false }));
      await user.click(button(t().common.confirm));

      expect(actions.setSandboxEnabled).not.toHaveBeenCalled();
    });

    // The settings window closes itself when an approval needs the screen.
    it.each([
      ['sandbox', () => t().settings.sandboxProtection, () => actions.setSandboxEnabled, () => useSettingsStore.getState().sandboxEnabled],
      ['content scanning', () => t().settings.contentGuardTitle, () => actions.setContentGuardEnabled, () => useSettingsStore.getState().safety.enableContentGuard],
    ] as const)('withdraws the %s question and keeps the protection on when the settings window closes under it', async (_name, title, action, isOn) => {
      const user = userEvent.setup();
      const settings = (open: boolean) => (
        <Dialog open={open} onOpenChange={() => undefined} title="Settings">
          <SandboxSection />
        </Dialog>
      );
      const { rerender } = render(settings(true), { wrapper: DesignSystemProvider });

      await user.click(screen.getByText(title()));
      expect(screen.getByRole('alertdialog')).toBeInTheDocument();

      rerender(settings(false));

      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: t().common.confirm })).not.toBeInTheDocument();
      expect(action()).not.toHaveBeenCalled();
      expect(isOn()).toBe(true);
    });

    it('leaves content scanning alone when it was turned off while the question was open', async () => {
      const user = userEvent.setup();
      renderSection();

      await user.click(screen.getByText(t().settings.contentGuardTitle));
      act(() => useSettingsStore.setState({ safety: { ...useSettingsStore.getState().safety, enableContentGuard: false } }));
      await user.click(button(t().common.confirm));

      expect(actions.setContentGuardEnabled).not.toHaveBeenCalled();
    });
  });

  describe('names and hints', () => {
    it('names each switch after its row, once', () => {
      renderSection();
      expect(screen.getAllByRole('switch').map((control) => control.id))
        .toEqual(['setting-sandbox', 'setting-network-isolation', 'setting-private-networks', 'setting-content-guard']);
      // Named by its visible label alone: the info button beside the label carries the same words.
      expect(screen.getByRole('switch', { name: t().settings.sandboxProtection })).toHaveAttribute('id', 'setting-sandbox');
      expect(document.getElementById('setting-sandbox')).not.toHaveAttribute('aria-label');
      expect(document.querySelector('label[for="setting-sandbox"]')).toHaveTextContent(t().settings.sandboxProtection);
      expect(document.querySelector('label[for="setting-sandbox"] button')).toBeNull();
      expect(screen.getByRole('switch', { name: t().settings.networkIsolation })).toHaveAttribute('id', 'setting-network-isolation');
      expect(screen.getByRole('switch', { name: t().settings.allowPrivateNetworks })).toHaveAttribute('id', 'setting-private-networks');
      expect(screen.getByRole('switch', { name: t().settings.contentGuardTitle })).toHaveAttribute('id', 'setting-content-guard');
    });

    it('names every icon-only button', () => {
      authorizeWorkspace(FOLDER_A);
      renderSection();
      expect(within(rowOf('a.example.com')).getByRole('button', { name: t().common.delete })).toBeInTheDocument();
      expect(within(rowOf('b.example.com')).getByRole('button', { name: t().common.delete })).toBeInTheDocument();
      expect(within(domainInput().parentElement!).getByRole('button', { name: t().settings.add })).toBeInTheDocument();
      expect(within(rowOf(FOLDER_A)).getByRole('button', { name: t().sandbox.revoke })).toBeInTheDocument();
    });

    it.each([true, false])('keeps the info button outside the label, so pressing it asks nothing and saves nothing (sandbox on: %s)', async (sandboxEnabled) => {
      useSettingsStore.setState({ sandboxEnabled });
      const user = userEvent.setup();
      renderSection();
      const info = screen.getByRole('button', { name: t().settings.sandboxProtection });
      expect(info.closest('label')).toBeNull();

      await user.click(info);
      info.focus();
      await user.keyboard('{Enter}');
      await user.keyboard(' ');

      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(actions.setSandboxEnabled).not.toHaveBeenCalled();
      expect(useSettingsStore.getState().sandboxEnabled).toBe(sandboxEnabled);
    });

    it('explains the sandbox from its info button when the keyboard reaches it', async () => {
      renderSection();
      const info = screen.getByRole('button', { name: t().settings.sandboxProtection });
      expect(screen.queryByText(t().settings.sandboxProtectedPaths)).not.toBeInTheDocument();

      act(() => info.focus());

      const hint = await screen.findByRole('tooltip');
      expect(hint).toHaveTextContent(t().settings.sandboxProtectedPaths);
      expect(hint).toHaveTextContent(t().settings.sandboxWritablePaths);
      expect(actions.setSandboxEnabled).not.toHaveBeenCalled();
    });

    it('puts a warning sign on content scanning only while it is off', () => {
      const sign = () => document.querySelector('label[for="setting-content-guard"] svg');
      renderSection();
      expect(sign()).toBeNull();
      cleanup();

      useSettingsStore.setState({ safety: { ...useSettingsStore.getState().safety, enableContentGuard: false } });
      renderSection();
      expect(sign()).toHaveClass('text-warning');
    });
  });
});
