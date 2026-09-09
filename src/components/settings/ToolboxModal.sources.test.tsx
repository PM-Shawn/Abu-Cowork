// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '@/stores/settingsStore';
import { usePluginStore } from '@/stores/pluginStore';

// The real settings store drives plugin navigation and released capability pages.
// Panels are stubbed here; their actions are covered by component and Electron tests.

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    setPendingInput: vi.fn(),
    startNewConversation: vi.fn(),
  }),
}));

vi.mock('@/stores/enterpriseStore', () => ({
  useEnterpriseStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    mode: { kind: 'personal' },
  }),
}));

vi.mock('@/i18n', () => ({
  format: (value: string) => value,
  useI18n: () => ({
    t: {
      toolbox: {
        skills: '技能', agents: '代理', mcp: 'MCP', plugins: '插件',
        connectors: '连接器', pluginsEmptyState: '还没有安装任何插件',
        sourceMarket: '市场', sourceMine: '我的',
        searchPlaceholder: '搜索...', importEntry: '导入',
        pluginsUpdatesAvailable: '{count} 个插件可更新',
        pluginsUpdatesAvailableOne: '1 个插件可更新',
        aiCreateSkillPrompt: '',
      },
    },
  }),
}));

vi.mock('@/core/enterprise/mounts-registry', () => ({
  getEnterpriseMount: () => null,
}));

vi.mock('../customize/SkillsSection', () => ({ default: () => <div>Personal skills</div> }));
vi.mock('../customize/MCPSection', () => ({ default: ({ showAddForm }: { showAddForm: boolean }) => <div>Personal MCP{showAddForm && <div role="dialog">Add connector</div>}</div> }));



// Real TopTabNav renders each item as a labeled button and calls onSelect —
// good enough to assert tab presence/absence without pulling in the actual
// window-drag / layout plumbing it also depends on.
vi.mock('@/components/toolbox/TopTabNav', () => ({
  default: ({ items, activeId, onSelect, right }: {
    items: Array<{ id: string; label: string; badge?: ReactNode }>;
    activeId: string;
    onSelect: (id: string) => void;
    right: ReactNode;
  }) => (
    <nav data-active-tab={activeId}>
      {items.map(item => (
        <button key={item.id} onClick={() => onSelect(item.id)}>{item.label}{item.badge}</button>
      ))}
      {right}
    </nav>
  ),
}));
vi.mock('@/components/toolbox/ToolboxCreateMenu', () => ({
  default: ({ onClick }: { onClick?: () => void }) => <button data-testid="create-control" onClick={onClick}>Add</button>,
}));
// The plugins panel owns its own filesystem/store plumbing (home resolution,
// installed.json hydration, marketplace reads). Stub it here so this file
// keeps testing the tab IA rather than re-testing the plugins UI.
vi.mock('@/components/toolbox/plugins/PluginsTab', () => ({
  default: ({ searchQuery, source }: { searchQuery: string; source?: string }) => (
    <div data-testid="plugins-panel" data-source={source}>plugins panel:{searchQuery}</div>
  ),
}));

import ExtensionsView from './ToolboxModal';

const tab = (name: string) => screen.getByRole('button', { name });

describe('Extensions retains the released capability pages', () => {
  beforeEach(() => {
    useSettingsStore.setState({ viewMode: 'chat', activeExtensionsTab: 'plugins', extensionsSearchQueries: { plugins: '', skills: '', mcp: '' }, pendingExtensionsSource: null });
    usePluginStore.setState({ updateAvailableKeys: [], updateAvailableCount: 0 });
    vi.clearAllMocks();
  });

  it('keeps the plugin panel without source subtabs across capability tabs', () => {
    render(<ExtensionsView />);
    const plugins = screen.getByTestId('plugins-panel');
    expect(plugins).toBeVisible();
    expect(screen.queryByTestId('extensions-source-mine')).toBeNull();
    fireEvent.click(tab('技能'));
    expect(screen.getByText('Personal skills')).toBeVisible();
    expect(screen.queryByTestId('extensions-source-market')).toBeNull();
    expect(screen.queryByTestId('skills-market')).toBeNull();
    fireEvent.click(tab('连接器'));
    expect(screen.getByText('Personal MCP')).toBeVisible();
    expect(screen.queryByTestId('connectors-market')).toBeNull();
    fireEvent.click(tab('插件'));
    expect(screen.getByTestId('plugins-panel')).toBe(plugins);
    expect(plugins).toBeVisible();
  });

  it.each(['skills', 'mcp'] as const)('opens the original %s page directly with its add control', (activeExtensionsTab) => {
    useSettingsStore.setState({ activeExtensionsTab });
    render(<ExtensionsView />);
    expect(screen.getByTestId('create-control')).toBeVisible();
    expect(screen.queryByTestId('extensions-source-market')).toBeNull();
    if (activeExtensionsTab === 'mcp') {
      fireEvent.click(screen.getByTestId('create-control'));
      expect(screen.getByRole('dialog')).toHaveTextContent('Add connector');
    }
  });

  it('keeps search words independently for the three pages', () => {
    render(<ExtensionsView />);
    fireEvent.change(screen.getByPlaceholderText('搜索...'), { target: { value: 'plugin words' } });
    fireEvent.click(tab('技能'));
    fireEvent.change(screen.getByPlaceholderText('搜索...'), { target: { value: 'skill words' } });
    fireEvent.click(tab('连接器'));
    fireEvent.change(screen.getByPlaceholderText('搜索...'), { target: { value: 'server words' } });
    fireEvent.click(tab('技能'));
    expect(screen.getByPlaceholderText('搜索...')).toHaveValue('skill words');
    fireEvent.click(tab('插件'));
    expect(screen.getByPlaceholderText('搜索...')).toHaveValue('plugin words');
  });

  it('honors a skill deep link without moving it behind a source tab', () => {
    useSettingsStore.getState().openExtensions('skills', 'mine');
    useSettingsStore.getState().setExtensionsSearchQuery('skills', 'accepted-skill');
    render(<ExtensionsView />);
    expect(screen.getByText('Personal skills')).toBeVisible();
    expect(screen.getByPlaceholderText('搜索...')).toHaveValue('accepted-skill');
    expect(useSettingsStore.getState().pendingExtensionsSource).toBeNull();
  });

  it('keeps the new plugin tab and its update badge without restoring the retired agents tab', () => {
    usePluginStore.setState({ updateAvailableCount: 10 });
    render(<ExtensionsView />);
    expect(screen.getByTestId('plugins-tab-update-badge')).toHaveTextContent('9+');
    expect(tab('技能')).toBeVisible();
    expect(tab('连接器')).toBeVisible();
    expect(screen.queryByRole('button', { name: '代理' })).toBeNull();
    expect(screen.getByTestId('create-control')).toBeVisible();
  });
});
