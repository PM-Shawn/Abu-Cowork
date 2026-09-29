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

  it('opens project settings only after the menu has gone', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const onOpenSettings = vi.fn();
      renderItem([], { onOpenSettings });
      fireEvent.contextMenu(screen.getByRole('button', { name: 'fastapi-bridge-dev' }));
      await user.click(await screen.findByRole('menuitem', { name: '项目设置' }));
      await act(() => vi.runOnlyPendingTimersAsync());
      expect(screen.queryByRole('menu')).toBeNull();
      expect(onOpenSettings).toHaveBeenCalledWith('p1');
    } finally {
      vi.useRealTimers();
    }
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
