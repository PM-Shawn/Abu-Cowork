// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render as renderBare, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { DesignSystemProvider } from '@/components/ds/provider';
import ChatInput from './ChatInput';
import { getI18n } from '@/i18n';
import { passSettleInterval } from '@/test/dsWindows';
import { clearAllComposerDrafts } from '@/stores/composerDraftStore';
import { useChatStore } from '@/stores/chatStore';
import { useEnterpriseStore } from '@/stores/enterpriseStore';
import { usePermissionStore } from '@/stores/permissionStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';

// The welcome page's composer asks for access to a folder the user picks there. What each
// answer records is pinned through the real permission store; the folder comes from the
// system folder picker, which is the mocked plugin.
const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });

const FOLDER = '/fake/project';
const t = () => getI18n();

const grants = () => {
  const { persistedGrants, sessionGrants } = usePermissionStore.getState();
  return { persisted: persistedGrants, session: sessionGrants };
};
const NO_GRANTS = { persisted: {}, session: {} };
const title = () => screen.queryByRole('heading', { name: t().permission.workspace.title });
// One of the four durations.
const duration = (name: string) => screen.getByRole('radio', { name });
// The allowing button. With the grant for good chosen, the duration carries nearly the same words.
const allow = (name: string) => screen.getByRole('button', { name });
// The folder control of the welcome composer reads the folder's name once one is set.
const folderControl = (name: string) => screen.queryByRole('button', { name: new RegExp(name) });

async function pickFolder(user: ReturnType<typeof userEvent.setup>) {
  render(<ChatInput variant="welcome" onSend={vi.fn()} />);
  await user.click(screen.getByRole('button', { name: new RegExp(t().folder.loadFolder) }));
  await waitFor(() => expect(title()).toBeInTheDocument());
  // The grant window takes no pointer press for a moment after it appears; the keyboard is never
  // held. It has been read by the time a case presses it.
  passSettleInterval();
}

describe('ChatInput: access to the folder picked on the welcome page', () => {
  beforeAll(() => {
    HTMLElement.prototype.setPointerCapture ??= () => {};
    HTMLElement.prototype.releasePointerCapture ??= () => {};
    HTMLElement.prototype.hasPointerCapture ??= () => false;
    HTMLElement.prototype.scrollIntoView ??= () => {};
  });

  beforeEach(() => {
    clearAllComposerDrafts();
    useEnterpriseStore.setState({ mode: { kind: 'personal' }, initialized: true });
    useChatStore.setState({
      conversations: {},
      conversationIndex: {},
      activeConversationId: null,
      pendingInput: null,
      pendingInputAppend: null,
      pendingReferences: [],
      pendingAttachmentRequests: [],
    });
    usePermissionStore.setState({ persistedGrants: {}, sessionGrants: {} });
    useWorkspaceStore.setState({ currentPath: null, recentPaths: [] });
    vi.mocked(openDialog).mockReset().mockResolvedValue(FOLDER);
  });

  afterEach(() => { cleanup(); });

  it('asks before it uses a folder without access, and asking grants nothing', async () => {
    await pickFolder(userEvent.setup());
    expect(screen.getByText(FOLDER)).toBeInTheDocument();
    expect(grants()).toEqual(NO_GRANTS);
    expect(folderControl('project')).toBeNull();
  });

  it('records a grant for the session and takes the folder on Allow for Session', async () => {
    const user = userEvent.setup();
    await pickFolder(user);

    await user.click(allow(t().permission.allowSessionButton));
    expect(grants().persisted).toEqual({});
    expect(grants().session).toEqual({
      [FOLDER]: expect.objectContaining({ path: FOLDER, capabilities: ['read', 'write', 'execute'], duration: 'session', expiresAt: null }),
    });
    expect(title()).toBeNull();
    expect(folderControl('project')).toBeInTheDocument();
  });

  it('records a grant for good only after the second press', async () => {
    const user = userEvent.setup();
    await pickFolder(user);

    await user.click(duration(t().permission.durationAlways));
    await user.click(allow(t().permission.allowAlwaysButton));
    expect(grants()).toEqual(NO_GRANTS);
    expect(title()).toBeInTheDocument();
    expect(folderControl('project')).toBeNull();

    // Confirm is where the allowing button was: the window holds pointer presses again for a moment.
    passSettleInterval();
    await user.click(screen.getByRole('button', { name: t().common.confirm }));
    expect(grants().session).toEqual({});
    expect(grants().persisted[FOLDER]).toEqual(expect.objectContaining({
      capabilities: ['read', 'write', 'execute'], duration: 'always', expiresAt: null,
    }));
    expect(folderControl('project')).toBeInTheDocument();
  });

  it.each([
    ['Deny', async (user: ReturnType<typeof userEvent.setup>) => { await user.click(screen.getByRole('button', { name: t().permission.deny })); }],
    ['Escape', async (user: ReturnType<typeof userEvent.setup>) => { await user.keyboard('{Escape}'); }],
  ] as const)('records nothing and takes no folder on %s', async (_name, answer) => {
    const user = userEvent.setup();
    await pickFolder(user);

    await answer(user);
    await waitFor(() => expect(title()).toBeNull());
    expect(grants()).toEqual(NO_GRANTS);
    expect(folderControl('project')).toBeNull();
  });

  it('opens with the focus on Deny: Enter pressed as it appears records nothing and takes no folder', async () => {
    const user = userEvent.setup();
    await pickFolder(user);
    expect(screen.getByRole('alertdialog', { name: t().permission.workspace.title })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t().permission.deny })).toHaveFocus();

    await user.keyboard('{Enter}');
    await waitFor(() => expect(title()).toBeNull());
    expect(grants()).toEqual(NO_GRANTS);
    expect(folderControl('project')).toBeNull();
  });

  it('takes a folder that already has access without asking', async () => {
    const user = userEvent.setup();
    usePermissionStore.getState().grantPermission(FOLDER, ['read', 'write', 'execute'], 'session');
    render(<ChatInput variant="welcome" onSend={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: new RegExp(t().folder.loadFolder) }));

    await waitFor(() => expect(folderControl('project')).toBeInTheDocument());
    expect(title()).toBeNull();
  });
});
