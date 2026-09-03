// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { initLanguage } from '@/i18n';
import { useSettingsStore } from '@/stores/settingsStore';
import { usePluginStore } from '@/stores/pluginStore';

// The sidebar's main navigation carries ONE entry for the Extensions view —
// 「扩展」 / "Extensions" — which replaced the retired 工具箱 / Toolbox. This
// file pins the entry's label, that it opens the view, and that the
// plugin-update dot rides on it. Everything the sidebar renders besides the
// navigation (conversation list, modals, account menu) is stubbed.

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    conversationIndex: [],
    conversations: new Map(),
    activeConversationId: null,
    startNewConversation: vi.fn(),
    switchConversation: vi.fn(),
    deleteConversation: vi.fn(),
    renameConversation: vi.fn(),
    clearCompletedStatus: vi.fn(),
    exportConversation: vi.fn(),
    importConversation: vi.fn(),
    loadConversation: vi.fn(),
  }),
}));
vi.mock('@/stores/projectStore', () => ({
  useProjectStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    projects: new Map(),
    addConversationToProject: vi.fn(),
    removeConversationFromProject: vi.fn(),
  }),
}));
vi.mock('@/stores/noticeBadgeStore', () => ({
  useNoticeBadgeStore: (selector: (state: Record<string, unknown>) => unknown) => selector({ clear: vi.fn() }),
}));
vi.mock('@/stores/inboxStore', () => ({
  useInboxStore: (selector: (state: Record<string, unknown>) => unknown) => selector({ getPendingCount: () => 0 }),
}));
vi.mock('@/stores/previewStore', () => ({
  usePreviewStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    fileTreeMode: false,
    setFileTreeMode: vi.fn(),
  }),
}));
vi.mock('@/components/common/GuideModal', () => ({ default: () => null }));
vi.mock('@/components/common/ProfileEditModal', () => ({ default: () => null }));
vi.mock('@/components/sidebar/AccountMenu', () => ({ default: () => null }));
vi.mock('@/components/sidebar/ProjectsSection', () => ({ default: () => null }));
vi.mock('@/components/panel/WorkspaceFileTree', () => ({ default: () => null }));
vi.mock('@/components/share/ShareExportDialog', () => ({ default: () => null }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({ readTextFile: vi.fn() }));
vi.mock('@/utils/platform', () => ({ isMacOS: () => true, isWindows: () => false }));

import Sidebar from './Sidebar';

function mainNav(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Main navigation' });
}

describe('Sidebar — Extensions entry', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    useSettingsStore.setState({ viewMode: 'chat', activeExtensionsTab: 'plugins', guideOpen: false });
    usePluginStore.setState({ updateAvailableKeys: [] });
  });
  afterEach(() => cleanup());

  it('shows a single 「扩展」 entry and no 「工具箱」', () => {
    render(<Sidebar />);
    const nav = within(mainNav());
    expect(nav.getByRole('button', { name: '扩展' })).toBeInTheDocument();
    expect(nav.queryByRole('button', { name: /工具箱|插件/ })).not.toBeInTheDocument();
  });

  it('reads "Extensions" in en-US', () => {
    initLanguage('en-US');
    render(<Sidebar />);
    expect(within(mainNav()).getByRole('button', { name: 'Extensions' })).toBeInTheDocument();
    expect(within(mainNav()).queryByRole('button', { name: 'Toolbox' })).not.toBeInTheDocument();
  });

  it('opens the Extensions view on its default (plugins) tab', () => {
    useSettingsStore.setState({ activeExtensionsTab: 'mcp' });
    render(<Sidebar />);
    fireEvent.click(within(mainNav()).getByRole('button', { name: '扩展' }));
    expect(useSettingsStore.getState().viewMode).toBe('extensions');
    expect(useSettingsStore.getState().activeExtensionsTab).toBe('plugins');
  });

  it('carries the plugin-update dot when updates are available', () => {
    usePluginStore.setState({ updateAvailableKeys: ['market/plugin-a'] });
    render(<Sidebar />);
    const entry = within(mainNav()).getByRole('button', { name: /扩展/ });
    expect(within(entry).getByLabelText(/1/)).toBeInTheDocument();
  });
});
