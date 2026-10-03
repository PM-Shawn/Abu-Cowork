// @vitest-environment happy-dom
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ds/button';
import { DEFAULT_SOURCES, useExtensionSourceStore } from '@/stores/extensionSourceStore';
import { useSettingsStore, type ExtensionsTab } from '@/stores/settingsStore';

// Every tab is split by SOURCE: 「市场」 is what is on offer, 「我的」 what this
// user has. A bound client's 「市场」 is its organization catalog, so the same
// two shelves serve OSS and enterprise alike.

// The page takes no props and reads the real settings store one field at a time, so a
// test changes what it shows by changing the store.
const showTab = (activeExtensionsTab: ExtensionsTab) => act(() => useSettingsStore.setState({ activeExtensionsTab }));

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
    <div>{items.map(item => <Button key={item.id}>{item.label}</Button>)}{right}</div>
  ),
}));
vi.mock('@/components/toolbox/ToolboxCreateMenu', () => ({
  default: () => <Button data-testid="create-control">Add</Button>,
}));

import ExtensionsView from './ToolboxModal';

const resetSettings = (activeExtensionsTab: ExtensionsTab) => useSettingsStore.setState({
  viewMode: 'chat', activeExtensionsTab, extensionsSearchQueries: { plugins: '', skills: '', mcp: '' }, pendingExtensionsSource: null,
});

describe('Extensions capability sources (bound enterprise client)', () => {
  beforeEach(() => {
    resetSettings('skills');
    // The shelf each tab sits on persists, so every case starts from the
    // default shelf.
    useExtensionSourceStore.setState({ sources: { ...DEFAULT_SOURCES } });
    vi.clearAllMocks();
  });

  it.each(['skills', 'mcp'] as const)('opens %s on the organization catalog and keeps 我的 for this user', (activeTab) => {
    resetSettings(activeTab);
    render(<ExtensionsView />);
    // 「市场」 is what is on offer, and for a bound client that IS the
    // organization catalog — reached without a scope control of its own.
    expect(screen.getByTestId('organization-catalog')).toHaveAttribute('data-slot', activeTab === 'skills' ? 'skillTab' : 'mcpTab');
    expect(screen.queryByTestId('create-control')).toBeNull();
    // Both shelves stay reachable while bound.
    expect(screen.getByTestId('extensions-source-market')).toBeVisible();

    fireEvent.click(screen.getByTestId('extensions-source-mine'));
    expect(screen.getByText(activeTab === 'skills' ? 'Personal skills' : 'Personal MCP')).toBeVisible();
    expect(screen.getByTestId('create-control')).toBeVisible();
  });

  it('opens plugins on the organization catalog and keeps authored plugins under 我的', () => {
    resetSettings('plugins');
    render(<ExtensionsView />);
    expect(screen.getByTestId('organization-catalog')).toHaveAttribute('data-slot', 'pluginTab');
    expect(screen.queryByTestId('create-control')).toBeNull();

    fireEvent.click(screen.getByTestId('extensions-source-mine'));
    expect(screen.getByText('Personal plugins')).toBeVisible();
    expect(screen.getByTestId('create-control')).toBeVisible();
  });

  it('passes the current search to the organization capability slot', () => {
    render(<ExtensionsView />);
    fireEvent.change(screen.getByPlaceholderText('Search'), { target: { value: 'finance' } });
    expect(screen.getByTestId('organization-catalog')).toHaveTextContent('finance');
    expect(useSettingsStore.getState().extensionsSearchQueries.skills).toBe('finance');
  });
});

it('retains visited personal panels and hides inactive content across tab switches', () => {
  useExtensionSourceStore.setState({
    sources: { plugins: 'mine', skills: 'mine', mcp: 'mine', members: 'mine', teams: 'mine' },
  });
  resetSettings('skills');
  render(<ExtensionsView />);
  const skills = screen.getByText('Personal skills');
  showTab('mcp');
  expect(skills).not.toBeVisible();
  expect(screen.getByText('Personal MCP')).toBeVisible();
  showTab('plugins');
  const plugins = screen.getByText('Personal plugins');
  showTab('skills');
  expect(screen.getByText('Personal skills')).toBe(skills);
  expect(skills).toBeVisible();
  expect(plugins).not.toBeVisible();
});
