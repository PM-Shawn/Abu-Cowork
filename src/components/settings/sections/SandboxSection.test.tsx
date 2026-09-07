// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SandboxSection from './SandboxSection';
import { useSettingsStore } from '@/stores/settingsStore';
import { initLanguage, getI18n } from '@/i18n';

// Platform is the axis under test: the OS-level sandbox UI must render on
// BOTH macOS and Windows (electron/commandHost.cjs sandboxes on both), and
// fall back to the unsupported-platform banner only elsewhere.
const platformState = { current: 'macos' };
vi.mock('@/utils/platform', () => ({
  isMacOS: () => platformState.current === 'macos',
  isWindows: () => platformState.current === 'windows',
}));

const t = () => getI18n();

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
      render(<SandboxSection />);
      expect(screen.getByText(t().settings.sandboxProtection)).toBeInTheDocument();
      expect(screen.getByText(t().settings.sandboxProtectionDescription)).toBeInTheDocument();
      expect(screen.queryByText(t().settings.sandboxMacOSOnly)).not.toBeInTheDocument();
      // App-layer notice is a Windows affordance (there it IS the path
      // defense); macOS keeps its Seatbelt-focused layout without it.
      expect(screen.queryByText(t().settings.sandboxAppLayerProtection)).not.toBeInTheDocument();
    });

    it('shows the macOS disable warning when toggling off', async () => {
      const user = userEvent.setup();
      render(<SandboxSection />);
      await user.click(screen.getByText(t().settings.sandboxProtection));
      expect(screen.getByText(t().settings.sandboxDisableWarning)).toBeInTheDocument();
    });
  });

  describe('Windows', () => {
    beforeEach(() => { platformState.current = 'windows'; });

    it('renders the sandbox toggle (no unsupported banner) with Windows copy', () => {
      render(<SandboxSection />);
      expect(screen.getByText(t().settings.sandboxProtection)).toBeInTheDocument();
      expect(screen.getByText(t().settings.sandboxProtectionDescriptionWindows)).toBeInTheDocument();
      // The old drift: Windows fell into the "not supported" banner while the
      // backend sandboxed anyway. Guard against regressing to that.
      expect(screen.queryByText(t().settings.sandboxMacOSOnly)).not.toBeInTheDocument();
      expect(screen.queryByText(t().settings.sandboxProtectionDescription)).not.toBeInTheDocument();
    });

    it('uses the Windows section description (macOS one claims path isolation)', () => {
      render(<SandboxSection />);
      expect(screen.getByText(t().settings.sandboxDescriptionWindows)).toBeInTheDocument();
      expect(screen.queryByText(t().settings.sandboxDescription)).not.toBeInTheDocument();
    });

    it('keeps the always-visible app-layer protection notice Windows users had', () => {
      render(<SandboxSection />);
      expect(screen.getByText(t().settings.sandboxAppLayerProtection)).toBeInTheDocument();
    });

    it('renders network isolation with the Windows (proxy env var) description', () => {
      render(<SandboxSection />);
      expect(screen.getByText(t().settings.networkIsolation)).toBeInTheDocument();
      expect(screen.getByText(t().settings.networkIsolationDescriptionWindows)).toBeInTheDocument();
      expect(screen.queryByText(t().settings.networkIsolationDescription)).not.toBeInTheDocument();
    });

    it('shows the Windows disable warning when toggling off', async () => {
      const user = userEvent.setup();
      render(<SandboxSection />);
      await user.click(screen.getByText(t().settings.sandboxProtection));
      expect(screen.getByText(t().settings.sandboxDisableWarningWindows)).toBeInTheDocument();
      expect(screen.queryByText(t().settings.sandboxDisableWarning)).not.toBeInTheDocument();
    });
  });

  describe('other platforms (linux)', () => {
    beforeEach(() => { platformState.current = 'linux'; });

    it('shows the unsupported banner and no sandbox toggle', () => {
      render(<SandboxSection />);
      expect(screen.getByText(t().settings.sandboxMacOSOnly)).toBeInTheDocument();
      expect(screen.queryByText(t().settings.sandboxProtection)).not.toBeInTheDocument();
    });
  });
});
