// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
// The two owners of the export window, each with the real window: the recents list of the
// sidebar and the task rows of a project. An export chosen for a second conversation while the
// first is still being read ends with the second conversation's window on the page.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DesignSystemProvider } from '@/components/ds/provider';
import type { ConversationMeta } from '@/core/session/conversationStorage';
import type { ShareBundle } from '@/core/session/shareBundle';
import { initLanguage } from '@/i18n';
import { usePluginStore } from '@/stores/pluginStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { Project } from '@/types/project';

const chat = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));

vi.mock('@/stores/chatStore', () => {
  const useChatStore = (selector: (state: Record<string, unknown>) => unknown) => selector(chat.state);
  useChatStore.getState = () => chat.state;
  return { useChatStore };
});
vi.mock('@/stores/projectStore', () => ({
  useProjectStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    projects: {},
    toggleExpanded: vi.fn(),
    togglePin: vi.fn(),
    archiveProject: vi.fn(),
    deleteProject: vi.fn(),
  }),
}));
vi.mock('@/stores/noticeBadgeStore', () => ({
  useNoticeBadgeStore: (selector: (state: Record<string, unknown>) => unknown) => selector({ clear: vi.fn() }),
}));
vi.mock('@/stores/inboxStore', () => ({
  useInboxStore: (selector: (state: Record<string, unknown>) => unknown) => selector({ getPendingCount: () => 0 }),
}));
vi.mock('@/stores/previewStore', () => ({
  usePreviewStore: (selector: (state: Record<string, unknown>) => unknown) => selector({ fileTreeMode: false, setFileTreeMode: vi.fn() }),
}));
vi.mock('@/components/common/GuideModal', () => ({ default: () => null }));
vi.mock('@/components/common/ProfileEditModal', () => ({ default: () => null }));
vi.mock('@/components/common/CreateProjectDialog', () => ({ default: () => null }));
vi.mock('@/components/sidebar/AccountMenu', () => ({ default: () => null }));
vi.mock('@/components/sidebar/ProjectsSection', () => ({ default: () => null }));
vi.mock('@/components/panel/WorkspaceFileTree', () => ({ default: () => null }));
vi.mock('./ImportedBadge', () => ({ default: () => null }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({ readTextFile: vi.fn(), writeTextFile: vi.fn() }));
vi.mock('@/utils/platform', () => ({ isMacOS: () => true, isWindows: () => false }));

import ProjectItem from './ProjectItem';
import Sidebar from './Sidebar';

const FIRST: ConversationMeta = { id: 'c1', title: 'Fake first task', createdAt: 2, updatedAt: 2, messageCount: 1 };
const SECOND: ConversationMeta = { id: 'c2', title: 'Fake second task', createdAt: 1, updatedAt: 1, messageCount: 1 };
const PROJECT: Project = { id: 'p1', name: 'fake-project', workspacePath: '/fake/project', pinned: false, archived: false, createdAt: 0, updatedAt: 0, lastActiveAt: 0 };

function bundleOf(id: string): ShareBundle {
  return {
    schema: { abuShareVersion: 1, tier: 'standard', exportedAt: 1 },
    conversation: { id, title: `Fake ${id}`, createdAt: 1, updatedAt: 1 },
    messages: [{ id: `${id}-m1`, role: 'user', content: `Fake question of ${id}`, timestamp: 1 }],
    attachments: {},
    stats: { redactionCount: 0, attachmentCount: 0, embeddedCount: 0, sizeBytes: 100 },
  };
}

// The reads of the two conversations from disk, finished by the test in the order it wants.
let reads: Record<string, () => void> = {};

// Lets every promise the page waits on settle, then runs the timers that are due (a menu's
// close hook, the hook of a window that has left the page).
const tick = async () => {
  await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); });
  await act(() => vi.runOnlyPendingTimersAsync());
  await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); });
};

// Chooses 导出会话 in the menu of the row at this place.
async function chooseExport(row: number) {
  // The task rows' buttons: a project's own 更多操作 sits in the group named after the project.
  const projectGroup = screen.queryByRole('group', { name: PROJECT.name, hidden: true });
  const rowButtons = screen.getAllByRole('button', { name: '更多操作', hidden: true }).filter((button) => !projectGroup?.contains(button));
  fireEvent.pointerDown(rowButtons[row], { button: 0 });
  fireEvent.click(screen.getByRole('menuitem', { name: '导出会话' }));
  await tick();
}

const finishRead = async (id: string) => {
  reads[id]();
  await tick();
};

// Both exports are chosen before either conversation is read; then the reads end in this order.
async function exportBothThenRead(order: string[]) {
  await chooseExport(0);
  await chooseExport(1);
  expect(Object.keys(reads).sort()).toEqual(['c1', 'c2']);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  for (const id of order) await finishRead(id);
  await tick();
}

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  initLanguage('zh-CN');
  vi.useFakeTimers();
  reads = {};
  chat.state = {
    conversationIndex: { c1: FIRST, c2: SECOND },
    conversations: {},
    activeConversationId: null,
    startNewConversation: vi.fn(),
    switchConversation: vi.fn(),
    deleteConversation: vi.fn(),
    renameConversation: vi.fn(),
    clearCompletedStatus: vi.fn(),
    exportConversation: vi.fn(),
    importConversation: vi.fn(),
    setConversationProject: vi.fn(),
    loadConversation: vi.fn((id: string) => new Promise<void>((resolve) => { reads[id] = resolve; })),
    exportConversationForShare: vi.fn(async (id: string) => bundleOf(id)),
  };
  useSettingsStore.setState({ viewMode: 'chat', guideOpen: false });
  usePluginStore.setState({ updateAvailableKeys: [], updateAvailableCount: 0 });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe.each([
  ['the recents list of the sidebar', () => render(<Sidebar />, { wrapper: DesignSystemProvider })],
  ['the task rows of a project', () => render(
    <ProjectItem project={PROJECT} conversations={[FIRST, SECOND]} expanded onNewTask={vi.fn()} onOpenSettings={vi.fn()} />,
    { wrapper: DesignSystemProvider },
  )],
])('the export window opened from %s', (_owner, mount) => {
  it('opens with the preview of its conversation and is gone after Escape, ready to open again', async () => {
    mount();
    await chooseExport(0);
    await finishRead('c1');
    expect(screen.getByRole('dialog', { name: '导出对话 · 预览' })).toBeInTheDocument();
    expect(screen.getByText('Fake question of c1')).toBeInTheDocument();

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await tick();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await chooseExport(0);
    await finishRead('c1');
    expect(screen.getByText('Fake question of c1')).toBeInTheDocument();
  });

  it.each([
    ['first, then the second', ['c1', 'c2'], 'c2'],
    ['second, then the first', ['c2', 'c1'], 'c1'],
  ])('keeps the window of the conversation read last when the reads end %s', async (_order, order, last) => {
    mount();

    await exportBothThenRead(order);

    expect(screen.getAllByRole('dialog', { name: '导出对话 · 预览' })).toHaveLength(1);
    expect(screen.getByText(`Fake question of ${last}`)).toBeInTheDocument();
  });
});
