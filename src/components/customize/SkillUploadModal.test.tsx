// @vitest-environment happy-dom
import type { ReactElement } from 'react';
import { act, fireEvent, render as renderBare, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { DesignSystemProvider } from '@/components/ds/provider';

// The window is a design-system dialog, so it renders inside the provider like the app does.
const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });

// ── Mocks ──────────────────────────────────────────────────────────

const addToast = vi.fn();
vi.mock('@/stores/toastStore', () => ({
  useToastStore: { getState: () => ({ addToast }) },
}));

const refresh = vi.fn().mockResolvedValue(undefined);
vi.mock('@/stores/discoveryStore', () => ({
  useDiscoveryStore: { getState: () => ({ refresh }) },
}));

vi.mock('@/core/skill/installer', () => ({ installSkillFromFolder: vi.fn() }));
vi.mock('@/core/skill/packager', () => ({
  unpackSkill: vi.fn(),
  validateArchive: vi.fn().mockReturnValue(null),
  ConflictError: class ConflictError extends Error { skillName = ''; },
}));

// The handler the drop zone registered, for as long as the zone is on the page.
const drop = vi.hoisted(() => ({ handler: null as ((paths: string[]) => void | Promise<void>) | null }));
vi.mock('@/hooks/useFileDragDrop', async () => {
  const { useEffect } = await import('react');
  return {
    useFileDragDrop: (handler: (paths: string[]) => void | Promise<void>) => {
      useEffect(() => {
        drop.handler = handler;
        return () => { drop.handler = null; };
      });
      return { isDragging: false, dropTargetProps: {} };
    },
  };
});

// Real placeholder substitution, so the assertions below read the string the
// user actually sees rather than a bare template.
vi.mock('@/i18n', () => ({
  format: (template: string, values: Record<string, string | number>) =>
    template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? `{${key}}`)),
  useI18n: () => ({
    t: {
      // The window and its question are design-system dialogs: these are the words they read.
      common: { cancel: 'Cancel', close: 'Close' },
      designSystem: { discardTitle: 'Discard?', discardMessage: 'Unsaved', keepEditing: 'Keep editing', discard: 'Discard' },
      toolbox: {
        importEntry: 'Import', dropZoneHint: 'Drop a folder', pickFile: 'Pick file',
        importSuccess: 'Import succeeded', importFailed: 'Import failed',
        importSuccessDetail: '{count} file(s)',
        importSkippedFiles: 'skipped {n} hidden file(s): {names}',
        importSkippedLinks: 'skipped {n} link(s): {names}',
        importSkippedLinksSeparator: ', ',
        importSymlinkRootRefused: 'that folder is itself a link ({path}); choose the folder it points at',
        importConflictTitle: 'Exists', importConflictMessage: '{name} exists',
        importConflictOverwrite: 'Overwrite',
        importUnsafeName: 'the package declares an unusable folder name ("{name}"); Abu refused it',
        importPolicyDenied: 'your organization blocks the skill name "{name}"',
      },
    },
  }),
}));

import { installSkillFromFolder } from '@/core/skill/installer';
import { ConflictError, unpackSkill, validateArchive } from '@/core/skill/packager';
import { SkillPolicyDeniedError } from '@/core/skill/skillPolicy';
import SkillUploadModal from './SkillUploadModal';

const mockInstall = vi.mocked(installSkillFromFolder);
const mockValidateArchive = vi.mocked(validateArchive);
const mockOpenDialog = vi.mocked(openDialog);

function renderAndPickFolder(path = '/Users/test/some-skill') {
  mockOpenDialog.mockResolvedValue(path as never);
  render(<SkillUploadModal onClose={vi.fn()} onInstalled={vi.fn()} />);
  fireEvent.click(screen.getByText('Drop a folder'));
}

beforeEach(() => {
  vi.clearAllMocks();
  // Answers queued for one test and not used up must not reach the next.
  mockInstall.mockReset();
  vi.mocked(unpackSkill).mockReset();
  mockValidateArchive.mockReset().mockReturnValue(null);
  mockOpenDialog.mockReset().mockResolvedValue(null as never);
  refresh.mockResolvedValue(undefined);
});

describe('SkillUploadModal folder install disclosure', () => {
  it('names the refused links in the success toast', async () => {
    // The whole point of the `skippedSymlinks` channel: the skill that landed
    // is missing entries the chosen folder appeared to contain, and this is
    // the only place the user is told.
    mockInstall.mockResolvedValue({
      ok: true, name: 'my-skill', fileCount: 3, skipped: [], skippedSymlinks: ['data/x', 'linkdir'],
    });

    renderAndPickFolder();

    await waitFor(() => expect(addToast).toHaveBeenCalled());
    expect(addToast.mock.calls[0][0]).toMatchObject({
      type: 'success',
      message: expect.stringContaining('skipped 2 link(s): data/x, linkdir'),
    });
  });

  it('says nothing about links when there were none', async () => {
    mockInstall.mockResolvedValue({ ok: true, name: 'my-skill', fileCount: 3, skipped: [], skippedSymlinks: [] });

    renderAndPickFolder();

    await waitFor(() => expect(addToast).toHaveBeenCalled());
    expect(addToast.mock.calls[0][0].message).not.toContain('link');
  });

  it('explains a refused linked root instead of showing the developer message', async () => {
    mockInstall.mockResolvedValue({
      ok: false, code: 'SYMLINK_ROOT', message: 'Refusing a skill folder that is itself a symlink: /Users/test/some-skill',
    });

    renderAndPickFolder();

    await waitFor(() => expect(addToast).toHaveBeenCalled());
    expect(addToast.mock.calls[0][0]).toMatchObject({
      type: 'error',
      message: 'that folder is itself a link (/Users/test/some-skill); choose the folder it points at',
    });
  });

  it('shows the developer message for refusals with no localized text', async () => {
    mockInstall.mockResolvedValue({
      ok: false,
      code: 'NO_SKILL_MD',
      message: 'Folder does not contain a SKILL.md of its own: SKILL.md is a symlink.',
    });

    renderAndPickFolder();

    await waitFor(() => expect(addToast).toHaveBeenCalled());
    expect(addToast.mock.calls[0][0]).toMatchObject({
      type: 'error',
      message: 'Folder does not contain a SKILL.md of its own: SKILL.md is a symlink.',
    });
  });
});

/**
 * Importing writes into the user's skills folder, and an import over a skill
 * of the same name replaces it. These hold the calls: nothing is overwritten
 * before the user says so, and the answer overwrites what was asked about.
 */
describe('SkillUploadModal · what an import writes', () => {
  const installed = { ok: true as const, name: 'my-skill', fileCount: 3, skipped: [], skippedSymlinks: [] };
  const exists = { ok: false as const, code: 'ALREADY_EXISTS' as const, message: 'Skill "my-skill" already exists' };
  const mockUnpack = vi.mocked(unpackSkill);

  function open(path: string) {
    mockOpenDialog.mockResolvedValue(path as never);
    const onClose = vi.fn();
    const onInstalled = vi.fn();
    render(<SkillUploadModal onClose={onClose} onInstalled={onInstalled} />);
    return { onClose, onInstalled };
  }
  // The mocked class takes no arguments of its own, so the name is set on the instance.
  const conflict = () => Object.assign(new ConflictError('my-skill', '/skills/my-skill'), { skillName: 'my-skill' });

  it('installs a folder without overwriting, then reads the skills again, reports the name and closes', async () => {
    mockInstall.mockResolvedValue(installed);
    const { onClose, onInstalled } = open('/Users/test/my-skill');
    fireEvent.click(screen.getByText('Drop a folder'));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(mockOpenDialog).toHaveBeenCalledWith({ directory: true, multiple: false });
    expect(mockInstall).toHaveBeenCalledTimes(1);
    expect(mockInstall).toHaveBeenCalledWith('/Users/test/my-skill');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(onInstalled).toHaveBeenCalledWith('my-skill');
  });

  it('installs the folder that holds a picked SKILL.md', async () => {
    mockInstall.mockResolvedValue(installed);
    open('/Users/test/my-skill/SKILL.md');
    fireEvent.click(screen.getByText('Drop a folder'));

    await waitFor(() => expect(mockInstall).toHaveBeenCalledTimes(1));
    expect(mockInstall).toHaveBeenCalledWith('/Users/test/my-skill');
  });

  it('does nothing when the folder picker is cancelled', async () => {
    mockOpenDialog.mockResolvedValue(null as never);
    const onClose = vi.fn();
    render(<SkillUploadModal onClose={onClose} onInstalled={vi.fn()} />);
    fireEvent.click(screen.getByText('Drop a folder'));

    await waitFor(() => expect(mockOpenDialog).toHaveBeenCalledTimes(1));
    expect(mockInstall).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('asks before replacing a folder skill of the same name, and replaces it only after the answer', async () => {
    mockInstall.mockResolvedValueOnce(exists).mockResolvedValueOnce(installed);
    const { onClose, onInstalled } = open('/Users/test/my-skill');
    fireEvent.click(screen.getByText('Drop a folder'));

    expect(await screen.findByText('my-skill exists')).toBeTruthy();
    expect(mockInstall).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Overwrite' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(mockInstall).toHaveBeenCalledTimes(2);
    expect(mockInstall.mock.calls[0]).toEqual(['/Users/test/my-skill']);
    expect(mockInstall).toHaveBeenLastCalledWith('/Users/test/my-skill', { overwrite: true });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(onInstalled).toHaveBeenCalledWith('my-skill');
  });

  it('replaces nothing when the question is cancelled, and stays open', async () => {
    mockInstall.mockResolvedValueOnce(exists);
    const { onClose, onInstalled } = open('/Users/test/my-skill');
    fireEvent.click(screen.getByText('Drop a folder'));
    await screen.findByText('my-skill exists');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByText('my-skill exists')).toBeNull());
    expect(mockInstall).toHaveBeenCalledTimes(1);
    expect(onInstalled).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('Drop a folder')).toBeTruthy();
  });

  it('unpacks an archive into the skills folder without overwriting', async () => {
    mockValidateArchive.mockReturnValue(null);
    mockUnpack.mockResolvedValue({ name: 'my-skill' } as never);
    const { onClose, onInstalled } = open('/Users/test/my-skill.askill');
    fireEvent.click(screen.getByText('Pick file'));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(mockOpenDialog).toHaveBeenCalledWith({ filters: [{ name: 'Skill Package', extensions: ['askill', 'zip'] }], multiple: false });
    expect(mockUnpack).toHaveBeenCalledTimes(1);
    const [bytes, baseDir, ...rest] = mockUnpack.mock.calls[0];
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(baseDir).toMatch(/\/\.abu\/skills$/);
    expect(rest).toEqual([]);
    expect(mockInstall).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(onInstalled).toHaveBeenCalledWith('my-skill');
  });

  it('asks before replacing a skill with an archive, and unpacks the same bytes over it after the answer', async () => {
    mockValidateArchive.mockReturnValue(null);
    mockUnpack.mockRejectedValueOnce(conflict()).mockResolvedValueOnce({ name: 'my-skill' } as never);
    const { onClose, onInstalled } = open('/Users/test/my-skill.zip');
    fireEvent.click(screen.getByText('Pick file'));

    expect(await screen.findByText('my-skill exists')).toBeTruthy();
    expect(mockUnpack).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Overwrite' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(mockUnpack).toHaveBeenCalledTimes(2);
    const [firstBytes, firstDir] = mockUnpack.mock.calls[0];
    expect(mockUnpack.mock.calls[1]).toEqual([firstBytes, firstDir, { overwrite: true }]);
    expect(mockUnpack.mock.calls[1][0]).toBe(firstBytes);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(onInstalled).toHaveBeenCalledWith('my-skill');
  });

  it('stays open and reports it when the replacement fails', async () => {
    mockInstall.mockResolvedValueOnce(exists).mockResolvedValueOnce({ ok: false, code: 'COPY_FAILED', message: 'copy failed' } as never);
    const { onClose, onInstalled } = open('/Users/test/my-skill');
    fireEvent.click(screen.getByText('Drop a folder'));
    await screen.findByText('my-skill exists');

    fireEvent.click(screen.getByRole('button', { name: 'Overwrite' }));

    await waitFor(() => expect(addToast).toHaveBeenCalledWith({ type: 'error', title: 'Import failed', message: 'copy failed' }));
    // Whatever the handler still had to do after the notice has run by now.
    await act(async () => { for (let turn = 0; turn < 5; turn += 1) await Promise.resolve(); });
    expect(addToast).toHaveBeenCalledTimes(1);
    expect(onInstalled).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('SkillUploadModal · the window', () => {
  const installed = { ok: true as const, name: 'my-skill', fileCount: 3, skipped: [], skippedSymlinks: [] };
  const exists = { ok: false as const, code: 'ALREADY_EXISTS' as const, message: 'Skill "my-skill" already exists' };

  // happy-dom reports no animation, so Radix removes a closed layer at once. With this, a closed
  // layer has an exit animation: it stays on the page, as it does in the app while it fades out.
  let restoreStyles: (() => void) | null = null;
  function keepClosingLayersOnScreen() {
    const real = window.getComputedStyle.bind(window);
    const spy = vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element, pseudo?: string | null) => {
      const styles = real(element, pseudo);
      return new Proxy(styles, {
        get(target, prop) {
          if (prop === 'animationName') return element.getAttribute('data-state') === 'closed' ? 'exit' : 'enter';
          const value = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    });
    restoreStyles = () => spy.mockRestore();
  }

  afterEach(() => {
    restoreStyles?.();
    restoreStyles = null;
  });

  it('is a window with its title, a drop zone that is a button and a link for packages', () => {
    render(<SkillUploadModal onClose={vi.fn()} onInstalled={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'Import' });
    expect(within(dialog).getByRole('button', { name: 'Drop a folder' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Pick file' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('renders nothing while it is closed', () => {
    render(<SkillUploadModal open={false} onClose={vi.fn()} onInstalled={vi.fn()} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on Escape while nothing is being imported', () => {
    const onClose = vi.fn();
    render(<SkillUploadModal onClose={onClose} onInstalled={vi.fn()} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('stays, with the drop zone busy and focusable, while an import runs', async () => {
    let finish: (result: typeof installed) => void = () => {};
    mockInstall.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    mockOpenDialog.mockResolvedValue('/Users/test/my-skill' as never);
    const onClose = vi.fn();
    render(<SkillUploadModal onClose={onClose} onInstalled={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Drop a folder' }));
    await waitFor(() => expect(mockInstall).toHaveBeenCalledTimes(1));

    const zone = screen.getByRole('button', { name: 'Drop a folder' });
    expect(zone).toHaveAttribute('aria-disabled', 'true');
    expect(zone).not.toBeDisabled();
    // One spinner, and the hint is what it says.
    expect(within(zone).getByRole('status')).toHaveTextContent('Drop a folder');
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Pick file' })).toHaveAttribute('aria-disabled', 'true');

    // Neither Escape nor a second press does anything.
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(zone);
    fireEvent.click(screen.getByRole('button', { name: 'Pick file' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(mockOpenDialog).toHaveBeenCalledTimes(1);

    await act(async () => { finish(installed); });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(mockInstall).toHaveBeenCalledTimes(1);
  });

  it('imports nothing from a window that is closing', async () => {
    mockOpenDialog.mockResolvedValue('/Users/test/my-skill' as never);
    mockInstall.mockResolvedValue(installed);
    const view = render(<SkillUploadModal open onClose={vi.fn()} onInstalled={vi.fn()} />);
    keepClosingLayersOnScreen();
    view.rerender(<SkillUploadModal open={false} onClose={vi.fn()} onInstalled={vi.fn()} />);
    const closing = document.querySelector<HTMLElement>('[role="dialog"][data-state="closed"]');
    expect(closing).not.toBeNull();

    fireEvent.click(within(closing as HTMLElement).getByText('Drop a folder'));
    fireEvent.click(within(closing as HTMLElement).getByText('Pick file'));
    await act(async () => { await Promise.resolve(); });

    expect(mockOpenDialog).not.toHaveBeenCalled();
    expect(mockInstall).not.toHaveBeenCalled();
  });

  it('asks about the skill by name in a question of its own, with Overwrite and Cancel', async () => {
    mockInstall.mockResolvedValueOnce(exists);
    mockOpenDialog.mockResolvedValue('/Users/test/my-skill' as never);
    render(<SkillUploadModal onClose={vi.fn()} onInstalled={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Drop a folder' }));

    const question = await screen.findByRole('alertdialog', { name: 'Exists' });
    expect(question).toHaveTextContent('my-skill exists');
    expect(within(question).getByRole('button', { name: 'Overwrite' })).toBeInTheDocument();
    expect(within(question).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('ends the question with the window: nothing is overwritten once the window has closed', async () => {
    mockInstall.mockResolvedValueOnce(exists).mockResolvedValueOnce(installed);
    mockOpenDialog.mockResolvedValue('/Users/test/my-skill' as never);
    const onInstalled = vi.fn();
    const view = render(<SkillUploadModal open onClose={vi.fn()} onInstalled={onInstalled} />);
    fireEvent.click(screen.getByRole('button', { name: 'Drop a folder' }));
    await screen.findByRole('alertdialog');

    view.rerender(<SkillUploadModal open={false} onClose={vi.fn()} onInstalled={onInstalled} />);

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await act(async () => { await Promise.resolve(); });
    expect(mockInstall).toHaveBeenCalledTimes(1);
    expect(onInstalled).not.toHaveBeenCalled();
  });

  it('ends the question with the page: nothing is overwritten once the page has left', async () => {
    mockInstall.mockResolvedValueOnce(exists).mockResolvedValueOnce(installed);
    mockOpenDialog.mockResolvedValue('/Users/test/my-skill' as never);
    const onInstalled = vi.fn();
    const view = render(<SkillUploadModal onClose={vi.fn()} onInstalled={onInstalled} />);
    fireEvent.click(screen.getByRole('button', { name: 'Drop a folder' }));
    await screen.findByRole('alertdialog');

    view.rerender(<span>another page</span>);

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await act(async () => { await Promise.resolve(); });
    expect(mockInstall).toHaveBeenCalledTimes(1);
    expect(onInstalled).not.toHaveBeenCalled();
  });

  it.each([
    ['the page has left', (view: ReturnType<typeof render>) => view.rerender(<span>chat</span>)],
    ['the window has been closed', (view: ReturnType<typeof render>) => view.rerender(<SkillUploadModal open={false} onClose={vi.fn()} onInstalled={vi.fn()} />)],
  ] as const)('asks nothing when an import ends in a name conflict after %s', async (_when, leave) => {
    let finish: (result: typeof exists) => void = () => {};
    mockInstall.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    mockInstall.mockResolvedValue(installed);
    mockOpenDialog.mockResolvedValue('/Users/test/my-skill' as never);
    const view = render(<SkillUploadModal open onClose={vi.fn()} onInstalled={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Drop a folder' }));
    await waitFor(() => expect(mockInstall).toHaveBeenCalledTimes(1));

    leave(view);
    await act(async () => { finish(exists); });
    await act(async () => { for (let turn = 0; turn < 5; turn += 1) await Promise.resolve(); });

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByText('my-skill exists')).toBeNull();
    expect(mockInstall).toHaveBeenCalledTimes(1);
  });

  it('imports a dropped folder, ignores a drop while that import runs, and listens only while it is open', async () => {
    let finish: (result: typeof installed) => void = () => {};
    mockInstall.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const onClose = vi.fn();
    const view = render(<SkillUploadModal open onClose={onClose} onInstalled={vi.fn()} />);
    expect(drop.handler).not.toBeNull();

    await act(async () => { void drop.handler?.(['/Users/test/first-skill', '/Users/test/ignored-second-path']); });
    await waitFor(() => expect(mockInstall).toHaveBeenCalledTimes(1));
    expect(mockInstall).toHaveBeenCalledWith('/Users/test/first-skill');

    await act(async () => { void drop.handler?.(['/Users/test/dropped-while-busy']); });
    await act(async () => { void drop.handler?.([]); });
    expect(mockInstall).toHaveBeenCalledTimes(1);

    await act(async () => { finish(installed); });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));

    view.rerender(<SkillUploadModal open={false} onClose={onClose} onInstalled={vi.fn()} />);
    expect(drop.handler).toBeNull();
  });

  it('asks again for a second import and overwrites only what the last question was about', async () => {
    const other = { ok: false as const, code: 'ALREADY_EXISTS' as const, message: 'Skill "other-skill" already exists' };
    mockInstall.mockResolvedValueOnce(exists);
    mockOpenDialog.mockResolvedValueOnce('/Users/test/my-skill' as never);
    render(<SkillUploadModal onClose={vi.fn()} onInstalled={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Drop a folder' }));
    await screen.findByText('my-skill exists');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());

    mockInstall.mockResolvedValueOnce(other).mockResolvedValueOnce({ ...installed, name: 'other-skill' });
    mockOpenDialog.mockResolvedValueOnce('/Users/test/other-skill' as never);
    fireEvent.click(screen.getByRole('button', { name: 'Drop a folder' }));
    await screen.findByText('other-skill exists');
    fireEvent.click(screen.getByRole('button', { name: 'Overwrite' }));

    await waitFor(() => expect(mockInstall).toHaveBeenCalledTimes(3));
    expect(mockInstall.mock.calls).toEqual([
      ['/Users/test/my-skill'],
      ['/Users/test/other-skill'],
      ['/Users/test/other-skill', { overwrite: true }],
    ]);
  });
});

describe('SkillUploadModal archive refusal', () => {
  it('explains a traversing archive name in the user\'s language', async () => {
    // `validateArchive` short-circuits before `unpackSkill`, so the localized
    // text on `UnsafeSkillNameError` never reaches a toast — this branch is the
    // one a user importing a hostile .askill actually sees, and a developer
    // sentence about directory segments is not it.
    mockValidateArchive.mockReturnValue({
      code: 'UNSAFE_NAME',
      message: 'SKILL.md declares a name that is not a single directory segment: "../../.ssh"',
      skillName: '../../.ssh',
    });

    renderAndPickFolder('/Users/test/hostile.askill');

    await waitFor(() => expect(addToast).toHaveBeenCalled());
    expect(addToast.mock.calls[0][0]).toMatchObject({
      type: 'error',
      message: 'the package declares an unusable folder name ("../../.ssh"); Abu refused it',
    });
  });

  it('still shows the developer message for the refusals with no locale text', async () => {
    mockValidateArchive.mockReturnValue({ code: 'INVALID_ZIP', message: 'File is not a valid zip archive' });

    renderAndPickFolder('/Users/test/broken.askill');

    await waitFor(() => expect(addToast).toHaveBeenCalled());
    expect(addToast.mock.calls[0][0]).toMatchObject({
      type: 'error',
      message: 'File is not a valid zip archive',
    });
  });
});

describe("SkillUploadModal and the organization's skill policy", () => {
  it('explains a folder the policy refused in the user\'s language', async () => {
    mockInstall.mockResolvedValue({
      ok: false, code: 'POLICY_DENIED', message: "[policy] skill 'blocked-skill' blocked by policy", skillName: 'blocked-skill',
    });

    renderAndPickFolder();

    await waitFor(() => expect(addToast).toHaveBeenCalled());
    expect(addToast.mock.calls[0][0]).toMatchObject({
      type: 'error',
      message: 'your organization blocks the skill name "blocked-skill"',
    });
  });

  it('explains an archive the policy refused in the user\'s language', async () => {
    mockValidateArchive.mockReturnValue(null);
    vi.mocked(unpackSkill).mockRejectedValue(new SkillPolicyDeniedError('blocked-skill', 'blocked by policy'));

    renderAndPickFolder('/Users/test/blocked.askill');

    await waitFor(() => expect(addToast).toHaveBeenCalled());
    expect(addToast.mock.calls[0][0]).toMatchObject({
      type: 'error',
      message: 'your organization blocks the skill name "blocked-skill"',
    });
  });
});
