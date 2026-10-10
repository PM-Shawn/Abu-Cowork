// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import { initLanguage } from '@/i18n';
import PptxPreview from './PptxPreview';

const deck = vi.hoisted(() => ({ preview: vi.fn(), destroy: vi.fn() }));

// The real renderer needs layout. Like the library, each previewer adds a wrapper of its own
// to the container when it is made, and draws its slides into that wrapper once the deck is read.
vi.mock('pptx-preview', () => ({
  init: (container: HTMLElement) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'pptx-preview-wrapper';
    container.append(wrapper);
    return {
      preview: async (data: ArrayBuffer) => {
        wrapper.innerHTML = '';
        await deck.preview(data);
        const slide = document.createElement('div');
        slide.className = 'pptx-preview-slide-wrapper';
        slide.textContent = new TextDecoder().decode(data);
        wrapper.append(slide);
      },
      destroy: deck.destroy,
    };
  },
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

  it('hands the deck to its default application by path alone, whatever characters the name holds', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(openPath).mockClear();
    vi.mocked(invoke).mockClear();
    deck.preview.mockRejectedValue(new Error('not a zip file'));
    const path = '/work/Q3 "final" $HOME `draft`.pptx';
    render(<PptxPreview filePath={path} data={bytes('Quarterly review')} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open in PowerPoint' }));

    await waitFor(() => expect(openPath).toHaveBeenCalledTimes(1));
    expect(openPath).toHaveBeenCalledWith(path);
    expect(invoke).not.toHaveBeenCalled();
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

  // A previewer draws into the wrapper it added, and the container is emptied before the next
  // previewer is made: a deck read late draws into a wrapper that has left the page.
  it('keeps the newest deck on screen when an earlier one is read after a later one', async () => {
    let finishFirst: () => void = () => {};
    const firstRead = new Promise<void>((resolve) => { finishFirst = resolve; });
    deck.preview.mockImplementation((data: ArrayBuffer) => (
      new TextDecoder().decode(data) === 'Large first deck' ? firstRead : Promise.resolve()
    ));
    const { rerender, container } = render(<PptxPreview filePath="/work/deck.pptx" data={bytes('Opening deck')} />);
    expect(await screen.findByText('Opening deck')).toBeInTheDocument();

    rerender(<PptxPreview filePath="/work/deck.pptx" data={bytes('Large first deck')} />);
    await waitFor(() => expect(deck.preview).toHaveBeenCalledTimes(2));
    rerender(<PptxPreview filePath="/work/deck.pptx" data={bytes('Small second deck')} />);
    expect(await screen.findByText('Small second deck')).toBeInTheDocument();

    finishFirst();
    await firstRead;
    await Promise.resolve();
    expect(screen.getByText('Small second deck')).toBeInTheDocument();
    expect(screen.queryByText('Large first deck')).toBeNull();
    expect(container.querySelectorAll('.pptx-preview-wrapper')).toHaveLength(1);
    expect(container.querySelectorAll('.pptx-preview-slide-wrapper')).toHaveLength(1);
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
