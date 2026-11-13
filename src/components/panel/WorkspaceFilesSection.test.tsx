// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { readDir } from '@tauri-apps/plugin-fs';
import { DesignSystemProvider } from '@/components/ds/provider';
import { initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { usePermissionStore } from '@/stores/permissionStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { passSettleInterval } from '@/test/dsWindows';
import type { Conversation } from '@/types';
import WorkspaceFilesSection from './WorkspaceFilesSection';

const ALPHA = '/work/alpha';
const BETA = '/work/beta';
const GAMMA = '/work/gamma';
const CONVERSATION_ID = 'conv-files-section';
const PERMISSION_TITLE = 'Workspace Access';

function conversation(): Conversation {
  return {
    id: CONVERSATION_ID,
    title: 'Files section',
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    status: 'idle',
    workspacePath: null,
  };
}

function entry(name: string, isDirectory: boolean) {
  return { name, isDirectory, isFile: !isDirectory, isSymlink: false };
}

function renderSection() {
  return render(
    <DesignSystemProvider>
      <WorkspaceFilesSection />
    </DesignSystemProvider>,
  );
}

const grants = () => {
  const { persistedGrants, sessionGrants } = usePermissionStore.getState();
  return { persisted: persistedGrants, session: sessionGrants };
};

describe('WorkspaceFilesSection', () => {
  beforeAll(() => {
    // happy-dom has no pointer capture or scrollIntoView; Radix layers call them.
    HTMLElement.prototype.setPointerCapture ??= () => {};
    HTMLElement.prototype.releasePointerCapture ??= () => {};
    HTMLElement.prototype.hasPointerCapture ??= () => false;
    HTMLElement.prototype.scrollIntoView ??= () => {};
  });

  beforeEach(() => {
    initLanguage('en-US');
    vi.mocked(openDialog).mockReset().mockResolvedValue(null);
    vi.mocked(readDir).mockReset().mockImplementation(async (path) => {
      if (String(path) === ALPHA) return [entry('report.md', false), entry('data', true)];
      if (String(path) === `${ALPHA}/data`) return [entry('nested.md', false)];
      if (String(path) === BETA) return [entry('notes.txt', false)];
      return [entry('gamma.md', false)];
    });
    useChatStore.setState({ activeConversationId: CONVERSATION_ID, conversations: { [CONVERSATION_ID]: conversation() } });
    usePermissionStore.setState({ persistedGrants: {}, sessionGrants: {} });
    useWorkspaceStore.setState({ currentPath: null, recentPaths: [] });
  });

  afterEach(() => cleanup());

  it('is a section named 所有文件 that lists the first level of the workspace folder, folders first', async () => {
    useWorkspaceStore.setState({ currentPath: ALPHA });
    renderSection();

    const data = await screen.findByRole('button', { name: 'data' });
    const report = screen.getByRole('button', { name: 'report.md' });
    expect(screen.getByRole('region', { name: 'All files' })).toContainElement(data);
    expect(data.compareDocumentPosition(report) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(readDir).toHaveBeenCalledWith(ALPHA);
  });

  it('offers only the workspace picker and lists the chosen folder when it already has access', async () => {
    const user = userEvent.setup();
    usePermissionStore.getState().grantPermission(BETA, ['read', 'write', 'execute'], 'session');
    vi.mocked(openDialog).mockResolvedValue(BETA);
    renderSection();

    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['All files', 'Select Workspace']);
    await user.click(screen.getByRole('button', { name: 'Select Workspace' }));

    expect(await screen.findByRole('button', { name: 'notes.txt' })).toBeInTheDocument();
    expect(useWorkspaceStore.getState().currentPath).toBe(BETA);
    // The folder is the conversation's own from now on, not only the one in view.
    expect(useChatStore.getState().conversations[CONVERSATION_ID].workspacePath).toBe(BETA);
  });

  it('asks for access to a folder that has none, and lists it once access is given', async () => {
    const user = userEvent.setup();
    vi.mocked(openDialog).mockResolvedValue(BETA);
    renderSection();

    await user.click(screen.getByRole('button', { name: 'Select Workspace' }));

    const dialog = await screen.findByRole('alertdialog', { name: PERMISSION_TITLE });
    expect(dialog).toHaveTextContent(BETA);
    expect(useWorkspaceStore.getState().currentPath).toBeNull();

    await passSettleInterval();
    await user.click(screen.getByRole('button', { name: 'Always Allow' }));

    expect(await screen.findByRole('button', { name: 'notes.txt' })).toBeInTheDocument();
    expect(useWorkspaceStore.getState().currentPath).toBe(BETA);
  });

  it('keeps the state without a workspace when the folder picker is dismissed', async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole('button', { name: 'Select Workspace' }));

    await waitFor(() => expect(openDialog).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Select Workspace' })).toBeInTheDocument();
    expect(useWorkspaceStore.getState().currentPath).toBeNull();
  });

  it('keeps expanded folders and their files when the section is folded and opened again', async () => {
    const user = userEvent.setup();
    useWorkspaceStore.setState({ currentPath: ALPHA });
    renderSection();

    await user.click(await screen.findByRole('button', { name: 'data' }));
    const nested = await screen.findByRole('button', { name: 'nested.md' });
    await user.click(screen.getByRole('button', { name: 'All files' }));
    expect(screen.queryByRole('button', { name: 'nested.md' })).not.toBeInTheDocument();
    expect(nested).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'All files' }));
    expect(screen.getByRole('button', { name: 'nested.md' })).toBe(nested);
    expect(vi.mocked(readDir).mock.calls.filter(([path]) => path === `${ALPHA}/data`)).toHaveLength(1);
  });

  // The workspace folder row's menu, then its list of folders to change to.
  describe('changing the folder', () => {
    async function openChangeList(user: ReturnType<typeof userEvent.setup>) {
      await user.click(screen.getByRole('button', { name: 'More actions' }));
      screen.getByRole('menuitem', { name: 'Change workspace' }).focus();
      await user.keyboard('{ArrowRight}');
      await screen.findByRole('menuitem', { name: 'Select other folder...' });
    }

    beforeEach(() => {
      useWorkspaceStore.setState({ currentPath: ALPHA, recentPaths: [ALPHA, BETA, GAMMA] });
      usePermissionStore.getState().grantPermission(BETA, ['read', 'write', 'execute'], 'session');
    });

    it('lists the recent folders as radio items with the current workspace checked', async () => {
      const user = userEvent.setup();
      renderSection();

      await openChangeList(user);

      expect(screen.getAllByRole('menuitemradio').map((item) => item.textContent)).toEqual(['alpha', 'beta', 'gamma']);
      expect(screen.getByRole('menuitemradio', { name: 'alpha' })).toHaveAttribute('aria-checked', 'true');
      expect(screen.getByRole('menuitem', { name: 'Select other folder...' })).toBeInTheDocument();
    });

    it('switches to a folder that has access and lists it, with the focus back on the menu button', async () => {
      const user = userEvent.setup();
      renderSection();

      await openChangeList(user);
      await user.click(screen.getByRole('menuitemradio', { name: 'beta' }));

      await waitFor(() => expect(useWorkspaceStore.getState().currentPath).toBe(BETA));
      expect(await screen.findByRole('button', { name: 'notes.txt' })).toBeInTheDocument();
      expect(useChatStore.getState().conversations[CONVERSATION_ID].workspacePath).toBe(BETA);
      expect(screen.queryByText(PERMISSION_TITLE)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'beta' })).toHaveAttribute('aria-expanded', 'true');
      await waitFor(() => expect(screen.getByRole('button', { name: 'More actions' })).toHaveFocus());
    });

    it('asks for access to a folder without permission only after the menu has closed, and the window has the focus', async () => {
      const user = userEvent.setup();
      const order: string[] = [];
      const observer = new MutationObserver(() => {
        const menuOpen = document.querySelector('[role="menu"]') !== null;
        if (screen.queryByText(PERMISSION_TITLE) !== null) order.push(menuOpen ? 'dialog-with-menu' : 'dialog-without-menu');
      });
      renderSection();
      observer.observe(document.body, { childList: true, subtree: true });

      await openChangeList(user);
      await user.click(screen.getByRole('menuitemradio', { name: 'gamma' }));

      expect(await screen.findByRole('heading', { name: PERMISSION_TITLE })).toBeInTheDocument();
      observer.disconnect();
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      expect(order).not.toContain('dialog-with-menu');
      expect(screen.getByText(GAMMA)).toBeInTheDocument();
      expect(useWorkspaceStore.getState().currentPath).toBe(ALPHA);
      expect(Object.keys(grants().session)).toEqual([BETA]);
      expect(screen.getByRole('button', { name: 'Deny' })).toHaveFocus();
    });

    it('records a grant for good and lists the folder on Always Allow, the default', async () => {
      const user = userEvent.setup();
      renderSection();
      await openChangeList(user);
      await user.click(screen.getByRole('menuitemradio', { name: 'gamma' }));
      await screen.findByRole('heading', { name: PERMISSION_TITLE });
      await passSettleInterval();

      await user.click(screen.getByRole('button', { name: 'Always Allow' }));

      expect(grants().persisted[GAMMA]).toEqual(expect.objectContaining({
        path: GAMMA, capabilities: ['read', 'write', 'execute'], duration: 'always', expiresAt: null,
      }));
      expect(Object.keys(grants().session)).toEqual([BETA]);
      expect(useWorkspaceStore.getState().currentPath).toBe(GAMMA);
      expect(await screen.findByRole('button', { name: 'gamma.md' })).toBeInTheDocument();
    });

    it('records nothing and keeps the folder on Deny', async () => {
      const user = userEvent.setup();
      renderSection();
      await openChangeList(user);
      await user.click(screen.getByRole('menuitemradio', { name: 'gamma' }));
      await screen.findByRole('heading', { name: PERMISSION_TITLE });
      await passSettleInterval();

      await user.click(screen.getByRole('button', { name: 'Deny' }));

      await waitFor(() => expect(screen.queryByRole('heading', { name: PERMISSION_TITLE })).not.toBeInTheDocument());
      expect(Object.keys(grants().session)).toEqual([BETA]);
      expect(useWorkspaceStore.getState().currentPath).toBe(ALPHA);
      expect(screen.getByRole('button', { name: 'report.md' })).toBeInTheDocument();
    });

    it('asks in the same way for a folder from the system folder picker, opened after the menu has closed', async () => {
      const user = userEvent.setup();
      let menuOpenWhenPickerOpened: boolean | null = null;
      vi.mocked(openDialog).mockImplementation(async () => {
        menuOpenWhenPickerOpened = document.querySelector('[role="menu"]') !== null;
        return GAMMA;
      });
      renderSection();

      await openChangeList(user);
      await user.click(screen.getByRole('menuitem', { name: 'Select other folder...' }));

      expect(await screen.findByRole('heading', { name: PERMISSION_TITLE })).toBeInTheDocument();
      expect(menuOpenWhenPickerOpened).toBe(false);
      expect(screen.getByText(GAMMA)).toBeInTheDocument();
      expect(useWorkspaceStore.getState().currentPath).toBe(ALPHA);

      await passSettleInterval();
      await user.click(screen.getByRole('radio', { name: 'Until I quit' }));
      await user.click(screen.getByRole('button', { name: 'Allow Until I Quit' }));
      expect(useWorkspaceStore.getState().currentPath).toBe(GAMMA);
      expect(Object.keys(grants().session)).toEqual([BETA, GAMMA]);
    });
  });
});
