// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render as renderBare, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { exists } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import { closingWindow, finishClosing, keepClosingLayersOnScreen, windowBox } from '@/test/dsWindows';
import { DesignSystemProvider } from '@/components/ds/provider';
import { format, getI18n, initLanguage } from '@/i18n';
import PromoteToProjectHint from './PromoteToProjectHint';

interface FakeProject { id: string; name: string; workspacePath: string }

vi.mock('@/stores/projectStore', async () => {
  const { create } = await import('zustand');
  const useProjectStore = create<{
    projects: Record<string, FakeProject>;
    createProject: (data: Omit<FakeProject, 'id'>) => string;
    getProjectByWorkspace: (workspacePath: string) => FakeProject | undefined;
  }>()((set, get) => ({
    projects: {},
    createProject: (data) => {
      set((state) => ({ projects: { ...state.projects, 'p-new': { ...data, id: 'p-new' } } }));
      return 'p-new';
    },
    getProjectByWorkspace: (workspacePath) => Object.values(get().projects).find((project) => project.workspacePath === workspacePath),
  }));
  return { useProjectStore };
});
vi.mock('@/stores/chatStore', async () => {
  const { create } = await import('zustand');
  return {
    useChatStore: create(() => ({
      conversationIndex: {},
      setConversationProject: () => undefined,
      startNewConversation: () => undefined,
    })),
  };
});
vi.mock('@/stores/workspaceStore', async () => {
  const { create } = await import('zustand');
  return { useWorkspaceStore: create(() => ({ setWorkspace: () => undefined })) };
});
vi.mock('@/stores/settingsStore', async () => {
  const { create } = await import('zustand');
  return { useSettingsStore: create(() => ({ setViewMode: () => undefined })) };
});
vi.mock('@/stores/previewStore', async () => {
  const { create } = await import('zustand');
  return { usePreviewStore: create(() => ({ setFileTreeMode: () => undefined })) };
});

import { useProjectHintStore } from '@/stores/projectHintStore';
import { useProjectStore as projectStore } from '@/stores/projectStore';

// The project store above is the stand-in: it holds only what the hint and the window read.
const useProjectStore = projectStore as unknown as {
  setState: (state: { projects: Record<string, FakeProject> }) => void;
  getState: () => { projects: Record<string, FakeProject> };
};

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });
const t = () => getI18n();
const FOLDER = '/fake/work/notes';

const ui = {
  hint: () => screen.queryByText(format(t().project.hintPromote, { name: 'notes' })),
  promote: () => screen.getByRole('button', { name: t().project.hintPromoteAction }),
  ignore: () => screen.getByRole('button', { name: t().project.hintPromoteDismiss }),
  name: () => screen.getByPlaceholderText<HTMLInputElement>(t().project.namePlaceholder),
  create: () => screen.getByRole('button', { name: t().project.create }),
  window: () => windowBox(t().project.createTitle),
  escape: () => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' }),
};

// Lets every promise the window waits on settle.
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  initLanguage('zh-CN');
  useProjectStore.setState({ projects: {} });
  useProjectHintStore.setState({ dismissedWorkspaces: [] });
  vi.mocked(homeDir).mockReset().mockResolvedValue('/fake/home');
  vi.mocked(exists).mockReset().mockResolvedValue(false);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PromoteToProjectHint', () => {
  describe('when it shows', () => {
    it('offers to make a project of a folder that is none yet', () => {
      render(<PromoteToProjectHint workspacePath={FOLDER} />);
      expect(ui.hint()).toBeInTheDocument();
    });

    it('shows nothing without a folder', () => {
      render(<PromoteToProjectHint workspacePath={null} />);
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('shows nothing for a folder that is a project already', () => {
      useProjectStore.setState({ projects: { p1: { id: 'p1', name: 'Notes', workspacePath: FOLDER } } });
      render(<PromoteToProjectHint workspacePath={FOLDER} />);
      expect(ui.hint()).not.toBeInTheDocument();
    });

    it('goes for good once it is ignored', () => {
      render(<PromoteToProjectHint workspacePath={FOLDER} />);

      fireEvent.click(ui.ignore());

      expect(ui.hint()).not.toBeInTheDocument();
      expect(useProjectHintStore.getState().dismissedWorkspaces).toEqual([FOLDER]);
    });
  });

  describe('the window it opens', () => {
    it('is the form, filled in with the folder and its name', async () => {
      render(<PromoteToProjectHint workspacePath={FOLDER} />);

      fireEvent.click(ui.promote());
      await settle();

      expect(ui.name().value).toBe('notes');
      expect(ui.window()).toHaveTextContent(FOLDER);
    });

    it('gives the focus back to 升级 when it is closed without a project', async () => {
      keepClosingLayersOnScreen();
      render(<PromoteToProjectHint workspacePath={FOLDER} />);
      ui.promote().focus();
      fireEvent.click(ui.promote());
      await settle();

      ui.escape();
      finishClosing();

      expect(ui.window()).toBeNull();
      expect(ui.promote()).toHaveFocus();
    });

    // The hint goes the moment the folder is a project. The window is closed, not taken off
    // the page with the hint: it fades out showing what it showed.
    it('fades out with the folder and the name once the project exists, while the hint has gone', async () => {
      keepClosingLayersOnScreen();
      render(<PromoteToProjectHint workspacePath={FOLDER} />);
      fireEvent.click(ui.promote());
      await settle();

      fireEvent.click(ui.create());
      await settle();

      expect(useProjectStore.getState().projects['p-new']).toMatchObject({ name: 'notes', workspacePath: FOLDER });
      expect(ui.hint()).not.toBeInTheDocument();
      expect(closingWindow()).toHaveTextContent(t().project.createTitle);
      expect(closingWindow()).toHaveTextContent(FOLDER);
      expect(closingWindow()).not.toHaveTextContent(format(t().project.folderConflict, { name: 'notes' }));
      expect(ui.name().value).toBe('notes');

      finishClosing();
      expect(ui.window()).toBeNull();
    });

    it('keeps the folder it was opened for when the page moves to another folder while it fades out', async () => {
      keepClosingLayersOnScreen();
      const view = render(<PromoteToProjectHint workspacePath={FOLDER} />);
      fireEvent.click(ui.promote());
      await settle();
      fireEvent.click(ui.create());
      await settle();

      view.rerender(<PromoteToProjectHint workspacePath={null} />);

      expect(closingWindow()).toHaveTextContent(FOLDER);
    });
  });
});
