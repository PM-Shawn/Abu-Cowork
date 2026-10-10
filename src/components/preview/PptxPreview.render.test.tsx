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
      slide.textContent = new TextDecoder().decode(data);
      container.appendChild(slide);
    },
    destroy: deck.destroy,
  }),
}));

function bytes(text: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(text));
}

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
    render(<PptxPreview filePath="/work/deck.pptx" data={bytes('Quarterly review')} />);
    const slide = await screen.findByText('Quarterly review');
    expect(slide.closest('[data-page-canvas]')).not.toBeNull();
    expect(slide.closest('[data-page-canvas]')).toHaveClass('pptx-preview-container');
  });

  it('shows one spinner with its sentence until the slides are drawn', async () => {
    let finish: () => void = () => {};
    deck.preview.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    const { container } = render(<PptxPreview filePath="/work/slow.pptx" data={bytes('Quarterly review')} />);
    await waitFor(() => expect(deck.preview).toHaveBeenCalled());
    expect(screen.getByRole('status')).toHaveTextContent('Loading...');
    expect(container.querySelectorAll('[data-ds-spinner]')).toHaveLength(1);

    finish();
    await screen.findByText('Quarterly review');
    await waitFor(() => expect(container.querySelectorAll('[data-ds-spinner]')).toHaveLength(0));
  });

  it('offers the two ways out when a deck cannot be previewed', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    deck.preview.mockRejectedValue(new Error('not a zip file'));
    render(<PptxPreview filePath="/work/汇报材料.pptx" data={bytes('Quarterly review')} />);

    expect(await screen.findByText('汇报材料.pptx')).toBeInTheDocument();
    expect(screen.getByText('In-app preview does not support this PPT. Open in PowerPoint to view the full slides.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open in PowerPoint' })).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
    expect(document.body.textContent).not.toContain('not a zip file');
    expect(errorLog.mock.calls.map((call) => call.map(String).join(' ')).join('\n')).toContain('not a zip file');

    fireEvent.click(screen.getByRole('button', { name: 'Show in File Manager' }));
    await waitFor(() => expect(revealItemInDir).toHaveBeenCalledWith('/work/汇报材料.pptx'));
  });

  it('draws the slides again from new bytes without a loading state, and leaves the ways out once a deck draws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    deck.preview.mockRejectedValueOnce(new Error('not a zip file'));
    const { rerender } = render(<PptxPreview filePath="/work/deck.pptx" data={bytes('Broken deck')} />);
    expect(await screen.findByRole('button', { name: 'Open in PowerPoint' })).toBeInTheDocument();

    rerender(<PptxPreview filePath="/work/deck.pptx" data={bytes('First deck')} />);
    expect(await screen.findByText('First deck')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open in PowerPoint' })).toBeNull();

    rerender(<PptxPreview filePath="/work/deck.pptx" data={bytes('Second deck')} />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(await screen.findByText('Second deck')).toBeInTheDocument();
    expect(screen.queryByText('First deck')).toBeNull();
  });

  it('hands the renderer the buffer the bytes fill, and a copy of exactly the bytes of a view into a larger one', async () => {
    const whole = bytes('Whole deck');
    const { unmount } = render(<PptxPreview filePath="/work/whole.pptx" data={whole} />);
    await screen.findByText('Whole deck');
    expect(deck.preview.mock.calls.at(-1)?.[0]).toBe(whole.buffer);
    unmount();

    const padded = bytes('__Part deck__');
    const view = new Uint8Array(padded.buffer, 2, 9);
    render(<PptxPreview filePath="/work/part.pptx" data={view} />);
    await screen.findByText('Part deck');
    const handed = deck.preview.mock.calls.at(-1)?.[0] as ArrayBuffer;
    expect(handed).not.toBe(padded.buffer);
    expect(handed.byteLength).toBe(9);
  });
});
