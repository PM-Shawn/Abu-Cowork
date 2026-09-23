// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SOURCES, useExtensionSourceStore } from '@/stores/extensionSourceStore';

// Every tab is split by SOURCE: 「市场」 is what is on offer, 「我的」 what this
// user has. A bound client's 「市场」 is its organization catalog, so the same
// two shelves serve OSS and enterprise alike.

type ExtensionsTab = 'plugins' | 'skills' | 'mcp';

const settingsState = {
  activeExtensionsTab: 'skills' as ExtensionsTab,
  closeExtensions: vi.fn(),
  setActiveExtensionsTab: vi.fn(),
  extensionsSearchQueries: { plugins: '', skills: '', mcp: '' } as Record<ExtensionsTab, string>,
  setExtensionsSearchQuery: vi.fn((tab: ExtensionsTab, value: string) => {
    settingsState.extensionsSearchQueries[tab] = value;
  }),
};

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: () => settingsState,
  useExtensionsSearchQuery: (tab?: ExtensionsTab) =>
    settingsState.extensionsSearchQueries[tab ?? settingsState.activeExtensionsTab] ?? '',
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    setPendingInput: vi.fn(),
    startNewConversation: vi.fn(),
  }),
}));

vi.mock('@/stores/enterpriseStore', () => ({
  // A store, not just a selector: discoveryStore subscribes to it at import.
  useEnterpriseStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector({
      mode: {
        kind: 'enterprise',
        binding: { serverUrl: 'https://enterprise.example' },
        config: null,
      },
    }),
    { subscribe: () => () => {} },
  ),
}));

vi.mock('@/i18n', () => ({
  format: (value: string) => value,
  useI18n: () => ({
    t: {
      toolbox: {
        plugins: 'Plugins', skills: 'Skills', connectors: 'Connectors',
        sourceMarket: 'Market', sourceMine: 'Mine', categoryMine: 'Mine',
        searchPlaceholder: 'Search', importEntry: 'Import', aiCreateSkillPrompt: '',
      },
    },
  }),
}));

// Every mount slot is registered, as in a bound enterprise build.
vi.mock('@/core/enterprise/mounts-registry', () => ({
  getEnterpriseMount: (slot: string) => ({ searchQuery = '' }: { searchQuery?: string }) => (
    <div data-testid="organization-catalog" data-slot={slot}>Organization catalog: {searchQuery}</div>
  ),
}));

vi.mock('../customize/SkillsSection', () => ({ default: () => <div>Personal skills</div> }));
vi.mock('../customize/MCPSection', () => ({ default: () => <div>Personal MCP</div> }));
vi.mock('@/components/toolbox/plugins/PluginsTab', () => ({ default: () => <div>Personal plugins</div> }));


vi.mock('@/components/toolbox/TopTabNav', () => ({
  default: ({ items, right }: { items: Array<{ id: string; label: string }>; right: ReactNode }) => (
    <div>{items.map(item => <button key={item.id}>{item.label}</button>)}{right}</div>
  ),
}));
vi.mock('@/components/toolbox/ToolboxCreateMenu', () => ({
  default: () => <button data-testid="create-control">Add</button>,
}));

import ExtensionsView from './ToolboxModal';


describe('Extensions capability sources (bound enterprise client)', () => {
  beforeEach(() => {
    settingsState.activeExtensionsTab = 'skills';
    settingsState.extensionsSearchQueries = { plugins: '', skills: '', mcp: '' };
    // The shelf each tab sits on persists, so every case starts from the
    // default rather than from whichever shelf the previous one left behind.
    useExtensionSourceStore.setState({ sources: { ...DEFAULT_SOURCES } });
    vi.clearAllMocks();
  });

  it.each(['skills', 'mcp'] as const)('opens %s on the organization catalog and keeps 我的 for this user', (activeTab) => {
    settingsState.activeExtensionsTab = activeTab;
    render(<ExtensionsView />);
    // 「市场」 is what is on offer, and for a bound client that IS the
    // organization catalog — reached without a scope control of its own.
    expect(screen.getByTestId('organization-catalog')).toHaveAttribute('data-slot', activeTab === 'skills' ? 'skillTab' : 'mcpTab');
    expect(screen.queryByTestId('create-control')).toBeNull();
    expect(screen.getByTestId('extensions-source-market')).toBeVisible();

    fireEvent.click(screen.getByTestId('extensions-source-mine'));
    expect(screen.getByText(activeTab === 'skills' ? 'Personal skills' : 'Personal MCP')).toBeVisible();
    expect(screen.getByTestId('create-control')).toBeVisible();
  });

  it('opens plugins on the organization catalog and keeps authored plugins under 我的', () => {
    settingsState.activeExtensionsTab = 'plugins';
    render(<ExtensionsView />);
    expect(screen.getByTestId('organization-catalog')).toHaveAttribute('data-slot', 'pluginTab');

    fireEvent.click(screen.getByTestId('extensions-source-mine'));
    expect(screen.getByText('Personal plugins')).toBeVisible();
    expect(screen.getByTestId('create-control')).toBeVisible();
  });

  it('passes the current search to the organization capability slot', async () => {
    const { rerender } = render(<ExtensionsView />);
    fireEvent.change(screen.getByPlaceholderText('Search'), { target: { value: 'finance' } });
    rerender(<ExtensionsView />);
    await waitFor(() => expect(screen.getByTestId('organization-catalog')).toHaveTextContent('finance'));
  });
});

it('retains visited personal panels and hides inactive content across tab switches', () => {
  useExtensionSourceStore.setState({
    sources: { plugins: 'mine', skills: 'mine', mcp: 'mine', members: 'mine', teams: 'mine' },
  });
  settingsState.activeExtensionsTab = 'skills';
  const { rerender } = render(<ExtensionsView />);
  const skills = screen.getByText('Personal skills');
  settingsState.activeExtensionsTab = 'mcp';
  rerender(<ExtensionsView />);
  expect(skills).not.toBeVisible();
  expect(screen.getByText('Personal MCP')).toBeVisible();
  settingsState.activeExtensionsTab = 'plugins';
  rerender(<ExtensionsView />);
  const plugins = screen.getByText('Personal plugins');
  settingsState.activeExtensionsTab = 'skills';
  rerender(<ExtensionsView />);
  expect(screen.getByText('Personal skills')).toBe(skills);
  expect(skills).toBeVisible();
  expect(plugins).not.toBeVisible();
});
