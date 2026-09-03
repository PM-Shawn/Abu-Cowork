// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type ExtensionsTab = 'plugins' | 'skills' | 'mcp';

const settingsState = {
  activeExtensionsTab: 'skills' as ExtensionsTab,
  closeExtensions: vi.fn(),
  setActiveExtensionsTab: vi.fn(),
  extensionsSearchQuery: '',
  setExtensionsSearchQuery: vi.fn((value: string) => {
    settingsState.extensionsSearchQuery = value;
  }),
};

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: () => settingsState,
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
        personalSource: 'Mine', organizationSource: 'Organization',
        searchPlaceholder: 'Search', importEntry: 'Import', aiCreateSkillPrompt: '',
      },
    },
  }),
}));

vi.mock('@/core/enterprise/mounts-registry', () => ({
  getEnterpriseMount: () => ({ searchQuery = '' }: { searchQuery?: string }) => (
    <div data-testid="organization-catalog">Organization catalog: {searchQuery}</div>
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

describe('Extensions capability sources', () => {
  beforeEach(() => {
    settingsState.activeExtensionsTab = 'skills';
    settingsState.extensionsSearchQuery = '';
    vi.clearAllMocks();
  });

  it('keeps personal create actions separate from the organization catalog', async () => {
    const { rerender } = render(<ExtensionsView />);

    expect(screen.getByText('Personal skills')).toBeInTheDocument();
    expect(screen.getByTestId('create-control')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Organization' }));

    expect(await screen.findByTestId('organization-catalog')).toBeInTheDocument();
    expect(screen.queryByTestId('create-control')).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Search'), { target: { value: 'finance' } });
    rerender(<ExtensionsView />);
    await waitFor(() => {
      expect(screen.getByTestId('organization-catalog')).toHaveTextContent('finance');
    });
  });

  it('offers the 个人/组织 switch on every tab for a bound enterprise client', () => {
    render(<ExtensionsView />);
    expect(screen.getByRole('button', { name: 'Organization' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Plugins' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connectors' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Agents' })).not.toBeInTheDocument();
  });
});
