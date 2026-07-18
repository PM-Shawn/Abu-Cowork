import { Package, Loader2, Upload, Check, Info } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { useI18n, format } from '@/i18n';
import { useToastStore } from '@/stores/toastStore';
import { useDiagnosticStore } from '@/stores/diagnosticStore';
import { useChatStore } from '@/stores/chatStore';
import { useFeedbackDraftStore } from '@/stores/feedbackDraftStore';
import { Toggle } from '@/components/ui/toggle';
import { Textarea } from '@/components/ui/textarea';
import { produceBundle, collectAndZip, type ProduceResult } from '@/core/diagnostic/bundle';
import { mapPermissionsError } from '@/core/diagnostic/errorMap';
import { uploadDiagnosticBundle } from '@/utils/consoleDiagnostic';
import ConversationPicker from './ConversationPicker';
import ScreenshotUpload from './ScreenshotUpload';

interface Props {
  onExportSuccess: (r: ProduceResult) => void;
  description: string;
  onDescriptionChange: (v: string) => void;
}

/** `01.png`, `02.jpg`, ... — extension follows the (possibly compressed) mediaType. */
function screenshotFilename(index: number, mediaType: string): string {
  const ext =
    mediaType === 'image/jpeg' ? 'jpg' : mediaType === 'image/png' ? 'png' : mediaType === 'image/webp' ? 'webp' : mediaType === 'image/gif' ? 'gif' : 'png';
  return `${String(index + 1).padStart(2, '0')}.${ext}`;
}

export default function DiagnosticUpload({ onExportSuccess, description, onDescriptionChange }: Props) {
  const { t } = useI18n();
  const exportInProgress = useDiagnosticStore((s) => s.exportInProgress);
  const setExportInProgress = useDiagnosticStore((s) => s.setExportInProgress);
  const setLastExportPath = useDiagnosticStore((s) => s.setLastExportPath);
  const includeRawText = useDiagnosticStore((s) => s.includeRawText);
  const setIncludeRawText = useDiagnosticStore((s) => s.setIncludeRawText);
  const addToast = useToastStore((s) => s.addToast);
  const activeConversationId = useChatStore((s) => s.activeConversationId);

  // Draft lives in a session store (not component state) so it survives leaving
  // the settings view — e.g. going back to chat to grab a screenshot — which
  // unmounts this component (App renders it behind `viewMode === 'settings'`).
  const selectedConversationIds = useFeedbackDraftStore((s) => s.selectedConversationIds);
  const setSelectedConversationIds = useFeedbackDraftStore((s) => s.setSelectedConversationIds);
  const touchedSelection = useFeedbackDraftStore((s) => s.touchedSelection);
  const screenshots = useFeedbackDraftStore((s) => s.screenshots);
  const setScreenshots = useFeedbackDraftStore((s) => s.setScreenshots);
  const clearDraft = useFeedbackDraftStore((s) => s.clearDraft);

  const [uploadInProgress, setUploadInProgress] = useState(false);
  const [uploadDone, setUploadDone] = useState(false);

  // Click-to-toggle info popover next to the "select conversations" label
  // (a hover tooltip vanishes on mouse-out; users want it to stay open).
  const [infoOpen, setInfoOpen] = useState(false);
  const infoRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!infoOpen) return;
    const onDown = (e: MouseEvent) => {
      if (infoRef.current && !infoRef.current.contains(e.target as Node)) setInfoOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setInfoOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onEsc);
    };
  }, [infoOpen]);
  // Until the user manually changes the selection, it follows the active
  // conversation (defaults to attaching just the current one). Runs on mount
  // too, so after clearDraft() the selection re-syncs to the active chat.
  useEffect(() => {
    if (touchedSelection) return;
    setSelectedConversationIds(activeConversationId ? [activeConversationId] : [], { touched: false });
  }, [activeConversationId, touchedSelection, setSelectedConversationIds]);
  const handleSelectedConversationIdsChange = (ids: string[]) => {
    setSelectedConversationIds(ids, { touched: true });
  };
  const busy = uploadInProgress || exportInProgress;

  const onUpload = async () => {
    if (uploadInProgress || exportInProgress) return;
    setUploadInProgress(true);
    setUploadDone(false);
    try {
      const trimmedDescription = description.trim() || undefined;
      const { bytes, filename } = await collectAndZip({
        includeRawText,
        conversationIds: selectedConversationIds,
        description: trimmedDescription,
        screenshots: screenshots.map((s, i) => ({ name: screenshotFilename(i, s.mediaType), bytes: s.bytes })),
      });
      await uploadDiagnosticBundle(bytes, filename, trimmedDescription);
      setUploadDone(true);
      setTimeout(() => setUploadDone(false), 4000);
      addToast({ title: t.diagnostic.uploadSuccess, type: 'success', duration: 3000 });
      // Submitted — clear the whole draft (description, selection, screenshots).
      clearDraft();
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      addToast({ title: t.diagnostic.uploadFailed, message: raw, type: 'error', duration: 6000 });
    } finally {
      setUploadInProgress(false);
    }
  };

  const onExport = async () => {
    if (exportInProgress) return;
    setExportInProgress(true);
    try {
      const res = await produceBundle({
        includeRawText,
        conversationIds: selectedConversationIds,
        description: description.trim() || undefined,
        screenshots: screenshots.map((s, i) => ({ name: screenshotFilename(i, s.mediaType), bytes: s.bytes })),
      });
      setLastExportPath(res.path);
      onExportSuccess(res);
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      const friendly = mapPermissionsError(raw);
      addToast({
        title: t.diagnostic.exportFailed,
        message: friendly.message === t.diagnostic.errMap.unknown ? raw : `${friendly.message}\n${raw}`,
        type: 'error',
        duration: 6000,
      });
    } finally {
      setExportInProgress(false);
    }
  };

  return (
    <section className="space-y-4">
      {/* Field 1 — problem description (the primary input). */}
      <div>
        <div className="mb-1.5 text-body font-medium text-[var(--abu-text-secondary)]">
          {t.diagnostic.descriptionLabel}
        </div>
        <Textarea
          value={description}
          onChange={(e) => onDescriptionChange(e.target.value)}
          placeholder={t.diagnostic.uploadDescriptionPlaceholder}
          className="min-h-[104px] text-body resize-none"
          disabled={busy}
        />
      </div>

      {/* Field 2 — screenshots (label + right-aligned counter). */}
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-body font-medium text-[var(--abu-text-secondary)]">
            {t.diagnostic.screenshotTitle}
          </span>
          <span className="text-caption text-[var(--abu-text-muted)]">
            {format(t.diagnostic.screenshotCount, { n: screenshots.length })}
          </span>
        </div>
        <ScreenshotUpload screenshots={screenshots} onChange={setScreenshots} disabled={busy} />
      </div>

      {/* Field 3 — select conversations. The info icon carries the privacy +
          limits copy so no toggles/extra lines are needed. */}
      <div>
        <div className="mb-1.5 flex items-center gap-1.5">
          <span className="text-body font-medium text-[var(--abu-text-secondary)]">
            {t.diagnostic.conversationPickerTitle}
          </span>
          <div ref={infoRef} className="relative flex items-center">
            <button
              type="button"
              aria-label={t.diagnostic.conversationPickerInfoTooltip}
              onClick={() => setInfoOpen((o) => !o)}
              className={cn(
                'transition-colors',
                infoOpen ? 'text-[var(--abu-clay)]' : 'text-[var(--abu-text-muted)] hover:text-[var(--abu-text-secondary)]',
              )}
            >
              <Info className="h-3.5 w-3.5" />
            </button>
            {infoOpen && (
              <div className="absolute z-50 left-0 top-full mt-1.5 w-[260px] p-2.5 rounded-lg bg-[var(--abu-bg-muted)] border border-[var(--abu-border)] shadow-md text-caption text-[var(--abu-text-secondary)] leading-relaxed">
                {t.diagnostic.conversationPickerInfoTooltip}
              </div>
            )}
          </div>
        </div>
        <ConversationPicker
          selectedIds={selectedConversationIds}
          onChange={handleSelectedConversationIdsChange}
          disabled={busy}
        />

        {/* Raw-text toggle — ON by default (message text is included, secrets
            still scrubbed). Off strips text down to a size placeholder. */}
        <div className="mt-2 flex items-center justify-between py-1.5">
          <label htmlFor="diag-include-raw" className="text-minor text-[var(--abu-text-secondary)] flex-1">
            {t.diagnostic.exportIncludeRaw}
          </label>
          <Toggle checked={includeRawText} onChange={() => setIncludeRawText(!includeRawText)} size="md" />
        </div>
        <div className="-mt-0.5 text-caption text-[var(--abu-text-muted)] leading-relaxed">
          {t.diagnostic.exportIncludeRawHint}
        </div>
      </div>

      {/* ── Submit ────────────────────────────────────────────── */}
      <div className="border-t border-[var(--abu-border)] pt-3 space-y-2">
        {/* Auto-included-content hint */}
        <div className="text-caption text-[var(--abu-text-muted)]">{t.diagnostic.uploadAutoIncludedHint}</div>

        {/* Primary: upload to console */}
        <button
          type="button"
          onClick={onUpload}
          disabled={uploadInProgress || exportInProgress}
          className={cn(
            'mt-1 w-full py-2.5 rounded-lg text-body font-medium transition-colors flex items-center justify-center gap-2',
            uploadDone
              ? 'bg-[var(--abu-success-bg)] text-[var(--abu-success)] cursor-default'
              : 'bg-[var(--abu-clay)] text-white hover:bg-[var(--abu-clay-hover)] disabled:opacity-50 disabled:cursor-not-allowed'
          )}
        >
          {uploadInProgress ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {t.diagnostic.uploadInProgress}
            </>
          ) : uploadDone ? (
            <>
              <Check className="h-4 w-4" />
              {t.diagnostic.uploadSuccess}
            </>
          ) : (
            <>
              <Upload className="h-4 w-4" />
              {t.diagnostic.uploadButton}
            </>
          )}
        </button>

        {/* Secondary: export offline bundle */}
        <button
          type="button"
          onClick={onExport}
          disabled={exportInProgress || uploadInProgress}
          className="w-full py-2 flex items-center justify-center gap-1.5 text-minor text-[var(--abu-text-muted)] hover:text-[var(--abu-text-secondary)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {exportInProgress ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t.diagnostic.exportInProgress}
            </>
          ) : (
            <>
              <Package className="h-3.5 w-3.5" />
              {t.diagnostic.exportButton}
            </>
          )}
        </button>
      </div>
    </section>
  );
}
