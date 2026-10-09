// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { act, cleanup, fireEvent, render as renderBare, screen, waitFor } from '@testing-library/react';
import type { ComponentProps, ReactElement } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { getI18n, initLanguage } from '@/i18n';
import ImagePreview from './ImagePreview';

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

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });

const SRC = 'data:image/png;base64,AAAA';

function toolbarButton(name: string): HTMLElement {
  return screen.getByRole('button', { name });
}

describe('ImagePreview toolbar', () => {
  beforeAll(() => {
    // happy-dom has no pointer capture; the image stage captures the pointer while panning.
    Element.prototype.setPointerCapture ??= () => {};
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.releasePointerCapture ??= () => {};
  });

  beforeEach(() => {
    initLanguage('en-US');
    iconButtonRenders.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('names every control and leaves the native tooltip attribute off the buttons', () => {
    render(<ImagePreview src={SRC} alt="photo" />);
    const t = getI18n().panel;
    const names = [t.imageZoomOut, t.imageZoomIn, t.imageRotateLeft, t.imageRotateRight, t.imageResetView, t.imageCopy];
    for (const name of names) {
      expect(toolbarButton(name)).not.toHaveAttribute('title');
    }
    expect(screen.getAllByRole('button')).toHaveLength(names.length);
  });

  it('keeps the double-click hint on the image stage and away from the buttons', () => {
    render(<ImagePreview src={SRC} alt="photo" />);
    const t = getI18n().panel;
    const stage = screen.getByRole('img', { name: 'photo' }).parentElement;
    expect(stage).toHaveAttribute('title', t.imageDoubleClickReset);
    expect(toolbarButton(t.imageCopy).closest('[title]')).toBeNull();
  });

  it('floats the toolbar on the raised surface', () => {
    render(<ImagePreview src={SRC} alt="photo" />);
    const toolbar = toolbarButton(getI18n().panel.imageZoomOut).parentElement;
    expect(toolbar).toHaveClass('bg-raised');
    expect(toolbar).toHaveClass('shadow-float');
    expect(toolbar).toHaveClass('rounded-panel');
  });

  it('disables zooming out at the smallest size and zooming in at the largest', () => {
    render(<ImagePreview src={SRC} alt="photo" />);
    const t = getI18n().panel;
    expect(toolbarButton(t.imageZoomOut)).toBeEnabled();
    for (let step = 0; step < 3; step++) fireEvent.click(toolbarButton(t.imageZoomOut));
    expect(screen.getByText('25%')).toBeInTheDocument();
    expect(toolbarButton(t.imageZoomOut)).toBeDisabled();

    for (let step = 0; step < 15; step++) fireEvent.click(toolbarButton(t.imageZoomIn));
    expect(screen.getByText('400%')).toBeInTheDocument();
    expect(toolbarButton(t.imageZoomIn)).toBeDisabled();
  });

  it('rotates by quarter turns and resets the view', () => {
    render(<ImagePreview src={SRC} alt="photo" />);
    const t = getI18n().panel;
    const image = screen.getByRole('img', { name: 'photo' });
    fireEvent.click(toolbarButton(t.imageZoomIn));
    fireEvent.click(toolbarButton(t.imageRotateRight));
    expect(image.style.transform).toBe('translate(0px, 0px) scale(1.25) rotate(90deg)');
    fireEvent.click(toolbarButton(t.imageRotateLeft));
    fireEvent.click(toolbarButton(t.imageRotateLeft));
    expect(image.style.transform).toBe('translate(0px, 0px) scale(1.25) rotate(270deg)');
    fireEvent.click(toolbarButton(t.imageResetView));
    expect(image.style.transform).toBe('translate(0px, 0px) scale(1) rotate(0deg)');
  });

  it('resets on a double click on the image stage and not on two quick clicks on a button', () => {
    render(<ImagePreview src={SRC} alt="photo" />);
    const t = getI18n().panel;
    const image = screen.getByRole('img', { name: 'photo' });
    fireEvent.click(toolbarButton(t.imageZoomIn));
    fireEvent.doubleClick(toolbarButton(t.imageZoomIn));
    expect(image.style.transform).toBe('translate(0px, 0px) scale(1.25) rotate(0deg)');
    fireEvent.doubleClick(image.parentElement as HTMLElement);
    expect(image.style.transform).toBe('translate(0px, 0px) scale(1) rotate(0deg)');
  });

  it('keeps the success color on the copy button while the pointer stays on it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('ClipboardItem', class {
      readonly items: Record<string, Blob>;
      constructor(items: Record<string, Blob>) {
        this.items = items;
      }
    });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write } });
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: () => {} } as unknown as CanvasRenderingContext2D);
    const toBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((done) => done(new Blob(['png'], { type: 'image/png' })));
    try {
      render(<ImagePreview src={SRC} alt="photo" />);
      const t = getI18n().panel;
      const image = screen.getByRole('img', { name: 'photo' });
      Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 64 });
      Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 64 });

      const copy = toolbarButton(t.imageCopy);
      expect(copy).not.toHaveClass('text-success');
      fireEvent.click(copy);
      await waitFor(() => expect(copy).toHaveClass('text-success'));
      expect(write).toHaveBeenCalledTimes(1);
      // The button's own hover color would otherwise win under the pointer.
      expect(copy).toHaveClass('hover:text-success');
      expect(copy).not.toHaveClass('not-aria-disabled:hover:text-label');

      await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
      expect(copy).not.toHaveClass('text-success');
    } finally {
      getContext.mockRestore();
      toBlob.mockRestore();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it('does not re-render the toolbar for each frame of panning a zoomed image', () => {
    render(<ImagePreview src={SRC} alt="photo" />);
    const t = getI18n().panel;
    fireEvent.click(toolbarButton(t.imageZoomIn));
    const image = screen.getByRole('img', { name: 'photo' });
    const stage = image.parentElement as HTMLElement;

    fireEvent.pointerDown(stage, { pointerId: 1, clientX: 10, clientY: 10 });
    const before = iconButtonRenders.mock.calls.length;
    expect(before).toBeGreaterThan(0);

    for (let frame = 1; frame <= 5; frame++) {
      fireEvent.pointerMove(stage, { pointerId: 1, clientX: 10 + frame * 4, clientY: 10 + frame * 2 });
    }
    expect(image.style.transform).toBe('translate(20px, 10px) scale(1.25) rotate(0deg)');
    expect(iconButtonRenders.mock.calls.length).toBe(before);
  });
});
