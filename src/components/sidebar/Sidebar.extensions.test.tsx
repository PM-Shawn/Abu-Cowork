// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DesignSystemProvider } from '@/components/ds/provider';
import { keepClosingLayersOnScreen } from '@/test/dsWindows';
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
const preview = vi.hoisted(() => ({ fileTreeMode: false }));
vi.mock('@/stores/previewStore', () => ({
  usePreviewStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    fileTreeMode: preview.fileTreeMode,
    setFileTreeMode: vi.fn(),
  }),
}));
vi.mock('@/components/common/GuideModal', () => ({ default: () => null }));
vi.mock('@/components/common/ProfileEditModal', () => ({ default: () => null }));
vi.mock('@/components/sidebar/AccountMenu', () => ({ default: () => null }));
vi.mock('@/components/sidebar/ProjectsSection', async () => {
  const { Button } = await import('@/components/ds/button');
  return {
    default: ({ onCreateProject }: { onCreateProject: () => void }) => <Button onClick={onCreateProject}>Stub: create a project</Button>,
  };
});
// Stands in for the create project window: in the page whether open or closed, as the real one is.
vi.mock('@/components/common/CreateProjectDialog', async () => {
  const { Button } = await import('@/components/ds/button');
  return {
    default: ({ open, onClose }: { open: boolean; onClose: () => void }) => (
      <div data-testid="create-project-window" data-open={String(open)}>
        <Button onClick={onClose}>Stub: close the window</Button>
      </div>
    ),
  };
});
vi.mock('@/components/panel/WorkspaceFileTree', () => ({ default: () => null }));
// Stands in for the export window: it shows which conversation it was opened for.
vi.mock('@/components/share/ShareExportDialog', () => ({
  default: ({ convId }: { convId: string }) => <div data-testid="share-export-window" data-conversation={convId} />,
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({ readTextFile: vi.fn() }));
vi.mock('@/utils/platform', () => ({ isMacOS: () => true, isWindows: () => false }));

import Sidebar from './Sidebar';
import { UNDO_OFFER_MS } from './undoOffer';
import ToasterMount from '@/components/common/ToasterMount';
import { setToastPlacesForDecision, useToastStore } from '@/stores/toastStore';

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
    expect(menu).toHaveAccessibleName('更多操作');
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      '重命名', '导出会话', '移入项目', '删除会话',
    ]);
    // An open menu hides the rest of the page from screen readers.
    expect(screen.getByRole('button', { name: '更多操作', hidden: true })).toHaveAttribute('aria-expanded', 'true');
    expect(chat.state.switchConversation).not.toHaveBeenCalled();
  });

  it('lists the projects inside the 移入项目 submenu', async () => {
    const user = userEvent.setup();
    renderSidebar();
    await user.click(screen.getByRole('button', { name: '更多操作' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: 'Launch plan' })).toBeNull();
    await user.click(within(menu).getByRole('menuitem', { name: '移入项目' }));
    const project = await screen.findByRole('menuitem', { name: 'Launch plan' });
    const submenu = project.closest('[role="menu"]');
    expect(submenu).not.toBe(menu);
    expect(submenu).toHaveAttribute('data-electron-no-drag');
  });

  it('moves the task into a project without also opening it', async () => {
    const user = userEvent.setup();
    renderSidebar();
    await user.click(screen.getByRole('button', { name: '更多操作' }));
    await user.click(await screen.findByRole('menuitem', { name: '移入项目' }));
    // Choose it from the keyboard: happy-dom has no layout for Radix's pointer path into
    // a submenu. The pointer path is covered by the real shell check.
    await user.keyboard('{ArrowRight}');
    expect(await screen.findByRole('menuitem', { name: 'Launch plan' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(chat.state.setConversationProject).toHaveBeenCalledWith('c1', 'p1');
    expect(chat.state.switchConversation).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  describe('rename', () => {
    // The rename field mounts from Radix's focus-scope timer once the menu has gone.
    beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
    afterEach(() => { vi.useRealTimers(); });

    it('renames in place from 更多操作 and keeps the field focused after the menu closes', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderSidebar();
      await user.click(screen.getByRole('button', { name: '更多操作' }));
      await user.click(await screen.findByRole('menuitem', { name: '重命名' }));
      await act(() => vi.runOnlyPendingTimersAsync());
      const field = screen.getByRole('textbox', { name: '重命名' });
      await act(() => vi.runOnlyPendingTimersAsync());
      expect(field).toHaveFocus();
      await user.clear(field);
      await user.type(field, 'Q3 summary{Enter}');
      expect(chat.state.renameConversation).toHaveBeenCalledWith('c1', 'Q3 summary');
    });

    it('renames from the right-click menu and keeps the field focused', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderSidebar();
      const row = screen.getByText('Quarterly summary').closest<HTMLElement>('[role="button"]')!;
      act(() => row.focus());
      fireEvent.contextMenu(row);
      await user.click(await screen.findByRole('menuitem', { name: '重命名' }));
      await act(() => vi.runOnlyPendingTimersAsync());
      const field = screen.getByRole('textbox', { name: '重命名' });
      await act(() => vi.runOnlyPendingTimersAsync());
      expect(field).toHaveFocus();
      expect(field.closest('[role="button"]')).toHaveAttribute('tabindex', '0');
    });
  });

  // The export window is a dialog that gives the focus back to where it was when it opened, so
  // it opens from the menu's close-focus hook, after the menu has returned the focus.
  describe('export', () => {
    beforeEach(() => {
      // The menu's close-focus hook runs from a timer; the tests run it themselves.
      vi.useFakeTimers();
      resetChat({ conversationIndex: { c1: CONVERSATION }, loadConversation: vi.fn(async () => undefined) });
    });
    afterEach(() => { vi.useRealTimers(); });

    const openRowMenu = () => {
      const more = screen.getByRole('button', { name: '更多操作' });
      act(() => more.focus());
      fireEvent.pointerDown(more, { button: 0 });
      return more;
    };

    it('reads the conversation and opens the window only once the menu has gone, with the focus back on the row button', async () => {
      renderSidebar();
      const more = openRowMenu();

      fireEvent.click(screen.getByRole('menuitem', { name: '导出会话' }));
      expect(chat.state.loadConversation).not.toHaveBeenCalled();
      expect(screen.queryByTestId('share-export-window')).toBeNull();

      await act(() => vi.runOnlyPendingTimersAsync());
      expect(chat.state.loadConversation).toHaveBeenCalledWith('c1');
      expect(screen.getByTestId('share-export-window')).toHaveAttribute('data-conversation', 'c1');
      expect(more).toHaveFocus();
    });

    it('opens no window for a choice made in a menu that was opened again before it had gone', async () => {
      const fades = keepClosingLayersOnScreen();
      renderSidebar();
      const more = openRowMenu();
      fireEvent.click(screen.getByRole('menuitem', { name: '导出会话' }));

      // Still on the page, fading: the row button opens it again.
      fireEvent.pointerDown(more, { button: 0 });
      fades.mockRestore();
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
      await act(() => vi.runOnlyPendingTimersAsync());

      expect(screen.queryByRole('menu')).toBeNull();
      expect(chat.state.loadConversation).not.toHaveBeenCalled();
      expect(screen.queryByTestId('share-export-window')).toBeNull();
    });
  });

  // The offer is a notification like any other: it is in the app's list, so it takes a press
  // while a window is open and follows the list's rules.
  describe('the undo offer after a delete', () => {
    const OTHER = { id: 'c2', title: 'Travel plan', createdAt: 2, messageCount: 1 };
    const offer = () => within(screen.getByRole('region', { name: '通知' })).queryByText('会话已删除')?.closest('li') ?? null;
    const clearNotices = () => {
      for (const toast of useToastStore.getState().toasts) useToastStore.getState().removeToast(toast.id);
    };
    const renderSidebar = () => render(<><Sidebar /><ToasterMount /></>, { wrapper: DesignSystemProvider });
    beforeEach(() => {
      // Time moves only when a test moves it: the offer's five seconds are counted, not waited for.
      vi.useFakeTimers();
      // Testing Library waits one zero-length timer after each user action and moves a fake
      // clock itself only through a global named `jest`; this hands it Vitest's clock.
      vi.stubGlobal('jest', { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) });
      clearNotices();
      resetChat({
        conversationIndex: { c1: CONVERSATION, c2: OTHER },
        exportConversation: vi.fn((id: string) => `{"id":"${id}"}`),
      });
    });
    afterEach(() => {
      act(() => clearNotices());
      vi.unstubAllGlobals();
      vi.useRealTimers();
    });

    it('is a notification with 撤销, and the press brings the conversation back', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderSidebar();
      await deleteRow(user, 'Quarterly summary');
      expect(chat.state.deleteConversation).toHaveBeenCalledWith('c1');
      expect(screen.queryByRole('alert')).toBeNull();
      expect(useToastStore.getState().toasts.map((toast) => [toast.type, toast.title, toast.duration, toast.actions?.map((action) => action.label)]))
        .toEqual([['info', '会话已删除', UNDO_OFFER_MS, ['撤销']]]);

      // A notification that has just appeared takes no pointer press for a moment.
      await act(() => vi.advanceTimersByTimeAsync(600));
      await user.click(within(offer()!).getByRole('button', { name: '撤销' }));

      expect(chat.state.importConversation).toHaveBeenCalledWith('{"id":"c1"}', { keepPermissionMode: true });
      expect(offer()).toBeNull();
    });

    it('is offered for five seconds', () => {
      expect(UNDO_OFFER_MS).toBe(5000);
    });

    async function deleteRow(user: ReturnType<typeof userEvent.setup>, title: string) {
      const row = screen.getByText(title).closest<HTMLElement>('[role="button"]')!;
      await user.click(within(row).getByRole('button', { name: '更多操作' }));
      await user.click(screen.getByRole('menuitem', { name: '删除会话' }));
      await act(() => vi.advanceTimersByTimeAsync(0));
    }

    it('stays for five seconds and then goes, with nothing restored', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderSidebar();
      await deleteRow(user, 'Quarterly summary');
      expect(offer()).toHaveTextContent('会话已删除');

      await act(() => vi.advanceTimersByTimeAsync(4000));
      expect(offer()).not.toBeNull();
      await act(() => vi.advanceTimersByTimeAsync(1100));
      expect(offer()).toBeNull();
      expect(chat.state.importConversation).not.toHaveBeenCalled();
    });

    it('is one offer for the last delete only, and its five seconds start again', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderSidebar();
      await deleteRow(user, 'Quarterly summary');
      await act(() => vi.advanceTimersByTimeAsync(3000));
      await deleteRow(user, 'Travel plan');
      expect(screen.getAllByRole('button', { name: '撤销' })).toHaveLength(1);

      // Three seconds after the second delete, more than five after the first.
      await act(() => vi.advanceTimersByTimeAsync(3000));
      expect(offer()).not.toBeNull();
      await user.click(screen.getByRole('button', { name: '撤销' }));

      expect(chat.state.importConversation).toHaveBeenCalledTimes(1);
      expect(chat.state.importConversation).toHaveBeenCalledWith('{"id":"c2"}', { keepPermissionMode: true });
      expect(offer()).toBeNull();
    });

    it('stays when another task is opened', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderSidebar();
      await deleteRow(user, 'Quarterly summary');

      await user.click(screen.getByText('Travel plan'));

      expect(chat.state.switchConversation).toHaveBeenCalledWith('c2');
      expect(offer()).not.toBeNull();
    });

    // While an approval or a question shows, the list has one place: a newer notification pushes
    // the offer out, and it returns with the time it had left. An offer that is on screen undoes,
    // however long ago the delete was.
    it('still brings the conversation back when it returns after a newer notification pushed it out', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderSidebar();
      act(() => setToastPlacesForDecision(true));
      try {
        await deleteRow(user, 'Quarterly summary');
        await act(() => vi.advanceTimersByTimeAsync(2000));
        act(() => useToastStore.getState().addToast({ type: 'warning', title: 'A newer notice', duration: 0 }));
        expect(offer()).toBeNull();

        // A minute passes: twelve times the offer's own five seconds.
        await act(() => vi.advanceTimersByTimeAsync(60_000));
        expect(chat.state.importConversation).not.toHaveBeenCalled();
        const newer = useToastStore.getState().toasts.find((toast) => toast.title === 'A newer notice')!;
        act(() => useToastStore.getState().removeToast(newer.id));
        expect(offer()).not.toBeNull();

        await act(() => vi.advanceTimersByTimeAsync(600));
        await user.click(within(offer()!).getByRole('button', { name: '撤销' }));

        expect(chat.state.importConversation).toHaveBeenCalledTimes(1);
        expect(chat.state.importConversation).toHaveBeenCalledWith('{"id":"c1"}', { keepPermissionMode: true });
        expect(offer()).toBeNull();
      } finally {
        act(() => setToastPlacesForDecision(false));
      }
    });

    it('is not made when the conversation could not be read for it; the delete still happens', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      resetChat({ conversationIndex: { c1: CONVERSATION, c2: OTHER }, exportConversation: vi.fn(() => null) });
      renderSidebar();
      await deleteRow(user, 'Quarterly summary');

      expect(chat.state.deleteConversation).toHaveBeenCalledWith('c1');
      expect(offer()).toBeNull();
    });

    it('reads the conversation before it deletes it', async () => {
      const order: string[] = [];
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      resetChat({
        conversationIndex: { c1: CONVERSATION, c2: OTHER },
        loadConversation: vi.fn(async () => { order.push('load'); }),
        exportConversation: vi.fn(() => { order.push('export'); return '{"id":"c1"}'; }),
        deleteConversation: vi.fn(() => { order.push('delete'); }),
      });
      renderSidebar();
      await deleteRow(user, 'Quarterly summary');

      expect(order).toEqual(['load', 'export', 'delete']);
    });

    // The row leaves under the focus: it goes on to a row, never to the window and never to the offer.
    describe('and the keyboard focus', () => {
      const page = <><Sidebar /><ToasterMount /></>;
      // The store here is a plain object: the delete takes the conversation out of it, and the
      // test draws the sidebar again, as the store's change does in the app.
      const removesFromTheList = () => vi.fn((id: string) => {
        const index = { ...(chat.state.conversationIndex as Record<string, unknown>) };
        delete index[id];
        chat.state = { ...chat.state, conversationIndex: index };
      });
      const rowOf = (title: string) => screen.getByText(title).closest<HTMLElement>('[role="button"]')!;

      it('goes to the row that took the deleted one\'s place, and the offer is not given it', async () => {
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        resetChat({
          conversationIndex: { c1: CONVERSATION, c2: OTHER },
          exportConversation: vi.fn((id: string) => `{"id":"${id}"}`),
          deleteConversation: removesFromTheList(),
        });
        const view = renderSidebar();
        // The newest conversation is the first row.
        await deleteRow(user, 'Travel plan');
        act(() => view.rerender(page));

        expect(screen.queryByText('Travel plan')).toBeNull();
        expect(rowOf('Quarterly summary')).toHaveFocus();
        expect(offer()).not.toBeNull();
        expect(offer()!.contains(document.activeElement)).toBe(false);
      });

      it('goes to the row before it when the last row is deleted', async () => {
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        resetChat({
          conversationIndex: { c1: CONVERSATION, c2: OTHER },
          exportConversation: vi.fn((id: string) => `{"id":"${id}"}`),
          deleteConversation: removesFromTheList(),
        });
        const view = renderSidebar();
        await deleteRow(user, 'Quarterly summary');
        act(() => view.rerender(page));

        expect(rowOf('Travel plan')).toHaveFocus();
      });

      it('goes to 新任务 when no row is left', async () => {
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        resetChat({
          conversationIndex: { c1: CONVERSATION },
          exportConversation: vi.fn((id: string) => `{"id":"${id}"}`),
          deleteConversation: removesFromTheList(),
        });
        const view = renderSidebar();
        await deleteRow(user, 'Quarterly summary');
        act(() => view.rerender(page));

        expect(within(mainNav()).getByRole('button', { name: '新任务' })).toHaveFocus();
      });

      it('stays where the user has put it meanwhile', async () => {
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        resetChat({
          conversationIndex: { c1: CONVERSATION, c2: OTHER },
          exportConversation: vi.fn((id: string) => `{"id":"${id}"}`),
          deleteConversation: removesFromTheList(),
        });
        const view = renderSidebar();
        await deleteRow(user, 'Travel plan');
        const elsewhere = within(mainNav()).getByRole('button', { name: '扩展' });
        act(() => { elsewhere.focus(); });
        act(() => view.rerender(page));

        expect(elsewhere).toHaveFocus();
      });
    });
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

  // Tab reaches a row; Enter and Space on the row open the task as a click does.
  describe('from the keyboard', () => {
    const row = () => screen.getByText('Quarterly summary').closest<HTMLElement>('[role="button"]')!;

    it.each([['Enter', 'Enter'], [' ', 'Space']])('opens the task with %j pressed on the row, and the page does not scroll', (key, code) => {
      renderSidebar();
      expect(row().tabIndex).toBe(0);

      // fireEvent returns false once the default was prevented.
      expect(fireEvent.keyDown(row(), { key, code })).toBe(false);

      expect(chat.state.switchConversation).toHaveBeenCalledExactlyOnceWith('c1');
      expect(useSettingsStore.getState().viewMode).toBe('chat');
    });

    // The focus is handed to the neighbouring row after a delete; a key still down repeats there.
    it('opens nothing on the repeats of a held Enter or Space', () => {
      renderSidebar();

      expect(fireEvent.keyDown(row(), { key: 'Enter', code: 'Enter', repeat: true })).toBe(false);
      expect(fireEvent.keyDown(row(), { key: ' ', code: 'Space', repeat: true })).toBe(false);

      expect(chat.state.switchConversation).not.toHaveBeenCalled();
    });

    it('leaves keys pressed on the row\'s 更多操作 to that button, and other keys alone', () => {
      renderSidebar();

      fireEvent.keyDown(screen.getByRole('button', { name: '更多操作' }), { key: 'Enter', code: 'Enter' });
      expect(fireEvent.keyDown(row(), { key: 'Tab', code: 'Tab' })).toBe(true);
      expect(fireEvent.keyDown(row(), { key: 'ArrowDown', code: 'ArrowDown' })).toBe(true);

      expect(chat.state.switchConversation).not.toHaveBeenCalled();
    });
  });
});

describe('Sidebar — the create project window', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    resetChat();
    preview.fileTreeMode = false;
    useSettingsStore.setState({ viewMode: 'chat', guideOpen: false });
  });
  afterEach(() => {
    cleanup();
    preview.fileTreeMode = false;
  });

  const createWindow = () => screen.getByTestId('create-project-window');

  it('opens from the projects section and closes when the window says so', () => {
    renderSidebar();
    expect(createWindow()).toHaveAttribute('data-open', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'Stub: create a project' }));
    expect(createWindow()).toHaveAttribute('data-open', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Stub: close the window' }));
    expect(createWindow()).toHaveAttribute('data-open', 'false');
  });

  // A created project turns the sidebar to its file tree, which takes the projects section off
  // the page. The window belongs to the sidebar, so it is closed and not taken off with it.
  it('stays in the page, as open as it was, when the sidebar turns to the file tree', () => {
    const view = renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Stub: create a project' }));
    const before = createWindow();

    preview.fileTreeMode = true;
    view.rerender(<Sidebar />);

    expect(screen.queryByRole('button', { name: 'Stub: create a project' })).not.toBeInTheDocument();
    expect(createWindow()).toBe(before);
    expect(createWindow()).toHaveAttribute('data-open', 'true');
  });
});
