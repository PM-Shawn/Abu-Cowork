// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { exists } from '@tauri-apps/plugin-fs';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { DesignSystemProvider } from '@/components/ds/provider';
import { scanMemoryFiles } from '@/core/memdir/scan';
import { initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { usePermissionStore } from '@/stores/permissionStore';
import { useProjectStore } from '@/stores/projectStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import type { Conversation } from '@/types';
import { passSettleInterval } from '@/test/dsWindows';
import WorkspaceSection from './WorkspaceSection';

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
  openPath: vi.fn().mockResolvedValue(undefined),
  revealItemInDir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/core/memdir/scan', () => ({
  scanMemoryFiles: vi.fn().mockResolvedValue([]),
}));

const layerRenders = vi.hoisted(() => ({ iconButton: vi.fn(), menu: vi.fn() }));
// The latest props of the folder menu, to drive it the way Radix does when it is
// reopened during its exit animation (happy-dom has no animations).
const menuProps = vi.hoisted(() => ({
  onOpenChange: undefined as ((open: boolean) => void) | undefined,
  onValueChange: undefined as ((value: string) => void) | undefined,
}));

// Counts renders of the section's floating-layer controls (the reveal button's tooltip, the folder menu).
vi.mock('@/components/ds/button', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ds/button')>();
  return {
    ...actual,
    IconButton: (props: ComponentProps<typeof actual.IconButton>) => {
      layerRenders.iconButton();
      return actual.IconButton(props);
    },
  };
});

vi.mock('@/components/ds/menu', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ds/menu')>();
  return {
    ...actual,
    Menu: (props: ComponentProps<typeof actual.Menu>) => {
      layerRenders.menu();
      menuProps.onOpenChange = props.onOpenChange;
      return actual.Menu(props);
    },
    MenuRadioGroup: (props: ComponentProps<typeof actual.MenuRadioGroup>) => {
      menuProps.onValueChange = props.onValueChange;
      return actual.MenuRadioGroup(props);
    },
  };
});

const ALPHA = '/work/alpha';
const BETA = '/work/beta';
const GAMMA = '/work/gamma';
const PERMISSION_TITLE = 'Workspace Access';

function renderSection() {
  return render(
    <DesignSystemProvider>
      <WorkspaceSection />
    </DesignSystemProvider>,
  );
}

function folderCard() {
  return screen.getByRole('button', { name: /alpha/ });
}

// The section reads ABU.md and the memory files after it mounts; let that settle.
async function settle() {
  await waitFor(() => expect(scanMemoryFiles).toHaveBeenCalled());
  await act(async () => {});
}

describe('WorkspaceSection', () => {
  beforeAll(() => {
    // happy-dom has no pointer capture or scrollIntoView; Radix menus call them.
    HTMLElement.prototype.setPointerCapture ??= () => {};
    HTMLElement.prototype.releasePointerCapture ??= () => {};
    HTMLElement.prototype.hasPointerCapture ??= () => false;
    HTMLElement.prototype.scrollIntoView ??= () => {};
  });

  beforeEach(() => {
    initLanguage('en-US');
    vi.mocked(exists).mockResolvedValue(false);
    vi.mocked(openDialog).mockReset().mockResolvedValue(null);
    vi.mocked(scanMemoryFiles).mockClear();
    vi.mocked(revealItemInDir).mockClear();
    layerRenders.iconButton.mockClear();
    layerRenders.menu.mockClear();
    useChatStore.setState({ activeConversationId: null, conversations: {} });
    useProjectStore.setState({ projects: {} });
    usePermissionStore.setState({ persistedGrants: {}, sessionGrants: {} });
    useWorkspaceStore.setState({ currentPath: ALPHA, recentPaths: [ALPHA, BETA, GAMMA] });
    usePermissionStore.getState().grantPermission(BETA, ['read', 'write', 'execute'], 'session');
  });

  afterEach(() => cleanup());

  it('lists the recent folders as radio items with the current workspace checked', async () => {
    const user = userEvent.setup();
    renderSection();
    await settle();

    await user.click(folderCard());

    const items = screen.getAllByRole('menuitemradio');
    expect(items.map((item) => item.textContent)).toEqual(['alpha', 'beta', 'gamma']);
    expect(screen.getByRole('menuitemradio', { name: 'alpha' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menuitemradio', { name: 'beta' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('menuitem', { name: 'Select other folder...' })).toBeInTheDocument();
  });

  it('moves only the highlight with the arrow keys and switches the workspace on Enter', async () => {
    const user = userEvent.setup();
    renderSection();
    await settle();

    await user.click(folderCard());
    await user.keyboard('{ArrowDown}{ArrowDown}');

    expect(screen.getByRole('menuitemradio', { name: 'beta' })).toHaveAttribute('data-highlighted');
    expect(useWorkspaceStore.getState().currentPath).toBe(ALPHA);

    await user.keyboard('{Enter}');

    await waitFor(() => expect(useWorkspaceStore.getState().currentPath).toBe(BETA));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.queryByText(PERMISSION_TITLE)).not.toBeInTheDocument();
    // Nothing took the focus, so it goes back to the folder card.
    await waitFor(() => expect(screen.getByRole('button', { name: /beta/ })).toHaveFocus());
  });

  it('leaves the workspace alone when the menu is dismissed with Escape', async () => {
    const user = userEvent.setup();
    renderSection();
    await settle();

    await user.click(folderCard());
    await user.keyboard('{ArrowDown}{ArrowDown}{Escape}');

    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(useWorkspaceStore.getState().currentPath).toBe(ALPHA);
    expect(folderCard()).toHaveFocus();
  });

  it('asks for access to a folder without permission only after the menu has closed', async () => {
    const user = userEvent.setup();
    const order: string[] = [];
    const observer = new MutationObserver(() => {
      const menuOpen = document.querySelector('[role="menu"]') !== null;
      const dialogOpen = screen.queryByText(PERMISSION_TITLE) !== null;
      if (dialogOpen) order.push(menuOpen ? 'dialog-with-menu' : 'dialog-without-menu');
    });
    renderSection();
    await settle();
    observer.observe(document.body, { childList: true, subtree: true });

    await user.click(folderCard());
    await user.click(screen.getByRole('menuitemradio', { name: 'gamma' }));

    expect(await screen.findByText(PERMISSION_TITLE)).toBeInTheDocument();
    observer.disconnect();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(order).not.toContain('dialog-with-menu');
    expect(useWorkspaceStore.getState().currentPath).toBe(ALPHA);
    // The window has the focus, on Deny; it is not left on the card behind it.
    expect(screen.getByRole('button', { name: 'Deny' })).toHaveFocus();
  });

  // The window that asks for access to a folder chosen here. What each answer records is
  // pinned through the real permission and workspace stores.
  describe('access to a folder without permission', () => {
    const grants = () => {
      const { persistedGrants, sessionGrants } = usePermissionStore.getState();
      return { persisted: persistedGrants, session: sessionGrants };
    };
    // The folder the suite starts with has a grant for the session; nothing else has one.
    const sessionPaths = () => Object.keys(grants().session);
    // One of the four durations.
    const duration = (name: string) => screen.getByRole('radio', { name });
    // The allowing button. With the grant for good chosen, the duration carries nearly the same words.
    const allow = (name: string) => screen.getByRole('button', { name });
    async function chooseGamma(user: ReturnType<typeof userEvent.setup>) {
      renderSection();
      await settle();
      await user.click(folderCard());
      await user.click(screen.getByRole('menuitemradio', { name: 'gamma' }));
      expect(await screen.findByRole('heading', { name: PERMISSION_TITLE })).toBeInTheDocument();
      // The grant window takes no pointer press for a moment after it appears; the keyboard is
      // never held. It has been read by the time a case presses it.
      passSettleInterval();
    }

    it('names the folder and grants nothing by opening', async () => {
      await chooseGamma(userEvent.setup());
      expect(screen.getByText(GAMMA)).toBeInTheDocument();
      expect(sessionPaths()).toEqual([BETA]);
      expect(grants().persisted).toEqual({});
      expect(useWorkspaceStore.getState().currentPath).toBe(ALPHA);
    });

    it('records a grant for the session and switches the workspace on Allow for Session', async () => {
      const user = userEvent.setup();
      useChatStore.setState({ activeConversationId: 'conv-1', conversations: { 'conv-1': { id: 'conv-1', messages: [] } } } as never);
      await chooseGamma(user);

      await user.click(allow('Allow for Session'));
      expect(grants().session[GAMMA]).toEqual(expect.objectContaining({
        path: GAMMA, capabilities: ['read', 'write', 'execute'], duration: 'session', expiresAt: null,
      }));
      expect(grants().persisted).toEqual({});
      expect(useWorkspaceStore.getState().currentPath).toBe(GAMMA);
      expect(useChatStore.getState().conversations['conv-1'].workspacePath).toBe(GAMMA);
      expect(screen.queryByRole('heading', { name: PERMISSION_TITLE })).not.toBeInTheDocument();
    });

    it('records a grant for good only after the second press', async () => {
      const user = userEvent.setup();
      await chooseGamma(user);

      await user.click(duration('Always allow'));
      await user.click(allow('Always Allow'));
      expect(grants().persisted).toEqual({});
      expect(sessionPaths()).toEqual([BETA]);
      expect(useWorkspaceStore.getState().currentPath).toBe(ALPHA);
      expect(screen.getByRole('heading', { name: PERMISSION_TITLE })).toBeInTheDocument();

      // Confirm is where the allowing button was: the window holds pointer presses again for a moment.
      passSettleInterval();
      await user.click(screen.getByRole('button', { name: 'Confirm' }));
      expect(grants().persisted[GAMMA]).toEqual(expect.objectContaining({
        capabilities: ['read', 'write', 'execute'], duration: 'always', expiresAt: null,
      }));
      expect(useWorkspaceStore.getState().currentPath).toBe(GAMMA);
    });

    it.each([
      ['Deny', async (user: ReturnType<typeof userEvent.setup>) => { await user.click(screen.getByRole('button', { name: 'Deny' })); }],
      ['Escape', async (user: ReturnType<typeof userEvent.setup>) => { await user.keyboard('{Escape}'); }],
    ] as const)('records nothing and keeps the workspace on %s', async (_name, answer) => {
      const user = userEvent.setup();
      await chooseGamma(user);

      await answer(user);
      await waitFor(() => expect(screen.queryByRole('heading', { name: PERMISSION_TITLE })).not.toBeInTheDocument());
      expect(sessionPaths()).toEqual([BETA]);
      expect(grants().persisted).toEqual({});
      expect(useWorkspaceStore.getState().currentPath).toBe(ALPHA);
    });

    it('opens with the focus on Deny: Enter pressed as it appears records nothing and keeps the workspace', async () => {
      const user = userEvent.setup();
      await chooseGamma(user);
      expect(screen.getByRole('alertdialog', { name: PERMISSION_TITLE })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Deny' })).toHaveFocus();

      await user.keyboard('{Enter}');
      await waitFor(() => expect(screen.queryByRole('heading', { name: PERMISSION_TITLE })).not.toBeInTheDocument());
      expect(sessionPaths()).toEqual([BETA]);
      expect(grants().persisted).toEqual({});
      expect(useWorkspaceStore.getState().currentPath).toBe(ALPHA);
    });

    it('asks in the same way for a folder from the system folder picker', async () => {
      const user = userEvent.setup();
      vi.mocked(openDialog).mockResolvedValue(GAMMA);
      renderSection();
      await settle();
      await user.click(folderCard());
      await user.click(screen.getByRole('menuitem', { name: 'Select other folder...' }));

      expect(await screen.findByRole('heading', { name: PERMISSION_TITLE })).toBeInTheDocument();
      expect(screen.getByText(GAMMA)).toBeInTheDocument();
      expect(useWorkspaceStore.getState().currentPath).toBe(ALPHA);
      expect(sessionPaths()).toEqual([BETA]);

      passSettleInterval();
      await user.click(allow('Allow for Session'));
      expect(useWorkspaceStore.getState().currentPath).toBe(GAMMA);
      expect(sessionPaths()).toEqual([BETA, GAMMA]);
    });
  });

  it('opens the system folder picker only after the menu has closed', async () => {
    const user = userEvent.setup();
    let menuOpenWhenPickerOpened: boolean | null = null;
    vi.mocked(openDialog).mockImplementation(async () => {
      menuOpenWhenPickerOpened = document.querySelector('[role="menu"]') !== null;
      return BETA;
    });
    renderSection();
    await settle();

    await user.click(folderCard());
    await user.click(screen.getByRole('menuitem', { name: 'Select other folder...' }));

    await waitFor(() => expect(useWorkspaceStore.getState().currentPath).toBe(BETA));
    expect(menuOpenWhenPickerOpened).toBe(false);
  });

  // A menu reopened during its exit animation stays mounted: the close hook never ran
  // for the choice made before, and opening again must forget it.
  it('forgets a choice whose close hook never ran when the menu opens again', async () => {
    const user = userEvent.setup();
    renderSection();
    await settle();

    await user.click(folderCard());
    act(() => menuProps.onValueChange?.(GAMMA));
    act(() => menuProps.onOpenChange?.(true));
    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(screen.queryByText(PERMISSION_TITLE)).not.toBeInTheDocument();
    expect(useWorkspaceStore.getState().currentPath).toBe(ALPHA);
    expect(folderCard()).toHaveFocus();
  });

  it('keeps the reveal button apart from the title button', async () => {
    const user = userEvent.setup();
    renderSection();
    await settle();

    const title = screen.getByRole('button', { name: /^Workspace/ });
    expect(title).toHaveAttribute('aria-expanded', 'true');
    const reveal = screen.getByRole('button', { name: 'Open in File Manager' });
    expect(title).not.toContainElement(reveal);
    expect(reveal).not.toHaveAttribute('title');

    await user.click(reveal);

    expect(revealItemInDir).toHaveBeenCalledWith(ALPHA);
    expect(title).toHaveAttribute('aria-expanded', 'true');
    expect(folderCard()).toBeInTheDocument();

    await user.click(title);

    expect(title).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: /alpha/ })).not.toBeInTheDocument();
  });

  it('shows the project name and the two entries without any category color', async () => {
    vi.mocked(exists).mockResolvedValue(true);
    useProjectStore.setState({
      projects: { p1: { id: 'p1', name: 'Launch plan', workspacePath: ALPHA, createdAt: 1, updatedAt: 1 } },
    } as never);
    renderSection();
    await settle();

    expect(screen.getByText('Launch plan').closest('span.bg-fill')).toBeInTheDocument();
    const instructions = await screen.findByRole('button', { name: 'Instructions · ABU.md' });
    expect(instructions).toHaveClass('bg-fill');
    expect(instructions).toHaveClass('text-label');
    const memory = screen.getByRole('button', { name: 'Project Memory · None' });
    expect(memory).toHaveClass('bg-fill');
    expect(memory).toHaveClass('text-label-tertiary');
  });

  it('offers to pick a workspace when there is none', async () => {
    const user = userEvent.setup();
    useWorkspaceStore.setState({ currentPath: null, recentPaths: [] });
    vi.mocked(openDialog).mockResolvedValue(BETA);
    renderSection();

    expect(screen.queryByRole('button', { name: 'Open in File Manager' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Select Workspace' }));

    await waitFor(() => expect(useWorkspaceStore.getState().currentPath).toBe(BETA));
  });

  // The two windows are opened by a press on their entry: each gives the focus back to it.
  it('opens the instructions window from its entry, and the entry has the focus again once the window has closed', async () => {
    const user = userEvent.setup();
    renderSection();
    await settle();
    const entry = screen.getByRole('button', { name: 'Instructions · Click to add' });

    await user.click(entry);
    expect(await screen.findByRole('dialog', { name: 'Project Instructions' })).toBeInTheDocument();
    vi.mocked(exists).mockClear();
    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(entry).toHaveFocus());
    // The section looks for the file again when the window closes.
    expect(exists).toHaveBeenCalledWith(`${ALPHA}/.abu/ABU.md`);
  });

  it('opens the memory window from its entry, and the entry has the focus again once the window has closed', async () => {
    const user = userEvent.setup();
    renderSection();
    await settle();
    const entry = screen.getByRole('button', { name: 'Project Memory · None' });

    await user.click(entry);
    expect(await screen.findByRole('dialog', { name: 'Project Memory' })).toBeInTheDocument();
    vi.mocked(scanMemoryFiles).mockClear();
    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(entry).toHaveFocus());
    // The section scans the folder again when the window closes.
    expect(scanMemoryFiles).toHaveBeenCalledWith(ALPHA);
  });

  // The summary stays open while a reply streams. The section reads only the workspace,
  // the active conversation id and the project list, so a streamed character must not
  // re-render its tooltip button or its menu.
  it('does not re-render its floating-layer controls while a reply streams', async () => {
    const conversation: Conversation = {
      id: 'conv-1',
      title: 'Streaming',
      messages: [{ id: 'm1', role: 'assistant', content: '', timestamp: 1 }],
      createdAt: 1,
      updatedAt: 1,
      status: 'running',
    } as Conversation;
    useChatStore.setState({ activeConversationId: 'conv-1', conversations: { 'conv-1': conversation } });
    renderSection();
    await settle();
    const iconButtonBefore = layerRenders.iconButton.mock.calls.length;
    const menuBefore = layerRenders.menu.mock.calls.length;
    expect(iconButtonBefore).toBeGreaterThan(0);
    expect(menuBefore).toBeGreaterThan(0);

    for (const content of ['a', 'ab', 'abc']) {
      act(() => {
        useChatStore.setState((state) => ({
          conversations: {
            ...state.conversations,
            'conv-1': {
              ...state.conversations['conv-1'],
              messages: [{ ...state.conversations['conv-1'].messages[0], content }],
            },
          },
        }));
      });
    }

    expect(layerRenders.iconButton.mock.calls.length).toBe(iconButtonBefore);
    expect(layerRenders.menu.mock.calls.length).toBe(menuBefore);
  });
});
