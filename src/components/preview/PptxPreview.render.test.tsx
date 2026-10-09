// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { initLanguage } from '@/i18n';
import PptxPreview from './PptxPreview';

const deck = vi.hoisted(() => ({ preview: vi.fn(), destroy: vi.fn() }));

// The real renderer needs layout; the stand-in draws one slide wrapper like the library does.
vi.mock('pptx-preview', () => ({
  init: (container: HTMLElement) => ({
    preview: async (data: ArrayBuffer) => {
      await deck.preview(data);
      const slide = document.createElement('div');
      slide.className = 'pptx-preview-slide-wrapper';
      slide.textContent = 'Quarterly review';
      container.appendChild(slide);
    },
    destroy: deck.destroy,
  }),
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
  openPath: vi.fn().mockResolvedValue(undefined),
  revealItemInDir: vi.fn().mockResolvedValue(undefined),
}));

describe('PptxPreview', () => {
  beforeEach(() => {
    initLanguage('en-US');
    deck.preview.mockReset();
    deck.preview.mockResolvedValue(undefined);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  // The marker switches selected text and the reference mark to the page selection color.
  it('marks the slides as white paper', async () => {
    render(<PptxPreview filePath="/work/deck.pptx" />);
    const slide = await screen.findByText('Quarterly review');
    expect(slide.closest('[data-page-canvas]')).not.toBeNull();
    expect(slide.closest('[data-page-canvas]')).toHaveClass('pptx-preview-container');
  });

  it('shows one spinner with its sentence until the slides are drawn', async () => {
    let finish: () => void = () => {};
    deck.preview.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    const { container } = render(<PptxPreview filePath="/work/slow.pptx" />);
    await waitFor(() => expect(deck.preview).toHaveBeenCalled());
    expect(screen.getByRole('status')).toHaveTextContent('Loading...');
    expect(container.querySelectorAll('[data-ds-spinner]')).toHaveLength(1);

    finish();
    await screen.findByText('Quarterly review');
    await waitFor(() => expect(container.querySelectorAll('[data-ds-spinner]')).toHaveLength(0));
  });

  it('offers the two ways out when a deck cannot be previewed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    deck.preview.mockRejectedValue(new Error('not a zip file'));
    render(<PptxPreview filePath="/work/汇报材料.pptx" />);

    expect(await screen.findByText('汇报材料.pptx')).toBeInTheDocument();
    expect(screen.getByText('In-app preview does not support this PPT. Open in PowerPoint to view the full slides.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open in PowerPoint' })).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show in File Manager' }));
    await waitFor(() => expect(revealItemInDir).toHaveBeenCalledWith('/work/汇报材料.pptx'));
  });
});
