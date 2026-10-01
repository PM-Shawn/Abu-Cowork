// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
/**
 * Tests for the per-project conversation list in the sidebar.
 *
 * Regression: a project folder only rendered the first 5 conversations and
 * offered a "+N more" button, but that button was wired to `toggleExpanded`
 * — the folder's own collapse toggle. Since "+N more" only renders while the
 * folder is already expanded, clicking it collapsed the whole folder instead
 * of revealing the older conversations. Users with many conversations under a
 * project could never reach conversations 6..N ("点击 more 没反应，无法展开").
 *
 * The rest pins the task rows (selected, running), the row and project menus,
 * and rename.
 */
import type { ComponentProps } from 'react';
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest';
import { act, render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DesignSystemProvider } from '@/components/ds/provider';
import { initLanguage } from '@/i18n';
import ProjectItem from './ProjectItem';
import type { Project } from '@/types/project';
import type { ConversationMeta } from '@/core/session/conversationStorage';

const mocks = vi.hoisted(() => ({
  chat: {} as Record<string, unknown>,
  project: {} as Record<string, unknown>,
  viewMode: 'chat',
}));

// What the menus were given, to drive a menu the way Radix does when it is opened again
// before its close hook ran (happy-dom has no animations), and how many menus are mounted.
const menuProps = vi.hoisted(() => ({
  contextMenus: new Map<string, ((open: boolean) => void) | undefined>(),
  menus: new Map<string, ((open: boolean) => void) | undefined>(),
  itemSelect: new Map<string, ((event: Event) => void) | undefined>(),
}));

vi.mock('@/components/ds/context-menu', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ds/context-menu')>();
  const { useId } = await import('react');
  return {
    ...actual,
    ContextMenu: (props: ComponentProps<typeof actual.ContextMenu>) => {
      menuProps.contextMenus.set(useId(), props.onOpenChange);
      return actual.ContextMenu(props);
    },
  };
});

vi.mock('@/components/ds/menu', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ds/menu')>();
  const { useId } = await import('react');
  return {
    ...actual,
    Menu: (props: ComponentProps<typeof actual.Menu>) => {
      menuProps.menus.set(useId(), props.onOpenChange);
      return actual.Menu(props);
    },
    MenuItem: (props: ComponentProps<typeof actual.MenuItem>) => {
      if (typeof props.children === 'string') menuProps.itemSelect.set(props.children, props.onSelect);
      return actual.MenuItem(props);
    },
  };
});

vi.mock('./ImportedBadge', () => ({ default: () => null }));
vi.mock('@/components/share/ShareExportDialog', () => ({ default: () => null }));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (sel: (s: Record<string, unknown>) => unknown) => sel(mocks.chat),
}));

vi.mock('@/stores/projectStore', () => ({
  useProjectStore: (sel: (s: Record<string, unknown>) => unknown) => sel(mocks.project),
}));

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ setViewMode: vi.fn(), viewMode: mocks.viewMode }),
}));

function makeConv(i: number): ConversationMeta {
  return {
    id: `c${i}`,
    title: `对话${i}`,
    createdAt: 0,
    updatedAt: 0,
    messageCount: 1,
  };
}

const project: Project = {
  id: 'p1',
  name: 'fastapi-bridge-dev',
  workspacePath: '/tmp/fastapi-bridge-dev',
  pinned: false,
  archived: false,
  createdAt: 0,
  updatedAt: 0,
  lastActiveAt: 0,
};

function renderItem(convs: ConversationMeta[], props: Partial<Parameters<typeof ProjectItem>[0]> = {}) {
  return render(
    <ProjectItem
      project={project}
      conversations={convs}
      expanded={true}
      onNewTask={vi.fn()}
      onOpenSettings={vi.fn()}
      {...props}
    />,
    { wrapper: DesignSystemProvider },
  );
}

beforeAll(() => {
  // happy-dom lacks the pointer-capture and scroll APIs Radix menus call.
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
  initLanguage('zh-CN');
  menuProps.contextMenus.clear();
  menuProps.menus.clear();
  menuProps.itemSelect.clear();
  mocks.viewMode = 'chat';
  mocks.chat = {
    switchConversation: vi.fn(),
    deleteConversation: vi.fn(),
    renameConversation: vi.fn(),
    loadConversation: vi.fn(() => Promise.resolve()),
    activeConversationId: null,
    conversations: {},
    conversationIndex: {},
    setConversationProject: vi.fn(),
  };
  mocks.project = {
    toggleExpanded: vi.fn(),
    togglePin: vi.fn(),
    archiveProject: vi.fn(),
    deleteProject: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
});

describe('ProjectItem — "+N more" expander', () => {
  it('reveals the remaining conversations without collapsing the folder', async () => {
    renderItem(Array.from({ length: 8 }, (_, i) => makeConv(i)));

    // Only the first 5 are shown initially.
    expect(screen.getByText('对话0')).toBeInTheDocument();
    expect(screen.getByText('对话4')).toBeInTheDocument();
    expect(screen.queryByText('对话5')).not.toBeInTheDocument();

    // Click "+N more" (3 hidden).
    await userEvent.click(screen.getByRole('button', { name: /还有 3 个/ }));

    // Now all 8 are visible…
    expect(screen.getByText('对话5')).toBeInTheDocument();
    expect(screen.getByText('对话7')).toBeInTheDocument();
    // …and the folder was NOT collapsed.
    expect(mocks.project.toggleExpanded).not.toHaveBeenCalled();
  });

  it('collapses the extra conversations again via "show less"', async () => {
    renderItem(Array.from({ length: 8 }, (_, i) => makeConv(i)));

    await userEvent.click(screen.getByRole('button', { name: /还有 3 个/ }));
    expect(screen.getByText('对话7')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '收起' }));
    expect(screen.queryByText('对话7')).not.toBeInTheDocument();
    expect(screen.getByText('对话4')).toBeInTheDocument();
    expect(mocks.project.toggleExpanded).not.toHaveBeenCalled();
  });
});

describe('ProjectItem — project row', () => {
  it('toggles the folder from its name and keeps 新任务 beside it', async () => {
    const onNewTask = vi.fn();
    renderItem([], { onNewTask });
    const header = screen.getByRole('button', { name: 'fastapi-bridge-dev' });
    await userEvent.click(header);
    expect(mocks.project.toggleExpanded).toHaveBeenCalledWith('p1');
    // The E2E specs find 新任务 as a sibling of the project name.
    await userEvent.click(within(header.parentElement!).getByRole('button', { name: '新任务' }));
    expect(onNewTask).toHaveBeenCalledWith('p1');
  });

  it('asks before deleting the project from its right-click menu, and unlinks its tasks', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderItem([makeConv(0)]);
      fireEvent.contextMenu(screen.getByRole('button', { name: 'fastapi-bridge-dev' }));
      await user.click(await screen.findByRole('menuitem', { name: '删除' }));
      // The question opens once the menu has gone.
      await act(() => vi.runOnlyPendingTimersAsync());
      const question = await screen.findByRole('alertdialog', { name: '删除项目' });
      expect(mocks.project.deleteProject).not.toHaveBeenCalled();
      await user.click(within(question).getByRole('button', { name: '删除' }));
      expect(mocks.chat.setConversationProject).toHaveBeenCalledWith('c0', undefined);
      expect(mocks.project.deleteProject).toHaveBeenCalledWith('p1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens project settings only after the menu has gone, with focus off the row behind it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const onOpenSettings = vi.fn();
      renderItem([], { onOpenSettings });
      const header = screen.getByRole('button', { name: 'fastapi-bridge-dev' });
      act(() => header.focus());
      fireEvent.contextMenu(header);
      await user.click(await screen.findByRole('menuitem', { name: '项目设置' }));
      await act(() => vi.runOnlyPendingTimersAsync());
      expect(screen.queryByRole('menu')).toBeNull();
      expect(onOpenSettings).toHaveBeenCalledWith('p1');
      // The settings dialog is a legacy one that takes no focus: Enter on the row
      // behind it must not act, so focus stays on the page body.
      expect(document.activeElement).toBe(document.body);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets the menu give focus back to the row before the archive question takes it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const focused: Element[] = [];
    const record = (event: FocusEvent) => { focused.push(event.target as Element); };
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderItem([]);
      const header = screen.getByRole('button', { name: 'fastapi-bridge-dev' });
      act(() => header.focus());
      fireEvent.contextMenu(header);
      const archive = await screen.findByRole('menuitem', { name: '归档' });
      document.addEventListener('focusin', record);
      await user.click(archive);
      await act(() => vi.runOnlyPendingTimersAsync());
      const question = await screen.findByRole('alertdialog', { name: '归档项目' });
      // The question is a ds dialog: it remembers the row as where focus was, so the
      // menu must not keep focus off the row the way it does for legacy dialogs.
      const rowAt = focused.lastIndexOf(header);
      expect(rowAt).toBeGreaterThanOrEqual(0);
      expect(focused.slice(rowAt + 1).every((el) => question.contains(el))).toBe(true);
      expect(question).toContainElement(document.activeElement as HTMLElement);
      await user.click(within(question).getByRole('button', { name: '取消' }));
      await act(() => vi.runOnlyPendingTimersAsync());
      expect(mocks.project.archiveProject).not.toHaveBeenCalled();
      // Answering gives focus back to the row that asked.
      expect(header).toHaveFocus();
    } finally {
      document.removeEventListener('focusin', record);
      vi.useRealTimers();
    }
  });
});

// A menu opened again during its exit animation gets new content, and the close hook of
// the content it replaces runs at once. A choice recorded before must be forgotten when
// a menu opens, or it would be carried out under the new menu.
describe('ProjectItem — a menu opened again before its close hook ran', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); });

  it('forgets 项目设置 chosen in the project menu', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onOpenSettings = vi.fn();
    renderItem([], { onOpenSettings });
    fireEvent.contextMenu(screen.getByRole('button', { name: 'fastapi-bridge-dev' }));
    act(() => menuProps.itemSelect.get('项目设置')?.(new Event('select')));
    // The project menu is the first one mounted.
    act(() => [...menuProps.contextMenus.values()][0]?.(true));
    await user.keyboard('{Escape}');
    await act(() => vi.runOnlyPendingTimersAsync());
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onOpenSettings).not.toHaveBeenCalled();
  });

  it('forgets 重命名 chosen in a task row menu, opened by right-click', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderItem([makeConv(0)]);
    fireEvent.contextMenu(screen.getByText('对话0'));
    act(() => menuProps.itemSelect.get('重命名')?.(new Event('select')));
    act(() => [...menuProps.contextMenus.values()][1]?.(true));
    await user.keyboard('{Escape}');
    await act(() => vi.runOnlyPendingTimersAsync());
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.queryByRole('textbox', { name: '重命名' })).toBeNull();
  });

  it('forgets 重命名 chosen in a task row menu, opened from 更多操作', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderItem([makeConv(0)]);
    await user.click(screen.getByRole('button', { name: '更多操作' }));
    act(() => menuProps.itemSelect.get('重命名')?.(new Event('select')));
    act(() => [...menuProps.menus.values()][0]?.(true));
    await user.keyboard('{Escape}');
    await act(() => vi.runOnlyPendingTimersAsync());
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.queryByRole('textbox', { name: '重命名' })).toBeNull();
  });
});

describe('ProjectItem — task rows', () => {
  it('marks the open task and shows a spinner on a running one', () => {
    mocks.chat.activeConversationId = 'c0';
    mocks.chat.conversations = { c1: { status: 'running' } };
    renderItem([makeConv(0), makeConv(1)]);
    const selected = screen.getByText('对话0').closest('[role="button"]');
    expect(selected).toHaveAttribute('aria-current', 'true');
    expect(selected).toHaveClass('bg-fill-selected');
    const running = screen.getByText('对话1').closest('[role="button"]') as HTMLElement;
    expect(running).not.toHaveAttribute('aria-current');
    expect(within(running).getByRole('status')).toHaveTextContent('执行中...');
  });

  it('opens the row menu from 更多操作 without opening the task', async () => {
    const user = userEvent.setup();
    renderItem([makeConv(0)]);
    await user.click(screen.getByRole('button', { name: '更多操作' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      '重命名', '导出会话', '移出项目', '删除会话',
    ]);
    expect(within(menu).getByRole('menuitem', { name: '删除会话' })).toHaveClass('text-danger');
    expect(mocks.chat.switchConversation).not.toHaveBeenCalled();
  });

  // Every mounted menu listens for each key press on the document.
  it('shares one right-click menu and one 更多操作 menu between all the task rows', async () => {
    renderItem(Array.from({ length: 8 }, (_, i) => makeConv(i)));
    await userEvent.click(screen.getByRole('button', { name: /还有 3 个/ }));

    expect(screen.getAllByRole('button', { name: '更多操作' })).toHaveLength(8);
    // The project row's own menu, and the task list's.
    expect(menuProps.contextMenus.size).toBe(2);
    expect(menuProps.menus.size).toBe(1);
  });

  it('opens the menu of the row whose 更多操作 was pressed', async () => {
    const user = userEvent.setup();
    renderItem([makeConv(0), makeConv(1)]);
    const second = screen.getByText('对话1').closest('[role="button"]') as HTMLElement;
    await user.click(within(second).getByRole('button', { name: '更多操作' }));
    await user.click(await screen.findByRole('menuitem', { name: '删除会话' }));
    expect(mocks.chat.deleteConversation).toHaveBeenCalledWith('c1');
    expect(mocks.chat.switchConversation).not.toHaveBeenCalled();
  });

  it('opens the task when the row itself is clicked', async () => {
    renderItem([makeConv(0)]);
    await userEvent.click(screen.getByText('对话0'));
    expect(mocks.chat.switchConversation).toHaveBeenCalledWith('c0');
  });

  describe('rename', () => {
    // The rename field mounts from Radix's focus-scope timer once the menu has gone.
    beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
    afterEach(() => { vi.useRealTimers(); });

    async function startRename(user: ReturnType<typeof userEvent.setup>) {
      await user.click(screen.getByRole('button', { name: '更多操作' }));
      await user.click(await screen.findByRole('menuitem', { name: '重命名' }));
      await act(() => vi.runOnlyPendingTimersAsync());
      const field = screen.getByRole('textbox', { name: '重命名' });
      await act(() => vi.runOnlyPendingTimersAsync());
      expect(field).toHaveFocus();
      return field;
    }

    it('saves with Enter and keeps the field focused after the menu closes', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderItem([makeConv(0)]);
      const field = await startRename(user);
      await user.clear(field);
      await user.type(field, '新名字{Enter}');
      expect(mocks.chat.renameConversation).toHaveBeenCalledWith('c0', '新名字');
      expect(screen.queryByRole('textbox', { name: '重命名' })).toBeNull();
    });

    it('cancels with Escape', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderItem([makeConv(0)]);
      const field = await startRename(user);
      await user.type(field, 'x{Escape}');
      expect(mocks.chat.renameConversation).not.toHaveBeenCalled();
      expect(screen.queryByRole('textbox', { name: '重命名' })).toBeNull();
      expect(screen.getByText('对话0')).toBeInTheDocument();
    });

    it('renames from the right-click menu too', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderItem([makeConv(0)]);
      fireEvent.contextMenu(screen.getByText('对话0'));
      await user.click(await screen.findByRole('menuitem', { name: '重命名' }));
      await act(() => vi.runOnlyPendingTimersAsync());
      const field = screen.getByRole('textbox', { name: '重命名' });
      await act(() => vi.runOnlyPendingTimersAsync());
      expect(field).toHaveFocus();
    });
  });
});
