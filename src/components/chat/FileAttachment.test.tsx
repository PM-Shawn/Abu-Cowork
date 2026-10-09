// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { initLanguage } from '@/i18n';
import { DesignSystemProvider } from '@/components/ds/provider';

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

const { default: FileAttachment, ImagePreviewCard } = await import('./FileAttachment');

beforeEach(() => { initLanguage('en-US'); });

afterEach(() => {
  cleanup();
  previewRenders.mockClear();
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

describe('FileAttachment for a presented file', () => {
  it('reads the given path without looking for a snapshot', async () => {
    const { resolveFileSource } = await import('@/core/session/outputSnapshots');
    vi.mocked(resolveFileSource).mockClear();

    render(<Group tick={0}><FileAttachment filePath="/workspace/report.docx" description="Quarterly report" declared /></Group>);

    expect(screen.getByTitle('report.docx')).toHaveTextContent('report');
    expect(screen.getByText('Quarterly report')).toBeInTheDocument();
    expect(screen.queryByText('Document · DOCX')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open with Word' })).toBeInTheDocument();
    expect(resolveFileSource).not.toHaveBeenCalled();
  });

  it('shows the file type when the agent gave no description', () => {
    render(<Group tick={0}><FileAttachment filePath="/workspace/report.docx" declared /></Group>);

    expect(screen.getByText('Document · DOCX')).toBeInTheDocument();
  });
});

describe('FileAttachment without the declared flag', () => {
  it('resolves the file through the snapshot lookup and shows the file type', async () => {
    const { resolveFileSource } = await import('@/core/session/outputSnapshots');
    vi.mocked(resolveFileSource).mockClear();

    render(<Group tick={0}><FileAttachment filePath="/workspace/report.docx" /></Group>);

    expect(await screen.findByText('Document · DOCX')).toBeInTheDocument();
    expect(resolveFileSource).toHaveBeenCalledWith(undefined, '/workspace/report.docx', null);
  });
});

describe('FileAttachment image card', () => {
  it('is named by the file name once', async () => {
    render(<Group tick={0}><FileAttachment filePath="/workspace/chart.png" /></Group>);
    const card = await screen.findByRole('button', { name: 'chart.png' });
    expect(card.querySelector('img')).toHaveAttribute('alt', '');
  });
});
