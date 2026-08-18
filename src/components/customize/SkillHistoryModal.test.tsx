/// <reference types="@testing-library/jest-dom" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SkillHistoryModal from './SkillHistoryModal';
import type { HistoryEntry, RevertResult } from '@/core/skill/history';

const mockReadHistory = vi.fn<(skillDir: string) => Promise<HistoryEntry[]>>();
const mockRevertTurn = vi.fn<(skillDir: string, turnId: string) => Promise<RevertResult>>();
const mockAddToast = vi.fn();

vi.mock('@/core/skill/history', async () => {
  const actual = await vi.importActual<typeof import('@/core/skill/history')>(
    '@/core/skill/history',
  );
  return {
    ...actual,
    readHistory: (p: string) => mockReadHistory(p),
    revertTurn: (p: string, tid: string) => mockRevertTurn(p, tid),
  };
});

vi.mock('@/stores/toastStore', () => ({
  useToastStore: (selector: (s: { addToast: typeof mockAddToast }) => unknown) =>
    selector({ addToast: mockAddToast }),
}));

vi.mock('@tauri-apps/plugin-fs', async () => {
  const actual = await vi.importActual<typeof import('@tauri-apps/plugin-fs')>(
    '@tauri-apps/plugin-fs',
  );
  return {
    ...actual,
    // Most diff views in our tests don't need real file reads — returning
    // empty strings means createPatch produces an "identical" patch,
    // which we handle gracefully ("no textual diff").
    exists: vi.fn().mockResolvedValue(false),
    readTextFile: vi.fn().mockResolvedValue(''),
  };
});

const onClose = vi.fn();

// Filler timestamp (TESTING.md §3) — SkillHistoryModal only feeds `entry.ts`
// into relativeTime(ts, now = Date.now()) for on-screen "X ago" copy, which
// none of these tests assert on; row order comes from array order (the
// component never sorts by ts), not from the timestamp value itself.
const FIXED_TIMESTAMP = 1_700_000_000_000;
const ONE_DAY_MS = 86_400_000;

beforeEach(() => {
  mockReadHistory.mockReset();
  mockRevertTurn.mockReset();
  mockAddToast.mockReset();
  onClose.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('SkillHistoryModal', () => {
  it('shows empty-state copy when the skill has no recorded modifications', async () => {
    mockReadHistory.mockResolvedValueOnce([]);

    render(<SkillHistoryModal skillDir="/skill" skillName="weekly-digest" onClose={onClose} />);

    expect(await screen.findByText(/No modifications recorded yet/i)).toBeInTheDocument();
  });

  it('lists history entries newest first and hides details until expanded', async () => {
    mockReadHistory.mockResolvedValueOnce([
      {
        turnId: 't-new',
        ts: FIXED_TIMESTAMP,
        op: 'patch',
        files: [{ relPath: 'SKILL.md', snapshotPath: '/b1', action: 'modified' }],
        summary: 'replaced step 3',
      },
      {
        turnId: 't-old',
        ts: FIXED_TIMESTAMP - ONE_DAY_MS,
        op: 'edit',
        files: [{ relPath: 'SKILL.md', snapshotPath: '/b2', action: 'modified' }],
      },
    ]);

    render(<SkillHistoryModal skillDir="/skill" skillName="weekly-digest" onClose={onClose} />);

    // Both rows render; summary is only visible on the patch row.
    expect(await screen.findByText(/Patched/)).toBeInTheDocument();
    expect(screen.getByText(/Edited/)).toBeInTheDocument();
    expect(screen.getByText(/replaced step 3/)).toBeInTheDocument();
    // Revert button hidden until row is expanded.
    expect(screen.queryByRole('button', { name: /Revert this change/ })).not.toBeInTheDocument();
  });

  it('expanding a row shows the revert button; clicking it calls revertTurn', async () => {
    mockReadHistory.mockResolvedValueOnce([
      {
        turnId: 't-1',
        ts: FIXED_TIMESTAMP,
        op: 'patch',
        files: [{ relPath: 'SKILL.md', snapshotPath: '/b', action: 'modified' }],
        summary: 'replace step 3',
      },
    ]);
    // Post-revert, readHistory is re-called; stub an empty reload so
    // state updates without complaining about undefined.
    mockReadHistory.mockResolvedValueOnce([]);
    mockRevertTurn.mockResolvedValueOnce({ ok: true, restored: 1, failed: [] });

    const user = userEvent.setup();
    render(<SkillHistoryModal skillDir="/skill" skillName="wd" onClose={onClose} />);

    // Expand the row (click the entry header).
    await user.click(await screen.findByText(/Patched/));

    const revertBtn = await screen.findByRole('button', { name: /Revert this change/ });
    await user.click(revertBtn);

    await waitFor(() => {
      expect(mockRevertTurn).toHaveBeenCalledWith('/skill', 't-1');
    });
    expect(mockAddToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success' }),
    );
  });

  it('surfaces an error toast when revert reports failures', async () => {
    mockReadHistory.mockResolvedValueOnce([
      {
        turnId: 't-bad',
        ts: FIXED_TIMESTAMP,
        op: 'patch',
        files: [{ relPath: 'SKILL.md', snapshotPath: '/gone', action: 'modified' }],
      },
    ]);
    mockRevertTurn.mockResolvedValueOnce({
      ok: false,
      restored: 0,
      failed: [{ relPath: 'SKILL.md', reason: 'backup file no longer exists' }],
    });

    const user = userEvent.setup();
    render(<SkillHistoryModal skillDir="/skill" skillName="wd" onClose={onClose} />);

    await user.click(await screen.findByText(/Patched/));
    await user.click(await screen.findByRole('button', { name: /Revert this change/ }));

    await waitFor(() => {
      expect(mockAddToast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          message: expect.stringContaining('backup file no longer exists'),
        }),
      );
    });
  });

  it("revert entries don't show their own 'Revert' button (can't undo an undo)", async () => {
    mockReadHistory.mockResolvedValueOnce([
      {
        turnId: 't-rev',
        ts: FIXED_TIMESTAMP,
        op: 'revert',
        files: [{ relPath: 'SKILL.md', snapshotPath: null, action: 'modified' }],
        summary: 'Reverted turn t-1',
        revertedTurnId: 't-1',
      },
    ]);

    const user = userEvent.setup();
    render(<SkillHistoryModal skillDir="/skill" skillName="wd" onClose={onClose} />);

    await user.click(await screen.findByText(/Reverted/));
    expect(screen.queryByRole('button', { name: /Revert this change/ })).not.toBeInTheDocument();
  });

  it('backdrop click closes the modal', async () => {
    mockReadHistory.mockResolvedValueOnce([]);
    const user = userEvent.setup();
    const { container } = render(
      <SkillHistoryModal skillDir="/skill" skillName="wd" onClose={onClose} />,
    );

    await screen.findByText(/No modifications recorded yet/i);
    // Click the backdrop (the outermost fixed inset div).
    const backdrop = container.firstChild as HTMLElement;
    await user.pointer({ keys: '[MouseLeft>]', target: backdrop });
    await user.pointer({ keys: '[/MouseLeft]', target: backdrop });

    expect(onClose).toHaveBeenCalled();
  });
});
