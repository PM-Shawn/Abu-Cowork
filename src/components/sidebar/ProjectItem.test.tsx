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
import { passSettleInterval } from '@/test/dsWindows';
import ProjectItem from './ProjectItem';
import type { Project } from '@/types/project';
import type { ConversationMeta } from '@/core/session/conversationStorage';

const mocks = vi.hoisted(() => ({
  chat: {} as Record<string, unknown>,
  project: {} as Record<string, unknown>,
  projects: {} as Record<string, unknown>,
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
// Stands in for the export window: it shows which conversation it was opened for.
vi.mock('@/components/share/ShareExportDialog', () => ({
  default: ({ convId }: { convId: string }) => <div data-testid="share-export-window" data-conversation={convId} />,
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) => sel(mocks.chat),
    // What the store holds at the moment it is read: the delete of a task reads it after the record was read.
    { getState: () => mocks.chat },
  ),
}));

vi.mock('@/stores/projectStore', () => ({
  useProjectStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) => sel(mocks.project),
    // What the store holds at the moment it is read: the answer to a question reads it again.
    { getState: () => ({ ...mocks.project, projects: mocks.projects }) },
  ),
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

// The project's name and the three buttons beside it, found by the name they are grouped under.
const projectGroup = () => screen.getByRole('group', { name: 'fastapi-bridge-dev' });

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
    loadFailures: {},
    setConversationProject: vi.fn(),
  };
  mocks.projects = { p1: project };
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
    await userEvent.click(within(projectGroup()).getByRole('button', { name: '新任务' }));
    expect(onNewTask).toHaveBeenCalledWith('p1');
  });

  // 项目文件, 新任务 and 更多操作 read the same on every project row: the group says whose they are.
  it('groups the row\'s buttons under the name of the project', () => {
    renderItem([makeConv(0)]);
    const group = projectGroup();
    expect(group).toHaveAttribute('aria-labelledby', screen.getByRole('button', { name: 'fastapi-bridge-dev' }).id);
    expect(within(group).getAllByRole('button').map((button) => button.getAttribute('aria-label') ?? button.textContent)).toEqual([
      'fastapi-bridge-dev', '项目文件', '新任务', '更多操作',
    ]);
    // The E2E specs find 新任务 from the element around the project name: both sit directly in the group.
    expect(Array.from(group.children)).toContain(screen.getByRole('button', { name: 'fastapi-bridge-dev' }));
    expect(Array.from(group.children)).toContain(within(group).getByRole('button', { name: '新任务' }));
    // A task row's buttons are no part of it.
    expect(group).not.toContainElement(screen.getByText('对话0'));
  });

  it('lists the project\'s actions in its right-click menu, and pins at once', async () => {
    renderItem([]);
    fireEvent.contextMenu(screen.getByRole('button', { name: 'fastapi-bridge-dev' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      '置顶', '项目设置', '在 Finder 中打开', '归档', '删除',
    ]);
    expect(within(menu).getByRole('menuitem', { name: '删除' })).toHaveClass('text-danger');
    await userEvent.click(within(menu).getByRole('menuitem', { name: '置顶' }));
    expect(mocks.project.togglePin).toHaveBeenCalledExactlyOnceWith('p1');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('offers 取消置顶 for a pinned project', async () => {
    renderItem([], { project: { ...project, pinned: true } });
    fireEvent.contextMenu(screen.getByRole('button', { name: /fastapi-bridge-dev/ }));
    expect(await screen.findByRole('menuitem', { name: '取消置顶' })).toBeInTheDocument();
  });

  // What the two questions say. The text of a question is found through the box it describes.
  it.each([
    ['归档', '归档项目', '「fastapi-bridge-dev」将从项目列表中移除。对话、定时任务和文件不会被删除。', '归档'],
    // The project's name is the second line of the delete question.
    ['删除', '删除项目', '删除项目后，对话将保留为独立对话\nfastapi-bridge-dev', '删除'],
  ] as const)('asks about 「%s」 with the title 「%s」, its sentence and two buttons', async (item, title, sentence, answer) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderItem([]);
      fireEvent.contextMenu(screen.getByRole('button', { name: 'fastapi-bridge-dev' }));
      await user.click(await screen.findByRole('menuitem', { name: item }));
      await act(() => vi.runOnlyPendingTimersAsync());
      const asked = await screen.findByRole('alertdialog', { name: title });
      expect(document.getElementById(asked.getAttribute('aria-describedby')!)?.textContent).toBe(sentence);
      expect(within(asked).getByRole('button', { name: '取消' })).toBeInTheDocument();
      expect(within(asked).getByRole('button', { name: answer })).toHaveClass('text-danger');
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks before deleting the project from its right-click menu, and unlinks its tasks', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderItem([makeConv(0)]);
      fireEvent.contextMenu(screen.getByRole('button', { name: 'fastapi-bridge-dev' }));
      await user.click(await screen.findByRole('menuitem', { name: '删除' }));
      const question = await screen.findByRole('alertdialog', { name: '删除项目' });
      expect(mocks.project.deleteProject).not.toHaveBeenCalled();
      passSettleInterval();
      await user.click(within(question).getByRole('button', { name: '删除' }));
      expect(mocks.chat.setConversationProject).toHaveBeenCalledWith('c0', undefined);
      expect(mocks.project.deleteProject).toHaveBeenCalledWith('p1');
    } finally {
      vi.useRealTimers();
    }
  });

  // The row leaves the page with its project: its owner is told first, so it can move the focus
  // to the row that takes its place.
  it.each([
    ['归档', '归档项目', '归档', 'archiveProject'],
    ['删除', '删除项目', '删除', 'deleteProject'],
  ] as const)('tells its owner the row is about to leave before 「%s」 takes the project away', async (item, question, answer, action) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const onLeaving = vi.fn();
      renderItem([], { onLeaving });
      fireEvent.contextMenu(screen.getByRole('button', { name: 'fastapi-bridge-dev' }));
      await user.click(await screen.findByRole('menuitem', { name: item }));
      const asked = await screen.findByRole('alertdialog', { name: question });
      expect(onLeaving).not.toHaveBeenCalled();

      passSettleInterval();
      await user.click(within(asked).getByRole('button', { name: answer }));

      expect(onLeaving).toHaveBeenCalledTimes(1);
      expect(onLeaving).toHaveBeenCalledWith('p1');
      const storeCall = mocks.project[action] as ReturnType<typeof vi.fn>;
      expect(storeCall).toHaveBeenCalledWith('p1');
      expect(onLeaving.mock.invocationCallOrder[0]).toBeLessThan(storeCall.mock.invocationCallOrder[0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says nothing to its owner when the question is cancelled', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const onLeaving = vi.fn();
      renderItem([], { onLeaving });
      fireEvent.contextMenu(screen.getByRole('button', { name: 'fastapi-bridge-dev' }));
      await user.click(await screen.findByRole('menuitem', { name: '归档' }));
      const asked = await screen.findByRole('alertdialog', { name: '归档项目' });

      passSettleInterval();
      await user.click(within(asked).getByRole('button', { name: '取消' }));

      expect(onLeaving).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks its name as the project row, so the focus can find it', () => {
    renderItem([]);
    expect(screen.getByRole('button', { name: 'fastapi-bridge-dev' })).toHaveAttribute('data-project-row', 'p1');
  });

  it('opens project settings only after the menu has gone, with focus back on the row, which the window returns to', async () => {
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
      expect(header).toHaveFocus();
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
      const question = await screen.findByRole('alertdialog', { name: '归档项目' });
      // The question is a ds dialog: it remembers the row as where focus was, so the
      // menu must not keep focus off the row the way it does for legacy dialogs.
      const rowAt = focused.lastIndexOf(header);
      expect(rowAt).toBeGreaterThanOrEqual(0);
      expect(focused.slice(rowAt + 1).every((el) => question.contains(el))).toBe(true);
      expect(question).toContainElement(document.activeElement as HTMLElement);
      passSettleInterval();
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

const projectRow = () => screen.getByRole('button', { name: 'fastapi-bridge-dev' });
// The project's own 更多操作 sits in the project's group; a task row's sits inside that row.
const projectMore = () => within(projectGroup()).getByRole('button', { name: '更多操作' });
const taskRow = (title: string) => screen.getByText(title).closest<HTMLElement>('[role="button"]')!;
const taskMore = (title = '对话0') => within(taskRow(title)).getByRole('button', { name: '更多操作' });
const PROJECT_ITEMS = ['置顶', '项目设置', '在 Finder 中打开', '归档', '删除'];

describe('ProjectItem — the project row\'s 更多操作', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); });
  const setup = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

  it('shows on the terms of a task row\'s button: under the pointer, with the focus, and while its menu is open', () => {
    renderItem([makeConv(0)]);
    for (const button of [projectMore(), taskMore()]) {
      expect(button).toHaveClass('opacity-0');
      expect(button).toHaveClass('group-hover:opacity-100');
      expect(button).toHaveClass('focus-visible:opacity-100');
      expect(button).toHaveAttribute('aria-haspopup', 'menu');
      expect(button).toHaveAttribute('aria-expanded', 'false');
      // Hidden by opacity alone: Tab reaches it.
      expect(button.tabIndex).toBe(0);
    }
    // After 项目文件 and 新任务, the last control of the row.
    expect(within(projectGroup()).getAllByRole('button').map((button) => button.getAttribute('aria-label') ?? button.textContent)).toEqual([
      'fastapi-bridge-dev', '项目文件', '新任务', '更多操作',
    ]);
  });

  it.each([['Enter', '{Enter}'], ['Space', ' ']])('opens the right-click menu\'s items with %s, and Escape gives the focus back to it', async (_name, key) => {
    const user = setup();
    renderItem([]);
    act(() => projectMore().focus());
    await user.keyboard(key);
    const menu = await screen.findByRole('menu');
    expect(menu).toHaveAccessibleName('更多操作');
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(PROJECT_ITEMS);
    expect(within(menu).getByRole('menuitem', { name: '删除' })).toHaveClass('text-danger');
    const button = screen.getByRole('button', { name: '更多操作', hidden: true });
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(button).toHaveClass('opacity-100');
    // The folder is not opened or closed by a press on the button.
    expect(mocks.project.toggleExpanded).not.toHaveBeenCalled();

    await user.keyboard('{Escape}');
    await act(() => vi.runOnlyPendingTimersAsync());
    expect(screen.queryByRole('menu')).toBeNull();
    expect(projectMore()).toHaveFocus();
    expect(projectMore()).not.toHaveClass('opacity-100');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('opens with a pointer press, and the folder stays as it is', async () => {
    const user = setup();
    renderItem([]);
    await user.click(projectMore());
    expect(within(await screen.findByRole('menu')).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(PROJECT_ITEMS);
    expect(mocks.project.toggleExpanded).not.toHaveBeenCalled();
  });

  it('is its own menu: no task row\'s menu opens with it', async () => {
    const user = setup();
    renderItem([makeConv(0)]);
    await user.click(projectMore());
    await screen.findByRole('menu');
    expect(screen.queryByRole('menuitem', { name: '删除会话' })).toBeNull();
    expect(screen.getAllByRole('menu')).toHaveLength(1);
  });

  it('opens project settings once the menu has gone, with the focus back on the button', async () => {
    const user = setup();
    // What was on the page at the moment the window was asked for.
    const menusAtCall: number[] = [];
    const onOpenSettings = vi.fn(() => { menusAtCall.push(screen.queryAllByRole('menu').length); });
    renderItem([], { onOpenSettings });
    act(() => projectMore().focus());
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('menuitem', { name: '项目设置' }));
    await act(() => vi.runOnlyPendingTimersAsync());
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onOpenSettings).toHaveBeenCalledExactlyOnceWith('p1');
    expect(menusAtCall).toEqual([0]);
    expect(projectMore()).toHaveFocus();
  });

  it.each([
    ['归档', '归档项目', 'archiveProject'],
    ['删除', '删除项目', 'deleteProject'],
  ] as const)('asks about 「%s」 once the menu has gone and acts on the answer', async (item, title, action) => {
    const user = setup();
    const onLeaving = vi.fn();
    renderItem([makeConv(0)], { onLeaving });
    await user.click(projectMore());
    await user.click(await screen.findByRole('menuitem', { name: item }));
    const asked = await screen.findByRole('alertdialog', { name: title });
    expect(mocks.project[action]).not.toHaveBeenCalled();
    passSettleInterval();
    await user.click(within(asked).getByRole('button', { name: item }));
    expect(onLeaving).toHaveBeenCalledExactlyOnceWith('p1');
    expect(mocks.project[action]).toHaveBeenCalledExactlyOnceWith('p1');
  });
});

// The answer acts on the project as the store holds it at that moment.
describe('ProjectItem — the archive and delete questions read their project again at the answer', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); });

  // The question, on the page long enough to take a pointer press.
  async function ask(user: ReturnType<typeof userEvent.setup>, item: '归档' | '删除') {
    fireEvent.contextMenu(projectRow());
    await user.click(await screen.findByRole('menuitem', { name: item }));
    const asked = await screen.findByRole('alertdialog', { name: item === '归档' ? '归档项目' : '删除项目' });
    passSettleInterval();
    return asked;
  }

  it.each([
    ['归档', 'deleted from elsewhere', () => ({})],
    ['归档', 'archived from elsewhere', () => ({ p1: { ...project, archived: true } })],
    ['删除', 'deleted from elsewhere', () => ({})],
    ['删除', 'archived from elsewhere', () => ({ p1: { ...project, archived: true } })],
  ] as const)('「%s」 does nothing for a project %s while the question was on the page', async (item, _what, now) => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onLeaving = vi.fn();
    renderItem([makeConv(0)], { onLeaving });
    const asked = await ask(user, item);
    mocks.projects = now();

    await user.click(within(asked).getByRole('button', { name: item }));

    expect(mocks.project.archiveProject).not.toHaveBeenCalled();
    expect(mocks.project.deleteProject).not.toHaveBeenCalled();
    expect(mocks.chat.setConversationProject).not.toHaveBeenCalled();
    expect(onLeaving).not.toHaveBeenCalled();
  });

  // The question is asked from the menu's close hook, later than the choice: a project that has
  // gone meanwhile is asked nothing about.
  it.each([
    ['归档', 'deleted', () => ({})],
    ['归档', 'archived', () => ({ p1: { ...project, archived: true } })],
    ['删除', 'deleted', () => ({})],
    ['删除', 'archived', () => ({ p1: { ...project, archived: true } })],
  ] as const)('asks nothing about 「%s」 for a project %s from elsewhere while its menu was closing', async (item, _what, now) => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderItem([makeConv(0)]);
    await user.click(projectMore());
    await screen.findByRole('menu');
    act(() => menuProps.itemSelect.get(item)?.(new Event('select')));
    mocks.projects = now();
    await user.keyboard('{Escape}');
    await act(() => vi.runOnlyPendingTimersAsync());

    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('asks nothing when the row left the page with its project while the menu was closing', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const view = renderItem([makeConv(0)]);
    await user.click(projectMore());
    await screen.findByRole('menu');
    act(() => menuProps.itemSelect.get('删除')?.(new Event('select')));
    mocks.projects = {};
    view.rerender(<span>No project</span>);
    await act(() => vi.runOnlyPendingTimersAsync());

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(mocks.project.deleteProject).not.toHaveBeenCalled();
  });

  it('deletes a project once: 删除 chosen again on the row that is still drawn asks nothing', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    // The store drops the project; this row is still drawn, as it is until the list renders again.
    (mocks.project.deleteProject as ReturnType<typeof vi.fn>).mockImplementation(() => { mocks.projects = {}; });
    renderItem([makeConv(0)]);
    await user.click(within(await ask(user, '删除')).getByRole('button', { name: '删除' }));
    await act(() => vi.runOnlyPendingTimersAsync());
    fireEvent.contextMenu(projectRow());
    await user.click(await screen.findByRole('menuitem', { name: '删除' }));
    await act(() => vi.runOnlyPendingTimersAsync());

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(mocks.project.deleteProject).toHaveBeenCalledTimes(1);
    expect(mocks.chat.setConversationProject).toHaveBeenCalledTimes(1);
  });

  it('deletes once when the confirming button is pressed twice', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderItem([makeConv(0)]);
    const confirmButton = within(await ask(user, '删除')).getByRole('button', { name: '删除' });
    act(() => {
      fireEvent.click(confirmButton);
      fireEvent.click(confirmButton);
    });
    await act(() => vi.runOnlyPendingTimersAsync());

    expect(mocks.project.deleteProject).toHaveBeenCalledTimes(1);
  });

  it('unlinks the tasks the project has at the answer, also one that arrived while the question was on the page', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const view = renderItem([makeConv(0)]);
    const asked = await ask(user, '删除');
    view.rerender(<ProjectItem project={project} conversations={[makeConv(0), makeConv(1)]} expanded onNewTask={vi.fn()} onOpenSettings={vi.fn()} />);

    await user.click(within(asked).getByRole('button', { name: '删除' }));

    expect(mocks.chat.setConversationProject).toHaveBeenCalledWith('c0', undefined);
    expect(mocks.chat.setConversationProject).toHaveBeenCalledWith('c1', undefined);
    expect(mocks.project.deleteProject).toHaveBeenCalledExactlyOnceWith('p1');
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

  it.each([
    ['删除', 'deleteProject'],
    ['归档', 'archiveProject'],
  ] as const)('forgets 「%s」 chosen in the project row\'s 更多操作 menu: no question is asked under the menu opened again', async (item, action) => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderItem([makeConv(0)]);
    await user.click(projectMore());
    await screen.findByRole('menu');
    act(() => menuProps.itemSelect.get(item)?.(new Event('select')));
    // The project row's own 更多操作 menu is the first one mounted.
    act(() => [...menuProps.menus.values()][0]?.(true));
    await user.keyboard('{Escape}');
    await act(() => vi.runOnlyPendingTimersAsync());
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(mocks.project[action]).not.toHaveBeenCalled();
  });

  it('forgets 删除 chosen in the 更多操作 menu when the project\'s right-click menu opens before the close hook ran', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderItem([makeConv(0)]);
    await user.click(projectMore());
    await screen.findByRole('menu');
    act(() => menuProps.itemSelect.get('删除')?.(new Event('select')));
    act(() => [...menuProps.contextMenus.values()][0]?.(true));
    await user.keyboard('{Escape}');
    await act(() => vi.runOnlyPendingTimersAsync());
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(mocks.project.deleteProject).not.toHaveBeenCalled();
  });

  it('asks 「删除」 chosen in the 更多操作 menu when no menu opened in between', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderItem([makeConv(0)]);
    await user.click(projectMore());
    await screen.findByRole('menu');
    act(() => menuProps.itemSelect.get('删除')?.(new Event('select')));
    await user.keyboard('{Escape}');
    await act(() => vi.runOnlyPendingTimersAsync());
    expect(screen.getByRole('alertdialog', { name: '删除项目' })).toBeInTheDocument();
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
    await user.click(taskMore());
    act(() => menuProps.itemSelect.get('重命名')?.(new Event('select')));
    // The project row's own menu is the first one mounted, the task rows' the second.
    act(() => [...menuProps.menus.values()][1]?.(true));
    await user.keyboard('{Escape}');
    await act(() => vi.runOnlyPendingTimersAsync());
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.queryByRole('textbox', { name: '重命名' })).toBeNull();
  });
});

// A touch held on a row opens the right-click menu with no right-click event.
describe('ProjectItem — a touch held on a task row', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Testing Library moves a fake clock only through a global named `jest`.
    vi.stubGlobal('jest', { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('opens the task menu of that row alone and deletes that task, after another task was right-clicked', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderItem([makeConv(0), makeConv(1)]);
    const rowOf = (title: string) => screen.getByText(title).closest<HTMLElement>('[role="button"]')!;
    fireEvent.contextMenu(rowOf('对话0'));
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.pointerDown(rowOf('对话1'), { button: 0, pointerType: 'touch' });
    await act(() => vi.advanceTimersByTimeAsync(700));

    expect(screen.getAllByRole('menu')).toHaveLength(1);
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      '重命名', '导出会话', '移出项目', '删除会话',
    ]);

    await user.click(screen.getByRole('menuitem', { name: '删除会话' }));
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(mocks.chat.deleteConversation).toHaveBeenCalledTimes(1);
    expect(mocks.chat.deleteConversation).toHaveBeenCalledWith('c1');
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
    await user.click(taskMore());
    const menu = await screen.findByRole('menu');
    expect(menu).toHaveAccessibleName('更多操作');
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

    // Eight task rows and the project row.
    expect(screen.getAllByRole('button', { name: '更多操作' })).toHaveLength(9);
    // The project row's own two menus, and the task list's two.
    expect(menuProps.contextMenus.size).toBe(2);
    expect(menuProps.menus.size).toBe(2);
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

  // The export window is a dialog that gives the focus back to where it was when it opened.
  it('opens the export window after the menu has gone, with the focus back on the button that opened the menu', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderItem([makeConv(0)]);
      const more = taskMore();
      await user.click(more);
      await user.click(await screen.findByRole('menuitem', { name: '导出会话' }));
      await act(() => vi.runOnlyPendingTimersAsync());
      expect(screen.queryByRole('menu')).toBeNull();
      expect(mocks.chat.loadConversation).toHaveBeenCalledWith('c0');
      expect(screen.getByTestId('share-export-window')).toHaveAttribute('data-conversation', 'c0');
      expect(more).toHaveFocus();
    } finally {
      vi.useRealTimers();
    }
  });

  // The row leaves while its menu is still closing with the focus in it.
  describe('after 删除会话 chosen from the keyboard', () => {
    beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
    afterEach(() => { vi.useRealTimers(); });

    async function deleteFromKeyboard(convs: ConversationMeta[], title: string, left: ConversationMeta[]) {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const view = renderItem(convs);
      act(() => taskMore(title).focus());
      await user.keyboard('{Enter}');
      await user.click(await screen.findByRole('menuitem', { name: '删除会话' }));
      // The store drops the task; the list renders without its row before the menu has gone.
      view.rerender(<ProjectItem project={project} conversations={left} expanded onNewTask={vi.fn()} onOpenSettings={vi.fn()} />);
      await act(() => vi.runOnlyPendingTimersAsync());
      expect(screen.queryByRole('menu')).toBeNull();
    }

    it('marks its task rows as conversation rows', () => {
      renderItem([makeConv(0)]);
      expect(taskRow('对话0')).toHaveAttribute('data-conversation-row', 'c0');
    });

    it('moves the focus to the row that took its place', async () => {
      await deleteFromKeyboard([makeConv(0), makeConv(1), makeConv(2)], '对话1', [makeConv(0), makeConv(2)]);
      expect(mocks.chat.deleteConversation).toHaveBeenCalledExactlyOnceWith('c1');
      expect(taskRow('对话2')).toHaveFocus();
      expect(mocks.chat.switchConversation).not.toHaveBeenCalled();
    });

    it('moves the focus to the row before it when it was the last', async () => {
      await deleteFromKeyboard([makeConv(0), makeConv(1)], '对话1', [makeConv(0)]);
      expect(taskRow('对话0')).toHaveFocus();
    });

    it('moves the focus to the project\'s own row when its only task is deleted', async () => {
      await deleteFromKeyboard([makeConv(0)], '对话0', []);
      expect(mocks.chat.deleteConversation).toHaveBeenCalledExactlyOnceWith('c0');
      expect(projectRow()).toHaveFocus();
      expect(mocks.project.toggleExpanded).not.toHaveBeenCalled();
    });
  });

  // A record that is on disk and cannot be read: the delete asks first, as in the recent tasks.
  describe('删除会话 for a task whose record cannot be read', () => {
    const question = () => screen.queryByRole('alertdialog', { name: '删除这个任务？' });
    const menuGone = () => act(() => vi.advanceTimersByTimeAsync(10));
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mocks.chat.conversationIndex = { c0: makeConv(0), c1: makeConv(1), c2: makeConv(2) };
      mocks.chat.loadFailures = { c1: true };
    });
    afterEach(() => { vi.useRealTimers(); });

    async function chooseDelete(title: string) {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const view = renderItem([makeConv(0), makeConv(1), makeConv(2)]);
      act(() => taskMore(title).focus());
      await user.keyboard('{Enter}');
      await user.click(await screen.findByRole('menuitem', { name: '删除会话' }));
      await menuGone();
      return { user, view };
    }

    it('reads the record, then asks by name, with the focus on 取消, and deletes nothing meanwhile', async () => {
      await chooseDelete('对话1');
      expect(mocks.chat.loadConversation).toHaveBeenCalledWith('c1');
      const asked = question()!;
      expect(asked).toHaveTextContent('「对话1」的记录目前读不出来，删除后无法恢复。');
      expect(within(asked).getByRole('button', { name: '取消' })).toHaveFocus();
      expect(mocks.chat.deleteConversation).not.toHaveBeenCalled();
    });

    it('keeps the task on 取消, with the focus back on the row\'s button', async () => {
      await chooseDelete('对话1');
      fireEvent.click(within(question()!).getByRole('button', { name: '取消' }));
      await menuGone();
      expect(question()).toBeNull();
      expect(mocks.chat.deleteConversation).not.toHaveBeenCalled();
      expect(taskMore('对话1')).toHaveFocus();
    });

    it('deletes once on 删除 and moves the focus to the row that took its place', async () => {
      const { view } = await chooseDelete('对话1');
      const confirmButton = within(question()!).getByRole('button', { name: '删除' });
      fireEvent.click(confirmButton);
      fireEvent.click(confirmButton);
      await menuGone();
      expect(mocks.chat.deleteConversation).toHaveBeenCalledExactlyOnceWith('c1');
      view.rerender(<ProjectItem project={project} conversations={[makeConv(0), makeConv(2)]} expanded onNewTask={vi.fn()} onOpenSettings={vi.fn()} />);
      await menuGone();
      expect(taskRow('对话2')).toHaveFocus();
      expect(mocks.chat.switchConversation).not.toHaveBeenCalled();
    });

    it('leaves a task alone that has gone by the time the question is answered', async () => {
      await chooseDelete('对话1');
      mocks.chat.conversationIndex = { c0: makeConv(0), c2: makeConv(2) };
      fireEvent.click(within(question()!).getByRole('button', { name: '删除' }));
      await menuGone();
      expect(mocks.chat.deleteConversation).not.toHaveBeenCalled();
    });

    it('asks nothing for a task whose record can be read', async () => {
      await chooseDelete('对话2');
      expect(mocks.chat.loadConversation).toHaveBeenCalledWith('c2');
      expect(question()).toBeNull();
      expect(mocks.chat.deleteConversation).toHaveBeenCalledExactlyOnceWith('c2');
    });

    it('deletes nothing when the row leaves the page with its project while the question waits', async () => {
      const { view } = await chooseDelete('对话1');
      expect(question()).not.toBeNull();
      view.unmount();
      await menuGone();
      expect(mocks.chat.deleteConversation).not.toHaveBeenCalled();
    });
  });

  it('opens the task when the row itself is clicked', async () => {
    renderItem([makeConv(0)]);
    await userEvent.click(screen.getByText('对话0'));
    expect(mocks.chat.switchConversation).toHaveBeenCalledWith('c0');
  });

  // Tab reaches a row; Enter and Space on the row open the task as a click does.
  describe('from the keyboard', () => {
    const row = () => screen.getByText('对话0').closest<HTMLElement>('[role="button"]')!;

    it.each([['Enter', 'Enter'], [' ', 'Space']])('opens the task with %j pressed on the row, and the page does not scroll', (key, code) => {
      renderItem([makeConv(0)]);
      expect(row().tabIndex).toBe(0);

      // fireEvent returns false once the default was prevented.
      expect(fireEvent.keyDown(row(), { key, code })).toBe(false);

      expect(mocks.chat.switchConversation).toHaveBeenCalledExactlyOnceWith('c0');
    });

    it('opens nothing on the repeats of a held Enter or Space', () => {
      renderItem([makeConv(0)]);

      expect(fireEvent.keyDown(row(), { key: 'Enter', code: 'Enter', repeat: true })).toBe(false);
      expect(fireEvent.keyDown(row(), { key: ' ', code: 'Space', repeat: true })).toBe(false);

      expect(mocks.chat.switchConversation).not.toHaveBeenCalled();
    });

    it('leaves keys pressed on the row\'s 更多操作 to that button, and other keys alone', () => {
      renderItem([makeConv(0)]);

      fireEvent.keyDown(within(row()).getByRole('button', { name: '更多操作' }), { key: 'Enter', code: 'Enter' });
      expect(fireEvent.keyDown(row(), { key: 'Tab', code: 'Tab' })).toBe(true);

      expect(mocks.chat.switchConversation).not.toHaveBeenCalled();
    });
  });

  describe('rename', () => {
    // The rename field mounts from Radix's focus-scope timer once the menu has gone.
    beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
    afterEach(() => { vi.useRealTimers(); });

    async function startRename(user: ReturnType<typeof userEvent.setup>) {
      await user.click(taskMore());
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
