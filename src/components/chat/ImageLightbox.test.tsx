// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ImageLightbox from './ImageLightbox';
import { DesignSystemProvider } from '@/components/ds/provider';
import { initLanguage } from '@/i18n';
import { useImageLightboxStore, type ImageLightboxItem } from '@/stores/imageLightboxStore';
import {
  drainConfirmationQueue,
  requestCommandConfirmation,
} from '@/core/agent/permissionBridge';
import { APPROVAL_TITLE, approvalProbe, closingWindow, finishClosing, keepClosingLayersOnScreen, windowBox } from '@/test/dsWindows';

const mocks = vi.hoisted(() => ({
  loadLocalImageBlob: vi.fn(),
  resolveFileSource: vi.fn(),
  saveImageAttachment: vi.fn(),
  saveHostAvailable: vi.fn(),
}));

vi.mock('@/utils/electronHost', () => ({
  hasElectronImageSaveHost: () => mocks.saveHostAvailable(),
  MAX_ELECTRON_IMAGE_SAVE_BYTES: 16,
  saveElectronImageAttachment: (...args: unknown[]) => mocks.saveImageAttachment(...args),
  // #549: the conversation writer resolves the conversations root through this
  // one; null is what a tier without the Electron bridge answers.
  canonicalizeElectronPathForPolicy: async () => null,
}));

vi.mock('@/core/session/outputSnapshots', () => ({
  resolveFileSource: (...args: unknown[]) => mocks.resolveFileSource(...args),
}));

vi.mock('@/utils/pathUtils', () => ({
  loadLocalImageBlob: (...args: unknown[]) => mocks.loadLocalImageBlob(...args),
}));

const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01];
const PNG_BASE64 = btoa(String.fromCharCode(...PNG_BYTES));

function item(id: string, overrides: Partial<ImageLightboxItem> = {}): ImageLightboxItem {
  return {
    id,
    data: PNG_BASE64,
    mediaType: 'image/png',
    ...overrides,
  };
}

// The viewer as the app mounts it; `beside` is drawn next to it, inside the same providers.
function renderViewer(beside?: ReactNode) {
  return render(<DesignSystemProvider><ImageLightbox />{beside}</DesignSystemProvider>);
}

const viewer = () => screen.getByRole('dialog', { name: 'Image preview' });
const queryViewer = () => screen.queryByRole('dialog', { name: 'Image preview' });
// The room around the image: the box that scrolls a long image.
const imageRoom = () => screen.getByRole('img').parentElement!;

describe('ImageLightbox', () => {
  beforeEach(() => {
    initLanguage('en-US');
    useImageLightboxStore.getState().close();
    drainConfirmationQueue();
    mocks.loadLocalImageBlob.mockReset();
    mocks.resolveFileSource.mockReset();
    mocks.saveImageAttachment.mockReset();
    mocks.saveHostAvailable.mockReset();
    mocks.saveHostAvailable.mockReturnValue(true);
    mocks.saveImageAttachment.mockResolvedValue({ saved: false });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:resolved-image');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });

  afterEach(() => {
    useImageLightboxStore.getState().close();
    drainConfirmationQueue();
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it('opens as a viewer window, closes with Escape, and restores focus to its thumbnail', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'thumbnail';
    document.body.append(opener);
    opener.focus();
    renderViewer();

    act(() => {
      useImageLightboxStore.getState().open([item('one')], 0, opener);
    });

    const dialog = viewer();
    expect(dialog).toHaveClass('inset-6');
    expect(dialog).toHaveAttribute('data-ds-layer');
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Previous image' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next image' })).not.toBeInTheDocument();

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });

    await waitFor(() => expect(queryViewer()).not.toBeInTheDocument());
    expect(useImageLightboxStore.getState().isOpen).toBe(false);
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('draws no scrim, portal or focus loop of its own', () => {
    renderViewer();
    act(() => {
      useImageLightboxStore.getState().open([item('one'), item('two')], 0);
    });

    // One scrim, the design system's; the window is neither black nor above the dialog level.
    expect(document.querySelectorAll('.bg-scrim')).toHaveLength(1);
    expect(viewer()).toHaveClass('bg-raised');
    expect(viewer()).toHaveClass('z-dialog');
    expect(document.body.style.overflow).toBe('');
  });

  it('names every control and marks the ends of a gallery as unavailable', () => {
    renderViewer();
    act(() => {
      useImageLightboxStore.getState().open([item('one'), item('two')], 0);
    });

    for (const name of ['Download image', 'Previous image', 'Next image', 'Close']) {
      const button = screen.getByRole('button', { name });
      expect(button).toHaveClass('rounded-control');
      expect(button).toHaveClass('h-7');
    }
    expect(screen.getByRole('button', { name: 'Previous image' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next image' })).toBeEnabled();
    // The count is a neutral tag, announced when it changes.
    const count = screen.getByText('Image 1 of 2');
    expect(count).toHaveClass('bg-fill');
    expect(count).toHaveClass('text-ui-sm');
    expect(count.closest('[aria-live="polite"]')).not.toBeNull();
  });

  it('falls back to the composer when its thumbnail is removed before close', async () => {
    const opener = document.createElement('button');
    const composer = document.createElement('textarea');
    composer.dataset.chatComposer = '';
    document.body.append(opener, composer);
    renderViewer();

    act(() => {
      useImageLightboxStore.getState().open([item('one')], 0, opener);
    });
    opener.remove();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });

    await waitFor(() => expect(composer).toHaveFocus());
  });

  it('keeps Tab focus inside the viewer controls', () => {
    renderViewer();
    act(() => {
      useImageLightboxStore.getState().open([item('one')], 0);
    });

    const download = screen.getByRole('button', { name: 'Download image' });
    const close = screen.getByRole('button', { name: 'Close' });
    expect(close).toHaveFocus();

    fireEvent.keyDown(close, { key: 'Tab' });
    expect(download).toHaveFocus();
    fireEvent.keyDown(download, { key: 'Tab', shiftKey: true });
    expect(close).toHaveFocus();
  });

  describe('with an approval', () => {
    // The probe stands in for a command approval; nothing here answers it.
    function Stage({ approval }: { approval: boolean }) {
      return (
        <DesignSystemProvider>
          <ImageLightbox />
          {approvalProbe(approval, () => undefined)}
        </DesignSystemProvider>
      );
    }

    it('closes for an approval that arrives, and leaves the focus on the approval', async () => {
      const opener = document.createElement('button');
      document.body.append(opener);
      opener.focus();
      const { rerender } = render(<Stage approval={false} />);
      act(() => {
        useImageLightboxStore.getState().open([item('one')], 0, opener);
      });
      expect(viewer()).toBeInTheDocument();

      rerender(<Stage approval />);

      await waitFor(() => expect(queryViewer()).not.toBeInTheDocument());
      expect(useImageLightboxStore.getState().isOpen).toBe(false);
      const approval = windowBox(APPROVAL_TITLE)!;
      expect(approval).not.toHaveAttribute('hidden');
      await waitFor(() => expect(approval.contains(document.activeElement)).toBe(true));
      // The thumbnail does not take the focus back from the approval.
      expect(opener).not.toHaveFocus();
    });

    it('is turned away while an approval shows, and opens again once the approval has gone', async () => {
      const { rerender } = render(<Stage approval />);
      expect(windowBox(APPROVAL_TITLE)).not.toBeNull();

      act(() => {
        useImageLightboxStore.getState().open([item('one')], 0);
      });
      await waitFor(() => expect(useImageLightboxStore.getState().isOpen).toBe(false));
      expect(queryViewer()).not.toBeInTheDocument();

      rerender(<Stage approval={false} />);
      await waitFor(() => expect(windowBox(APPROVAL_TITLE)).toBeNull());
      act(() => {
        useImageLightboxStore.getState().open([item('one')], 0);
      });
      expect(viewer()).toBeInTheDocument();
      expect(useImageLightboxStore.getState().isOpen).toBe(true);
    });

    it('stays open while a request waits that shows no approval window', async () => {
      renderViewer();
      let confirmation!: Promise<boolean>;
      act(() => {
        confirmation = requestCommandConfirmation({
          command: 'touch /fake/project/pending-approval',
          level: 'warn',
          reason: 'Regression test',
        });
      });

      act(() => {
        useImageLightboxStore.getState().open([item('one')], 0);
      });
      expect(viewer()).toBeInTheDocument();
      expect(useImageLightboxStore.getState().isOpen).toBe(true);

      act(() => drainConfirmationQueue());
      await expect(confirmation).resolves.toBe(false);
      expect(viewer()).toBeInTheDocument();
    });
  });

  it('navigates a gallery with bounded buttons and arrow keys', () => {
    renderViewer();
    act(() => {
      useImageLightboxStore.getState().open([item('one'), item('two'), item('three')], 1);
    });

    expect(screen.getByText('Image 2 of 3')).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight', shiftKey: true });
    expect(screen.getByText('Image 2 of 3')).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(screen.getByText('Image 3 of 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next image' })).toBeDisabled();

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(screen.getByText('Image 3 of 3')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Previous image' }));
    expect(screen.getByText('Image 2 of 3')).toBeInTheDocument();
    fireEvent.keyDown(viewer(), { key: 'ArrowLeft' });
    expect(screen.getByText('Image 1 of 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous image' })).toBeDisabled();
  });

  it('moves the focus to the other arrow when the pressed one reaches the end', () => {
    renderViewer();
    act(() => {
      useImageLightboxStore.getState().open([item('one'), item('two')], 0);
    });

    const next = screen.getByRole('button', { name: 'Next image' });
    act(() => { next.focus(); });
    fireEvent.click(next);
    expect(screen.getByText('Image 2 of 2')).toBeInTheDocument();
    expect(next).toBeDisabled();
    const previous = screen.getByRole('button', { name: 'Previous image' });
    expect(previous).toHaveFocus();

    fireEvent.click(previous);
    expect(screen.getByText('Image 1 of 2')).toBeInTheDocument();
    expect(previous).toBeDisabled();
    expect(next).toHaveFocus();
  });

  it('keeps the viewer open when the disabled previous-arrow area is clicked', () => {
    renderViewer();
    act(() => {
      useImageLightboxStore.getState().open([item('one'), item('two')], 0);
    });

    const previous = screen.getByRole('button', { name: 'Previous image' });
    expect(previous).toBeDisabled();
    fireEvent.click(previous.parentElement!);

    expect(viewer()).toBeInTheDocument();
    expect(screen.getByText('Image 1 of 2')).toBeInTheDocument();
  });

  it('scrolls a long image with arrow and page keys', () => {
    renderViewer();
    act(() => {
      useImageLightboxStore.getState().open([item('long')], 0);
    });

    const image = screen.getByRole('img');
    Object.defineProperties(image, {
      naturalWidth: { configurable: true, value: 400 },
      naturalHeight: { configurable: true, value: 2400 },
    });
    fireEvent.load(image);
    expect(image).toHaveClass('self-start');

    const scrollContainer = imageRoom();
    expect(scrollContainer).toHaveClass('overflow-auto');
    const scrollBy = vi.fn();
    Object.defineProperties(scrollContainer, {
      clientHeight: { configurable: true, value: 600 },
      scrollBy: { configurable: true, value: scrollBy },
    });

    for (const [key, top] of [
      ['ArrowDown', 80],
      ['ArrowUp', -80],
      ['PageDown', 600],
      ['PageUp', -600],
    ] as const) {
      fireEvent.keyDown(document.activeElement!, { key });
      expect(scrollBy).toHaveBeenLastCalledWith({ behavior: 'smooth', top });
    }
  });

  it('closes on a press beside the image, not on the image', async () => {
    renderViewer();
    act(() => {
      useImageLightboxStore.getState().open([item('one')], 0);
    });

    fireEvent.click(screen.getByRole('img'));
    expect(viewer()).toBeInTheDocument();
    fireEvent.click(imageRoom());
    await waitFor(() => expect(queryViewer()).not.toBeInTheDocument());
    expect(useImageLightboxStore.getState().isOpen).toBe(false);
  });

  it('saves the admitted inline image bytes through the narrow Electron bridge', async () => {
    mocks.saveImageAttachment.mockResolvedValue({ saved: true, fileName: 'chosen.png' });
    renderViewer();
    act(() => {
      useImageLightboxStore.getState().open([item('inline')], 0);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Download image' }));

    await waitFor(() => expect(mocks.saveImageAttachment).toHaveBeenCalledTimes(1));
    const request = mocks.saveImageAttachment.mock.calls[0][0];
    expect(request).toMatchObject({
      mediaType: 'image/png',
      suggestedName: 'Abu-image-1',
    });
    expect(Array.from(request.data as Uint8Array)).toEqual(PNG_BYTES);
    const saved = await screen.findByRole('status');
    expect(saved).toHaveTextContent('Image saved · chosen.png');
    // The inline message of the design system, with the success mark.
    expect(saved).toHaveClass('bg-success-soft');
    expect(saved.querySelector('svg')).not.toBeNull();
    expect(viewer()).toBeInTheDocument();
  });

  it('saves once per press: a second press while the save is running starts no second save', async () => {
    let finishSave!: (result: { saved: boolean; fileName?: string }) => void;
    mocks.saveImageAttachment.mockReturnValue(new Promise((resolve) => { finishSave = resolve; }));
    renderViewer();
    act(() => {
      useImageLightboxStore.getState().open([item('inline')], 0);
    });

    const download = screen.getByRole('button', { name: 'Download image' });
    act(() => { download.focus(); });
    fireEvent.click(download);
    await waitFor(() => expect(mocks.saveImageAttachment).toHaveBeenCalledTimes(1));
    // Busy, not disabled: the button keeps the focus while its own save runs.
    expect(download).toHaveAttribute('aria-disabled', 'true');
    expect(download).toBeEnabled();
    expect(download).toHaveFocus();
    fireEvent.click(download);
    fireEvent.click(download);
    expect(mocks.saveImageAttachment).toHaveBeenCalledTimes(1);

    await act(async () => { finishSave({ saved: true, fileName: 'chosen.png' }); });
    expect(await screen.findByRole('status')).toHaveTextContent('Image saved · chosen.png');
    expect(mocks.saveImageAttachment).toHaveBeenCalledTimes(1);
    expect(download).not.toHaveAttribute('aria-disabled');

    // The save has ended: the next press saves again.
    fireEvent.click(download);
    await waitFor(() => expect(mocks.saveImageAttachment).toHaveBeenCalledTimes(2));
  });

  it('keeps its image while it fades out, and a key press on the fading window saves nothing', async () => {
    keepClosingLayersOnScreen();
    renderViewer();
    act(() => {
      useImageLightboxStore.getState().open([item('one'), item('two')], 1);
    });
    const download = screen.getByRole('button', { name: 'Download image' });

    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(useImageLightboxStore.getState().isOpen).toBe(false);

    // Still on the page, fading, with what it showed.
    const closing = closingWindow();
    expect(closing.querySelector('img')).not.toBeNull();
    expect(closing).toHaveTextContent('Image 2 of 2');
    // Enter on the download button of the fading window.
    fireEvent.click(download);
    await act(async () => { await Promise.resolve(); });
    expect(mocks.saveImageAttachment).not.toHaveBeenCalled();

    finishClosing();
    expect(queryViewer()).not.toBeInTheDocument();
  });

  it('resolves a persisted image and downloads the exact displayed bytes', async () => {
    mocks.resolveFileSource.mockResolvedValue({
      status: 'available',
      path: '/canonical/outputs/images/image.webp',
    });
    const displayedBytes = Uint8Array.from([1, 2, 3, 4]);
    mocks.loadLocalImageBlob.mockResolvedValue(new Blob([displayedBytes], { type: 'image/webp' }));
    renderViewer();
    act(() => {
      useImageLightboxStore.getState().open([
        item('persisted', {
          data: '',
          mediaType: 'image/webp',
          filePath: '/workspace/outputs/images/image.webp',
          conversationId: 'conversation-1',
          workspacePath: '/workspace',
        }),
      ], 0);
    });

    await waitFor(() => {
      expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:resolved-image');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Download image' }));

    await waitFor(() => {
      expect(mocks.saveImageAttachment).toHaveBeenCalledTimes(1);
    });
    const request = mocks.saveImageAttachment.mock.calls[0][0];
    expect(request).toMatchObject({
      mediaType: 'image/webp',
      suggestedName: 'Abu-image-1',
    });
    expect(request).not.toHaveProperty('sourcePath');
    expect(Array.from(request.data as Uint8Array)).toEqual(Array.from(displayedBytes));
  });

  it('revokes each object URL across repeated open and close cycles', async () => {
    mocks.resolveFileSource.mockResolvedValue({
      status: 'available',
      path: '/canonical/outputs/images/image.webp',
    });
    mocks.loadLocalImageBlob.mockResolvedValue(new Blob(['image'], { type: 'image/webp' }));
    vi.mocked(URL.createObjectURL)
      .mockReset()
      .mockReturnValueOnce('blob:first-open')
      .mockReturnValueOnce('blob:second-open');
    renderViewer();
    const persisted = item('persisted', {
      data: '',
      mediaType: 'image/webp',
      filePath: '/workspace/outputs/images/image.webp',
      conversationId: 'conversation-1',
      workspacePath: '/workspace',
    });

    act(() => useImageLightboxStore.getState().open([persisted], 0));
    await waitFor(() => {
      expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:first-open');
    });
    act(() => useImageLightboxStore.getState().close());
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:first-open'));

    act(() => useImageLightboxStore.getState().open([persisted], 0));
    await waitFor(() => {
      expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:second-open');
    });
    act(() => useImageLightboxStore.getState().close());

    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2));
    expect(URL.revokeObjectURL).toHaveBeenNthCalledWith(2, 'blob:second-open');
  });

  it('never shows the previous persisted image while the next one is loading', async () => {
    let resolveSecond!: (value: { status: 'available'; path: string }) => void;
    const secondSource = new Promise<{ status: 'available'; path: string }>((resolve) => {
      resolveSecond = resolve;
    });
    mocks.resolveFileSource.mockImplementation((_: string, filePath: string) => (
      filePath.endsWith('first.webp')
        ? Promise.resolve({ status: 'available', path: '/canonical/first.webp' })
        : secondSource
    ));
    mocks.loadLocalImageBlob.mockImplementation((filePath: string) => (
      Promise.resolve(new Blob([filePath], { type: 'image/webp' }))
    ));
    vi.mocked(URL.createObjectURL)
      .mockReturnValueOnce('blob:/canonical/first.webp')
      .mockReturnValueOnce('blob:/canonical/second.webp');
    renderViewer();
    act(() => {
      useImageLightboxStore.getState().open([
        item('first', { data: '', mediaType: 'image/webp', filePath: '/first.webp' }),
        item('second', { data: '', mediaType: 'image/webp', filePath: '/second.webp' }),
      ], 0);
    });
    await waitFor(() => {
      expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:/canonical/first.webp');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Next image' }));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    // One spinner, and its sentence is its label.
    const loading = screen.getByRole('status');
    expect(loading).toHaveTextContent('Loading image...');
    expect(loading.querySelector('[data-ds-spinner]')).not.toBeNull();

    resolveSecond({ status: 'available', path: '/canonical/second.webp' });
    await waitFor(() => {
      expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:/canonical/second.webp');
    });
  });

  it('says so when the image cannot be read', async () => {
    mocks.resolveFileSource.mockResolvedValue({ status: 'missing', basename: 'gone.png', originalPath: '/fake/project/gone.png' });
    renderViewer();
    act(() => {
      useImageLightboxStore.getState().open([
        item('gone', { data: '', filePath: '/fake/project/gone.png' }),
      ], 0);
    });

    expect(await screen.findByText('Image unavailable')).toBeInTheDocument();
    expect(viewer().querySelector('svg.lucide-image-off')).not.toBeNull();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download image' })).toBeDisabled();
  });

  it('shows an image of a type the save bridge does not take, and offers no download for it', () => {
    const vector = btoa('<svg xmlns="http://www.w3.org/2000/svg"/>');
    renderViewer();
    act(() => {
      useImageLightboxStore.getState().open([item('vector', { mediaType: 'image/svg+xml', data: vector })], 0);
    });

    expect(screen.getByRole('img')).toHaveAttribute('src', `data:image/svg+xml;base64,${vector}`);
    const download = screen.getByRole('button', { name: 'Download image' });
    expect(download).toBeDisabled();
    fireEvent.click(download);
    expect(mocks.saveImageAttachment).not.toHaveBeenCalled();
  });

  it('disables download when the Electron save bridge is unavailable', () => {
    mocks.saveHostAvailable.mockReturnValue(false);
    renderViewer();
    act(() => {
      useImageLightboxStore.getState().open([item('inline')], 0);
    });

    const download = screen.getByRole('button', { name: 'Download image' });
    expect(download).toBeDisabled();
    fireEvent.click(download);
    expect(mocks.saveImageAttachment).not.toHaveBeenCalled();
  });

  it('rejects an oversized inline image before base64 decoding', async () => {
    const atobSpy = vi.spyOn(globalThis, 'atob');
    renderViewer();
    act(() => {
      useImageLightboxStore.getState().open([
        item('oversized', { data: 'A'.repeat(28) }),
      ], 0);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Download image' }));

    const failure = await screen.findByRole('alert');
    expect(failure).toHaveTextContent('This image is larger than the 32 MB download limit');
    expect(failure).toHaveClass('bg-danger-soft');
    expect(atobSpy).not.toHaveBeenCalled();
    expect(mocks.saveImageAttachment).not.toHaveBeenCalled();
  });
});
