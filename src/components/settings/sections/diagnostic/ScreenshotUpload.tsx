import { useCallback, useRef, useState } from 'react';
import { IconButton } from '@/components/ds/button';
import { HiddenFileInput } from '@/components/ds/file-input';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Pressable } from '@/components/ds/pressable';
import { Tooltip } from '@/components/ds/tooltip';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { compressImage } from '@/utils/imageCompress';
import { generateAttachmentId } from '@/utils/imageUtils';
import { useToastStore } from '@/stores/toastStore';
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
      {/* Focusable by a press, for a paste; the Tab key goes to the add button inside it, and a
          paste there arrives here as well. */}
      <div
        tabIndex={-1}
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
          'rounded-control border p-2 outline-none transition-colors duration-fast focus-visible:ring-2 focus-visible:ring-focus',
          dragOver ? 'border-dashed border-control-border bg-fill-hover' : 'border-separator',
          disabled && 'pointer-events-none opacity-40',
        )}
      >
        <HiddenFileInput
          ref={fileInputRef}
          accept="image/*"
          multiple
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
              className="group relative size-16 overflow-hidden rounded-control border border-separator"
            >
              <img src={s.previewUrl} alt={s.name} className="h-full w-full object-cover" />
              {/* Shown under the pointer and when the keyboard reaches it. */}
              <span className="absolute right-1 top-1 flex rounded-control bg-raised opacity-0 transition-opacity duration-fast group-hover:opacity-100 group-focus-within:opacity-100">
                <IconButton
                  size="sm"
                  variant="secondary"
                  icon={AppIcons.close}
                  label={t.diagnostic.screenshotRemoveAria}
                  onClick={() => removeShot(s.id)}
                />
              </span>
            </div>
          ))}

          {screenshots.length < MAX_SHOTS && (
            <Tooltip content={t.diagnostic.screenshotTitle}>
              <Pressable
                onClick={() => fileInputRef.current?.click()}
                disabled={disabled}
                aria-label={t.diagnostic.screenshotTitle}
                className="flex size-16 flex-col items-center justify-center gap-1 rounded-control border border-dashed border-control-border text-label-tertiary hover:text-label"
              >
                <Icon icon={AppIcons.addImage} />
              </Pressable>
            </Tooltip>
          )}
        </div>

        <div className="mt-2 text-caption text-label-tertiary">{t.diagnostic.screenshotAddHint}</div>
      </div>
    </section>
  );
}
