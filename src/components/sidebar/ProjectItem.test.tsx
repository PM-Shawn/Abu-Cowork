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
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ProjectItem from './ProjectItem';
import type { Project } from '@/types/project';
import type { ConversationMeta } from '@/core/session/conversationStorage';

const { toggleExpanded } = vi.hoisted(() => ({ toggleExpanded: vi.fn() }));

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      project: {
        newTask: '新任务',
        showMore: '还有 {count} 个',
        showLess: '收起',
        removeFromProject: '移出项目',
        pin: '置顶',
        unpin: '取消置顶',
        editSettings: '设置',
        openInFinder: '在访达中打开',
        archive: '归档',
        delete: '删除',
      },
      sidebar: {
        renameConversation: '重命名',
        exportConversation: '导出',
        deleteConversation: '删除',
        moreActions: '更多操作',
      },
    },
  }),
  format: (tpl: string, vars: Record<string, unknown>) =>
    tpl.replace(/\{(\w+)\}/g, (_: string, k: string) => String(vars[k])),
}));

vi.mock('./ImportedBadge', () => ({ default: () => null }));
vi.mock('@/components/share/ShareExportDialog', () => ({ default: () => null }));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      switchConversation: vi.fn(),
      deleteConversation: vi.fn(),
      renameConversation: vi.fn(),
      loadConversation: vi.fn(),
      activeConversationId: null,
      conversations: {},
      conversationIndex: {},
      setConversationProject: vi.fn(),
    }),
}));

vi.mock('@/stores/projectStore', () => ({
  useProjectStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      toggleExpanded,
      togglePin: vi.fn(),
      archiveProject: vi.fn(),
      deleteProject: vi.fn(),
    }),
}));

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ setViewMode: vi.fn(), viewMode: 'chat' }),
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

afterEach(() => {
  toggleExpanded.mockClear();
  cleanup();
});

describe('ProjectItem — "+N more" expander', () => {
  it('reveals the remaining conversations without collapsing the folder', async () => {
    const convs = Array.from({ length: 8 }, (_, i) => makeConv(i));
    render(
      <ProjectItem
        project={project}
        conversations={convs}
        expanded={true}
        onNewTask={vi.fn()}
        onOpenSettings={vi.fn()}
      />
    );

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
    expect(toggleExpanded).not.toHaveBeenCalled();
  });

  it('collapses the extra conversations again via "show less"', async () => {
    const convs = Array.from({ length: 8 }, (_, i) => makeConv(i));
    render(
      <ProjectItem
        project={project}
        conversations={convs}
        expanded={true}
        onNewTask={vi.fn()}
        onOpenSettings={vi.fn()}
      />
    );

    await userEvent.click(screen.getByRole('button', { name: /还有 3 个/ }));
    expect(screen.getByText('对话7')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '收起' }));
    expect(screen.queryByText('对话7')).not.toBeInTheDocument();
    expect(screen.getByText('对话4')).toBeInTheDocument();
    expect(toggleExpanded).not.toHaveBeenCalled();
  });
});
