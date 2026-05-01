/// <reference types="@testing-library/jest-dom" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SkillCategoryBlocksPanel from './SkillCategoryBlocksPanel';
import type { MemoryHeader } from '@/core/memdir/types';

const mockScanMemoryFiles = vi.fn<(ws: string | null) => Promise<MemoryHeader[]>>();
const mockDeleteMemory = vi.fn<(filename: string, ws: string | null) => Promise<void>>();
const mockAddToast = vi.fn();

vi.mock('@/core/memdir/scan', () => ({
  scanMemoryFiles: (ws: string | null) => mockScanMemoryFiles(ws),
}));

vi.mock('@/core/memdir/write', () => ({
  deleteMemory: (fn: string, ws: string | null) => mockDeleteMemory(fn, ws),
}));

vi.mock('@/stores/workspaceStore', () => ({
  useWorkspaceStore: (selector: (s: { currentPath: string | null }) => unknown) =>
    selector({ currentPath: '/ws' }),
}));

vi.mock('@/stores/toastStore', () => ({
  useToastStore: (selector: (s: { addToast: typeof mockAddToast }) => unknown) =>
    selector({ addToast: mockAddToast }),
}));

function makeHeader(name: string, filename: string, overrides: Partial<MemoryHeader> = {}): MemoryHeader {
  return {
    filename,
    filePath: `/ws/memory/${filename}`,
    name,
    description: 'user rejected',
    type: 'feedback',
    source: 'agent_explicit',
    created: 1_700_000_000_000,
    updated: 1_700_000_000_000,
    accessCount: 0,
    private: false,
    ...overrides,
  };
}

beforeEach(() => {
  mockScanMemoryFiles.mockReset();
  mockDeleteMemory.mockReset().mockResolvedValue(undefined);
  mockAddToast.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('SkillCategoryBlocksPanel', () => {
  it('renders nothing when there are no category blocks', async () => {
    mockScanMemoryFiles.mockResolvedValueOnce([]);
    const { container } = render(<SkillCategoryBlocksPanel />);
    // Panel hides until effect resolves; wait for the async branch to settle.
    await waitFor(() => {
      expect(mockScanMemoryFiles).toHaveBeenCalledWith('/ws');
    });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when workspace memdir has only unrelated memories', async () => {
    // Regression guard: an unrelated feedback memory must NOT show up
    // in the blocks list (would let users delete memories they didn't
    // intend to touch via this panel).
    mockScanMemoryFiles.mockResolvedValueOnce([
      makeHeader('不要直接使用 production 数据库', 'feedback_prod_db.md'),
      makeHeader('api-key 必须从 env 读取', 'feedback_envs.md'),
    ]);
    const { container } = render(<SkillCategoryBlocksPanel />);
    await waitFor(() => {
      expect(mockScanMemoryFiles).toHaveBeenCalled();
    });
    expect(container).toBeEmptyDOMElement();
  });

  it('lists each blocked skill with an Unblock button', async () => {
    mockScanMemoryFiles.mockResolvedValueOnce([
      makeHeader('不要主动为类似 "weekly-digest" 的任务建议 skill', 'feedback_wd.md'),
      makeHeader('不要主动为类似 "daily-report" 的任务建议 skill', 'feedback_dr.md'),
      makeHeader('无关记忆', 'feedback_other.md'),
    ]);

    render(<SkillCategoryBlocksPanel />);

    expect(await screen.findByText('weekly-digest')).toBeInTheDocument();
    expect(screen.getByText('daily-report')).toBeInTheDocument();
    expect(screen.queryByText('无关记忆')).not.toBeInTheDocument();
    // Two unblock buttons — one per entry.
    expect(screen.getAllByRole('button', { name: /Unblock/ })).toHaveLength(2);
  });

  it('clicking Unblock calls deleteMemory and removes the row optimistically', async () => {
    mockScanMemoryFiles.mockResolvedValueOnce([
      makeHeader('不要主动为类似 "weekly-digest" 的任务建议 skill', 'feedback_wd.md'),
      makeHeader('不要主动为类似 "daily-report" 的任务建议 skill', 'feedback_dr.md'),
    ]);

    const user = userEvent.setup();
    render(<SkillCategoryBlocksPanel />);

    const wdRow = await screen.findByText('weekly-digest');
    expect(wdRow).toBeInTheDocument();

    const unblockButtons = screen.getAllByRole('button', { name: /Unblock/ });
    await user.click(unblockButtons[0]);

    await waitFor(() => {
      expect(mockDeleteMemory).toHaveBeenCalledWith('feedback_wd.md', '/ws');
    });
    // Optimistic removal — row vanishes without re-scanning.
    await waitFor(() => {
      expect(screen.queryByText('weekly-digest')).not.toBeInTheDocument();
    });
    // Sibling row stays.
    expect(screen.getByText('daily-report')).toBeInTheDocument();
  });

  it('surfaces a toast and keeps the row when deleteMemory throws', async () => {
    mockScanMemoryFiles.mockResolvedValueOnce([
      makeHeader('不要主动为类似 "weekly-digest" 的任务建议 skill', 'feedback_wd.md'),
    ]);
    mockDeleteMemory.mockRejectedValueOnce(new Error('disk full'));

    const user = userEvent.setup();
    render(<SkillCategoryBlocksPanel />);

    await user.click(await screen.findByRole('button', { name: /Unblock/ }));

    await waitFor(() => {
      expect(mockAddToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', message: 'disk full' }),
      );
    });
    // Failed delete → row still visible so user can retry.
    expect(screen.getByText('weekly-digest')).toBeInTheDocument();
  });
});
