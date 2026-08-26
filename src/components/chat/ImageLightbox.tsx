import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Download, ImageOff, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useImageLightboxStore } from '@/stores/imageLightboxStore';
import { base64ToUint8Array } from '@/utils/base64';
import {
  hasElectronImageSaveHost,
  MAX_ELECTRON_IMAGE_SAVE_BYTES,
  saveElectronImageAttachment,
} from '@/utils/electronHost';
import {
  getPendingCapabilitySetup,
  subscribeCapabilitySetup,
} from '@/core/capabilityPlugins/setupBridge';
import {
  getPendingCommandConfirmation,
  getPendingFilePermission,
  getPendingUserQuestions,
  getPendingWorkspaceRequest,
  subscribeToCommandConfirmation,
  subscribeToFilePermission,
  subscribeToWorkspaceRequest,
  subscribeUserQuestion,
} from '@/core/agent/permissionBridge';
import { format, useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { usePreviewStore } from '@/stores/previewStore';

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

function subscribeBlockingApproval(onStoreChange: () => void): () => void {
  const unsubscribers = [
    subscribeToCommandConfirmation(onStoreChange),
    subscribeToFilePermission(onStoreChange),
    subscribeToWorkspaceRequest(onStoreChange),
    subscribeUserQuestion(onStoreChange),
  ];
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}

function getBlockingApprovalSnapshot(): boolean {
  return getPendingCommandConfirmation() !== null
    || getPendingFilePermission() !== null
    || getPendingWorkspaceRequest() !== null
    || getPendingUserQuestions().length > 0;
}

function hasBlockingOverlay(): boolean {
  return getPendingCapabilitySetup() !== null
    || getBlockingApprovalSnapshot()
    || usePreviewStore.getState().appModalOpen;
}

export default function ImageLightbox() {
  const { t } = useI18n();
  const isOpen = useImageLightboxStore((state) => state.isOpen);
  const items = useImageLightboxStore((state) => state.items);
  const activeIndex = useImageLightboxStore((state) => state.activeIndex);
  const returnFocus = useImageLightboxStore((state) => state.returnFocus);
  const close = useImageLightboxStore((state) => state.close);
  const previous = useImageLightboxStore((state) => state.previous);
  const next = useImageLightboxStore((state) => state.next);
  const capabilitySetup = useSyncExternalStore(
    subscribeCapabilitySetup,
    getPendingCapabilitySetup,
  );
  const blockingApproval = useSyncExternalStore(
    subscribeBlockingApproval,
    getBlockingApprovalSnapshot,
  );
  const appModalOpen = usePreviewStore((state) => state.appModalOpen);
  const blockingOverlay = capabilitySetup !== null || blockingApproval || appModalOpen;
  const dialogRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [diskImage, setDiskImage] = useState<DiskImageState>(DISK_IDLE);
  const [failedItemId, setFailedItemId] = useState<string | null>(null);
  const [longImageItemId, setLongImageItemId] = useState<string | null>(null);
  const [savingItemId, setSavingItemId] = useState<string | null>(null);
  const [saveFeedback, setSaveFeedback] = useState<{
    itemId: string;
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  const item = items[activeIndex];
  const currentDiskImage = diskImage.itemId === item?.id ? diskImage : DISK_IDLE;
  const inlineSrc = item?.data
    ? `data:${item.mediaType};base64,${item.data}`
    : null;
  const imageSrc = inlineSrc ?? currentDiskImage.src;
  const imageFailed = failedItemId === item?.id;
  const isLongImage = longImageItemId === item?.id;
  const saving = savingItemId === item?.id;
  const downloadable = hasElectronImageSaveHost()
    && Boolean(item?.data || currentDiskImage.blob);
  const hasGallery = items.length > 1;

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
    if (!isOpen || blockingOverlay) return;
    const dialog = dialogRef.current;
    const previousOverflow = document.body.style.overflow;
    const siblings = Array.from(document.body.children)
      .filter((element) => element !== dialog && !element.contains(dialog))
      .map((element) => ({
        element: element as HTMLElement,
        inert: (element as HTMLElement).inert,
        ariaHidden: element.getAttribute('aria-hidden'),
      }));

    document.body.style.overflow = 'hidden';
    for (const sibling of siblings) {
      sibling.element.inert = true;
      sibling.element.setAttribute('aria-hidden', 'true');
    }
    closeButtonRef.current?.focus();

    return () => {
      document.body.style.overflow = previousOverflow;
      for (const sibling of siblings) {
        sibling.element.inert = sibling.inert;
        if (sibling.ariaHidden === null) sibling.element.removeAttribute('aria-hidden');
        else sibling.element.setAttribute('aria-hidden', sibling.ariaHidden);
      }
      queueMicrotask(() => {
        // Capability setup may be published and committed by its own
        // subscriber before this component renders the same external-store
        // update. Consult the source of truth as well as the render ref so the
        // outgoing lightbox can never steal focus back from the incoming
        // permission dialog.
        if (hasBlockingOverlay()) return;
        if (returnFocus?.isConnected) {
          returnFocus.focus();
          return;
        }
        document.querySelector<HTMLTextAreaElement>(
          'textarea[data-chat-composer]:not(:disabled)',
        )?.focus();
      });
    };
  }, [blockingOverlay, isOpen, returnFocus]);

  useLayoutEffect(() => {
    if (isOpen && blockingOverlay) close();
  }, [blockingOverlay, close, isOpen]);

  const handleClose = useCallback(() => {
    close();
  }, [close]);

  const handleDownload = useCallback(async () => {
    if (!item || !downloadable || saving) return;
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
        mediaType: item.mediaType,
        suggestedName: `Abu-image-${activeIndex + 1}`,
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
    activeIndex,
    currentDiskImage.blob,
    downloadable,
    item,
    saving,
    t.chat.imageSaveDone,
    t.chat.imageSaveFailed,
    t.chat.imageSaveTooLarge,
  ]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      handleClose();
      return;
    }
    if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        previous();
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        next();
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
        return;
      }
    }
    if (event.key !== 'Tab') return;

    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
    );
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!isOpen || blockingOverlay || !item || typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={dialogRef}
      data-electron-no-drag
      role="dialog"
      aria-modal="true"
      aria-label={t.chat.imagePreviewTitle}
      tabIndex={-1}
      className="fixed inset-0 z-[10000] bg-black/85 animate-in fade-in duration-150 motion-reduce:animate-none"
      onKeyDown={handleKeyDown}
      onClick={(event) => {
        if (event.target === event.currentTarget) handleClose();
      }}
    >
      <div
        className="absolute right-4 z-20 flex flex-col items-end gap-2"
        style={{ top: 'calc(env(titlebar-area-y, 0px) + env(titlebar-area-height, 0px) + 16px)' }}
      >
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="icon-lg"
            className="size-11 rounded-full bg-white/95 text-black shadow-lg hover:bg-white"
            disabled={!downloadable || saving}
            onClick={() => void handleDownload()}
            title={t.chat.downloadImage}
            aria-label={t.chat.downloadImage}
          >
            {saving
              ? <Loader2 className="size-5 animate-spin" />
              : <Download className="size-5" />}
          </Button>
          <Button
            ref={closeButtonRef}
            type="button"
            variant="secondary"
            size="icon-lg"
            className="size-11 rounded-full bg-white/95 text-black shadow-lg hover:bg-white"
            onClick={handleClose}
            title={t.common.close}
            aria-label={t.common.close}
          >
            <X className="size-5" />
          </Button>
        </div>
        {saveFeedback?.itemId === item.id ? (
          <div
            role="status"
            className={cn(
              'max-w-72 rounded-lg bg-white/95 px-3 py-2 text-minor shadow-lg',
              saveFeedback.type === 'error' ? 'text-[var(--abu-danger)]' : 'text-black',
            )}
          >
            {saveFeedback.message}
          </div>
        ) : null}
      </div>

      <div
        ref={scrollContainerRef}
        className="absolute inset-0 flex items-center justify-center overflow-auto px-20 py-20"
        onClick={(event) => {
          if (event.target === event.currentTarget) handleClose();
        }}
      >
        {imageSrc && !imageFailed ? (
          <img
            key={item.id}
            src={imageSrc}
            alt={format(t.chat.imageCounter, { current: activeIndex + 1, total: items.length })}
            draggable={false}
            className={cn(
              'select-none rounded-lg shadow-2xl',
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
          <div role="status" className="flex items-center gap-2 text-body text-white/80">
            <Loader2 className="size-5 animate-spin" />
            {t.chat.imageLoading}
          </div>
        ) : (
          <div role="status" className="flex flex-col items-center gap-2 text-body text-white/80">
            <ImageOff className="size-7" />
            {t.chat.imageUnavailable}
          </div>
        )}
      </div>

      {hasGallery ? (
        <>
          <div
            className="absolute left-5 top-1/2 z-20 -translate-y-1/2"
            onClick={(event) => event.stopPropagation()}
          >
            <Button
              type="button"
              variant="secondary"
              size="icon-lg"
              className="size-12 rounded-full bg-white/90 text-black shadow-lg hover:bg-white"
              disabled={activeIndex === 0}
              onClick={previous}
              title={t.chat.previousImage}
              aria-label={t.chat.previousImage}
            >
              <ChevronLeft className="size-6" />
            </Button>
          </div>
          <div
            className="absolute right-5 top-1/2 z-20 -translate-y-1/2"
            onClick={(event) => event.stopPropagation()}
          >
            <Button
              type="button"
              variant="secondary"
              size="icon-lg"
              className="size-12 rounded-full bg-white/90 text-black shadow-lg hover:bg-white"
              disabled={activeIndex === items.length - 1}
              onClick={next}
              title={t.chat.nextImage}
              aria-label={t.chat.nextImage}
            >
              <ChevronRight className="size-6" />
            </Button>
          </div>
          <div
            aria-live="polite"
            className="absolute bottom-5 left-1/2 z-20 -translate-x-1/2 rounded-full bg-black/45 px-3 py-1.5 text-minor tabular-nums text-white/90"
          >
            {format(t.chat.imageCounter, { current: activeIndex + 1, total: items.length })}
          </div>
        </>
      ) : null}
    </div>,
    document.body,
  );
}
