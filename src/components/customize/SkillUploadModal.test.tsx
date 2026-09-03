// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { open as openDialog } from '@tauri-apps/plugin-dialog';

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

vi.mock('@/hooks/useFileDragDrop', () => ({
  useFileDragDrop: () => ({ isDragging: false, dropTargetProps: {} }),
}));

vi.mock('@/components/common/ConfirmDialog', () => ({
  default: ({ open, message }: { open: boolean; message: string }) =>
    open ? <div data-testid="confirm">{message}</div> : null,
}));

// Real placeholder substitution, so the assertions below read the string the
// user actually sees rather than a bare template.
vi.mock('@/i18n', () => ({
  format: (template: string, values: Record<string, string | number>) =>
    template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? `{${key}}`)),
  useI18n: () => ({
    t: {
      common: { cancel: 'Cancel' },
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
      },
    },
  }),
}));

import { installSkillFromFolder } from '@/core/skill/installer';
import SkillUploadModal from './SkillUploadModal';

const mockInstall = vi.mocked(installSkillFromFolder);
const mockOpenDialog = vi.mocked(openDialog);

function renderAndPickFolder(path = '/Users/test/some-skill') {
  mockOpenDialog.mockResolvedValue(path as never);
  render(<SkillUploadModal onClose={vi.fn()} onInstalled={vi.fn()} />);
  fireEvent.click(screen.getByText('Drop a folder'));
}

beforeEach(() => {
  vi.clearAllMocks();
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
