// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Button } from '@/components/ds/button';
import { DesignSystemProvider } from '@/components/ds/provider';
import { initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { useProjectStore } from '@/stores/projectStore';
import type { Project } from '@/types/project';
import ProjectsSection from './ProjectsSection';
import { projectRowProps } from './projectRowFocus';

// A project row as the sidebar draws it, without its menus: a button that carries the row mark.
vi.mock('./ProjectItem', () => ({
  default: ({ project }: { project: Project }) => <Button {...projectRowProps(project.id)}>{project.name}</Button>,
}));
vi.mock('@/components/common/ProjectSettingsDialog', () => ({ default: () => null }));

const project = (id: string, archived: boolean, updatedAt: number): Project => ({
  id,
  name: `Project ${id}`,
  workspacePath: `/fake/project/${id}`,
  pinned: false,
  archived,
  createdAt: 1,
  updatedAt,
  lastActiveAt: updatedAt,
} as Project);

// Archived rows show newest first: c, b, a.
function seed(projects: Project[]) {
  useProjectStore.setState({ projects: Object.fromEntries(projects.map((entry) => [entry.id, entry])), expandedProjectIds: [] });
}

function renderSection() {
  render(
    <DesignSystemProvider>
      <ProjectsSection onCreateProject={() => undefined} />
      <Button>Elsewhere</Button>
    </DesignSystemProvider>,
  );
}

const toggle = () => screen.getByRole('button', { name: /个已归档/ });
const archivedRow = (id: string) => screen.getByText(`Project ${id}`).closest<HTMLElement>('[data-archived-project]')!;
const restore = (id: string) => within(archivedRow(id)).getByRole('button', { name: '恢复' });
const remove = (id: string) => within(archivedRow(id)).getByRole('button', { name: '删除' });
// A press with the keyboard: the button has the focus when it is pressed.
function press(button: HTMLElement) {
  button.focus();
  fireEvent.click(button);
}

describe('the archived projects of the sidebar', () => {
  beforeEach(() => {
    initLanguage('zh-CN');
    useChatStore.setState({ conversationIndex: {} });
    seed([project('a', true, 10), project('b', true, 20), project('c', true, 30)]);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  // As it was before this change: no question is asked. Kept as it is, for the product owner to decide.
  it('deletes an archived project at once, with no question, and unlinks its conversations first', () => {
    useChatStore.setState({ conversationIndex: { 'conv-1': { id: 'conv-1', title: 'one', createdAt: 1, updatedAt: 1, messageCount: 0, projectId: 'b' } } as never });
    const unlink = vi.spyOn(useChatStore.getState(), 'setConversationProject');
    const deleteProject = vi.spyOn(useProjectStore.getState(), 'deleteProject');
    renderSection();
    fireEvent.click(toggle());

    // The rows show c, b, a: the second 删除 is b's.
    press(screen.getAllByRole('button', { name: '删除' })[1]);

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(unlink.mock.calls).toEqual([['conv-1', undefined]]);
    expect(deleteProject.mock.calls).toEqual([['b']]);
    expect(useProjectStore.getState().projects.b).toBeUndefined();
  });

  it('moves the focus to the row that took its place after 删除', () => {
    renderSection();
    fireEvent.click(toggle());

    press(remove('b'));

    expect(restore('a')).toHaveFocus();
  });

  it('moves the focus to the row before it after 删除 on the last row', () => {
    renderSection();
    fireEvent.click(toggle());

    press(remove('a'));

    expect(restore('b')).toHaveFocus();
  });

  it('moves the focus to the row that took its place after 恢复', () => {
    renderSection();
    fireEvent.click(toggle());

    press(restore('c'));

    expect(restore('b')).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Project c' })).toBeInTheDocument();
  });

  it('moves the focus to the restored project when the list of archived projects has gone with its last row', () => {
    seed([project('live', false, 5), project('a', true, 10)]);
    renderSection();
    fireEvent.click(toggle());

    press(restore('a'));

    expect(screen.queryByRole('button', { name: /个已归档/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Project a' })).toHaveFocus();
  });

  it('moves the focus to a project row when the last archived project is deleted', () => {
    seed([project('live', false, 5), project('a', true, 10)]);
    renderSection();
    fireEvent.click(toggle());

    press(remove('a'));

    expect(screen.getByRole('button', { name: 'Project live' })).toHaveFocus();
  });

  it('moves the focus to the button that creates a project when nothing else is left', () => {
    seed([project('a', true, 10)]);
    renderSection();
    fireEvent.click(toggle());

    press(remove('a'));

    expect(screen.getByRole('button', { name: '创建项目' })).toHaveFocus();
  });

  it('takes the focus from no control that has it', () => {
    renderSection();
    fireEvent.click(toggle());
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    elsewhere.focus();

    fireEvent.click(remove('b'));

    expect(elsewhere).toHaveFocus();
  });
});
