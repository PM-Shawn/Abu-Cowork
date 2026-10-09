// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import type { CheckResult } from '@/core/diagnostic/types';
import { initLanguage } from '@/i18n';
import { useCustomizeStore } from '@/stores/customizeStore';
import { useDiagnosticStore } from '@/stores/diagnosticStore';
import { useSettingsStore } from '@/stores/settingsStore';
import DiagnosticSection from './DiagnosticSection';

// Made-up check results. No check runs: the store's run functions are replaced for each test.
const NOW = new Date(2026, 9, 2, 12, 0, 0).getTime();

function check(id: string, more: Partial<CheckResult>): CheckResult {
  return { id, category: 'ai-services', name: id, status: 'passed', checkedAt: NOW, durationMs: 12, ...more };
}

const provider = check('ai-services:made-up-provider', {
  name: 'Made-up provider',
  status: 'failed',
  errorMessage: 'The key was refused',
  errorDetail: '401 made-up detail from the provider',
  suggestedAction: { type: 'open-settings', target: 'ai-services', label: 'Open AI services' },
});
const extension = check('mcp:made-up-server', {
  category: 'mcp',
  name: 'Made-up server',
  status: 'warning',
  errorMessage: 'Slow to answer',
  suggestedAction: { type: 'open-toolbox', label: 'Open extensions' },
});
const network = check('network:reachability', { category: 'network', name: 'Network', status: 'passed', metric: '48ms' });
const skills = check('skills:loader', { category: 'skills', name: 'Skill loading', status: 'skipped' });

const runs = {
  runAll: vi.fn(async () => undefined),
  runCategory: vi.fn(async () => undefined),
  refreshApp: vi.fn(async () => undefined),
  runItem: vi.fn(async () => undefined),
};
const openSystemSettings = vi.fn();
const setActiveSystemTab = vi.fn();
const openCustomize = vi.fn();
const realSettings = useSettingsStore.getInitialState();
const realCustomize = useCustomizeStore.getInitialState();
const realDiagnostic = useDiagnosticStore.getInitialState();

function results(...list: CheckResult[]): Record<string, CheckResult> {
  return Object.fromEntries(list.map((result) => [result.id, result]));
}

function renderPage() {
  return render(<DiagnosticSection />, { wrapper: DesignSystemProvider });
}

// The row of one check: the list item that holds its name.
function row(name: string): HTMLElement {
  const item = screen.getByText(name).closest('li');
  if (!item) throw new Error(`No row for ${name}`);
  return item;
}

describe('DiagnosticSection', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    for (const run of Object.values(runs)) run.mockClear();
    openSystemSettings.mockClear();
    setActiveSystemTab.mockClear();
    openCustomize.mockClear();
    useDiagnosticStore.setState({
      ...runs,
      results: results(provider, extension, network, skills),
      lastCheckedAt: NOW,
      isChecking: false,
      reRunning: {},
    });
    useSettingsStore.setState({ openSystemSettings, setActiveSystemTab, telemetryOptOut: false });
    useCustomizeStore.setState({ openCustomize });
  });

  afterEach(() => {
    cleanup();
    useDiagnosticStore.setState({
      runAll: realDiagnostic.runAll,
      runCategory: realDiagnostic.runCategory,
      refreshApp: realDiagnostic.refreshApp,
      runItem: realDiagnostic.runItem,
      results: {},
      lastCheckedAt: null,
      isChecking: false,
      reRunning: {},
    });
    useSettingsStore.setState({
      openSystemSettings: realSettings.openSystemSettings,
      setActiveSystemTab: realSettings.setActiveSystemTab,
      telemetryOptOut: realSettings.telemetryOptOut,
    });
    useCustomizeStore.setState({ openCustomize: realCustomize.openCustomize });
  });

  describe('opening the page', () => {
    it('runs every check on the first visit', () => {
      useDiagnosticStore.setState({ results: {}, lastCheckedAt: null });
      renderPage();

      expect(runs.runAll).toHaveBeenCalledTimes(1);
      expect(runs.refreshApp).not.toHaveBeenCalled();
    });

    it('refreshes only the app check when results are already there', () => {
      renderPage();

      expect(runs.refreshApp).toHaveBeenCalledTimes(1);
      expect(runs.runAll).not.toHaveBeenCalled();
    });

    it('says how many problems there are and when they were found', () => {
      renderPage();

      expect(screen.getByRole('heading', { name: '诊断' })).toBeInTheDocument();
      expect(screen.getByText('检测到 1 个问题')).toBeInTheDocument();
      expect(screen.getByText(/^上次检查 · /)).toBeInTheDocument();
    });
  });

  describe('running checks again', () => {
    it('runs every check from the summary', async () => {
      const user = userEvent.setup();
      renderPage();

      await user.click(screen.getByRole('button', { name: '立即重检' }));

      expect(runs.runAll).toHaveBeenCalledTimes(1);
    });

    it('offers no second full run while one is in flight', () => {
      useDiagnosticStore.setState({ isChecking: true });
      renderPage();

      expect(screen.getByText('诊断中…（4）')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '立即重检' })).toBeDisabled();
    });

    it('runs one group from its heading', async () => {
      const user = userEvent.setup();
      renderPage();
      const group = screen.getByRole('heading', { name: 'AI 服务' }).closest('section');
      if (!group) throw new Error('No group for AI services');

      await user.click(within(group).getByRole('button', { name: '重检本组' }));

      expect(runs.runCategory).toHaveBeenCalledExactlyOnceWith('ai-services');
    });

    it('runs one check from its row', async () => {
      const user = userEvent.setup();
      renderPage();

      await user.click(within(row('Made-up provider')).getByRole('button', { name: '重检' }));

      expect(runs.runItem).toHaveBeenCalledExactlyOnceWith(provider.id);
    });
  });

  describe('a check that failed', () => {
    it('is shown with its group open, its status and its reason', () => {
      renderPage();

      const failed = row('Made-up provider');
      expect(within(failed).getByText('The key was refused')).toBeInTheDocument();
      expect(failed.querySelector('[aria-label="failed"]')).not.toBeNull();
      expect(row('Made-up server').querySelector('[aria-label="warning"]')).not.toBeNull();
      // A group whose checks all passed starts folded.
      expect(screen.queryByText('Network')).not.toBeInTheDocument();
    });

    it('opens the settings page its suggestion names', async () => {
      const user = userEvent.setup();
      renderPage();

      await user.click(within(row('Made-up provider')).getByRole('button', { name: 'Open AI services' }));

      expect(openSystemSettings).toHaveBeenCalledExactlyOnceWith('ai-services');
      expect(openCustomize).not.toHaveBeenCalled();
    });

    it('opens the extensions page when its suggestion says so', async () => {
      const user = userEvent.setup();
      renderPage();

      await user.click(within(row('Made-up server')).getByRole('button', { name: 'Open extensions' }));

      expect(openCustomize).toHaveBeenCalledExactlyOnceWith('mcp');
      expect(openSystemSettings).not.toHaveBeenCalled();
    });

    it('copies the group, the name and the full error text', async () => {
      const user = userEvent.setup();
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      renderPage();

      await user.click(within(row('Made-up provider')).getByRole('button', { name: '复制错误' }));
      expect(writeText).toHaveBeenLastCalledWith('[diagnostic] ai-services/Made-up provider: 401 made-up detail from the provider');

      // Without the full text, the one-line reason is copied.
      await user.click(within(row('Made-up server')).getByRole('button', { name: '复制错误' }));
      expect(writeText).toHaveBeenLastCalledWith('[diagnostic] mcp/Made-up server: Slow to answer');
    });

    it('unfolds the full error text on request', async () => {
      const user = userEvent.setup();
      renderPage();
      expect(screen.queryByText('401 made-up detail from the provider')).not.toBeInTheDocument();

      await user.click(within(row('Made-up provider')).getByRole('button', { name: '展开详情' }));
      expect(screen.getByText('401 made-up detail from the provider')).toBeInTheDocument();

      await user.click(within(row('Made-up provider')).getByRole('button', { name: '收起详情' }));
      expect(screen.queryByText('401 made-up detail from the provider')).not.toBeInTheDocument();
    });
  });

  describe('a group', () => {
    it('unfolds and folds from its heading', async () => {
      const user = userEvent.setup();
      renderPage();
      const toggle = screen.getByRole('button', { name: /网络/ });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');

      await user.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      expect(within(row('Network')).getByText('48ms')).toBeInTheDocument();
      // A check that passed offers no actions.
      expect(within(row('Network')).queryByRole('button')).not.toBeInTheDocument();

      await user.click(toggle);
      expect(screen.queryByText('Network')).not.toBeInTheDocument();
    });
  });

  describe('while checks run', () => {
    it('turns one indicator, in the summary, and none in the rows', () => {
      useDiagnosticStore.setState({ isChecking: true, reRunning: { [provider.id]: true } });
      const { container } = renderPage();

      const summary = screen.getByRole('status');
      expect(summary).toHaveTextContent('诊断中…（4）');
      const turning = container.querySelectorAll('[data-ds-spinner]');
      expect(turning).toHaveLength(1);
      expect(summary.contains(turning[0])).toBe(true);
      expect(container.querySelectorAll('.animate-spin')).toHaveLength(1);
      // The row being checked again says so with a still icon.
      const checking = row('Made-up provider');
      expect(checking.querySelector('[aria-label="checking"]')).not.toBeNull();
      expect(checking.querySelector('[data-ds-spinner]')).toBeNull();
      expect(within(checking).queryByRole('button', { name: '重检' })).not.toBeInTheDocument();
    });

    it('shows a status mark with each summary, and none that turns', () => {
      const { container, unmount } = renderPage();
      expect(container.querySelector('[data-ds-spinner]')).toBeNull();
      expect(container.querySelector('.animate-spin')).toBeNull();
      unmount();

      useDiagnosticStore.setState({ results: results(network) });
      renderPage();
      expect(screen.getByText('一切正常')).toBeInTheDocument();
    });
  });

  describe('the rest of the page', () => {
    it('turns error reports off and on again', async () => {
      const user = userEvent.setup();
      renderPage();
      const reports = screen.getByRole('switch');
      expect(reports).toHaveAttribute('aria-checked', 'true');

      await user.click(reports);
      expect(useSettingsStore.getState().telemetryOptOut).toBe(true);
      expect(reports).toHaveAttribute('aria-checked', 'false');

      await user.click(reports);
      expect(useSettingsStore.getState().telemetryOptOut).toBe(false);
    });

    it('leads to the feedback page', async () => {
      const user = userEvent.setup();
      renderPage();

      await user.click(screen.getByRole('button', { name: '有问题？在反馈页附上诊断包 →' }));

      expect(setActiveSystemTab).toHaveBeenCalledExactlyOnceWith('feedback');
    });
  });
});
