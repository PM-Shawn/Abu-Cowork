// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, cleanup, fireEvent, render as renderBare, screen, waitFor } from '@testing-library/react';
import type { ComponentProps, ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { initLanguage } from '@/i18n';
import PdfPreview from './PdfPreview';

const iconButtonRenders = vi.hoisted(() => vi.fn());

// Counts renders of the toolbar's floating-layer controls (one tooltip per button).
vi.mock('@/components/ds/button', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ds/button')>();
  return {
    ...actual,
    IconButton: (props: ComponentProps<typeof actual.IconButton>) => {
      iconButtonRenders();
      return actual.IconButton(props);
    },
  };
});

const LOCKED = 0xff;
const passwordAsked = vi.hoisted(() => vi.fn());

// pdf.js needs a canvas and a worker. The stand-in has one page per byte it was given, and
// cannot open bytes that start with a zero. Bytes that start with 0xff are a document saved
// with a password: like pdf.js, the stand-in asks the `onPassword` it was given, keeps waiting
// while that takes the question, and fails with a `PasswordException` once it declines.
vi.mock('react-pdf', async () => {
  const { useEffect, useRef } = await import('react');
  return {
    pdfjs: { GlobalWorkerOptions: {} },
    Document: ({ file, children, onLoadSuccess, onLoadError, onPassword }: {
      file: { data: Uint8Array };
      children: ReactNode;
      onLoadSuccess: (doc: { numPages: number }) => void;
      onLoadError: (error: Error) => void;
      onPassword?: (answer: (password: string | null) => void, reason: number) => void;
    }) => {
      // The stand-in loads once per file object, like a real document.
      const loaded = useRef<{ data: Uint8Array } | null>(null);
      useEffect(() => {
        if (loaded.current === file) return;
        loaded.current = file;
        if (file.data[0] === LOCKED) {
          passwordAsked();
          let declined = !onPassword;
          try {
            onPassword?.(() => {}, 1);
          } catch {
            declined = true;
          }
          if (declined) onLoadError(Object.assign(new Error('No password given'), { name: 'PasswordException', code: 1 }));
        } else if (file.data[0] === 0) onLoadError(new Error('Invalid PDF structure in /Users/someone/work/broken.pdf'));
        else onLoadSuccess({ numPages: file.data.length });
      }, [file, onLoadSuccess, onLoadError, onPassword]);
      return <div>{children}</div>;
    },
    Page: ({ pageNumber, width, scale, rotate, className }: { pageNumber: number; width?: number; scale?: number; rotate?: number; className?: string }) => (
      <div data-testid="pdf-page" data-page={pageNumber} data-width={width ?? ''} data-scale={scale ?? ''} data-rotate={rotate ?? 0} className={className} />
    ),
  };
});

interface Observed { target: Element; notify: () => void }
const observed: Observed[] = [];

class FakeResizeObserver {
  private readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element) {
    observed.push({ target, notify: () => this.callback([], this as unknown as ResizeObserver) });
  }
  unobserve() {}
  disconnect() {}
}

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });

const THREE_PAGES = new Uint8Array([1, 2, 3]);

async function openPdf(filePath: string): Promise<HTMLElement> {
  const { container } = render(<PdfPreview filePath={filePath} data={THREE_PAGES} />);
  await screen.findByTestId('pdf-page');
  await screen.findByRole('button', { name: 'Next page' });
  return container;
}

function resizeViewport(container: HTMLElement, width: number) {
  const viewport = container.firstElementChild?.lastElementChild as HTMLElement;
  Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: width });
  const entry = observed.find((item) => item.target === viewport);
  if (!entry) throw new Error('The PDF viewport is not observed');
  act(() => entry.notify());
}

describe('PdfPreview toolbar', () => {
  beforeEach(() => {
    initLanguage('en-US');
    observed.length = 0;
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    iconButtonRenders.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('names every control and leaves the native tooltip attribute off the buttons', async () => {
    await openPdf('/work/names.pdf');
    for (const name of ['Previous page', 'Next page', 'Fit to width', 'Rotate clockwise', 'Zoom out', 'Zoom in']) {
      expect(screen.getByRole('button', { name })).not.toHaveAttribute('title');
    }
    expect(screen.getAllByRole('button')).toHaveLength(6);
  });

  it('moves between pages and stops at both ends', async () => {
    await openPdf('/work/pages.pdf');
    const previous = screen.getByRole('button', { name: 'Previous page' });
    const next = screen.getByRole('button', { name: 'Next page' });
    expect(screen.getByText('Page 1 / 3')).toBeInTheDocument();
    expect(previous).toBeDisabled();

    fireEvent.click(next);
    expect(screen.getByText('Page 2 / 3')).toBeInTheDocument();
    expect(screen.getByTestId('pdf-page')).toHaveAttribute('data-page', '2');
    expect(previous).toBeEnabled();

    fireEvent.click(next);
    expect(screen.getByText('Page 3 / 3')).toBeInTheDocument();
    expect(next).toBeDisabled();

    fireEvent.click(previous);
    expect(screen.getByText('Page 2 / 3')).toBeInTheDocument();
  });

  it('reports fit-to-width as a pressed toggle and leaves it when zooming', async () => {
    await openPdf('/work/fit.pdf');
    const fit = screen.getByRole('button', { name: 'Fit to width' });
    expect(fit).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Fit')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(fit).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('125%')).toBeInTheDocument();
    expect(screen.getByTestId('pdf-page')).toHaveAttribute('data-scale', '1.25');

    fireEvent.click(fit);
    expect(fit).toHaveAttribute('aria-pressed', 'true');
  });

  it('rotates the page clockwise by quarter turns', async () => {
    await openPdf('/work/rotate.pdf');
    fireEvent.click(screen.getByRole('button', { name: 'Rotate clockwise' }));
    expect(screen.getByTestId('pdf-page')).toHaveAttribute('data-rotate', '90');
  });

  // The marker switches selected text and the reference mark to the page selection color.
  it('marks the page as white paper and gives it the panel elevation', async () => {
    await openPdf('/work/paper.pdf');
    const page = screen.getByTestId('pdf-page');
    expect(page.closest('[data-page-canvas]')).not.toBeNull();
    expect(page).toHaveClass('rounded-control');
    expect(page).toHaveClass('shadow-panel');
  });

  it('does not re-render the toolbar for each width while the panel edge is dragged', async () => {
    const container = await openPdf('/work/resize.pdf');
    resizeViewport(container, 500);
    expect(screen.getByTestId('pdf-page')).toHaveAttribute('data-width', '452');
    const before = iconButtonRenders.mock.calls.length;
    expect(before).toBeGreaterThan(0);

    for (const width of [520, 540, 560, 580]) resizeViewport(container, width);
    expect(screen.getByTestId('pdf-page')).toHaveAttribute('data-width', '532');
    expect(iconButtonRenders.mock.calls.length).toBe(before);
  });

  it('keeps the page in view when the same file is read again, within the new page count', async () => {
    const { rerender } = renderBare(<PdfPreview filePath="/work/again.pdf" data={THREE_PAGES} />, { wrapper: DesignSystemProvider });
    fireEvent.click(await screen.findByRole('button', { name: 'Next page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByText('Page 3 / 3')).toBeInTheDocument();

    rerender(<PdfPreview filePath="/work/again.pdf" data={new Uint8Array([1, 2, 3, 4])} />);
    expect(await screen.findByText('Page 3 / 4')).toBeInTheDocument();

    rerender(<PdfPreview filePath="/work/again.pdf" data={new Uint8Array([1, 2])} />);
    expect(await screen.findByText('Page 2 / 2')).toBeInTheDocument();
    expect(screen.getByTestId('pdf-page')).toHaveAttribute('data-page', '2');
  });

  it('reports bytes it cannot open with the fixed sentence, and draws the next bytes', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { rerender } = renderBare(<PdfPreview filePath="/work/broken.pdf" data={new Uint8Array([0])} />, { wrapper: DesignSystemProvider });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/^Failed to read file$/));
    expect(screen.queryByRole('button')).toBeNull();
    expect(document.body.textContent).not.toContain('Invalid PDF structure');
    expect(errorLog.mock.calls.map((call) => call.map(String).join(' ')).join('\n')).toContain('Invalid PDF structure');

    rerender(<PdfPreview filePath="/work/broken.pdf" data={new Uint8Array([1, 2])} />);
    expect(await screen.findByText('Page 1 / 2')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('asks for no password: it says a document saved with one is password-protected, and draws the next bytes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    passwordAsked.mockClear();
    const { rerender } = renderBare(<PdfPreview filePath="/work/locked.pdf" data={new Uint8Array([LOCKED, 1])} />, { wrapper: DesignSystemProvider });

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/^This file is password-protected and cannot be previewed$/));
    expect(passwordAsked).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button')).toBeNull();

    rerender(<PdfPreview filePath="/work/locked.pdf" data={new Uint8Array([1, 2])} />);
    expect(await screen.findByText('Page 1 / 2')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
