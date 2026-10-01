// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import type { ComponentProps, ReactElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { copyFile, exists, mkdir, rename, writeTextFile } from '@tauri-apps/plugin-fs';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { DesignSystemProvider } from '@/components/ds/provider';
import type { UseWorkspaceTreeResult, WorkspaceTreeEntry } from '@/hooks/useWorkspaceTree';
import { initLanguage } from '@/i18n';
import enUS from '@/i18n/locales/en-US';
import { useChatStore } from '@/stores/chatStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useToastStore } from '@/stores/toastStore';
import WorkspaceFileTree from './WorkspaceFileTree';

// The tree state the mocked hook hands to the component; tests change it to play the
// part of the file watcher (a refresh, a file that went away, an expanded folder).
const tree = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let state: unknown = null;
  return {
    get: () => state,
    set: (next: unknown) => {
      state = next;
      listeners.forEach((listener) => listener());
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
});

vi.mock('@/hooks/useWorkspaceTree', async () => {
  const { useSyncExternalStore } = await import('react');
  return { useWorkspaceTree: () => useSyncExternalStore(tree.subscribe, tree.get) };
});

// The global setup mock has no `revealItemInDir`.
vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
  openPath: vi.fn().mockResolvedValue(undefined),
  revealItemInDir: vi.fn().mockResolvedValue(undefined),
}));

// What each row's right-click menu was given, keyed by the row's path, to drive a menu
// the way Radix does when it is reopened during its exit animation (happy-dom has no
// animations), plus the renders of each row, the rows that have a menu mounted and the
// close hooks that have run.
const HEADER_MENU = vi.hoisted(() => 'header menu');
const rowMenus = vi.hoisted(() => ({
  renders: [] as string[],
  mounted: new Set<string>(),
  closeHooks: [] as string[],
  headerRenders: { count: 0 },
  fieldsRendered: [] as string[],
  onOpenChange: new Map<string, ((open: boolean) => void) | undefined>(),
  onCloseAutoFocus: new Map<string, ((event: Event) => void) | undefined>(),
  itemSelect: new Map<string, ((event: Event) => void) | undefined>(),
}));

vi.mock('@/components/ds/context-menu', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ds/context-menu')>();
  return {
    ...actual,
    ContextMenu: (props: ComponentProps<typeof actual.ContextMenu>) => {
      const path = (props.children as ReactElement<{ title: string }>).props.title;
      rowMenus.mounted.add(path);
      rowMenus.onOpenChange.set(path, props.onOpenChange);
      rowMenus.onCloseAutoFocus.set(path, props.onCloseAutoFocus);
      return actual.ContextMenu({
        ...props,
        onCloseAutoFocus: (event) => {
          props.onCloseAutoFocus?.(event);
          rowMenus.closeHooks.push(path);
        },
      });
    },
  };
});

// Counts the renders of each row: a row is the only button that carries a path as its hint.
vi.mock('@/components/ds/pressable', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ds/pressable')>();
  return {
    ...actual,
    Pressable: (props: ComponentProps<typeof actual.Pressable>) => {
      if (props.title) rowMenus.renders.push(props.title);
      return actual.Pressable(props);
    },
  };
});

// Records every name field the tree renders, by its placeholder.
vi.mock('@/components/ds/text-field', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ds/text-field')>();
  return {
    ...actual,
    TextField: (props: ComponentProps<typeof actual.TextField>) => {
      rowMenus.fieldsRendered.push(props.placeholder ?? '');
      return actual.TextField(props);
    },
  };
});

vi.mock('@/components/ds/menu', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ds/menu')>();
  return {
    ...actual,
    Menu: (props: ComponentProps<typeof actual.Menu>) => {
      rowMenus.headerRenders.count += 1;
      return actual.Menu({
        ...props,
        onCloseAutoFocus: (event) => {
          props.onCloseAutoFocus?.(event);
          rowMenus.closeHooks.push(HEADER_MENU);
        },
      });
    },
    MenuItem: (props: ComponentProps<typeof actual.MenuItem>) => {
      if (typeof props.children === 'string') rowMenus.itemSelect.set(props.children, props.onSelect);
      return actual.MenuItem(props);
    },
  };
});

const ROOT = '/work/site';
const DOCS: WorkspaceTreeEntry = { name: 'docs', path: '/work/site/docs', isDirectory: true, isSymlink: false };
const NOTES: WorkspaceTreeEntry = { name: 'notes.md', path: '/work/site/notes.md', isDirectory: false, isSymlink: false };
const PLAN: WorkspaceTreeEntry = { name: 'plan.md', path: '/work/site/plan.md', isDirectory: false, isSymlink: false };
const GUIDE: WorkspaceTreeEntry = { name: 'guide.md', path: '/work/site/docs/guide.md', isDirectory: false, isSymlink: false };
const copy = enUS.panel.fileTree;

const refresh = vi.fn();
const toggleExpand = vi.fn((path: string) => {
  const current = tree.get() as UseWorkspaceTreeResult;
  const expandedPaths = new Set(current.expandedPaths);
  if (!expandedPaths.delete(path)) expandedPaths.add(path);
  tree.set({ ...current, expandedPaths });
});
const openPreview = vi.fn();
const closePreviewTabsForPath = vi.fn();
const retargetPreviewPath = vi.fn();
const addPendingAttachment = vi.fn();

function setTree(overrides: Partial<UseWorkspaceTreeResult> = {}) {
  tree.set({
    rootPath: ROOT,
    rootEntries: [DOCS, NOTES, PLAN],
    isRootLoading: false,
    rootError: null,
    rootMissing: false,
    childrenByPath: new Map(),
    expandedPaths: new Set(),
    loadingPaths: new Set(),
    errorsByPath: new Map(),
    toggleExpand,
    refresh,
    ...overrides,
  } satisfies UseWorkspaceTreeResult);
}

function patchTree(overrides: Partial<UseWorkspaceTreeResult>) {
  act(() => tree.set({ ...(tree.get() as UseWorkspaceTreeResult), ...overrides }));
}

function renderTree() {
  return render(
    <DesignSystemProvider>
      <WorkspaceFileTree />
    </DesignSystemProvider>,
  );
}

// Every row carries its full path as the native hint.
function row(entry: WorkspaceTreeEntry) {
  return screen.getByTitle(entry.path);
}

async function chooseFromRowMenu(user: UserEvent, entry: WorkspaceTreeEntry, label: string) {
  fireEvent.contextMenu(row(entry));
  await user.click(await screen.findByText(label));
}

async function chooseFromHeaderMenu(user: UserEvent, label: string) {
  await user.click(screen.getByRole('button', { name: copy.moreActions }));
  await user.click(await screen.findByText(label));
}

// Waits until the close hook of a menu (a row's path, or HEADER_MENU) has run and
// whatever it started has rendered.
async function closeHookRan(menu: string) {
  await waitFor(() => expect(rowMenus.closeHooks).toContain(menu));
  await act(async () => {});
}

function toasts() {
  return useToastStore.getState().toasts.map(({ type, title, message }) => ({ type, title, message }));
}

beforeAll(() => {
  // happy-dom has no pointer capture or scrollIntoView; Radix menus call them.
  HTMLElement.prototype.setPointerCapture ??= () => {};
  HTMLElement.prototype.releasePointerCapture ??= () => {};
  HTMLElement.prototype.hasPointerCapture ??= () => false;
  HTMLElement.prototype.scrollIntoView ??= () => {};
});

beforeEach(() => {
  initLanguage('en-US');
  setTree();
  refresh.mockClear();
  toggleExpand.mockClear();
  openPreview.mockClear();
  closePreviewTabsForPath.mockClear();
  retargetPreviewPath.mockClear();
  addPendingAttachment.mockClear();
  vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
  vi.mocked(exists).mockReset().mockResolvedValue(false);
  vi.mocked(rename).mockReset().mockResolvedValue(undefined);
  vi.mocked(mkdir).mockReset().mockResolvedValue(undefined);
  vi.mocked(writeTextFile).mockReset().mockResolvedValue(undefined);
  vi.mocked(copyFile).mockReset().mockResolvedValue(undefined);
  vi.mocked(openFileDialog).mockReset().mockResolvedValue(null);
  vi.mocked(revealItemInDir).mockReset().mockResolvedValue(undefined);
  usePreviewStore.setState({ previewFilePath: null, openPreview, closePreviewTabsForPath, retargetPreviewPath });
  useChatStore.setState({ activeConversationId: null, addPendingAttachment });
  useToastStore.setState({ toasts: [] });
  rowMenus.renders.length = 0;
  rowMenus.mounted.clear();
  rowMenus.closeHooks.length = 0;
  rowMenus.headerRenders.count = 0;
  rowMenus.fieldsRendered.length = 0;
  rowMenus.onOpenChange.clear();
  rowMenus.onCloseAutoFocus.clear();
  rowMenus.itemSelect.clear();
});

afterEach(() => cleanup());

// What the tree does to the disk, and when. These tests find every control by its words.
describe('WorkspaceFileTree file operations', () => {
  describe('delete', () => {
    it('asks first and moves nothing when the answer is Cancel', async () => {
      const user = userEvent.setup();
      renderTree();

      await chooseFromRowMenu(user, NOTES, copy.delete);

      expect(await screen.findByText(copy.confirmDelete)).toBeInTheDocument();
      expect(invoke).not.toHaveBeenCalled();

      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      await waitFor(() => expect(screen.queryByText(copy.confirmDelete)).not.toBeInTheDocument());
      expect(invoke).not.toHaveBeenCalled();
      expect(closePreviewTabsForPath).not.toHaveBeenCalled();
      expect(row(NOTES)).toBeInTheDocument();
    });

    it('moves nothing when the question is dismissed with Escape', async () => {
      const user = userEvent.setup();
      renderTree();

      await chooseFromRowMenu(user, NOTES, copy.delete);
      await screen.findByText(copy.confirmDelete);
      await user.keyboard('{Escape}');

      await waitFor(() => expect(screen.queryByText(copy.confirmDelete)).not.toBeInTheDocument());
      expect(invoke).not.toHaveBeenCalled();
    });

    it('moves exactly the chosen file to the trash once the answer is yes', async () => {
      const user = userEvent.setup();
      renderTree();

      await chooseFromRowMenu(user, NOTES, copy.delete);
      await screen.findByText(copy.confirmDelete);
      await user.click(screen.getByRole('button', { name: copy.moveToTrash }));

      await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
      expect(invoke).toHaveBeenCalledWith('move_to_trash', { path: NOTES.path });
      await waitFor(() => expect(closePreviewTabsForPath).toHaveBeenCalledWith(NOTES.path));
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(toasts()).toEqual([]);
    });

    it('moves a whole folder by its own path', async () => {
      const user = userEvent.setup();
      renderTree();

      await chooseFromRowMenu(user, DOCS, copy.delete);
      await screen.findByText(copy.confirmDelete);
      await user.click(screen.getByRole('button', { name: copy.moveToTrash }));

      await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
      expect(invoke).toHaveBeenCalledWith('move_to_trash', { path: DOCS.path });
    });

    it.each([
      ['a path outside the workspace', '/elsewhere/outside.txt'],
      ['a sibling folder that shares the workspace prefix', '/work/site-other/file.txt'],
      ['the workspace folder itself', '/work/site'],
      ['the workspace folder with a trailing slash', '/work/site/'],
    ])('refuses %s', async (_label, path) => {
      const user = userEvent.setup();
      const stray: WorkspaceTreeEntry = { name: 'stray', path, isDirectory: false, isSymlink: false };
      setTree({ rootEntries: [stray] });
      renderTree();

      await chooseFromRowMenu(user, stray, copy.delete);
      await screen.findByText(copy.confirmDelete);
      await user.click(screen.getByRole('button', { name: copy.moveToTrash }));

      await waitFor(() => expect(toasts()).toEqual([{ type: 'error', title: copy.deleteFailed, message: copy.invalidName }]));
      expect(invoke).not.toHaveBeenCalled();
      expect(closePreviewTabsForPath).not.toHaveBeenCalled();
    });

    it('passes a Windows path through untouched when it is inside the workspace', async () => {
      const user = userEvent.setup();
      const file: WorkspaceTreeEntry = { name: 'a.txt', path: 'C:\\work\\site\\a.txt', isDirectory: false, isSymlink: false };
      setTree({ rootPath: 'C:\\work\\site', rootEntries: [file] });
      renderTree();

      await chooseFromRowMenu(user, file, copy.delete);
      await screen.findByText(copy.confirmDelete);
      await user.click(screen.getByRole('button', { name: copy.moveToTrash }));

      await waitFor(() => expect(invoke).toHaveBeenCalledWith('move_to_trash', { path: 'C:\\work\\site\\a.txt' }));
    });

    it('reports a failed move and keeps the preview tabs', async () => {
      const user = userEvent.setup();
      vi.mocked(invoke).mockRejectedValue(new Error('trash is unavailable'));
      renderTree();

      await chooseFromRowMenu(user, NOTES, copy.delete);
      await screen.findByText(copy.confirmDelete);
      await user.click(screen.getByRole('button', { name: copy.moveToTrash }));

      await waitFor(() => expect(toasts()).toEqual([{ type: 'error', title: copy.deleteFailed, message: 'trash is unavailable' }]));
      expect(closePreviewTabsForPath).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
    });
  });

  describe('rename', () => {
    it('renames on Enter, with the name trimmed, and follows the open previews', async () => {
      const user = userEvent.setup();
      renderTree();

      await chooseFromRowMenu(user, NOTES, copy.rename);
      const field = await screen.findByRole('textbox');
      expect(field).toHaveValue('notes.md');
      await user.clear(field);
      await user.type(field, '  minutes.md {Enter}');

      await waitFor(() => expect(rename).toHaveBeenCalledTimes(1));
      expect(rename).toHaveBeenCalledWith(NOTES.path, '/work/site/minutes.md');
      await waitFor(() => expect(retargetPreviewPath).toHaveBeenCalledWith(NOTES.path, '/work/site/minutes.md'));
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    });

    it('renames a file in a folder inside that folder', async () => {
      const user = userEvent.setup();
      setTree({ expandedPaths: new Set([DOCS.path]), childrenByPath: new Map([[DOCS.path, [GUIDE]]]) });
      renderTree();

      await chooseFromRowMenu(user, GUIDE, copy.rename);
      const field = await screen.findByRole('textbox');
      await user.clear(field);
      await user.type(field, 'manual.md{Enter}');

      await waitFor(() => expect(rename).toHaveBeenCalledWith(GUIDE.path, '/work/site/docs/manual.md'));
    });

    it('leaves the file alone on Escape', async () => {
      const user = userEvent.setup();
      renderTree();

      await chooseFromRowMenu(user, NOTES, copy.rename);
      const field = await screen.findByRole('textbox');
      await user.clear(field);
      await user.type(field, 'minutes.md{Escape}');

      await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
      expect(rename).not.toHaveBeenCalled();
      expect(row(NOTES)).toHaveTextContent('notes.md');
      expect(toasts()).toEqual([]);
    });

    it('does nothing for an unchanged name', async () => {
      const user = userEvent.setup();
      renderTree();

      await chooseFromRowMenu(user, NOTES, copy.rename);
      await user.type(await screen.findByRole('textbox'), '{Enter}');

      await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
      expect(rename).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
      expect(toasts()).toEqual([]);
    });

    it.each([
      ['an empty name', ''],
      ['a name of spaces', '   '],
      ['a name with a slash', 'a/b.md'],
    ])('rejects %s', async (_label, name) => {
      const user = userEvent.setup();
      renderTree();

      await chooseFromRowMenu(user, NOTES, copy.rename);
      const field = await screen.findByRole('textbox');
      await user.clear(field);
      if (name) await user.type(field, name);
      await user.keyboard('{Enter}');

      await waitFor(() => expect(toasts()).toEqual([{ type: 'error', title: copy.renameFailed, message: copy.invalidName }]));
      expect(rename).not.toHaveBeenCalled();
    });

    it('commits once when the field loses focus, and not again after Enter', async () => {
      const user = userEvent.setup();
      renderTree();

      await chooseFromRowMenu(user, NOTES, copy.rename);
      const field = await screen.findByRole('textbox');
      await user.clear(field);
      await user.type(field, 'minutes.md');
      fireEvent.blur(field);

      await waitFor(() => expect(rename).toHaveBeenCalledTimes(1));
      expect(rename).toHaveBeenCalledWith(NOTES.path, '/work/site/minutes.md');

      vi.mocked(rename).mockClear();
      await chooseFromRowMenu(user, PLAN, copy.rename);
      const second = await screen.findByRole('textbox');
      await user.clear(second);
      await user.type(second, 'roadmap.md');
      // Enter and the blur that follows it land before the field has gone.
      act(() => {
        fireEvent.keyDown(second, { key: 'Enter' });
        fireEvent.blur(second);
      });

      await waitFor(() => expect(rename).toHaveBeenCalledTimes(1));
      expect(rename).toHaveBeenCalledWith(PLAN.path, '/work/site/roadmap.md');
    });

    // The field has no input-method guard: Enter that confirms a composition also commits.
    it('commits on Enter while an input method is composing', async () => {
      const user = userEvent.setup();
      renderTree();

      await chooseFromRowMenu(user, NOTES, copy.rename);
      const field = await screen.findByRole('textbox');
      await user.clear(field);
      await user.type(field, 'minutes.md');
      fireEvent.keyDown(field, { key: 'Enter', isComposing: true, keyCode: 229 });

      await waitFor(() => expect(rename).toHaveBeenCalledWith(NOTES.path, '/work/site/minutes.md'));
    });

    it('reports a failed rename', async () => {
      const user = userEvent.setup();
      vi.mocked(rename).mockRejectedValue(new Error('name is taken'));
      renderTree();

      await chooseFromRowMenu(user, NOTES, copy.rename);
      const field = await screen.findByRole('textbox');
      await user.clear(field);
      await user.type(field, 'minutes.md{Enter}');

      await waitFor(() => expect(toasts()).toEqual([{ type: 'error', title: copy.renameFailed, message: 'name is taken' }]));
      expect(retargetPreviewPath).not.toHaveBeenCalled();
    });
  });

  describe('new file and new folder inside a folder', () => {
    it('opens a collapsed folder, creates an empty file there and previews it', async () => {
      const user = userEvent.setup();
      renderTree();

      await chooseFromRowMenu(user, DOCS, copy.newFile);
      const field = await screen.findByPlaceholderText(copy.newFilePlaceholder);
      expect(toggleExpand).toHaveBeenCalledTimes(1);
      expect(toggleExpand).toHaveBeenCalledWith(DOCS.path);
      await user.type(field, ' draft.md {Enter}');

      await waitFor(() => expect(writeTextFile).toHaveBeenCalledTimes(1));
      expect(exists).toHaveBeenCalledWith('/work/site/docs/draft.md');
      expect(writeTextFile).toHaveBeenCalledWith('/work/site/docs/draft.md', '');
      expect(mkdir).not.toHaveBeenCalled();
      await waitFor(() => expect(openPreview).toHaveBeenCalledWith('/work/site/docs/draft.md'));
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('creates a folder in a folder that is already open without closing it', async () => {
      const user = userEvent.setup();
      setTree({ expandedPaths: new Set([DOCS.path]), childrenByPath: new Map([[DOCS.path, [GUIDE]]]) });
      renderTree();

      await chooseFromRowMenu(user, DOCS, copy.newFolder);
      const field = await screen.findByPlaceholderText(copy.newFolderPlaceholder);
      expect(toggleExpand).not.toHaveBeenCalled();
      await user.type(field, 'assets{Enter}');

      await waitFor(() => expect(mkdir).toHaveBeenCalledTimes(1));
      expect(mkdir).toHaveBeenCalledWith('/work/site/docs/assets', { recursive: true });
      expect(writeTextFile).not.toHaveBeenCalled();
      expect(openPreview).not.toHaveBeenCalled();
      expect(row(GUIDE)).toBeInTheDocument();
    });

    it('never overwrites an existing entry', async () => {
      const user = userEvent.setup();
      vi.mocked(exists).mockResolvedValue(true);
      renderTree();

      await chooseFromRowMenu(user, DOCS, copy.newFile);
      await user.type(await screen.findByPlaceholderText(copy.newFilePlaceholder), 'guide.md{Enter}');

      await waitFor(() => expect(toasts()).toEqual([{ type: 'error', title: copy.newFileFailed, message: copy.alreadyExists }]));
      expect(writeTextFile).not.toHaveBeenCalled();
      expect(openPreview).not.toHaveBeenCalled();
    });

    it.each([
      ['an empty name', '', 'file'],
      ['a name with a slash', '../up.md', 'file'],
      ['a folder name with a slash', 'a/b', 'folder'],
    ] as const)('rejects %s', async (_label, name, kind) => {
      const user = userEvent.setup();
      renderTree();

      await chooseFromRowMenu(user, DOCS, kind === 'file' ? copy.newFile : copy.newFolder);
      const field = await screen.findByPlaceholderText(kind === 'file' ? copy.newFilePlaceholder : copy.newFolderPlaceholder);
      if (name) await user.type(field, name);
      await user.keyboard('{Enter}');

      await waitFor(() => expect(toasts()).toEqual([{
        type: 'error',
        title: kind === 'file' ? copy.newFileFailed : copy.newFolderFailed,
        message: copy.invalidName,
      }]));
      expect(exists).not.toHaveBeenCalled();
      expect(writeTextFile).not.toHaveBeenCalled();
      expect(mkdir).not.toHaveBeenCalled();
    });

    it('creates nothing on Escape', async () => {
      const user = userEvent.setup();
      renderTree();

      await chooseFromRowMenu(user, DOCS, copy.newFile);
      await user.type(await screen.findByPlaceholderText(copy.newFilePlaceholder), 'draft.md{Escape}');

      await waitFor(() => expect(screen.queryByPlaceholderText(copy.newFilePlaceholder)).not.toBeInTheDocument());
      expect(writeTextFile).not.toHaveBeenCalled();
      expect(toasts()).toEqual([]);
    });
  });

  describe('the header menu', () => {
    it('creates a folder in the workspace folder', async () => {
      const user = userEvent.setup();
      renderTree();

      await chooseFromHeaderMenu(user, copy.newFolder);
      await user.type(await screen.findByPlaceholderText(copy.newFolderPlaceholder), ' archive {Enter}');

      await waitFor(() => expect(mkdir).toHaveBeenCalledTimes(1));
      expect(exists).toHaveBeenCalledWith('/work/site/archive');
      expect(mkdir).toHaveBeenCalledWith('/work/site/archive', { recursive: true });
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('says so when the folder already exists', async () => {
      const user = userEvent.setup();
      vi.mocked(exists).mockResolvedValue(true);
      renderTree();

      await chooseFromHeaderMenu(user, copy.newFolder);
      await user.type(await screen.findByPlaceholderText(copy.newFolderPlaceholder), 'docs{Enter}');

      await waitFor(() => expect(toasts()).toEqual([{ type: 'error', title: copy.newFolderFailed, message: copy.alreadyExists }]));
      expect(mkdir).not.toHaveBeenCalled();
    });

    it('creates nothing for an empty name or on Escape', async () => {
      const user = userEvent.setup();
      renderTree();

      await chooseFromHeaderMenu(user, copy.newFolder);
      await user.type(await screen.findByPlaceholderText(copy.newFolderPlaceholder), '{Enter}');
      await waitFor(() => expect(screen.queryByPlaceholderText(copy.newFolderPlaceholder)).not.toBeInTheDocument());

      await chooseFromHeaderMenu(user, copy.newFolder);
      await user.type(await screen.findByPlaceholderText(copy.newFolderPlaceholder), 'archive{Escape}');
      await waitFor(() => expect(screen.queryByPlaceholderText(copy.newFolderPlaceholder)).not.toBeInTheDocument());

      expect(exists).not.toHaveBeenCalled();
      expect(mkdir).not.toHaveBeenCalled();
      expect(toasts()).toEqual([]);
    });

    it('copies picked files into the workspace folder without overwriting', async () => {
      const user = userEvent.setup();
      vi.mocked(openFileDialog).mockResolvedValue(['/downloads/report.pdf', '/downloads/notes.md'] as never);
      // notes.md and "notes (1).md" are taken.
      vi.mocked(exists).mockImplementation(async (path) => path === '/work/site/notes.md' || path === '/work/site/notes (1).md');
      renderTree();

      await chooseFromHeaderMenu(user, copy.addFile);

      await waitFor(() => expect(copyFile).toHaveBeenCalledTimes(2));
      expect(openFileDialog).toHaveBeenCalledWith({ multiple: true });
      expect(copyFile).toHaveBeenNthCalledWith(1, '/downloads/report.pdf', '/work/site/report.pdf');
      expect(copyFile).toHaveBeenNthCalledWith(2, '/downloads/notes.md', '/work/site/notes (2).md');
      await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    });

    it('copies nothing when the picker is cancelled', async () => {
      const user = userEvent.setup();
      renderTree();

      await chooseFromHeaderMenu(user, copy.addFile);

      await waitFor(() => expect(openFileDialog).toHaveBeenCalledTimes(1));
      expect(copyFile).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
    });

    it('has no header menu without a workspace', () => {
      setTree({ rootPath: null, rootEntries: [] });
      renderTree();

      expect(screen.queryByRole('button', { name: copy.moreActions })).not.toBeInTheDocument();
      expect(screen.getByText(copy.noWorkspace)).toBeInTheDocument();
    });
  });

  describe('the other row actions', () => {
    it('reveals the row in the file manager', async () => {
      const user = userEvent.setup();
      renderTree();

      await chooseFromRowMenu(user, NOTES, copy.revealInFinder);

      await waitFor(() => expect(revealItemInDir).toHaveBeenCalledWith(NOTES.path));
    });

    it('copies the full path', async () => {
      const user = userEvent.setup();
      const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
      writeText.mockClear();
      renderTree();

      await chooseFromRowMenu(user, NOTES, copy.copyPath);

      await waitFor(() => expect(toasts()).toEqual([{ type: 'success', title: copy.copyPathDone, message: undefined }]));
      expect(writeText).toHaveBeenCalledWith(NOTES.path);
    });

    it('hands a file to the chat as a workspace attachment', async () => {
      const user = userEvent.setup();
      useChatStore.setState({ activeConversationId: 'conv-1' });
      renderTree();

      await chooseFromRowMenu(user, NOTES, copy.addToChat);

      await waitFor(() => expect(addPendingAttachment).toHaveBeenCalledTimes(1));
      expect(addPendingAttachment).toHaveBeenCalledWith(expect.objectContaining({ path: NOTES.path, readScope: 'workspace' }));
      expect(toasts()).toEqual([{ type: 'success', title: copy.addedToChat, message: undefined }]);
    });
  });

  describe('opening', () => {
    it('previews a file and toggles a folder on click', async () => {
      const user = userEvent.setup();
      renderTree();

      await user.click(row(NOTES));
      expect(openPreview).toHaveBeenCalledWith(NOTES.path);
      expect(toggleExpand).not.toHaveBeenCalled();

      await user.click(row(DOCS));
      expect(toggleExpand).toHaveBeenCalledWith(DOCS.path);
      expect(openPreview).toHaveBeenCalledTimes(1);
    });

    it('does the same from the keyboard with Enter and Space', async () => {
      const user = userEvent.setup();
      renderTree();

      act(() => row(NOTES).focus());
      await user.keyboard('{Enter}');
      expect(openPreview).toHaveBeenCalledTimes(1);

      act(() => row(DOCS).focus());
      await user.keyboard(' ');
      expect(toggleExpand).toHaveBeenCalledTimes(1);
      expect(toggleExpand).toHaveBeenCalledWith(DOCS.path);
    });

    it('reaches the rows in order with Tab', async () => {
      const user = userEvent.setup();
      setTree({ expandedPaths: new Set([DOCS.path]), childrenByPath: new Map([[DOCS.path, [GUIDE]]]) });
      renderTree();

      act(() => screen.getByRole('button', { name: copy.moreActions }).focus());
      const order: Array<string | null> = [];
      for (let i = 0; i < 4; i += 1) {
        await user.tab();
        order.push(document.activeElement?.getAttribute('title') ?? null);
      }

      expect(order).toEqual([DOCS.path, GUIDE.path, NOTES.path, PLAN.path]);
    });

    it('keeps the indentation of each level', () => {
      setTree({ expandedPaths: new Set([DOCS.path]), childrenByPath: new Map([[DOCS.path, [GUIDE]]]) });
      renderTree();

      expect(row(DOCS).style.paddingLeft).toBe('6px');
      expect(row(GUIDE).style.paddingLeft).toBe('20px');
      expect(row(GUIDE).style.paddingRight).toBe('6px');
    });

    it('shows what is inside an open folder, in order, and the states of a folder', () => {
      const empty: WorkspaceTreeEntry = { name: 'empty', path: '/work/site/empty', isDirectory: true, isSymlink: false };
      const loading: WorkspaceTreeEntry = { name: 'loading', path: '/work/site/loading', isDirectory: true, isSymlink: false };
      const broken: WorkspaceTreeEntry = { name: 'broken', path: '/work/site/broken', isDirectory: true, isSymlink: false };
      setTree({
        rootEntries: [DOCS, empty, loading, broken, NOTES],
        expandedPaths: new Set([DOCS.path, empty.path, loading.path, broken.path]),
        childrenByPath: new Map([[DOCS.path, [GUIDE]], [empty.path, []]]),
        loadingPaths: new Set([loading.path]),
        errorsByPath: new Map([[broken.path, 'denied']]),
      });
      const { container } = renderTree();

      const text = container.textContent ?? '';
      const order = ['docs', 'guide.md', 'empty', copy.empty, 'loading', copy.loading, 'broken', copy.loadError, 'notes.md'];
      const positions = order.map((word) => text.indexOf(word));
      expect(positions.every((position) => position >= 0)).toBe(true);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    });

    const emptyStates: Array<[string, Partial<UseWorkspaceTreeResult>, string]> = [
      ['no workspace', { rootPath: null, rootEntries: [] }, copy.noWorkspace],
      ['a deleted folder', { rootMissing: true, rootEntries: [] }, copy.folderDeleted],
      ['a folder that cannot be read', { rootError: 'denied', rootEntries: [] }, copy.loadError],
      ['a folder still loading', { isRootLoading: true, rootEntries: [] }, copy.loading],
      ['an empty folder', { rootEntries: [] }, copy.empty],
    ];
    it.each(emptyStates)('says so for %s', (_label, overrides, message) => {
      setTree(overrides);
      renderTree();

      expect(screen.getByText(message)).toBeInTheDocument();
    });
  });
});

// The tree on the design system: one right-click menu per row, a confirmation dialog
// for delete, and rows that stay put while the rest of the tree changes.
describe('WorkspaceFileTree menus and rows', () => {
  function menuItemNames() {
    return within(screen.getByRole('menu')).getAllByRole('menuitem').map((item) => item.textContent);
  }

  describe('the right-click menu', () => {
    it('offers the file actions for a file', () => {
      renderTree();

      fireEvent.contextMenu(row(NOTES));

      expect(menuItemNames()).toEqual([copy.revealInFinder, copy.addToChat, copy.copyPath, copy.rename, copy.delete]);
      expect(screen.queryByRole('menuitem', { name: copy.newFile })).not.toBeInTheDocument();
    });

    it('offers the folder actions for a folder', () => {
      renderTree();

      fireEvent.contextMenu(row(DOCS));

      expect(menuItemNames()).toEqual([copy.revealInFinder, copy.copyPath, copy.rename, copy.newFile, copy.newFolder, copy.delete]);
      expect(screen.queryByRole('menuitem', { name: copy.addToChat })).not.toBeInTheDocument();
    });

    it('closes before the rename field appears, and the field has the focus', async () => {
      const user = userEvent.setup();
      renderTree();

      fireEvent.contextMenu(row(NOTES));
      await user.click(screen.getByRole('menuitem', { name: copy.rename }));

      const field = await screen.findByRole('textbox');
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      expect(document.activeElement).toBe(field);
      expect(field).toHaveValue('notes.md');
    });

    it('gives the focus back to the row when a rename is cancelled with Escape', async () => {
      const user = userEvent.setup();
      renderTree();

      fireEvent.contextMenu(row(NOTES));
      await user.click(screen.getByRole('menuitem', { name: copy.rename }));
      await screen.findByRole('textbox');
      await user.keyboard('{Escape}');

      await waitFor(() => expect(row(NOTES)).toHaveFocus());
    });

    it('closes before the delete confirmation opens, and the confirmation is a dialog', async () => {
      const user = userEvent.setup();
      const order: string[] = [];
      const observer = new MutationObserver(() => {
        if (document.querySelector('[role="alertdialog"]')) {
          order.push(document.querySelector('[role="menu"]') ? 'dialog-with-menu' : 'dialog-without-menu');
        }
      });
      renderTree();
      observer.observe(document.body, { childList: true, subtree: true });

      fireEvent.contextMenu(row(NOTES));
      await user.click(screen.getByRole('menuitem', { name: copy.delete }));

      const dialog = await screen.findByRole('alertdialog', { name: enUS.panel.fileTree.confirmDelete });
      observer.disconnect();
      expect(order).not.toContain('dialog-with-menu');
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      expect(invoke).not.toHaveBeenCalled();
      // A stray Enter lands on Cancel, and the destructive button looks destructive.
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
      expect(within(dialog).getByRole('button', { name: copy.moveToTrash })).toHaveClass('text-danger');

      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
      expect(invoke).not.toHaveBeenCalled();
      await waitFor(() => expect(row(NOTES)).toHaveFocus());

      fireEvent.contextMenu(row(NOTES));
      await user.click(screen.getByRole('menuitem', { name: copy.delete }));
      await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: copy.moveToTrash }));

      await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
      expect(invoke).toHaveBeenCalledWith('move_to_trash', { path: NOTES.path });
    });

    it('moves only the highlight with the arrow keys', async () => {
      const user = userEvent.setup();
      const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
      writeText.mockClear();
      renderTree();

      fireEvent.contextMenu(row(NOTES));
      await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}');

      expect(screen.getByRole('menuitem', { name: copy.delete })).toHaveAttribute('data-highlighted');
      expect(screen.getByRole('menu')).toBeInTheDocument();
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
      expect(revealItemInDir).not.toHaveBeenCalled();
      expect(addPendingAttachment).not.toHaveBeenCalled();
      expect(writeText).not.toHaveBeenCalled();
      expect(invoke).not.toHaveBeenCalled();
      expect(rename).not.toHaveBeenCalled();

      await user.keyboard('{ArrowUp}');
      expect(screen.getByRole('menuitem', { name: copy.rename })).toHaveAttribute('data-highlighted');

      await user.keyboard('{Enter}');

      expect(document.activeElement).toBe(await screen.findByRole('textbox'));
      expect(invoke).not.toHaveBeenCalled();
    });

    it('leaves everything alone when the menu is dismissed with Escape', async () => {
      const user = userEvent.setup();
      renderTree();

      fireEvent.contextMenu(row(NOTES));
      await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{Escape}');

      await closeHookRan(NOTES.path);
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
      expect(invoke).not.toHaveBeenCalled();
    });

    // A menu reopened during its exit animation stays mounted: the close hook never ran
    // for the choice made before, and opening again must forget it.
    it('forgets a Delete whose close hook never ran when the same menu opens again', async () => {
      const user = userEvent.setup();
      renderTree();

      fireEvent.contextMenu(row(NOTES));
      act(() => rowMenus.itemSelect.get(copy.delete)?.(new Event('select')));
      act(() => rowMenus.onOpenChange.get(NOTES.path)?.(true));
      await user.keyboard('{Escape}');

      await closeHookRan(NOTES.path);
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(screen.queryByText(copy.confirmDelete)).not.toBeInTheDocument();
      expect(invoke).not.toHaveBeenCalled();
    });

    it('forgets a Delete whose close hook never ran when another row opens its menu', async () => {
      const user = userEvent.setup();
      renderTree();

      fireEvent.contextMenu(row(NOTES));
      act(() => rowMenus.itemSelect.get(copy.delete)?.(new Event('select')));
      fireEvent.contextMenu(row(PLAN));

      await closeHookRan(NOTES.path);
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

      await user.keyboard('{Escape}');

      await closeHookRan(PLAN.path);
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(invoke).not.toHaveBeenCalled();
    });

    it('forgets a Delete when the header menu opens before the row menu has gone', async () => {
      // The open row menu blocks the pointer outside it; the press still reaches the button.
      const user = userEvent.setup({ pointerEventsCheck: 0 });
      renderTree();

      fireEvent.contextMenu(row(NOTES));
      act(() => rowMenus.itemSelect.get(copy.delete)?.(new Event('select')));
      // An open menu hides the rest of the page from assistive technology.
      await user.click(screen.getByRole('button', { name: copy.moreActions, hidden: true }));

      await closeHookRan(NOTES.path);
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(screen.getByRole('menu')).toBeInTheDocument();

      await user.keyboard('{Escape}');

      await closeHookRan(HEADER_MENU);
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(invoke).not.toHaveBeenCalled();
    });

    it('lets a row carry out only the choice made in its own menu', async () => {
      const user = userEvent.setup();
      renderTree();

      // plan.md has had its menu open before, so its menu is mounted.
      fireEvent.contextMenu(row(PLAN));
      await user.keyboard('{Escape}');
      await closeHookRan(PLAN.path);

      fireEvent.contextMenu(row(NOTES));
      act(() => rowMenus.itemSelect.get(copy.delete)?.(new Event('select')));
      // Another row's close hook runs while the choice for notes.md is still waiting.
      const strayClose = new Event('close', { cancelable: true });
      act(() => rowMenus.onCloseAutoFocus.get(PLAN.path)?.(strayClose));

      expect(strayClose.defaultPrevented).toBe(false);
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

      // The menu of notes.md closes for real: Delete was chosen there, so it asks.
      await user.keyboard('{Escape}');

      const dialog = await screen.findByRole('alertdialog', { name: copy.confirmDelete });
      await user.click(within(dialog).getByRole('button', { name: copy.moveToTrash }));
      await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
      expect(invoke).toHaveBeenCalledWith('move_to_trash', { path: NOTES.path });
    });

    // The watcher can take a file away while its menu is still open.
    it('drops a pending Delete when the row goes away with its menu open', async () => {
      renderTree();

      fireEvent.contextMenu(row(NOTES));
      act(() => rowMenus.itemSelect.get(copy.delete)?.(new Event('select')));
      patchTree({ rootEntries: [DOCS, PLAN] });

      await closeHookRan(NOTES.path);
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(screen.queryByText(copy.confirmDelete)).not.toBeInTheDocument();
      expect(invoke).not.toHaveBeenCalled();
    });

    it('drops a pending Rename when the row goes away with its menu open', async () => {
      renderTree();

      fireEvent.contextMenu(row(NOTES));
      act(() => rowMenus.itemSelect.get(copy.rename)?.(new Event('select')));
      patchTree({ rootEntries: [DOCS, PLAN] });

      await closeHookRan(NOTES.path);
      // The file comes back under the same path: it must not start in rename mode.
      patchTree({ rootEntries: [DOCS, NOTES, PLAN] });

      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
      expect(row(NOTES)).toBeInTheDocument();
    });
  });

  describe('the header menu', () => {
    it('is a named icon button without a native hint, and its items are menu items', async () => {
      const user = userEvent.setup();
      renderTree();

      const more = screen.getByRole('button', { name: copy.moreActions });
      expect(more).not.toHaveAttribute('title');
      await user.click(more);

      expect(menuItemNames()).toEqual([copy.newFolder, copy.addFile]);
    });

    it('closes before the folder name field appears, and the field has the focus', async () => {
      const user = userEvent.setup();
      renderTree();

      await user.click(screen.getByRole('button', { name: copy.moreActions }));
      await user.click(screen.getByRole('menuitem', { name: copy.newFolder }));

      const field = await screen.findByPlaceholderText(copy.newFolderPlaceholder);
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      expect(document.activeElement).toBe(field);
    });

    it('forgets New folder when the menu opens again before its close hook ran', async () => {
      const user = userEvent.setup();
      renderTree();

      await user.click(screen.getByRole('button', { name: copy.moreActions }));
      act(() => rowMenus.itemSelect.get(copy.newFolder)?.(new Event('select')));
      fireEvent.contextMenu(row(NOTES));
      await closeHookRan(HEADER_MENU);
      await user.keyboard('{Escape}');
      await closeHookRan(NOTES.path);

      // A field that showed up would lose the focus to the row menu and go away at once,
      // so the test looks at what was rendered.
      expect(rowMenus.fieldsRendered).toEqual([]);
    });
  });

  describe('rows', () => {
    it('are buttons named by the file, with the path as the native hint', () => {
      renderTree();

      const notes = screen.getByRole('button', { name: 'notes.md' });
      expect(notes).toHaveAttribute('title', NOTES.path);
      expect(notes.tagName).toBe('BUTTON');
    });

    // Each mounted menu listens for every key press on the document, so a tree of
    // thousands of files mounts a menu only for the rows that were right-clicked.
    it('mounts the menu of a row with its first right-click', async () => {
      const user = userEvent.setup();
      renderTree();
      expect([...rowMenus.mounted]).toEqual([]);

      fireEvent.contextMenu(row(NOTES));

      expect(menuItemNames()).toEqual([copy.revealInFinder, copy.addToChat, copy.copyPath, copy.rename, copy.delete]);
      expect([...rowMenus.mounted]).toEqual([NOTES.path]);

      await user.keyboard('{Escape}');
      await closeHookRan(NOTES.path);
      fireEvent.contextMenu(row(NOTES));

      expect(screen.getAllByRole('menu')).toHaveLength(1);
      expect([...rowMenus.mounted]).toEqual([NOTES.path]);
    });

    it('keeps the keyboard focus on a row across its first right-click', async () => {
      const user = userEvent.setup();
      renderTree();

      act(() => row(NOTES).focus());
      fireEvent.contextMenu(row(NOTES));
      expect(screen.getByRole('menu')).toBeInTheDocument();
      await user.keyboard('{Escape}');

      await closeHookRan(NOTES.path);
      expect(row(NOTES)).toHaveFocus();
    });

    it('leaves the focus where it was when a row without it is right-clicked', async () => {
      const user = userEvent.setup();
      renderTree();

      act(() => row(PLAN).focus());
      fireEvent.contextMenu(row(NOTES));
      await user.keyboard('{Escape}');

      await closeHookRan(NOTES.path);
      expect(row(PLAN)).toHaveFocus();
    });

    it('marks the previewed file and nothing else', () => {
      usePreviewStore.setState({ previewFilePath: NOTES.path });
      renderTree();

      expect(row(NOTES)).toHaveClass('bg-fill-selected');
      expect(row(PLAN)).not.toHaveClass('bg-fill-selected');
      expect(row(PLAN)).toHaveClass('hover:bg-fill-hover');
      expect(row(DOCS)).not.toHaveClass('bg-fill-selected');
    });

    it('never marks a folder, even when its path is the previewed one', () => {
      usePreviewStore.setState({ previewFilePath: DOCS.path });
      renderTree();

      expect(row(DOCS)).not.toHaveClass('bg-fill-selected');
    });

    it('renders only the rows whose own state changed', () => {
      setTree({ expandedPaths: new Set([DOCS.path]), childrenByPath: new Map([[DOCS.path, [GUIDE]]]) });
      renderTree();
      expect([...rowMenus.renders].sort()).toEqual([DOCS.path, GUIDE.path, NOTES.path, PLAN.path].sort());

      // Another file is previewed: the row that gains the mark and the one that loses it.
      rowMenus.renders.length = 0;
      act(() => usePreviewStore.setState({ previewFilePath: NOTES.path }));
      expect(rowMenus.renders).toEqual([NOTES.path]);
      rowMenus.renders.length = 0;
      act(() => usePreviewStore.setState({ previewFilePath: PLAN.path }));
      expect([...rowMenus.renders].sort()).toEqual([NOTES.path, PLAN.path].sort());

      // The watcher re-reads every folder: same files, new objects.
      rowMenus.renders.length = 0;
      patchTree({
        rootEntries: [{ ...DOCS }, { ...NOTES }, { ...PLAN }],
        childrenByPath: new Map([[DOCS.path, [{ ...GUIDE }]]]),
        loadingPaths: new Set(),
        errorsByPath: new Map(),
      });
      expect(rowMenus.renders).toEqual([]);

      // A folder closes and opens: only that folder's row, and the rows that come back.
      act(() => toggleExpand(DOCS.path));
      expect(rowMenus.renders).toEqual([DOCS.path]);
      rowMenus.renders.length = 0;
      act(() => toggleExpand(DOCS.path));
      expect([...rowMenus.renders].sort()).toEqual([DOCS.path, GUIDE.path].sort());

      // A new file arrives: only its row.
      rowMenus.renders.length = 0;
      const added: WorkspaceTreeEntry = { name: 'added.md', path: '/work/site/added.md', isDirectory: false, isSymlink: false };
      patchTree({ rootEntries: [DOCS, added, NOTES, PLAN] });
      expect(rowMenus.renders).toEqual([added.path]);
    });

    it('renders neither the rows nor the header menu when the sidebar around the tree renders again', () => {
      const view = renderTree();
      rowMenus.renders.length = 0;
      const headerRenders = rowMenus.headerRenders.count;
      expect(headerRenders).toBeGreaterThan(0);

      view.rerender(
        <DesignSystemProvider>
          <WorkspaceFileTree />
        </DesignSystemProvider>,
      );

      expect(rowMenus.renders).toEqual([]);
      expect(rowMenus.headerRenders.count).toBe(headerRenders);
    });
  });

  describe('name fields', () => {
    it('are design-system text fields', async () => {
      const user = userEvent.setup();
      renderTree();

      fireEvent.contextMenu(row(NOTES));
      await user.click(screen.getByRole('menuitem', { name: copy.rename }));

      const field = await screen.findByRole('textbox');
      expect(field).toHaveClass('bg-field');
      expect(field).toHaveClass('border-control-border');
      expect(field).toHaveClass('flex-1');
    });
  });
});
