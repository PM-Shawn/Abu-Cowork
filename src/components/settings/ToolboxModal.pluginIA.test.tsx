// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from '@/stores/settingsStore';

// The Extensions view (formerly the Toolbox) has exactly three tabs —
// 插件 / 技能 / 连接器 — driven straight off the settings store's
// activeExtensionsTab; there is no Labs flag and no 代理 tab any more. These
// tests cover the tab IA only (tab set, store-driven landing tab, which panel
// mounts, the personal/organization switch gate, the skills deep link). The
// plugin list UI itself is stubbed and covered by
// src/components/toolbox/plugins/*.test.tsx.
//
// The settings store is the REAL one so the deep link exercises the real
// openExtensions/setExtensionsSearchQuery pair, not a hand-rolled stand-in.

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
        personalSource: '个人', organizationSource: '组织',
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
  default: ({ searchQuery }: { searchQuery: string }) => (
    <div data-testid="plugins-panel">plugins panel:{searchQuery}</div>
  ),
}));

import ExtensionsView from './ToolboxModal';

const noSwitch = () =>
  expect(screen.queryByRole('group', { name: '个人 / 组织' })).not.toBeInTheDocument();

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
    expect(screen.getByRole('button', { name: '插件' })).toBeInTheDocument();
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

    expect(screen.getByText('Personal MCP')).toBeInTheDocument();
    expect(screen.getByRole('navigation')).toHaveAttribute('data-active-tab', 'mcp');
  });

  it('selecting a tab writes it to the store and switches the panel', () => {
    render(<ExtensionsView />);

    fireEvent.click(screen.getByRole('button', { name: '技能' }));
    expect(useSettingsStore.getState().activeExtensionsTab).toBe('skills');
    expect(screen.getByText('Personal skills')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '插件' }));
    expect(useSettingsStore.getState().activeExtensionsTab).toBe('plugins');
    expect(screen.getByTestId('plugins-panel')).toBeInTheDocument();
  });

  it('the skills deep link lands on the skills tab with the search query applied', () => {
    // SkillProposalCard's jump: open on skills, then narrow to the skill name.
    // Mounting the view must NOT wipe that query (it only resets on a real
    // tab/scope change, never on first paint).
    const { openExtensions, setExtensionsSearchQuery } = useSettingsStore.getState();
    openExtensions('skills');
    setExtensionsSearchQuery('weekly-digest');
    render(<ExtensionsView />);

    expect(useSettingsStore.getState().viewMode).toBe('extensions');
    expect(screen.getByText('Personal skills')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('搜索...')).toHaveValue('weekly-digest');
    expect(useSettingsStore.getState().extensionsSearchQuery).toBe('weekly-digest');
  });

  it('switching tabs clears the search query', () => {
    useSettingsStore.getState().openExtensions('skills');
    useSettingsStore.getState().setExtensionsSearchQuery('weekly-digest');
    render(<ExtensionsView />);

    fireEvent.click(screen.getByRole('button', { name: '连接器' }));
    expect(useSettingsStore.getState().extensionsSearchQuery).toBe('');
    expect(screen.getByPlaceholderText('搜索...')).toHaveValue('');
  });

  it('personal (OSS) mode: no 个人/组织 switch on any tab', () => {
    // The organization view exists only for a bound enterprise client. In the
    // OSS build `enterpriseMode.kind` is always 'personal' (enterprise-modules
    // stub), so the toggle must never render and every tab shows its personal
    // panel.
    render(<ExtensionsView />);
    noSwitch();
    expect(screen.getByTestId('plugins-panel')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '技能' }));
    expect(screen.getByText('Personal skills')).toBeInTheDocument();
    noSwitch();
    fireEvent.click(screen.getByRole('button', { name: '连接器' }));
    expect(screen.getByText('Personal MCP')).toBeInTheDocument();
    noSwitch();
  });
});
