// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, cleanup, fireEvent, render as renderBare, screen, waitFor } from '@testing-library/react';
import type { ComponentProps, ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from '@tauri-apps/plugin-fs';
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

// pdf.js needs a canvas and a worker; a three-page document stands in for it.
vi.mock('react-pdf', async () => {
  const { useEffect, useRef } = await import('react');
  return {
    pdfjs: { GlobalWorkerOptions: {} },
    Document: ({ children, onLoadSuccess }: { children: ReactNode; onLoadSuccess: (doc: { numPages: number }) => void }) => {
      // The stand-in loads once, like a real document.
      const loaded = useRef(false);
      useEffect(() => {
        if (loaded.current) return;
        loaded.current = true;
        onLoadSuccess({ numPages: 3 });
      }, [onLoadSuccess]);
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

async function openPdf(filePath: string): Promise<HTMLElement> {
  const { container } = render(<PdfPreview filePath={filePath} />);
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
    vi.mocked(readFile).mockResolvedValue(new Uint8Array([1, 2, 3]));
    iconButtonRenders.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.mocked(readFile).mockResolvedValue(new Uint8Array());
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

  it('shows one spinner with its sentence while the file is read', async () => {
    let finish: (data: Uint8Array<ArrayBuffer>) => void = () => {};
    vi.mocked(readFile).mockReturnValue(new Promise<Uint8Array<ArrayBuffer>>((resolve) => { finish = resolve; }));
    const { container } = render(<PdfPreview filePath="/work/slow.pdf" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading...');
    expect(container.querySelectorAll('[data-ds-spinner]')).toHaveLength(1);

    await act(async () => { finish(new Uint8Array([1])); });
    await screen.findByTestId('pdf-page');
    expect(container.querySelectorAll('[data-ds-spinner]')).toHaveLength(0);
  });

  it('reports a file that cannot be read as an alert', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(readFile).mockRejectedValue(new Error('permission denied'));
    render(<PdfPreview filePath="/work/locked.pdf" />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('permission denied'));
    expect(screen.queryByRole('button')).toBeNull();
    errorLog.mockRestore();
  });
});
