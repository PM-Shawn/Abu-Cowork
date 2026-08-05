import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const settingsState = {
  activeToolboxTab: 'skills' as const,
  closeToolbox: vi.fn(),
  setActiveToolboxTab: vi.fn(),
  toolboxSearchQuery: '',
  setToolboxSearchQuery: vi.fn((value: string) => {
    settingsState.toolboxSearchQuery = value;
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

vi.mock('@/stores/discoveryStore', () => ({
  useDiscoveryStore: (selector: (state: Record<string, unknown>) => unknown) => selector({ refresh: vi.fn() }),
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
        skills: 'Skills', agents: 'Agents', mcp: 'MCP', personalSource: 'Mine', organizationSource: 'Organization',
        searchPlaceholder: 'Search', uploadFile: 'Upload', importEntry: 'Import', aiCreateAgentPrompt: '',
        aiCreateSkillPrompt: '', uploadFailed: '', uploadSuccess: '', uploadSuccessDetail: '',
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
vi.mock('../customize/AgentsSection', () => ({ default: () => <div>Personal agents</div> }));
vi.mock('../customize/MCPSection', () => ({ default: () => <div>Personal MCP</div> }));
vi.mock('@/components/toolbox/TopTabNav', () => ({
  default: ({ items, right }: { items: Array<{ id: string; label: string }>; right: ReactNode }) => (
    <div>{items.map(item => <button key={item.id}>{item.label}</button>)}{right}</div>
  ),
}));
vi.mock('@/components/toolbox/ToolboxCreateMenu', () => ({
  default: () => <button data-testid="create-control">Add</button>,
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('@/core/skill/installer', () => ({ installSkillFromFolder: vi.fn() }));
vi.mock('@/core/agent/installer', () => ({ installAgentFromFolder: vi.fn() }));
vi.mock('@/stores/toastStore', () => ({ useToastStore: { getState: () => ({ addToast: vi.fn() }) } }));

import ToolboxView from './ToolboxModal';

describe('Toolbox capability sources', () => {
  beforeEach(() => {
    settingsState.toolboxSearchQuery = '';
    vi.clearAllMocks();
  });

  it('keeps personal create actions separate from the organization catalog', async () => {
    const { rerender } = render(<ToolboxView />);

    expect(screen.getByText('Personal skills')).toBeInTheDocument();
    expect(screen.getByTestId('create-control')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Organization' }));

    expect(await screen.findByTestId('organization-catalog')).toBeInTheDocument();
    expect(screen.queryByTestId('create-control')).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Search'), { target: { value: 'finance' } });
    rerender(<ToolboxView />);
    await waitFor(() => {
      expect(screen.getByTestId('organization-catalog')).toHaveTextContent('finance');
    });
  });
});
