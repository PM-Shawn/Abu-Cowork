// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLanguage } from '@/i18n';
import { encryptedPackageBytes } from '@/test/encryptedPackage';
import DocxPreview from './DocxPreview';

// The real renderer needs layout. Like the library, the stand-in reads the bytes first, which
// takes time, and then empties the container and writes into it in one step; here the bytes
// are written as text. A test holds a read back by registering a gate under its text.
const docx = vi.hoisted(() => {
  const gates = new Map<string, Promise<void>>();
  const parseAsync = vi.fn(async (data: Uint8Array) => {
    const text = new TextDecoder().decode(data);
    await gates.get(text);
    if (text.startsWith('BROKEN')) throw new Error('not a zip file at /Users/someone/work/report.docx');
    return { text };
  });
  const renderDocument = vi.fn(async (parsed: { text: string }, container: HTMLElement) => {
    container.textContent = parsed.text;
  });
  const renderAsync = vi.fn(async (data: Uint8Array, container: HTMLElement) => {
    const parsed = await parseAsync(data);
    await renderDocument(parsed, container);
    return parsed;
  });
  return { gates, parseAsync, renderDocument, renderAsync };
});
vi.mock('docx-preview', () => ({
  parseAsync: docx.parseAsync,
  renderDocument: docx.renderDocument,
  renderAsync: docx.renderAsync,
}));

function gate(text: string): () => void {
  let open: () => void = () => {};
  docx.gates.set(text, new Promise<void>((resolve) => { open = resolve; }));
  return open;
}

function bytes(text: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(text));
}

describe('DocxPreview', () => {
  beforeEach(() => {
    initLanguage('en-US');
    docx.gates.clear();
    docx.parseAsync.mockClear();
    docx.renderDocument.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  // The marker switches selected text and the reference mark to the page selection color.
  it('marks the Word page as white paper', async () => {
    render(<DocxPreview data={bytes('Quarterly report')} />);
    await waitFor(() => expect(docx.renderDocument).toHaveBeenCalled());
    const page = document.querySelector('.docx-preview-container');
    expect(page).not.toBeNull();
    expect(page).toHaveAttribute('data-page-canvas');
  });

  it('takes the page background from the page canvas token', async () => {
    render(<DocxPreview data={bytes('Quarterly report')} />);
    await waitFor(() => expect(docx.renderDocument).toHaveBeenCalled());
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

  it('keeps the newest bytes on screen when an earlier read finishes after a later one', async () => {
    const finishFirst = gate('Large first draft');
    const { rerender } = render(<DocxPreview data={bytes('Opening draft')} />);
    expect(await screen.findByText('Opening draft')).toBeInTheDocument();

    rerender(<DocxPreview data={bytes('Large first draft')} />);
    await waitFor(() => expect(docx.parseAsync).toHaveBeenCalledTimes(2));
    rerender(<DocxPreview data={bytes('Small second draft')} />);
    expect(await screen.findByText('Small second draft')).toBeInTheDocument();

    finishFirst();
    await waitFor(() => expect(docx.parseAsync.mock.results[1].value).resolves.toEqual({ text: 'Large first draft' }));
    await Promise.resolve();
    expect(screen.getByText('Small second draft')).toBeInTheDocument();
    expect(screen.queryByText('Large first draft')).toBeNull();
    expect(docx.renderDocument.mock.calls.map(([parsed]) => parsed.text)).toEqual(['Opening draft', 'Small second draft']);
  });

  it('keeps the pages on screen until the next bytes are read', async () => {
    const finishSecond = gate('Second draft');
    const { rerender } = render(<DocxPreview data={bytes('First draft')} />);
    expect(await screen.findByText('First draft')).toBeInTheDocument();

    rerender(<DocxPreview data={bytes('Second draft')} />);
    await waitFor(() => expect(docx.parseAsync).toHaveBeenCalledTimes(2));
    expect(screen.getByText('First draft')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();

    finishSecond();
    expect(await screen.findByText('Second draft')).toBeInTheDocument();
    expect(screen.queryByText('First draft')).toBeNull();
  });

  it('says a document saved with a password is password-protected without handing it to the renderer, and draws the next bytes', async () => {
    const { rerender } = render(<DocxPreview data={encryptedPackageBytes()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/^This file is password-protected and cannot be previewed$/);
    expect(docx.parseAsync).not.toHaveBeenCalled();

    rerender(<DocxPreview data={bytes('Unlocked copy')} />);
    expect(await screen.findByText('Unlocked copy')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
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
