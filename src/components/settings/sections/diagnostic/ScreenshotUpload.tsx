import { useCallback, useRef, useState } from 'react';
import { ImagePlus, X } from 'lucide-react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { compressImage } from '@/utils/imageCompress';
import { generateAttachmentId } from '@/utils/imageUtils';
import { useToastStore } from '@/stores/toastStore';
import { Button } from '@/components/ui/button';
import type { ScreenshotDraft } from '@/stores/feedbackDraftStore';

const MAX_SHOTS = 5;
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;

interface Props {
  screenshots: ScreenshotDraft[];
  onChange: (shots: ScreenshotDraft[] | ((prev: ScreenshotDraft[]) => ScreenshotDraft[])) => void;
  disabled?: boolean;
}

/**
 * Screenshot attach panel for the diagnostic feedback form. Three add paths
 * (click-to-pick / drag&drop / paste), each funnelled through the same
 * compress-then-append pipeline. Enforces a 5-image / 5MB-total cap client
 * side — collect.ts does not re-validate this, so it must hold here.
 *
 * Blob-URL lifecycle is owned by the DRAFT (feedbackDraftStore), not this
 * component: created on add, revoked on explicit removal here or clearDraft().
 * We deliberately do NOT revoke on unmount — the draft (and its live URLs) must
 * survive navigating away from settings and back.
 */
export default function ScreenshotUpload({ screenshots, onChange, disabled }: Props) {
  const { t } = useI18n();
  const addToast = useToastStore((s) => s.addToast);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback(
    async (files: File[]) => {
      if (disabled) return;
      const imageFiles = files.filter((f) => f.type.startsWith('image/'));
      if (imageFiles.length === 0) return;

      // Compress every candidate up front (the slow async part). Cap
      // enforcement + commit then happen atomically in a functional updater
      // against the LATEST draft — so a drag firing mid-way through a paste's
      // compress can't clobber it by merging from a stale snapshot.
      const candidates: ScreenshotDraft[] = [];
      for (const file of imageFiles) {
        const buf = new Uint8Array(await file.arrayBuffer());
        const compressed = await compressImage({ bytes: buf, mediaType: file.type || 'image/png' });
        // Zero-copy: `compressed.bytes` is already a Uint8Array. The `as` only
        // narrows TS's generic `Uint8Array<ArrayBufferLike>` to the
        // `Uint8Array<ArrayBuffer>` that `BlobPart` requires — no runtime copy
        // — safe since these bytes always come from a plain (non-shared)
        // ArrayBuffer (file reads / canvas encode).
        const blob = new Blob([compressed.bytes as Uint8Array<ArrayBuffer>], { type: compressed.mediaType });
        candidates.push({
          id: generateAttachmentId(),
          name: file.name,
          bytes: compressed.bytes,
          mediaType: compressed.mediaType,
          previewUrl: URL.createObjectURL(blob),
        });
      }

      // Pure updater (StrictMode may run it twice — no side effects inside):
      // appends candidates in order until a cap is hit. `accepted`/`tooMany`
      // are deterministic functions of the inputs, so a double-run is safe.
      let accepted = 0;
      let tooMany = false;
      onChange((prev) => {
        const out = [...prev];
        let runningTotal = prev.reduce((sum, s) => sum + s.bytes.length, 0);
        for (const shot of candidates) {
          if (out.length >= MAX_SHOTS) {
            tooMany = true;
            break;
          }
          if (runningTotal + shot.bytes.length > MAX_TOTAL_BYTES) break;
          runningTotal += shot.bytes.length;
          out.push(shot);
        }
        accepted = out.length - prev.length;
        return out;
      });

      // Candidates are appended in order, so the rejected ones are the tail.
      for (const shot of candidates.slice(accepted)) URL.revokeObjectURL(shot.previewUrl);
      if (accepted < candidates.length) {
        addToast({
          title: tooMany ? t.diagnostic.screenshotTooMany : t.diagnostic.screenshotTooLarge,
          type: 'warning',
          duration: 4000,
        });
      }
    },
    [disabled, onChange, addToast, t],
  );

  const removeShot = (id: string) => {
    if (disabled) return;
    const target = screenshots.find((s) => s.id === id);
    if (target) URL.revokeObjectURL(target.previewUrl);
    onChange((prev) => prev.filter((s) => s.id !== id));
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
          'rounded-lg border p-2 outline-none transition-colors',
          dragOver
            ? 'border-dashed border-[var(--abu-clay)] bg-[var(--abu-clay)]/5'
            : 'border-[var(--abu-border)] bg-[var(--abu-bg-muted)]',
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
