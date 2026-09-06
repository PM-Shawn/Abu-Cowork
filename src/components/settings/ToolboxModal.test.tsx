// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// A BOUND enterprise client. There is no third 组织 scope any more: the
// organization catalog IS the 市场 panel of each tab, and 我的 is always the
// personal one. These tests pin that mapping per tab, plus the two things that
// stay personal-only — the create control and the search box that feeds both.

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
  useEnterpriseStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    mode: {
      kind: 'enterprise',
      binding: { serverUrl: 'https://enterprise.example' },
      config: null,
    },
  }),
}));

vi.mock('@/i18n', () => ({
  format: (value: string) => value,
  useI18n: () => ({
    t: {
      toolbox: {
        plugins: 'Plugins', skills: 'Skills', connectors: 'Connectors',
        sourceMarket: 'Market', sourceMine: 'Mine',
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
vi.mock('@/components/toolbox/skills/ExternalSkillsPanel', () => ({
  default: () => <div>Skills market</div>,
}));
vi.mock('@/components/toolbox/connectors/ConnectorCatalog', () => ({
  default: () => <div>Connectors market</div>,
}));
vi.mock('@/components/toolbox/TopTabNav', () => ({
  default: ({ items, right }: { items: Array<{ id: string; label: string }>; right: ReactNode }) => (
    <div>{items.map(item => <button key={item.id}>{item.label}</button>)}{right}</div>
  ),
}));
vi.mock('@/components/toolbox/ToolboxCreateMenu', () => ({
  default: () => <button data-testid="create-control">Add</button>,
}));

import ExtensionsView from './ToolboxModal';

const mine = () => screen.getByTestId('extensions-source-mine');

describe('Extensions capability sources (bound enterprise client)', () => {
  beforeEach(() => {
    settingsState.activeExtensionsTab = 'skills';
    settingsState.extensionsSearchQueries = { plugins: '', skills: '', mcp: '' };
    vi.clearAllMocks();
  });

  it('技能 · 市场 is the organization catalog; 我的 is the personal section', () => {
    render(<ExtensionsView />);

    const catalog = screen.getByTestId('organization-catalog');
    expect(catalog).toHaveAttribute('data-slot', 'skillTab');
    expect(screen.queryByText('Personal skills')).not.toBeInTheDocument();
    // The OSS 市场 panel is replaced by the mount, not rendered beside it.
    expect(screen.queryByText('Skills market')).not.toBeInTheDocument();

    fireEvent.click(mine());
    expect(screen.getByText('Personal skills')).toBeInTheDocument();
    expect(screen.queryByTestId('organization-catalog')).not.toBeInTheDocument();
  });

  it('插件 · 市场 is the organization catalog; 我的 is the personal panel', () => {
    settingsState.activeExtensionsTab = 'plugins';
    render(<ExtensionsView />);

    expect(screen.getByTestId('organization-catalog')).toHaveAttribute('data-slot', 'pluginTab');

    fireEvent.click(mine());
    expect(screen.getByText('Personal plugins')).toBeInTheDocument();
    expect(screen.queryByTestId('organization-catalog')).not.toBeInTheDocument();
  });

  it('连接器 · 市场 is the organization catalog; 我的 is the personal section', () => {
    settingsState.activeExtensionsTab = 'mcp';
    render(<ExtensionsView />);

    expect(screen.getByTestId('organization-catalog')).toHaveAttribute('data-slot', 'mcpTab');

    fireEvent.click(mine());
    expect(screen.getByText('Personal MCP')).toBeInTheDocument();
    expect(screen.queryByTestId('organization-catalog')).not.toBeInTheDocument();
  });

  it('keeps personal create actions off the organization catalog, and feeds it the search box', async () => {
    const { rerender } = render(<ExtensionsView />);

    expect(screen.getByTestId('organization-catalog')).toBeInTheDocument();
    expect(screen.queryByTestId('create-control')).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Search'), { target: { value: 'finance' } });
    rerender(<ExtensionsView />);
    await waitFor(() => {
      expect(screen.getByTestId('organization-catalog')).toHaveTextContent('finance');
    });

    fireEvent.click(mine());
    expect(screen.getByTestId('create-control')).toBeInTheDocument();
  });

  it('offers 市场 | 我的 — not a 个人/组织 scope toggle — on every tab', () => {
    render(<ExtensionsView />);

    expect(screen.getByTestId('extensions-source-market')).toBeInTheDocument();
    expect(mine()).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Mine / Organization' })).not.toBeInTheDocument();
    expect(screen.queryByText('Organization')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Plugins' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connectors' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Agents' })).not.toBeInTheDocument();
  });
});
