import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { IconButton } from '@/components/ds/button';
import { Dialog } from '@/components/ds/dialog';
import { EmptyState } from '@/components/ds/empty-state';
import { AppIcons } from '@/components/ds/icons';
import { InlineMessage } from '@/components/ds/inline-message';
import { lastInputWasPointer } from '@/components/ds/input-modality';
import { Spinner } from '@/components/ds/spinner';
import { Tag } from '@/components/ds/tag';
import { useImageLightboxStore, type ImageLightboxItem, type ImageLightboxMediaType } from '@/stores/imageLightboxStore';
import { base64ToUint8Array } from '@/utils/base64';
import {
  hasElectronImageSaveHost,
  MAX_ELECTRON_IMAGE_SAVE_BYTES,
  saveElectronImageAttachment,
} from '@/utils/electronHost';
import { format, useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { focusComposer } from './composerFocus';

type DiskImageState =
  | { status: 'idle'; itemId: null; src: null; blob: null }
  | { status: 'loading'; itemId: string; src: null; blob: null }
  | { status: 'ready'; itemId: string; src: string; blob: Blob }
  | { status: 'unavailable'; itemId: string; src: null; blob: null };

const DISK_IDLE: DiskImageState = { status: 'idle', itemId: null, src: null, blob: null };

function decodedBase64Length(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor(value.length * 3 / 4) - padding);
}

class ImageSaveTooLargeError extends Error {}

// The image types the save bridge takes. An image of another type (a tool can return one) is
// shown and cannot be downloaded.
const SAVABLE_MEDIA_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] satisfies ImageLightboxMediaType[];
function isSavableMediaType(mediaType: string): mediaType is ImageLightboxMediaType {
  return SAVABLE_MEDIA_TYPES.includes(mediaType);
}

// What the viewer shows. The store empties itself the moment the viewer closes; the window is
// still on the page then, fading out, and keeps showing this.
interface Shown {
  items: ImageLightboxItem[];
  activeIndex: number;
}

// The viewer opens on its close button: Escape and Enter both close it from there, and the
// first Tab goes to the download button.
const CLOSE_BUTTON = { 'data-lightbox-close': '' } as const;
const closeButtonOf = (content: HTMLElement) => content.querySelector<HTMLElement>('[data-lightbox-close]');

// The one image viewer of the app: a design-system window, so the layer registry closes it for
// an approval, keeps the keyboard inside it and hides what the page cannot paint over.
function ImageLightbox() {
  const { t } = useI18n();
  const isOpen = useImageLightboxStore((state) => state.isOpen);
  const items = useImageLightboxStore((state) => state.items);
  const activeIndex = useImageLightboxStore((state) => state.activeIndex);
  const returnFocus = useImageLightboxStore((state) => state.returnFocus);
  const close = useImageLightboxStore((state) => state.close);

  const [held, setHeld] = useState<Shown | null>(null);
  if (isOpen && (held === null || held.items !== items || held.activeIndex !== activeIndex)) {
    setHeld({ items, activeIndex });
  }
  const shown: Shown | null = isOpen ? { items, activeIndex } : held;

  const bodyRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const previousButtonRef = useRef<HTMLButtonElement>(null);
  const nextButtonRef = useRef<HTMLButtonElement>(null);
  // Where the focus goes once the window has gone: the thumbnail that opened it.
  const returnFocusRef = useRef<HTMLElement | null>(null);
  // The arrow that takes the focus after the pressed one reached the end of the gallery.
  const arrowHandOff = useRef<'previous' | 'next' | null>(null);
  const [diskImage, setDiskImage] = useState<DiskImageState>(DISK_IDLE);
  const [failedItemId, setFailedItemId] = useState<string | null>(null);
  const [longImageItemId, setLongImageItemId] = useState<string | null>(null);
  const [savingItemId, setSavingItemId] = useState<string | null>(null);
  const [saveFeedback, setSaveFeedback] = useState<{
    itemId: string;
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  const shownIndex = shown?.activeIndex ?? 0;
  const shownCount = shown?.items.length ?? 0;
  const item = shown?.items[shownIndex];
  const currentDiskImage = diskImage.itemId === item?.id ? diskImage : DISK_IDLE;
  const inlineSrc = item?.data
    ? `data:${item.mediaType};base64,${item.data}`
    : null;
  const imageSrc = inlineSrc ?? currentDiskImage.src;
  const imageFailed = failedItemId === item?.id;
  const isLongImage = longImageItemId === item?.id;
  const saving = savingItemId === item?.id;
  const downloadable = hasElectronImageSaveHost()
    && item !== undefined
    && isSavableMediaType(item.mediaType)
    && Boolean(item.data || currentDiskImage.blob);
  const hasGallery = shownCount > 1;

  useEffect(() => {
    setDiskImage(DISK_IDLE);
    setFailedItemId(null);
    setLongImageItemId(null);
    setSaveFeedback(null);
    if (!item || item.data || !item.filePath) return;

    let cancelled = false;
    let objectUrl: string | null = null;
    setDiskImage({ status: 'loading', itemId: item.id, src: null, blob: null });

    void (async () => {
      try {
        const [{ resolveFileSource }, { loadLocalImageBlob }] = await Promise.all([
          import('@/core/session/outputSnapshots'),
          import('@/utils/pathUtils'),
        ]);
        const resolved = await resolveFileSource(
          item.conversationId,
          item.filePath!,
          item.workspacePath,
        );
        if (cancelled) return;
        if (resolved.status !== 'available') {
          setDiskImage({ status: 'unavailable', itemId: item.id, src: null, blob: null });
          return;
        }
        const blob = await loadLocalImageBlob(resolved.path);
        objectUrl = URL.createObjectURL(blob);
        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        setDiskImage({ status: 'ready', itemId: item.id, src: objectUrl, blob });
      } catch {
        if (!cancelled) {
          setDiskImage({ status: 'unavailable', itemId: item.id, src: null, blob: null });
        }
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [item]);

  useLayoutEffect(() => {
    if (isOpen) returnFocusRef.current = returnFocus;
  }, [isOpen, returnFocus]);

  // Closed with no window on the page (it has gone, or the layer registry turned it away before
  // it was drawn): the images are let go. A window that is still fading lets them go when it
  // leaves (`windowLeft`).
  useEffect(() => {
    if (isOpen || bodyRef.current?.isConnected) return;
    setHeld(null);
  }, [isOpen]);

  // Runs once the window has left the page. The focus returns to the thumbnail, or to the
  // message field when the thumbnail is gone.
  const windowLeft = (event: Event) => {
    const opener = returnFocusRef.current;
    returnFocusRef.current = null;
    if (!useImageLightboxStore.getState().isOpen) setHeld(null);
    // Another layer took this window's place and holds the focus: leave it there.
    if (event.defaultPrevented) return;
    if (opener?.isConnected) {
      event.preventDefault();
      opener.focus();
      return;
    }
    if (focusComposer()) event.preventDefault();
  };

  const handleDownload = useCallback(async () => {
    // The window is fading out: its controls do nothing.
    if (!useImageLightboxStore.getState().isOpen) return;
    if (!item || !downloadable || saving) return;
    const mediaType = item.mediaType;
    if (!isSavableMediaType(mediaType)) return;
    const savingId = item.id;
    setSavingItemId(savingId);
    setSaveFeedback(null);
    try {
      let data: Uint8Array;
      if (item.data) {
        if (decodedBase64Length(item.data) > MAX_ELECTRON_IMAGE_SAVE_BYTES) {
          throw new ImageSaveTooLargeError();
        }
        data = base64ToUint8Array(item.data);
      } else {
        const blob = currentDiskImage.blob;
        if (!blob) throw new Error('Loaded image bytes are unavailable');
        if (blob.size > MAX_ELECTRON_IMAGE_SAVE_BYTES) {
          throw new ImageSaveTooLargeError();
        }
        data = new Uint8Array(await blob.arrayBuffer());
      }
      const result = await saveElectronImageAttachment({
        mediaType,
        suggestedName: `Abu-image-${shownIndex + 1}`,
        data,
      });
      if (!result) throw new Error('Electron image save bridge is unavailable');
      if (result.saved) {
        setSaveFeedback({
          itemId: savingId,
          type: 'success',
          message: result.fileName
            ? `${t.chat.imageSaveDone} · ${result.fileName}`
            : t.chat.imageSaveDone,
        });
      }
    } catch (error) {
      console.error('[ImageLightbox] Failed to save image:', error);
      setSaveFeedback({
        itemId: savingId,
        type: 'error',
        message: error instanceof ImageSaveTooLargeError
          ? t.chat.imageSaveTooLarge
          : t.chat.imageSaveFailed,
      });
    } finally {
      setSavingItemId((current) => current === savingId ? null : current);
    }
  }, [
    shownIndex,
    currentDiskImage.blob,
    downloadable,
    item,
    saving,
    t.chat.imageSaveDone,
    t.chat.imageSaveFailed,
    t.chat.imageSaveTooLarge,
  ]);

  // One step through the gallery. The arrow that reaches an end becomes unavailable; when it
  // has the focus, the other arrow takes it, so the keyboard stays in the window.
  const step = (direction: -1 | 1) => {
    const state = useImageLightboxStore.getState();
    if (!state.isOpen) return;
    const target = state.activeIndex + direction;
    if (target < 0 || target > state.items.length - 1) return;
    const pressed = direction === 1 ? nextButtonRef.current : previousButtonRef.current;
    const reachesEnd = target === 0 || target === state.items.length - 1;
    if (reachesEnd && pressed !== null && document.activeElement === pressed) {
      arrowHandOff.current = direction === 1 ? 'previous' : 'next';
    }
    if (direction === 1) state.next();
    else state.previous();
  };
  useLayoutEffect(() => {
    const to = arrowHandOff.current;
    arrowHandOff.current = null;
    if (to === null) return;
    const arrow = to === 'previous' ? previousButtonRef.current : nextButtonRef.current;
    arrow?.focus({ preventScroll: true, ...(lastInputWasPointer() ? { focusVisible: false } : {}) });
  }, [activeIndex]);

  // Keys pressed anywhere in the window reach this handler through the component tree.
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      step(-1);
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      step(1);
      return;
    }
    if (
      event.key === 'ArrowUp'
      || event.key === 'ArrowDown'
      || event.key === 'PageUp'
      || event.key === 'PageDown'
    ) {
      const scrollContainer = scrollContainerRef.current;
      if (!scrollContainer) return;
      event.preventDefault();
      const direction = event.key === 'ArrowUp' || event.key === 'PageUp' ? -1 : 1;
      const distance = event.key === 'PageUp' || event.key === 'PageDown'
        ? scrollContainer.clientHeight
        : 80;
      scrollContainer.scrollBy({ behavior: 'smooth', top: direction * distance });
    }
  };

  const counter = format(t.chat.imageCounter, { current: shownIndex + 1, total: shownCount });
  const feedback = item && saveFeedback?.itemId === item.id ? saveFeedback : null;

  return (
    <div className="contents" onKeyDown={handleKeyDown}>
      <Dialog
        open={isOpen && item !== undefined}
        onOpenChange={(next) => { if (!next) close(); }}
        size="viewer"
        title={t.chat.imagePreviewTitle}
        titleHidden
        closeButton={CLOSE_BUTTON}
        initialFocus={closeButtonOf}
        onCloseAutoFocus={windowLeft}
        header={(
          // As tall as the save message, so the image does not move when the message appears.
          <div className="flex min-h-13 items-center justify-end gap-2 px-3">
            {feedback && (
              <InlineMessage tone={feedback.type === 'error' ? 'danger' : 'success'}>
                {feedback.message}
              </InlineMessage>
            )}
            <IconButton
              icon={AppIcons.download}
              label={t.chat.downloadImage}
              busy={saving}
              disabled={!downloadable}
              onClick={() => void handleDownload()}
            />
          </div>
        )}
        footer={hasGallery ? (
          <div aria-live="polite" className="flex w-full justify-center pb-3">
            <Tag>{counter}</Tag>
          </div>
        ) : undefined}
      >
        <div ref={bodyRef} className="flex min-h-0 flex-1 items-center">
          {hasGallery && (
            <div className="flex shrink-0 pl-3">
              <IconButton
                ref={previousButtonRef}
                icon={AppIcons.previous}
                label={t.chat.previousImage}
                disabled={shownIndex === 0}
                onClick={() => step(-1)}
              />
            </div>
          )}
          <div
            ref={scrollContainerRef}
            className="flex min-h-0 min-w-0 flex-1 items-center justify-center self-stretch overflow-auto p-6"
            // A press on the room beside the image closes the viewer, as a press outside it does.
            onClick={(event) => {
              if (event.target === event.currentTarget) close();
            }}
          >
            {item && imageSrc && !imageFailed ? (
              <img
                key={item.id}
                src={imageSrc}
                alt={counter}
                draggable={false}
                className={cn(
                  'select-none rounded-control shadow-dialog',
                  isLongImage
                    ? 'h-auto max-w-full self-start'
                    : 'max-h-full max-w-full object-contain',
                )}
                onLoad={(event) => {
                  const image = event.currentTarget;
                  setLongImageItemId(
                    image.naturalHeight > image.naturalWidth * 2.5 ? item.id : null,
                  );
                }}
                onError={() => setFailedItemId(item.id)}
              />
            ) : currentDiskImage.status === 'loading' ? (
              <Spinner label={t.chat.imageLoading} />
            ) : (
              <EmptyState icon={AppIcons.imageMissing} title={t.chat.imageUnavailable} />
            )}
          </div>
          {hasGallery && (
            <div className="flex shrink-0 pr-3">
              <IconButton
                ref={nextButtonRef}
                icon={AppIcons.next}
                label={t.chat.nextImage}
                disabled={shownIndex === shownCount - 1}
                onClick={() => step(1)}
              />
            </div>
          )}
        </div>
      </Dialog>
    </div>
  );
}

export default memo(ImageLightbox);
