import { useCallback, useEffect, useRef, useState } from 'react';
import { ImagePlus, X } from 'lucide-react';
import { useI18n, format } from '@/i18n';
import { cn } from '@/lib/utils';
import { compressImage } from '@/utils/imageCompress';
import { generateAttachmentId } from '@/utils/imageUtils';
import { useToastStore } from '@/stores/toastStore';
import { Button } from '@/components/ui/button';

export interface LocalShot {
  id: string;
  name: string;
  bytes: Uint8Array;
  mediaType: string;
  /** `URL.createObjectURL` blob URL for the thumbnail — revoked on removal/unmount. */
  previewUrl: string;
}

const MAX_SHOTS = 5;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;

interface Props {
  screenshots: LocalShot[];
  onChange: (screenshots: LocalShot[]) => void;
  disabled?: boolean;
}

/**
 * Screenshot attach panel for the diagnostic feedback form. Three add paths
 * (click-to-pick / drag&drop / paste), each funnelled through the same
 * compress-then-append pipeline. Enforces a 5-image / 5MB-total cap client
 * side — collect.ts does not re-validate this, so it must hold here.
 */
export default function ScreenshotUpload({ screenshots, onChange, disabled }: Props) {
  const { t } = useI18n();
  const addToast = useToastStore((s) => s.addToast);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Dual-ref pattern: keep a ref mirror of the latest `screenshots` so the
  // unmount cleanup below (empty deps, runs once) revokes whatever is
  // actually present at unmount time, not a stale first-render snapshot.
  const screenshotsRef = useRef(screenshots);
  useEffect(() => {
    screenshotsRef.current = screenshots;
  }, [screenshots]);
  useEffect(() => {
    return () => {
      screenshotsRef.current.forEach((s) => URL.revokeObjectURL(s.previewUrl));
    };
  }, []);

  const addFiles = useCallback(
    async (files: File[]) => {
      if (disabled) return;
      const imageFiles = files.filter((f) => f.type.startsWith('image/'));
      if (imageFiles.length === 0) return;

      const remaining = MAX_SHOTS - screenshots.length;
      if (remaining <= 0) {
        addToast({ title: t.diagnostic.screenshotTooMany, type: 'warning', duration: 4000 });
        return;
      }

      const toAdd = imageFiles.slice(0, remaining);
      if (imageFiles.length > toAdd.length) {
        addToast({ title: t.diagnostic.screenshotTooMany, type: 'warning', duration: 4000 });
      }

      let runningTotal = screenshots.reduce((sum, s) => sum + s.bytes.length, 0);
      const newShots: LocalShot[] = [];
      let hitCap = false;

      for (const file of toAdd) {
        const buf = new Uint8Array(await file.arrayBuffer());
        const compressed = await compressImage({ bytes: buf, mediaType: file.type || 'image/png' });
        if (runningTotal + compressed.bytes.length > MAX_TOTAL_BYTES) {
          hitCap = true;
          break;
        }
        runningTotal += compressed.bytes.length;
        // Zero-copy: `compressed.bytes` is already a Uint8Array. The `as`
        // only narrows TS's generic `Uint8Array<ArrayBufferLike>` to the
        // `Uint8Array<ArrayBuffer>` that `BlobPart` requires — no runtime
        // copy — safe since these bytes always come from a plain
        // (non-shared) ArrayBuffer (file reads / canvas encode).
        const blob = new Blob([compressed.bytes as Uint8Array<ArrayBuffer>], { type: compressed.mediaType });
        newShots.push({
          id: generateAttachmentId(),
          name: file.name,
          bytes: compressed.bytes,
          mediaType: compressed.mediaType,
          previewUrl: URL.createObjectURL(blob),
        });
      }

      if (hitCap) {
        addToast({ title: t.diagnostic.screenshotTooLarge, type: 'warning', duration: 4000 });
      }
      if (newShots.length > 0) {
        onChange([...screenshots, ...newShots]);
      }
    },
    [disabled, screenshots, onChange, addToast, t],
  );

  const removeShot = (id: string) => {
    if (disabled) return;
    const target = screenshots.find((s) => s.id === id);
    if (target) URL.revokeObjectURL(target.previewUrl);
    onChange(screenshots.filter((s) => s.id !== id));
  };

  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLDivElement>) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files = Array.from(items)
        .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
        .map((it) => it.getAsFile())
        .filter((f): f is File => f !== null);
      if (files.length > 0) {
        e.preventDefault();
        void addFiles(files);
      }
    },
    [addFiles],
  );

  return (
    <section>
      <div className="flex items-center justify-between py-1.5">
        <span className="text-[12px] text-[var(--abu-text-tertiary)]">{t.diagnostic.screenshotTitle}</span>
        <span className="text-[11px] text-[var(--abu-text-muted)]">
          {format(t.diagnostic.screenshotCount, { n: screenshots.length })}
        </span>
      </div>

      <div
        tabIndex={0}
        onPaste={onPaste}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (disabled) return;
          void addFiles(Array.from(e.dataTransfer.files));
        }}
        className={cn(
          'rounded-lg border border-dashed p-2 outline-none transition-colors',
          dragOver ? 'border-[var(--abu-clay)] bg-[var(--abu-clay)]/5' : 'border-[var(--abu-border)]',
          disabled && 'opacity-50 pointer-events-none',
        )}
      >
        {/* Hidden native file input — ui/ has no equivalent (it's not a
            visible form control, just an OS file-picker trigger), so a raw
            <input type="file"> is the documented exception to §4.1. */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            void addFiles(files);
            e.target.value = '';
          }}
        />

        <div className="flex flex-wrap gap-2">
          {screenshots.map((s) => (
            <div
              key={s.id}
              className="relative group h-16 w-16 rounded-md overflow-hidden border border-[var(--abu-border)]"
            >
              <img src={s.previewUrl} alt={s.name} className="h-full w-full object-cover" />
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => removeShot(s.id)}
                aria-label={t.diagnostic.screenshotRemoveAria}
                className="absolute top-0.5 right-0.5 h-4 w-4 rounded-full bg-black/60 text-white opacity-0 group-hover:opacity-100 hover:bg-black/60 hover:text-white transition-opacity"
              >
                <X className="h-2.5 w-2.5" />
              </Button>
            </div>
          ))}

          {screenshots.length < MAX_SHOTS && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled}
              className="h-16 w-16 flex-col gap-0.5 rounded-md border border-dashed border-[var(--abu-border)] text-[var(--abu-text-tertiary)] hover:bg-transparent hover:text-[var(--abu-text-primary)] hover:border-[var(--abu-clay)] transition-colors"
            >
              <ImagePlus className="h-4 w-4" />
            </Button>
          )}
        </div>

        <div className="mt-1.5 text-[10px] text-[var(--abu-text-muted)]">{t.diagnostic.screenshotAddHint}</div>
      </div>
    </section>
  );
}
