// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactElement } from 'react';
import { act, fireEvent, render as renderBare, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DesignSystemProvider } from '@/components/ds/provider';
import { getI18n } from '@/i18n';
import SkillHistoryModal from './SkillHistoryModal';

// The window is a design-system dialog, so it renders inside the provider like the app does.
const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });
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
  it('allows inspecting package history without exposing a revert that can delete installed files', async () => {
    mockReadHistory.mockResolvedValueOnce([{ turnId: 'package-history', ts: FIXED_TIMESTAMP, op: 'patch', files: [{ relPath: 'SKILL.md', snapshotPath: null, action: 'created' }] }]);
    const user = userEvent.setup();
    render(<SkillHistoryModal skillDir="/plugin/skill" skillName="managed" readOnly onClose={onClose} />);
    await user.click(await screen.findByText(/Patched/));
    expect(screen.getAllByText('SKILL.md').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /Revert this change/ })).toBeNull();
    expect(mockRevertTurn).not.toHaveBeenCalled();
  });

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

  it('is a window named after the skill, and Escape closes it', async () => {
    mockReadHistory.mockResolvedValueOnce([]);
    const user = userEvent.setup();
    render(<SkillHistoryModal skillDir="/skill" skillName="wd" onClose={onClose} />);

    await screen.findByText(/No modifications recorded yet/i);
    expect(screen.getByRole('dialog', { name: `${getI18n().toolbox.historyModalTitle} — wd` })).toBeInTheDocument();
    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes from its close button', async () => {
    mockReadHistory.mockResolvedValueOnce([]);
    const user = userEvent.setup();
    render(<SkillHistoryModal skillDir="/skill" skillName="wd" onClose={onClose} />);

    await screen.findByText(/No modifications recorded yet/i);
    await user.click(screen.getByRole('button', { name: getI18n().common.close }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('says it is loading with one spinner, then lists the changes', async () => {
    let finish: (entries: HistoryEntry[]) => void = () => {};
    mockReadHistory.mockReturnValueOnce(new Promise<HistoryEntry[]>((resolve) => { finish = resolve; }));
    render(<SkillHistoryModal skillDir="/skill" skillName="wd" onClose={onClose} />);

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getAllByRole('status')).toHaveLength(1);
    expect(within(dialog).getByRole('status')).toHaveTextContent(getI18n().common.loading);

    await act(async () => { finish([{ turnId: 't-1', ts: FIXED_TIMESTAMP, op: 'edit', files: [{ relPath: 'SKILL.md', snapshotPath: '/b', action: 'modified' }] }]); });

    expect(await screen.findByText(/Edited/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('status')).toBeNull();
  });

  it('says whether a row is open, and marks what happened to each file', async () => {
    mockReadHistory.mockResolvedValueOnce([
      { turnId: 't-1', ts: FIXED_TIMESTAMP, op: 'write_file', files: [{ relPath: 'notes.md', snapshotPath: null, action: 'created' }] },
    ]);
    const user = userEvent.setup();
    render(<SkillHistoryModal skillDir="/skill" skillName="wd" onClose={onClose} />);

    const row = (await screen.findByText(getI18n().toolbox.historyOpWriteFile)).closest('button') as HTMLButtonElement;
    expect(row).toHaveAttribute('aria-expanded', 'false');
    await user.click(row);

    expect(row).toHaveAttribute('aria-expanded', 'true');
    const mark = await screen.findByText(getI18n().toolbox.historyActionCreated);
    expect(mark).toHaveClass('text-success');
  });

  it('keeps the revert button focusable while its revert runs, and reverts once', async () => {
    mockReadHistory.mockResolvedValue([
      { turnId: 't-1', ts: FIXED_TIMESTAMP, op: 'patch', files: [{ relPath: 'SKILL.md', snapshotPath: '/b', action: 'modified' }] },
    ]);
    let finish: (result: RevertResult) => void = () => {};
    mockRevertTurn.mockReturnValueOnce(new Promise<RevertResult>((resolve) => { finish = resolve; }));
    const user = userEvent.setup();
    render(<SkillHistoryModal skillDir="/skill" skillName="wd" onClose={onClose} />);
    await user.click(await screen.findByText(/Patched/));
    const revert = await screen.findByRole('button', { name: /Revert this change/ });

    await user.click(revert);

    expect(revert).toHaveAttribute('aria-disabled', 'true');
    expect(revert).not.toBeDisabled();
    fireEvent.click(revert);
    expect(mockRevertTurn).toHaveBeenCalledTimes(1);

    await act(async () => { finish({ ok: true, restored: 1, failed: [] }); });
    await waitFor(() => expect(revert).not.toHaveAttribute('aria-disabled'));
  });

  it('reverts nothing from a window that is closing', async () => {
    mockReadHistory.mockResolvedValue([
      { turnId: 't-1', ts: FIXED_TIMESTAMP, op: 'patch', files: [{ relPath: 'SKILL.md', snapshotPath: '/b', action: 'modified' }] },
    ]);
    const user = userEvent.setup();
    const view = render(<SkillHistoryModal open skillDir="/skill" skillName="wd" onClose={onClose} />);
    await user.click(await screen.findByText(/Patched/));
    const revert = await screen.findByRole('button', { name: /Revert this change/ });

    // happy-dom reports no animation, so Radix removes a closed layer at once. With this, the
    // closed window has an exit animation: it stays on the page, as it does in the app while it fades out.
    const real = window.getComputedStyle.bind(window);
    const styles = vi.spyOn(window, 'getComputedStyle').mockImplementation((element: Element, pseudo?: string | null) => {
      const computed = real(element, pseudo);
      return new Proxy(computed, {
        get(target, prop) {
          if (prop === 'animationName') return element.getAttribute('data-state') === 'closed' ? 'exit' : 'enter';
          const value = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    });
    view.rerender(<SkillHistoryModal open={false} skillDir="/skill" skillName="wd" onClose={onClose} />);
    expect(document.querySelector('[role="dialog"][data-state="closed"]')).not.toBeNull();

    fireEvent.click(revert);
    await act(async () => { await Promise.resolve(); });

    expect(mockRevertTurn).not.toHaveBeenCalled();
    styles.mockRestore();
  });
});
