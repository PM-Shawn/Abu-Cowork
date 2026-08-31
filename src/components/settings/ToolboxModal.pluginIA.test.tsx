// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Task 9: labs flag LABS_PLUGIN_SYSTEM switches the Toolbox's 3-tab IA from
// skills/agents/mcp to plugins/skills/mcp. These tests cover only the tab
// switch itself (registry entry, tab set per flag state, activeTab fallback,
// which panel mounts) — not the plugin list UI itself, which is stubbed below
// and covered by src/components/toolbox/plugins/*.test.tsx.

const settingsState = {
  activeToolboxTab: 'skills' as 'skills' | 'agents' | 'mcp',
  closeToolbox: vi.fn(),
  setActiveToolboxTab: vi.fn((tab: 'skills' | 'agents' | 'mcp') => {
    settingsState.activeToolboxTab = tab;
  }),
  toolboxSearchQuery: '',
  setToolboxSearchQuery: vi.fn((value: string) => {
    settingsState.toolboxSearchQuery = value;
  }),
};

let labsFlagOn = false;

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: () => settingsState,
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    setPendingInput: vi.fn(),
    startNewConversation: vi.fn(),
  }),
}));

vi.mock('@/stores/discoveryStore', () => ({
  useDiscoveryStore: (selector: (state: Record<string, unknown>) => unknown) => selector({ refresh: vi.fn() }),
}));

vi.mock('@/stores/enterpriseStore', () => ({
  useEnterpriseStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    mode: { kind: 'personal' },
  }),
}));

vi.mock('@/core/labs/resolve', () => ({
  useLabsFlag: () => labsFlagOn,
}));

vi.mock('@/i18n', () => ({
  format: (value: string) => value,
  useI18n: () => ({
    t: {
      toolbox: {
        skills: '技能', agents: '代理', mcp: '连接器', plugins: '插件',
        connectors: '连接器', pluginsEmptyState: '还没有安装任何插件',
        personalSource: '个人', organizationSource: '组织',
        searchPlaceholder: '搜索...', uploadFile: '上传', importEntry: '导入',
        aiCreateAgentPrompt: '', aiCreateSkillPrompt: '',
        uploadFailed: '', uploadSuccess: '', uploadSuccessDetail: '',
      },
    },
  }),
}));

vi.mock('@/core/enterprise/mounts-registry', () => ({
  getEnterpriseMount: () => null,
}));

vi.mock('../customize/SkillsSection', () => ({ default: () => <div>Personal skills</div> }));
vi.mock('../customize/AgentsSection', () => ({ default: () => <div>Personal agents</div> }));
vi.mock('../customize/MCPSection', () => ({ default: () => <div>Personal MCP</div> }));

// Real TopTabNav renders each item as a labeled button and calls onSelect —
// good enough to assert tab presence/absence without pulling in the actual
// window-drag / layout plumbing it also depends on.
vi.mock('@/components/toolbox/TopTabNav', () => ({
  default: ({ items, onSelect, right }: {
    items: Array<{ id: string; label: string }>;
    onSelect: (id: string) => void;
    right: ReactNode;
  }) => (
    <nav>
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
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('@/core/skill/installer', () => ({ installSkillFromFolder: vi.fn() }));
vi.mock('@/core/agent/installer', () => ({ installAgentFromFolder: vi.fn() }));
vi.mock('@/stores/toastStore', () => ({ useToastStore: { getState: () => ({ addToast: vi.fn() }) } }));
// The plugins panel owns its own filesystem/store plumbing (home resolution,
// installed.json hydration, marketplace reads). Stub it here so this file
// keeps testing the tab IA rather than re-testing Task 10's UI.
vi.mock('@/components/toolbox/plugins/PluginsTab', () => ({
  default: ({ searchQuery }: { searchQuery: string }) => (
    <div data-testid="plugins-panel">plugins panel:{searchQuery}</div>
  ),
}));

import ToolboxView from './ToolboxModal';

describe('ToolboxModal — Plugin System IA (LABS_PLUGIN_SYSTEM)', () => {
  beforeEach(() => {
    labsFlagOn = false;
    settingsState.activeToolboxTab = 'skills';
    settingsState.toolboxSearchQuery = '';
    vi.clearAllMocks();
  });

  it('flag off: renders the unchanged 3 tabs, including Agents', () => {
    render(<ToolboxView />);

    expect(screen.getByRole('button', { name: '技能' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '代理' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '连接器' })).toBeInTheDocument();
    // No Plugins tab and no Plugin IA title when the flag is off.
    expect(screen.queryByRole('button', { name: '插件' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('toolbox-plugin-title')).not.toBeInTheDocument();
  });

  it('flag on: renders Plugins/Skills/Connectors, and drops Agents', () => {
    labsFlagOn = true;
    render(<ToolboxView />);

    expect(screen.getByRole('button', { name: '插件' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '技能' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '连接器' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '代理' })).not.toBeInTheDocument();
  });

  it('flag on: the view title reads "插件"', () => {
    labsFlagOn = true;
    render(<ToolboxView />);

    expect(screen.getByTestId('toolbox-plugin-title')).toHaveTextContent('插件');
  });

  it('flag on with a stale activeTab of "agents": falls back to Plugins, not a blank screen', () => {
    settingsState.activeToolboxTab = 'agents';
    labsFlagOn = true;
    render(<ToolboxView />);

    // Must not render nothing — the Plugins panel shows instead.
    expect(screen.getByTestId('plugins-panel')).toBeInTheDocument();
    // Agents' own content must not render — that tab is gone under the IA.
    expect(screen.queryByText('Personal agents')).not.toBeInTheDocument();
  });

  it('flag on: the Plugins tab mounts the plugins panel', () => {
    labsFlagOn = true;
    render(<ToolboxView />);

    // Default landing tab is 'skills' (mirrors the pre-flip activeToolboxTab);
    // explicitly select Plugins to see its content.
    fireEvent.click(screen.getByRole('button', { name: '插件' }));

    expect(screen.getByTestId('plugins-panel')).toBeInTheDocument();
  });
});
