// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';
import DocxPreview from './DocxPreview';

// The real renderer needs layout; the stand-in writes the bytes it was given as text.
const { renderAsync } = vi.hoisted(() => ({
  renderAsync: vi.fn(async (data: Uint8Array, container: HTMLElement) => {
    const text = new TextDecoder().decode(data);
    if (text.startsWith('BROKEN')) throw new Error('not a zip file at /Users/someone/work/report.docx');
    container.textContent = text;
  }),
}));
vi.mock('docx-preview', () => ({ renderAsync }));

function bytes(text: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(text));
}

describe('DocxPreview', () => {
  beforeEach(() => {
    initLanguage('en-US');
    renderAsync.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  // The marker switches selected text and the reference mark to the page selection color.
  it('marks the Word page as white paper', async () => {
    render(<DocxPreview data={bytes('Quarterly report')} />);
    await waitFor(() => expect(renderAsync).toHaveBeenCalled());
    const page = document.querySelector('.docx-preview-container');
    expect(page).not.toBeNull();
    expect(page).toHaveAttribute('data-page-canvas');
  });

  it('takes the page background from the page canvas token', async () => {
    render(<DocxPreview data={bytes('Quarterly report')} />);
    await waitFor(() => expect(renderAsync).toHaveBeenCalled());
    const page = document.querySelector('.docx-preview-container') as HTMLElement;
    expect(page.style.background).toContain('--ds-page-canvas');
  });

  it('draws new bytes over the pages on screen without a loading state', async () => {
    const { rerender } = render(<DocxPreview data={bytes('First draft')} />);
    expect(await screen.findByText('First draft')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();

    rerender(<DocxPreview data={bytes('Second draft')} />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(await screen.findByText('Second draft')).toBeInTheDocument();
    expect(screen.queryByText('First draft')).toBeNull();
  });

  it('reports bytes it cannot draw with the fixed sentence, and draws the next bytes', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { rerender } = render(<DocxPreview data={bytes('BROKEN')} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/^Failed to read file$/);
    expect(document.body.textContent).not.toContain('not a zip file');
    expect(errorLog.mock.calls.map((call) => call.map(String).join(' ')).join('\n')).toContain('not a zip file');

    rerender(<DocxPreview data={bytes('Repaired')} />);
    expect(await screen.findByText('Repaired')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
