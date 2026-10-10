// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import { initLanguage } from '@/i18n';
import { DesignSystemProvider } from '@/components/ds/provider';
import { useToastStore } from '@/stores/toastStore';
import { OPEN_REFUSED_RUNS_BY_DEFAULT } from '@/utils/openWithDefaultApp';

const previewRenders = vi.fn();

// Every render of a card reads the preview store once, so this counts card renders.
vi.mock('@/stores/previewStore', () => ({
  usePreviewStore: (select: (state: { openPreview: () => void }) => unknown) => {
    previewRenders();
    return select({ openPreview: () => {} });
  },
}));

vi.mock('@/utils/pathUtils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/pathUtils')>()),
  loadLocalImage: vi.fn(async () => 'blob:chart'),
}));

vi.mock('@/core/session/outputSnapshots', () => ({
  resolveFileSource: vi.fn(async (_conversationId: unknown, filePath: string) => ({ status: 'available', path: filePath })),
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
  openPath: vi.fn(async () => undefined),
  revealItemInDir: vi.fn(async () => undefined),
}));

const { default: FileAttachment, ImagePreviewCard } = await import('./FileAttachment');

beforeEach(() => { initLanguage('en-US'); });

afterEach(() => {
  cleanup();
  previewRenders.mockClear();
  vi.mocked(openPath).mockReset().mockResolvedValue(undefined);
  vi.mocked(revealItemInDir).mockClear();
  useToastStore.setState({ toasts: [] });
});

// Stands in for a finished message group that re-renders while a later reply streams:
// `tick` changes, the card's own props do not.
function Group({ tick, children }: { tick: number; children: ReactNode }) {
  return <DesignSystemProvider><span data-tick={tick} />{children}</DesignSystemProvider>;
}

describe('ImagePreviewCard', () => {
  it('skips re-rendering while a later reply streams', async () => {
    const { rerender } = render(<Group tick={0}><ImagePreviewCard filePath="/workspace/chart.png" /></Group>);
    await screen.findByRole('img', { name: 'chart.png' });
    const settled = previewRenders.mock.calls.length;
    rerender(<Group tick={1}><ImagePreviewCard filePath="/workspace/chart.png" /></Group>);
    rerender(<Group tick={2}><ImagePreviewCard filePath="/workspace/chart.png" /></Group>);
    expect(previewRenders.mock.calls.length).toBe(settled);
  });

  it('reveals the file with the folder icon the file chip uses', async () => {
    const { container } = render(<Group tick={0}><ImagePreviewCard filePath="/workspace/chart.png" /></Group>);
    await screen.findByRole('img', { name: 'chart.png' });
    const reveal = screen.getByRole('button', { name: 'Show in File Manager' });
    expect(reveal.querySelector('svg.lucide-folder-open')).not.toBeNull();
    expect(container.querySelector('svg.lucide-external-link')).toBeNull();
  });
});

describe('FileAttachment open action', () => {
  it('opens a document with its default application', async () => {
    render(<Group tick={0}><FileAttachment filePath="/workspace/report.pdf" /></Group>);
    fireEvent.click(await screen.findByRole('button', { name: 'Open with Preview' }));
    await waitFor(() => expect(openPath).toHaveBeenCalledWith('/workspace/report.pdf'));
    expect(screen.queryByRole('button', { name: 'Show in File Manager' })).toBeNull();
  });

  it.each(['/workspace/setup.command', '/workspace/Tool.app', 'C:\\workspace\\setup.exe', 'C:\\workspace\\run.bat', '/workspace/job.py', '/workspace/job.sh', '/workspace/deploy'])(
    'only shows %s in the file manager',
    async (filePath) => {
      render(<Group tick={0}><FileAttachment filePath={filePath} /></Group>);
      const reveal = await screen.findByRole('button', { name: 'Show in File Manager' });
      expect(screen.queryByRole('button', { name: /^Open/ })).toBeNull();
      fireEvent.click(reveal);
      await waitFor(() => expect(revealItemInDir).toHaveBeenCalledWith(filePath));
      expect(openPath).not.toHaveBeenCalled();
    },
  );

  it('offers only the file manager once the main process has refused to open the file', async () => {
    vi.mocked(openPath).mockRejectedValue(new Error(`Error invoking remote method 'tauri:invoke': Error: ${OPEN_REFUSED_RUNS_BY_DEFAULT}`));
    render(<Group tick={0}><FileAttachment filePath="/workspace/report.pdf" /></Group>);
    fireEvent.click(await screen.findByRole('button', { name: 'Open with Preview' }));

    const reveal = await screen.findByRole('button', { name: 'Show in File Manager' });
    expect(screen.queryByRole('button', { name: /^Open/ })).toBeNull();
    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ type: 'error', title: 'Failed to open file', message: 'Could not open this file in a local app' }),
    ]);
    fireEvent.click(reveal);
    await waitFor(() => expect(revealItemInDir).toHaveBeenCalledWith('/workspace/report.pdf'));
  });

  it('keeps the open action after a failure that is no refusal', async () => {
    vi.mocked(openPath).mockRejectedValue(new Error('No application is set to open the file'));
    render(<Group tick={0}><FileAttachment filePath="/workspace/report.pdf" /></Group>);
    fireEvent.click(await screen.findByRole('button', { name: 'Open with Preview' }));
    await waitFor(() => expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ type: 'error', title: 'Failed to open file', message: 'No application is set to open the file' }),
    ]));
    expect(screen.getByRole('button', { name: 'Open with Preview' })).toBeInTheDocument();
  });
});

describe('FileAttachment image card', () => {
  it('is named by the file name once', async () => {
    render(<Group tick={0}><FileAttachment filePath="/workspace/chart.png" /></Group>);
    const card = await screen.findByRole('button', { name: 'chart.png' });
    expect(card.querySelector('img')).toHaveAttribute('alt', '');
  });
});
