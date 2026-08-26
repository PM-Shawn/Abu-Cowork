// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ImageLightbox from './ImageLightbox';
import { initLanguage } from '@/i18n';
import { useImageLightboxStore, type ImageLightboxItem } from '@/stores/imageLightboxStore';
import {
  drainCapabilitySetupRequests,
  requestCapabilitySetup,
} from '@/core/capabilityPlugins/setupBridge';
import {
  drainConfirmationQueue,
  requestCommandConfirmation,
} from '@/core/agent/permissionBridge';
import { usePreviewStore } from '@/stores/previewStore';

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

describe('ImageLightbox', () => {
  beforeEach(() => {
    initLanguage('en-US');
    useImageLightboxStore.getState().close();
    usePreviewStore.getState().setAppModalOpen(false);
    drainCapabilitySetupRequests();
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
    usePreviewStore.getState().setAppModalOpen(false);
    drainCapabilitySetupRequests();
    drainConfirmationQueue();
    cleanup();
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it('opens as a modal, closes with Escape, and restores focus to its thumbnail', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'thumbnail';
    document.body.append(opener);
    opener.focus();
    render(<ImageLightbox />);

    act(() => {
      useImageLightboxStore.getState().open([item('one')], 0, opener);
    });

    const dialog = screen.getByRole('dialog', { name: 'Image preview' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Previous image' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next image' })).not.toBeInTheDocument();
    expect(opener).toHaveAttribute('aria-hidden', 'true');

    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(opener).toHaveFocus());
    expect(opener).not.toHaveAttribute('aria-hidden');
    expect(document.body.style.overflow).toBe('');
  });

  it('falls back to the composer when its thumbnail is removed before close', async () => {
    const opener = document.createElement('button');
    const composer = document.createElement('textarea');
    composer.dataset.chatComposer = '';
    document.body.append(opener, composer);
    render(<ImageLightbox />);

    act(() => {
      useImageLightboxStore.getState().open([item('one')], 0, opener);
    });
    opener.remove();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    await waitFor(() => expect(composer).toHaveFocus());
  });

  it('keeps Tab focus inside the enabled lightbox controls', () => {
    render(<ImageLightbox />);
    act(() => {
      useImageLightboxStore.getState().open([item('one')], 0);
    });

    const dialog = screen.getByRole('dialog');
    const download = screen.getByRole('button', { name: 'Download image' });
    const close = screen.getByRole('button', { name: 'Close' });
    expect(close).toHaveFocus();

    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(download).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(close).toHaveFocus();
  });

  it('yields to an asynchronously requested capability setup', async () => {
    render(<ImageLightbox />);
    act(() => {
      useImageLightboxStore.getState().open([item('one')], 0);
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    let setupPromise!: Promise<boolean>;
    act(() => {
      setupPromise = requestCapabilitySetup('computer', {
        conversationId: 'conversation-1',
        toolCallId: 'tool-1',
        interactionMode: 'foreground',
      });
    });

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    act(() => drainCapabilitySetupRequests());
    await expect(setupPromise).resolves.toBe(false);
  });

  it('yields to a pending command confirmation and restores the app root', async () => {
    const root = document.createElement('div');
    root.id = 'root';
    document.body.append(root);
    render(<ImageLightbox />, { container: root });
    act(() => {
      useImageLightboxStore.getState().open([item('one')], 0);
    });
    expect(root.inert).toBe(true);
    expect(root).toHaveAttribute('aria-hidden', 'true');

    let confirmationPromise!: Promise<boolean>;
    act(() => {
      confirmationPromise = requestCommandConfirmation({
        command: 'touch pending-approval',
        level: 'warn',
        reason: 'Regression test',
      });
    });

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(root.inert).toBe(false);
    expect(root).not.toHaveAttribute('aria-hidden');
    act(() => drainConfirmationQueue());
    await expect(confirmationPromise).resolves.toBe(false);
  });

  it('yields to the global close-window confirmation', async () => {
    render(<ImageLightbox />);
    act(() => {
      useImageLightboxStore.getState().open([item('one')], 0);
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    act(() => usePreviewStore.getState().setAppModalOpen(true));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(useImageLightboxStore.getState().isOpen).toBe(false);
  });

  it('navigates a gallery with bounded buttons and arrow keys', () => {
    render(<ImageLightbox />);
    act(() => {
      useImageLightboxStore.getState().open([item('one'), item('two'), item('three')], 1);
    });

    const dialog = screen.getByRole('dialog');
    expect(screen.getByText('Image 2 of 3')).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: 'ArrowRight', shiftKey: true });
    expect(screen.getByText('Image 2 of 3')).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    expect(screen.getByText('Image 3 of 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next image' })).toBeDisabled();

    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    expect(screen.getByText('Image 3 of 3')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Previous image' }));
    expect(screen.getByText('Image 2 of 3')).toBeInTheDocument();
  });

  it('keeps the lightbox open when the disabled previous-arrow area is clicked', () => {
    render(<ImageLightbox />);
    act(() => {
      useImageLightboxStore.getState().open([item('one'), item('two')], 0);
    });

    const previous = screen.getByRole('button', { name: 'Previous image' });
    expect(previous).toBeDisabled();
    fireEvent.click(previous.parentElement!);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Image 1 of 2')).toBeInTheDocument();
  });

  it('scrolls a long image with arrow and page keys', () => {
    render(<ImageLightbox />);
    act(() => {
      useImageLightboxStore.getState().open([item('long')], 0);
    });

    const dialog = screen.getByRole('dialog');
    const image = screen.getByRole('img');
    Object.defineProperties(image, {
      naturalWidth: { configurable: true, value: 400 },
      naturalHeight: { configurable: true, value: 2400 },
    });
    fireEvent.load(image);
    expect(image).toHaveClass('self-start');

    const scrollContainer = image.parentElement!;
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
      fireEvent.keyDown(dialog, { key });
      expect(scrollBy).toHaveBeenLastCalledWith({ behavior: 'smooth', top });
    }
  });

  it('closes only when the empty backdrop is clicked', () => {
    render(<ImageLightbox />);
    act(() => {
      useImageLightboxStore.getState().open([item('one')], 0);
    });

    fireEvent.click(screen.getByRole('img'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('dialog'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('saves the admitted inline image bytes through the narrow Electron bridge', async () => {
    mocks.saveImageAttachment.mockResolvedValue({ saved: true, fileName: 'chosen.png' });
    render(<ImageLightbox />);
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
    expect(await screen.findByRole('status')).toHaveTextContent('Image saved · chosen.png');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('resolves a persisted image and downloads the exact displayed bytes', async () => {
    mocks.resolveFileSource.mockResolvedValue({
      status: 'available',
      path: '/canonical/outputs/images/image.webp',
    });
    const displayedBytes = Uint8Array.from([1, 2, 3, 4]);
    mocks.loadLocalImageBlob.mockResolvedValue(new Blob([displayedBytes], { type: 'image/webp' }));
    render(<ImageLightbox />);
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
    render(<ImageLightbox />);
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
    render(<ImageLightbox />);
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
    expect(screen.getByText('Loading image...')).toBeInTheDocument();

    resolveSecond({ status: 'available', path: '/canonical/second.webp' });
    await waitFor(() => {
      expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:/canonical/second.webp');
    });
  });

  it('disables download when the Electron save bridge is unavailable', () => {
    mocks.saveHostAvailable.mockReturnValue(false);
    render(<ImageLightbox />);
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
    render(<ImageLightbox />);
    act(() => {
      useImageLightboxStore.getState().open([
        item('oversized', { data: 'A'.repeat(28) }),
      ], 0);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Download image' }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      'This image is larger than the 32 MB download limit',
    );
    expect(atobSpy).not.toHaveBeenCalled();
    expect(mocks.saveImageAttachment).not.toHaveBeenCalled();
  });
});
