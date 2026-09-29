// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DesignSystemProvider } from '@/components/ds/provider';
import { initLanguage } from '@/i18n';
import { useSettingsStore } from '@/stores/settingsStore';
import { usePluginStore } from '@/stores/pluginStore';

// The sidebar's main navigation carries ONE entry for the Extensions view —
// 「扩展」 / "Extensions" — which replaced the retired 工具箱 / Toolbox. This
// file pins the entry's label, that it opens the view, and that the
// plugin-update dot rides on it; it also pins the sidebar frame (no painted
// background, entry order, the selected entry) and the Recents row menu.
// Everything else the sidebar renders (projects, modals, account menu) is stubbed.

const chat = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
}));

vi.mock('@/stores/chatStore', () => {
  const useChatStore = (selector: (state: Record<string, unknown>) => unknown) => selector(chat.state);
  useChatStore.getState = () => chat.state;
  return { useChatStore };
});
vi.mock('@/stores/projectStore', () => ({
  useProjectStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    projects: {
      p1: { id: 'p1', name: 'Launch plan', archived: false },
      p2: { id: 'p2', name: 'Old work', archived: true },
    },
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

const CONVERSATION = { id: 'c1', title: 'Quarterly summary', createdAt: 1, messageCount: 2 };

function resetChat(overrides: Record<string, unknown> = {}) {
  chat.state = {
    conversationIndex: {},
    conversations: {},
    activeConversationId: null,
    startNewConversation: vi.fn(),
    switchConversation: vi.fn(),
    deleteConversation: vi.fn(),
    renameConversation: vi.fn(),
    clearCompletedStatus: vi.fn(),
    exportConversation: vi.fn(),
    importConversation: vi.fn(),
    loadConversation: vi.fn(),
    setConversationProject: vi.fn(),
    ...overrides,
  };
}

function renderSidebar() {
  return render(<Sidebar />, { wrapper: DesignSystemProvider });
}

function mainNav(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Main navigation' });
}

beforeAll(() => {
  // happy-dom lacks the pointer-capture and scroll APIs Radix menus call.
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

describe('Sidebar — Extensions entry', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    resetChat();
    useSettingsStore.setState({ viewMode: 'chat', activeExtensionsTab: 'plugins', guideOpen: false });
    usePluginStore.setState({ updateAvailableKeys: [], updateAvailableCount: 0 });
  });
  afterEach(() => cleanup());

  it('shows a single 「扩展」 entry and no 「工具箱」', () => {
    renderSidebar();
    const nav = within(mainNav());
    expect(nav.getByRole('button', { name: '扩展' })).toBeInTheDocument();
    expect(nav.queryByRole('button', { name: /工具箱|插件/ })).not.toBeInTheDocument();
  });

  it('reads "Extensions" in en-US', () => {
    initLanguage('en-US');
    renderSidebar();
    expect(within(mainNav()).getByRole('button', { name: 'Extensions' })).toBeInTheDocument();
    expect(within(mainNav()).queryByRole('button', { name: 'Toolbox' })).not.toBeInTheDocument();
  });

  it('opens the Extensions view on its default (plugins) tab', () => {
    useSettingsStore.setState({ activeExtensionsTab: 'mcp' });
    renderSidebar();
    fireEvent.click(within(mainNav()).getByRole('button', { name: '扩展' }));
    expect(useSettingsStore.getState().viewMode).toBe('extensions');
    expect(useSettingsStore.getState().activeExtensionsTab).toBe('plugins');
  });

  it('carries the plugin-update count when updates are available', () => {
    // The sidebar entry is the only permanently visible one, so it is where a
    // user who never opens the market learns an update exists.
    usePluginStore.setState({ updateAvailableKeys: ['a@market', 'b@market', 'c@market'], updateAvailableCount: 3 });
    renderSidebar();
    const badge = within(mainNav()).getByTestId('extensions-update-badge');
    expect(badge).toHaveTextContent('3');
    expect(badge).toHaveAttribute('aria-label', '3 个插件可更新');
  });

  it('names itself for a screen reader, pluralised, on an element that can hold a name', () => {
    initLanguage('en-US');
    usePluginStore.setState({ updateAvailableCount: 1 });
    renderSidebar();
    const one = within(mainNav()).getByTestId('extensions-update-badge');
    // A bare <span> is a generic element: an `aria-label` on it is not
    // guaranteed to be exposed at all. `role="status"` both allows the name
    // and makes the badge the polite live region it actually is.
    expect(one).toHaveAttribute('role', 'status');
    expect(one).toHaveAttribute('aria-label', '1 plugin update available');

    cleanup();
    usePluginStore.setState({ updateAvailableCount: 2 });
    renderSidebar();
    expect(within(mainNav()).getByTestId('extensions-update-badge'))
      .toHaveAttribute('aria-label', '2 plugin updates available');
  });

  it('caps the count at 9+', () => {
    usePluginStore.setState({ updateAvailableCount: 12 });
    renderSidebar();
    expect(within(mainNav()).getByTestId('extensions-update-badge')).toHaveTextContent('9+');
  });

  it('shows nothing when there is no update', () => {
    renderSidebar();
    expect(within(mainNav()).queryByTestId('extensions-update-badge')).toBeNull();
  });
});

describe('Sidebar — frame and navigation', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    resetChat();
    useSettingsStore.setState({ viewMode: 'chat', guideOpen: false });
    usePluginStore.setState({ updateAvailableKeys: [], updateAvailableCount: 0 });
  });
  afterEach(() => cleanup());

  it('paints no background of its own, so the desk shows through', () => {
    renderSidebar();
    const root = mainNav().parentElement!;
    expect(root.className.split(/\s+/).filter((name) => name.startsWith('bg-'))).toEqual([]);
  });

  it('keeps the entries, their names and their order', () => {
    renderSidebar();
    const names = within(mainNav()).getAllByRole('button').map((button) => button.textContent);
    expect(names).toEqual(['新任务', '专家', '扩展', '自动化']);
    expect(within(mainNav()).getByRole('button', { name: '新任务' })).toHaveAttribute('data-sidebar-action', 'new-task');
    expect(within(mainNav()).getByRole('button', { name: '专家' })).toHaveAttribute('data-testid', 'sidebar-team');
  });

  it('marks 新任务 as the current view on a blank chat, and only it', () => {
    renderSidebar();
    const current = within(mainNav()).getAllByRole('button').filter((button) => button.getAttribute('aria-current') === 'page');
    expect(current.map((button) => button.textContent)).toEqual(['新任务']);
    expect(current[0]).toHaveClass('bg-fill-selected');
  });

  it('moves the current mark to the view the user opened', () => {
    useSettingsStore.setState({ viewMode: 'automation' });
    renderSidebar();
    const nav = within(mainNav());
    expect(nav.getByRole('button', { name: '自动化' })).toHaveAttribute('aria-current', 'page');
    expect(nav.getByRole('button', { name: '新任务' })).not.toHaveAttribute('aria-current');
  });

  it('marks no entry while an existing task is open', () => {
    resetChat({ activeConversationId: 'c1', conversationIndex: { c1: CONVERSATION } });
    renderSidebar();
    expect(within(mainNav()).getAllByRole('button').filter((button) => button.hasAttribute('aria-current'))).toEqual([]);
  });

  it('shows the Recents header and its import action by name', () => {
    renderSidebar();
    expect(screen.getByRole('button', { name: '最近' })).toHaveClass('text-ui-sm', 'font-medium', 'text-label-tertiary');
    // The hover reveal only adds opacity classes; the button keeps its own colour transition.
    expect(screen.getByRole('button', { name: '导入会话' })).toHaveClass('opacity-0', 'transition-colors', 'duration-fast');
  });
});

describe('Sidebar — Recents row menu', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    resetChat({ conversationIndex: { c1: CONVERSATION } });
    useSettingsStore.setState({ viewMode: 'chat', guideOpen: false });
    usePluginStore.setState({ updateAvailableKeys: [], updateAvailableCount: 0 });
  });
  afterEach(() => cleanup());

  it('opens the row menu from 更多操作 without opening the task', async () => {
    const user = userEvent.setup();
    renderSidebar();
    await user.click(screen.getByRole('button', { name: '更多操作' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      '重命名', '导出会话', 'Launch plan', '删除会话',
    ]);
    expect(within(menu).getByText('移入项目')).toBeInTheDocument();
    // An open menu hides the rest of the page from screen readers.
    expect(screen.getByRole('button', { name: '更多操作', hidden: true })).toHaveAttribute('aria-expanded', 'true');
    expect(chat.state.switchConversation).not.toHaveBeenCalled();
  });

  it('moves the task into a project without also opening it', async () => {
    const user = userEvent.setup();
    renderSidebar();
    await user.click(screen.getByRole('button', { name: '更多操作' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Launch plan' }));
    expect(chat.state.setConversationProject).toHaveBeenCalledWith('c1', 'p1');
    expect(chat.state.switchConversation).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('renames in place and keeps the field focused after the menu closes', async () => {
    const user = userEvent.setup();
    renderSidebar();
    await user.click(screen.getByRole('button', { name: '更多操作' }));
    await user.click(await screen.findByRole('menuitem', { name: '重命名' }));
    const field = await screen.findByRole('textbox', { name: '重命名' });
    // Let the menu finish closing and hand focus back.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(field).toHaveFocus();
    await user.clear(field);
    await user.type(field, 'Q3 summary{Enter}');
    expect(chat.state.renameConversation).toHaveBeenCalledWith('c1', 'Q3 summary');
  });

  it('renames from the right-click menu and keeps the field focused', async () => {
    // A closing right-click menu hands focus back to whatever was focused when
    // it opened: <body>, or this row after a right mouse press. Chromium cannot
    // focus either (<body> and a div without tabindex are not focusable), so
    // the field keeps focus. happy-dom focuses <body>; mirror Chromium here.
    const bodyFocus = vi.spyOn(document.body, 'focus').mockImplementation(() => {});
    const user = userEvent.setup();
    renderSidebar();
    const row = screen.getByText('Quarterly summary').closest<HTMLElement>('[role="button"]')!;
    expect(row).toHaveAttribute('tabindex', '0');
    fireEvent.contextMenu(row);
    await user.click(await screen.findByRole('menuitem', { name: '重命名' }));
    const field = await screen.findByRole('textbox', { name: '重命名' });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(field).toHaveFocus();
    expect(field.closest('[role="button"]')).not.toHaveAttribute('tabindex');
    bodyFocus.mockRestore();
  });

  it('deletes from the menu and offers 撤销 in a notice', async () => {
    const user = userEvent.setup();
    resetChat({ conversationIndex: { c1: CONVERSATION }, exportConversation: vi.fn(() => '{"id":"c1"}') });
    renderSidebar();
    await user.click(screen.getByRole('button', { name: '更多操作' }));
    await user.click(await screen.findByRole('menuitem', { name: '删除会话' }));
    const notice = await screen.findByRole('alert');
    expect(notice).toHaveTextContent('会话已删除');
    expect(notice).toHaveAttribute('data-electron-no-drag');
    expect(chat.state.deleteConversation).toHaveBeenCalledWith('c1');
    await user.click(within(notice).getByRole('button', { name: '撤销' }));
    expect(chat.state.importConversation).toHaveBeenCalledWith('{"id":"c1"}', { keepPermissionMode: true });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('opens the same menu on right-click', async () => {
    renderSidebar();
    fireEvent.contextMenu(screen.getByText('Quarterly summary'));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: '删除会话' })).toBeInTheDocument();
  });

  it('still opens the task when the row itself is clicked', async () => {
    const user = userEvent.setup();
    renderSidebar();
    await user.click(screen.getByText('Quarterly summary'));
    expect(chat.state.switchConversation).toHaveBeenCalledWith('c1');
  });
});
