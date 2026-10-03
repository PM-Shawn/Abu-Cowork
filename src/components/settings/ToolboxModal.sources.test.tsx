// @vitest-environment happy-dom
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ds/button';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { usePluginStore } from '@/stores/pluginStore';
import { DEFAULT_SOURCES, useExtensionSourceStore } from '@/stores/extensionSourceStore';

// The real settings and chat stores drive plugin navigation and released capability pages.
// Panels are stubbed here; their actions are covered by component and Electron tests.

// The tab row holds the page's floating layers (the add menu, the tooltips). Counting its
// renders shows whether the page frame renders again.
const tabRow = vi.hoisted(() => ({ renders: 0 }));

vi.mock('@/stores/enterpriseStore', () => ({
  // A store, not just a selector: discoveryStore subscribes to it at import.
  useEnterpriseStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector({
      mode: { kind: 'personal' },
    }),
    { subscribe: () => () => {} },
  ),
}));

vi.mock('@/i18n', () => ({
  format: (value: string) => value,
  useI18n: () => ({
    t: {
      toolbox: {
        skills: '技能', agents: '专家', mcp: 'MCP', plugins: '插件',
        connectors: '连接器', pluginsEmptyState: '还没有安装任何插件',
        sourceMarket: '市场', sourceMine: '我的', categoryMine: '我的',
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
  }) => {
    tabRow.renders += 1;
    return (
      <nav data-active-tab={activeId}>
        <div data-testid="tab-buttons">
          {items.map(item => (
            <Button key={item.id} onClick={() => onSelect(item.id)}>{item.label}{item.badge}</Button>
          ))}
        </div>
        {right}
      </nav>
    );
  },
}));
vi.mock('@/components/toolbox/ToolboxCreateMenu', () => ({
  default: ({ onClick }: { onClick?: () => void }) => <Button data-testid="create-control" onClick={onClick}>Add</Button>,
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
    // The sub-nav's pick is remembered, so a deep-link test must not leak its
    // shelf into the next one.
    useExtensionSourceStore.setState({ sources: { ...DEFAULT_SOURCES } });
    vi.clearAllMocks();
  });

  it('keeps one 市场 | 我的 sub-nav over every capability tab', () => {
    render(<ExtensionsView />);
    const plugins = screen.getByTestId('plugins-panel');
    expect(plugins).toBeVisible();
    expect(screen.getByTestId('extensions-source-mine')).toBeVisible();
    fireEvent.click(tab('技能'));
    expect(screen.getByText('Personal skills')).toBeVisible();
    expect(screen.getByTestId('extensions-source-market')).toBeVisible();
    // …and it is still the one pair, not a per-panel copy.
    expect(screen.getAllByTestId('extensions-source-market')).toHaveLength(1);
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
    expect(screen.getByTestId('extensions-source-market')).toBeVisible();
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

  it('honors a skill deep link by landing on the shelf it named', () => {
    useSettingsStore.getState().openExtensions('skills', 'mine');
    useSettingsStore.getState().setExtensionsSearchQuery('skills', 'accepted-skill');
    render(<ExtensionsView />);
    expect(screen.getByText('Personal skills')).toBeVisible();
    expect(screen.getByPlaceholderText('搜索...')).toHaveValue('accepted-skill');
    expect(screen.getByTestId('extensions-source-mine')).toHaveAttribute('aria-selected', 'true');
    expect(useSettingsStore.getState().pendingExtensionsSource).toBeNull();
  });

  it('keeps the new plugin tab and its update badge without restoring the retired agents tab', () => {
    usePluginStore.setState({ updateAvailableCount: 10 });
    render(<ExtensionsView />);
    expect(screen.getByTestId('plugins-tab-update-badge')).toHaveTextContent('9+');
    expect(tab('技能')).toBeVisible();
    expect(tab('连接器')).toBeVisible();
    expect(screen.queryByRole('button', { name: '专家' })).toBeNull();
    expect(screen.getByTestId('create-control')).toBeVisible();
  });
});

describe('Extensions page frame', () => {
  const panels = () => [...document.querySelectorAll<HTMLElement>('[data-extension-panel]')];

  beforeEach(() => {
    useSettingsStore.setState({ viewMode: 'chat', activeExtensionsTab: 'plugins', extensionsSearchQueries: { plugins: '', skills: '', mcp: '' }, pendingExtensionsSource: null });
    usePluginStore.setState({ updateAvailableKeys: [], updateAvailableCount: 0 });
    useExtensionSourceStore.setState({ sources: { ...DEFAULT_SOURCES } });
    tabRow.renders = 0;
  });

  it('names the three tabs 插件, 技能, 连接器 in that order', () => {
    render(<ExtensionsView />);
    const names = within(screen.getByTestId('tab-buttons')).getAllByRole('button').map((button) => button.textContent);
    expect(names).toEqual(['插件', '技能', '连接器']);
  });

  it('writes the chosen tab to the settings store', () => {
    render(<ExtensionsView />);
    fireEvent.click(tab('技能'));
    expect(useSettingsStore.getState().activeExtensionsTab).toBe('skills');
  });

  it('writes the search words under the tab in view only', () => {
    useSettingsStore.setState({ activeExtensionsTab: 'skills' });
    render(<ExtensionsView />);
    fireEvent.change(screen.getByPlaceholderText('搜索...'), { target: { value: 'weekly report' } });
    expect(useSettingsStore.getState().extensionsSearchQueries).toEqual({ plugins: '', skills: 'weekly report', mcp: '' });
  });

  it('keeps every visited panel mounted and shows only the one in view', () => {
    render(<ExtensionsView />);
    expect(panels().map((panel) => panel.dataset.extensionPanel)).toEqual(['plugins']);
    fireEvent.click(tab('技能'));
    fireEvent.click(tab('连接器'));
    expect(panels().map((panel) => panel.dataset.extensionPanel)).toEqual(['plugins', 'skills', 'mcp']);
    expect(panels().map((panel) => panel.hidden)).toEqual([true, true, false]);
    fireEvent.click(tab('插件'));
    expect(panels().map((panel) => panel.hidden)).toEqual([false, true, true]);
  });

  it('puts a requested shelf on the tab in view and forgets the request', () => {
    useSettingsStore.getState().openExtensions('mcp', 'mine');
    render(<ExtensionsView />);
    expect(useExtensionSourceStore.getState().sources).toEqual({ ...DEFAULT_SOURCES, mcp: 'mine' });
    expect(useSettingsStore.getState().pendingExtensionsSource).toBeNull();
  });

  it('names the search box with its placeholder words', () => {
    render(<ExtensionsView />);
    expect(screen.getByRole('textbox', { name: '搜索...' })).toBe(screen.getByPlaceholderText('搜索...'));
  });

  describe('render count', () => {
    // Stands in for App, which reads the chat store and renders for every piece of a streamed reply.
    const app = { renders: 0 };
    function AppAround() {
      useChatStore((s) => s.conversations);
      app.renders += 1;
      return <ExtensionsView />;
    }
    const streamPiece = (text: string) => {
      const { conversations } = useChatStore.getState();
      useChatStore.setState({
        conversations: {
          ...conversations,
          'conv-stream': {
            id: 'conv-stream', title: 'Streaming', createdAt: 1, updatedAt: 1, status: 'running',
            messages: [{ id: 'm1', role: 'assistant', content: text, timestamp: 1 }],
          },
        },
      });
    };

    beforeEach(() => { app.renders = 0; });

    it('does not render again when the chat store changes and the app around it renders', () => {
      render(<AppAround />);
      const frame = tabRow.renders;
      const around = app.renders;
      expect(frame).toBeGreaterThan(0);

      for (const text of ['Once', 'Once upon', 'Once upon a time']) act(() => streamPiece(text));

      expect(app.renders).toBe(around + 3);
      expect(tabRow.renders).toBe(frame);
    });

    it('does not render again when a settings field it does not read changes', () => {
      render(<ExtensionsView />);
      const frame = tabRow.renders;
      act(() => useSettingsStore.setState({ sidebarCollapsed: !useSettingsStore.getState().sidebarCollapsed }));
      act(() => useSettingsStore.getState().setExtensionsSearchQuery('skills', 'typed on another tab'));
      expect(tabRow.renders).toBe(frame);
    });

    it('renders again for what it shows: the tab in view and its own search words', () => {
      render(<ExtensionsView />);
      const frame = tabRow.renders;
      act(() => useSettingsStore.getState().setExtensionsSearchQuery('plugins', 'words'));
      expect(tabRow.renders).toBeGreaterThan(frame);
      expect(screen.getByPlaceholderText('搜索...')).toHaveValue('words');
    });
  });
});
