// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '@/stores/settingsStore';

// The Extensions view (formerly the Toolbox) has exactly three tabs —
// 插件 / 技能 / 连接器 — driven straight off the settings store's
// activeExtensionsTab, and every one of them carries the same 市场 | 我的
// source sub-nav. These tests cover that IA only (tab set, store-driven
// landing tab, which panel each tab×source mounts, per-tab source memory, the
// create control's gate, the skills deep link). The panels themselves are
// stubbed and covered by their own tests.
//
// The settings store is the REAL one so the deep link exercises the real
// openExtensions/setExtensionsSearchQuery pair, not a hand-rolled stand-in.
// SourceSubNav is real too — its testids are what the E2E specs click.

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
        aiCreateSkillPrompt: '',
      },
    },
  }),
}));

vi.mock('@/core/enterprise/mounts-registry', () => ({
  getEnterpriseMount: () => null,
}));

vi.mock('../customize/SkillsSection', () => ({ default: () => <div>Personal skills</div> }));
vi.mock('../customize/MCPSection', () => ({ default: () => <div>Personal MCP</div> }));
vi.mock('@/components/toolbox/skills/ExternalSkillsPanel', () => ({
  default: ({ searchQuery }: { searchQuery: string }) => (
    <div data-testid="skills-market">skills market:{searchQuery}</div>
  ),
}));
vi.mock('@/components/toolbox/connectors/ConnectorCatalog', () => ({
  default: ({ searchQuery }: { searchQuery: string }) => (
    <div data-testid="connectors-market">connectors market:{searchQuery}</div>
  ),
}));

// Real TopTabNav renders each item as a labeled button and calls onSelect —
// good enough to assert tab presence/absence without pulling in the actual
// window-drag / layout plumbing it also depends on.
vi.mock('@/components/toolbox/TopTabNav', () => ({
  default: ({ items, activeId, onSelect, right }: {
    items: Array<{ id: string; label: string }>;
    activeId: string;
    onSelect: (id: string) => void;
    right: ReactNode;
  }) => (
    <nav data-active-tab={activeId}>
      {items.map(item => (
        <button key={item.id} onClick={() => onSelect(item.id)}>{item.label}</button>
      ))}
      {right}
    </nav>
  ),
}));
vi.mock('@/components/toolbox/ToolboxCreateMenu', () => ({
  default: () => <button data-testid="create-control">Add</button>,
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

/** The retired 个人/组织 toggle must not come back in any shape. */
const noScopeToggle = () => {
  expect(screen.queryByRole('group', { name: '个人 / 组织' })).not.toBeInTheDocument();
  expect(screen.queryByText('组织')).not.toBeInTheDocument();
};

const tab = (name: string) => screen.getByRole('button', { name });
const market = () => screen.getByTestId('extensions-source-market');
const mine = () => screen.getByTestId('extensions-source-mine');

describe('Extensions view — 插件 / 技能 / 连接器', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      viewMode: 'chat',
      activeExtensionsTab: 'plugins',
      extensionsSearchQuery: '',
    });
    vi.clearAllMocks();
  });

  it('renders exactly the three tabs — 插件 / 技能 / 连接器 — and no 代理 tab', () => {
    render(<ExtensionsView />);

    const tabs = screen.getAllByRole('button').filter((b) => b.closest('nav'));
    expect(tabs.map((b) => b.textContent)).toEqual(['插件', '技能', '连接器']);
    expect(screen.queryByRole('button', { name: '代理' })).not.toBeInTheDocument();
  });

  it('carries no separate page title — the tabs are the header', () => {
    render(<ExtensionsView />);

    expect(screen.queryByTestId('toolbox-plugin-title')).not.toBeInTheDocument();
    expect(tab('插件')).toBeInTheDocument();
  });

  it('a stored tab of "plugins" (the default) lands on the plugins panel', () => {
    render(<ExtensionsView />);

    expect(screen.getByTestId('plugins-panel')).toBeInTheDocument();
    expect(screen.queryByText('Personal skills')).not.toBeInTheDocument();
    expect(screen.queryByText('Personal MCP')).not.toBeInTheDocument();
  });

  it('the stored tab drives the panel directly — no local tab state in between', () => {
    useSettingsStore.setState({ activeExtensionsTab: 'mcp' });
    render(<ExtensionsView />);

    expect(screen.getByTestId('connectors-market')).toBeInTheDocument();
    expect(screen.getByRole('navigation')).toHaveAttribute('data-active-tab', 'mcp');
  });

  it('selecting a tab writes it to the store and switches the panel', () => {
    render(<ExtensionsView />);

    fireEvent.click(tab('技能'));
    expect(useSettingsStore.getState().activeExtensionsTab).toBe('skills');
    expect(screen.getByTestId('skills-market')).toBeInTheDocument();

    fireEvent.click(tab('插件'));
    expect(useSettingsStore.getState().activeExtensionsTab).toBe('plugins');
    expect(screen.getByTestId('plugins-panel')).toBeInTheDocument();
  });

  describe('市场 | 我的', () => {
    it('offers both sources on every tab, market first', () => {
      render(<ExtensionsView />);

      for (const name of ['插件', '技能', '连接器']) {
        fireEvent.click(tab(name));
        expect(market()).toHaveAttribute('aria-selected', 'true');
        expect(mine()).toHaveAttribute('aria-selected', 'false');
      }
    });

    it('mounts the market panel of each tab by default', () => {
      render(<ExtensionsView />);
      expect(screen.getByTestId('plugins-panel')).toHaveAttribute('data-source', 'market');

      fireEvent.click(tab('技能'));
      expect(screen.getByTestId('skills-market')).toBeInTheDocument();
      expect(screen.queryByText('Personal skills')).not.toBeInTheDocument();

      fireEvent.click(tab('连接器'));
      expect(screen.getByTestId('connectors-market')).toBeInTheDocument();
      expect(screen.queryByText('Personal MCP')).not.toBeInTheDocument();
    });

    it('「我的」 mounts the personal panel of each tab', () => {
      render(<ExtensionsView />);
      fireEvent.click(mine());
      expect(screen.getByTestId('plugins-panel')).toHaveAttribute('data-source', 'mine');

      fireEvent.click(tab('技能'));
      fireEvent.click(mine());
      expect(screen.getByText('Personal skills')).toBeInTheDocument();

      fireEvent.click(tab('连接器'));
      fireEvent.click(mine());
      expect(screen.getByText('Personal MCP')).toBeInTheDocument();
    });

    it('remembers each tab’s source independently while the view is mounted', () => {
      render(<ExtensionsView />);

      // 插件 → 我的; 技能 stays on its own default.
      fireEvent.click(mine());
      fireEvent.click(tab('技能'));
      expect(market()).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByTestId('skills-market')).toBeInTheDocument();

      // Back to 插件 — still where it was left.
      fireEvent.click(tab('插件'));
      expect(mine()).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByTestId('plugins-panel')).toHaveAttribute('data-source', 'mine');
    });

    it('names the panel the sub-nav controls', () => {
      render(<ExtensionsView />);

      const panelId = market().getAttribute('aria-controls');
      expect(panelId).toBeTruthy();
      const panel = document.getElementById(panelId as string);
      expect(panel).toHaveAttribute('role', 'tabpanel');
      expect(panel).toContainElement(screen.getByTestId('plugins-panel'));
    });
  });

  describe('the create control', () => {
    it('is withheld on 市场 and offered on 我的 for 技能', () => {
      useSettingsStore.setState({ activeExtensionsTab: 'skills' });
      render(<ExtensionsView />);

      expect(screen.queryByTestId('create-control')).not.toBeInTheDocument();
      fireEvent.click(mine());
      expect(screen.getByTestId('create-control')).toBeInTheDocument();
    });

    it('is withheld on 市场 and offered on 我的 for 连接器', () => {
      useSettingsStore.setState({ activeExtensionsTab: 'mcp' });
      render(<ExtensionsView />);

      expect(screen.queryByTestId('create-control')).not.toBeInTheDocument();
      fireEvent.click(mine());
      expect(screen.getByTestId('create-control')).toBeInTheDocument();
    });

    it('never appears on 插件 — a market is added from inside the panel', () => {
      render(<ExtensionsView />);

      expect(screen.queryByTestId('create-control')).not.toBeInTheDocument();
      fireEvent.click(mine());
      expect(screen.queryByTestId('create-control')).not.toBeInTheDocument();
    });
  });

  it('the skills deep link lands on the skills tab with the search query applied', () => {
    // SkillProposalCard's jump: open on skills, then narrow to the skill name.
    // Mounting the view must NOT wipe that query (it only resets on a real
    // tab/source change, never on first paint).
    const { openExtensions, setExtensionsSearchQuery } = useSettingsStore.getState();
    openExtensions('skills');
    setExtensionsSearchQuery('weekly-digest');
    render(<ExtensionsView />);

    expect(useSettingsStore.getState().viewMode).toBe('extensions');
    expect(screen.getByTestId('skills-market')).toHaveTextContent('weekly-digest');
    expect(screen.getByPlaceholderText('搜索...')).toHaveValue('weekly-digest');
    expect(useSettingsStore.getState().extensionsSearchQuery).toBe('weekly-digest');
  });

  it('switching tabs clears the search query', () => {
    useSettingsStore.getState().openExtensions('skills');
    useSettingsStore.getState().setExtensionsSearchQuery('weekly-digest');
    render(<ExtensionsView />);

    fireEvent.click(tab('连接器'));
    expect(useSettingsStore.getState().extensionsSearchQuery).toBe('');
    expect(screen.getByPlaceholderText('搜索...')).toHaveValue('');
  });

  it('personal (OSS) mode: no 个人/组织 switch on any tab', () => {
    // The organization catalog exists only for a bound enterprise client, and
    // it is now the 市场 panel itself rather than a third scope. In the OSS
    // build `enterpriseMode.kind` is always 'personal' (enterprise-modules
    // stub), so nothing organization-shaped may render on any tab.
    render(<ExtensionsView />);
    noScopeToggle();
    expect(screen.getByTestId('plugins-panel')).toBeInTheDocument();
    fireEvent.click(tab('技能'));
    expect(screen.getByTestId('skills-market')).toBeInTheDocument();
    noScopeToggle();
    fireEvent.click(tab('连接器'));
    expect(screen.getByTestId('connectors-market')).toBeInTheDocument();
    noScopeToggle();
  });
});
