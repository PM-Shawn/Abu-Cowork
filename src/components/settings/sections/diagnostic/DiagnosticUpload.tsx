import { useEffect, useState, type ComponentProps } from 'react';
import { Button } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Popover } from '@/components/ds/popover';
import { Pressable } from '@/components/ds/pressable';
import { Spinner } from '@/components/ds/spinner';
import { StatusIcon } from '@/components/ds/status-icon';
import { Switch } from '@/components/ds/switch';
import { TextArea } from '@/components/ds/text-area';
import { Tooltip } from '@/components/ds/tooltip';
import { useI18n, format } from '@/i18n';
import { useToastStore } from '@/stores/toastStore';
import { useDiagnosticStore } from '@/stores/diagnosticStore';
import { useChatStore } from '@/stores/chatStore';
import { useFeedbackDraftStore } from '@/stores/feedbackDraftStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { produceBundle, collectAndZip, type ProduceResult } from '@/core/diagnostic/bundle';
import { mapPermissionsError } from '@/core/diagnostic/errorMap';
import { isDiagnosticUploadUnavailable, uploadDiagnosticBundle } from '@/utils/consoleDiagnostic';
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

/** The information button beside a field title. Its words show when the pointer rests on it or
 *  the keyboard reaches it; the panel it opens hands it the rest of its props. */
function InfoButton({ label, ...props }: Omit<ComponentProps<'button'>, 'children' | 'aria-label'> & { label: string }) {
  return (
    <Tooltip content={label}>
      <Pressable aria-label={label} className="inline-flex rounded-control text-label-tertiary hover:text-label" {...props}>
        <Icon icon={AppIcons.info} size="sm" />
      </Pressable>
    </Tooltip>
  );
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
  // Required-field errors only appear after an upload attempt, and self-clear
  // as soon as the field is filled (each render re-checks the condition).
  const [showRequiredErrors, setShowRequiredErrors] = useState(false);
  const descriptionMissing = description.trim().length === 0;
  const conversationMissing = selectedConversationIds.length === 0;

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
    // The settings window stays on the page while it fades out; a key press there sends nothing.
    if (!useSettingsStore.getState().systemSettingsOpen) return;
    if (uploadInProgress || exportInProgress) return;
    if (descriptionMissing || conversationMissing) {
      setShowRequiredErrors(true);
      return;
    }
    setShowRequiredErrors(false);
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
      addToast({
        title: t.diagnostic.uploadFailed,
        message: isDiagnosticUploadUnavailable(e) ? t.diagnostic.uploadUnavailable : raw,
        type: 'error',
        duration: 6000,
      });
    } finally {
      setUploadInProgress(false);
    }
  };

  const onExport = async () => {
    // Same as above: no bundle is written from a window that is closing.
    if (!useSettingsStore.getState().systemSettingsOpen) return;
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
        <label htmlFor="diag-description" className="mb-2 block text-ui font-medium text-label-secondary">
          {t.diagnostic.descriptionLabel}
          <span aria-hidden className="ml-1 text-danger">*</span>
        </label>
        <TextArea
          id="diag-description"
          rows={5}
          value={description}
          onChange={(e) => onDescriptionChange(e.target.value)}
          placeholder={t.diagnostic.uploadDescriptionPlaceholder}
          invalid={showRequiredErrors && descriptionMissing}
          disabled={busy}
        />
        {showRequiredErrors && descriptionMissing && (
          <RequiredError>{t.diagnostic.descriptionRequired}</RequiredError>
        )}
      </div>

      {/* Field 2 — screenshots (label + right-aligned counter). */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-ui font-medium text-label-secondary">
            {t.diagnostic.screenshotTitle}
          </span>
          <span className="text-caption text-label-tertiary">
            {format(t.diagnostic.screenshotCount, { n: screenshots.length })}
          </span>
        </div>
        <ScreenshotUpload screenshots={screenshots} onChange={setScreenshots} disabled={busy} />
      </div>

      {/* Field 3 — select conversations. The info icon carries the privacy +
          limits copy so no toggles/extra lines are needed. */}
      <div>
        <div className="mb-2 flex items-center gap-2">
          <span className="text-ui font-medium text-label-secondary">
            {t.diagnostic.conversationPickerTitle}
            <span aria-hidden className="ml-1 text-danger">*</span>
          </span>
          {/* Opens on a press and stays open: a hover tip would vanish while it is being read. */}
          <Popover
            align="start"
            className="w-65"
            trigger={<InfoButton label={t.diagnostic.conversationPickerInfoTooltip} />}
          >
            <p className="text-ui-sm text-label-secondary">{t.diagnostic.conversationPickerInfoTooltip}</p>
          </Popover>
        </div>
        <ConversationPicker
          selectedIds={selectedConversationIds}
          onChange={handleSelectedConversationIdsChange}
          disabled={busy}
        />
        {showRequiredErrors && conversationMissing && (
          <RequiredError>{t.diagnostic.conversationRequired}</RequiredError>
        )}

        {/* Raw-text toggle — ON by default (message text is included, secrets
            still scrubbed). Off strips text down to a size placeholder. */}
        <div className="mt-2 flex items-center justify-between gap-4 py-2">
          {/* The box takes the spare width; the label is only as wide as its words, so a press
              on the empty part of the row does not move the switch. */}
          <div className="min-w-0 flex-1">
            <label htmlFor="diag-include-raw" className="text-ui-sm text-label-secondary">
              {t.diagnostic.exportIncludeRaw}
            </label>
          </div>
          <Switch id="diag-include-raw" checked={includeRawText} onCheckedChange={() => setIncludeRawText(!includeRawText)} />
        </div>
        <div className="text-caption text-label-tertiary">
          {t.diagnostic.exportIncludeRawHint}
        </div>
      </div>

      {/* ── Submit ────────────────────────────────────────────── */}
      <div className="space-y-2 border-t border-separator pt-3">
        {/* Auto-included-content hint */}
        <div className="text-caption text-label-tertiary">{t.diagnostic.uploadAutoIncludedHint}</div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Primary: upload to console */}
          <Button variant="primary" icon={AppIcons.upload} onClick={onUpload} busy={busy}>
            {t.diagnostic.uploadButton}
          </Button>
          {/* Secondary: export offline bundle */}
          <Button variant="secondary" icon={AppIcons.bundle} onClick={onExport} busy={busy}>
            {t.diagnostic.exportButton}
          </Button>
        </div>

        {/* What the form is doing, or has just done. The line keeps its height while it is
            empty, so nothing below it moves when the words appear. */}
        <div className="flex min-h-5 items-center">
          {uploadInProgress && <Spinner label={t.diagnostic.uploadInProgress} />}
          {!uploadInProgress && exportInProgress && <Spinner label={t.diagnostic.exportInProgress} />}
          {!busy && uploadDone && (
            <span role="status" className="inline-flex items-center gap-2 text-ui text-label-secondary">
              <StatusIcon tone="success" size="sm" />
              {t.diagnostic.uploadSuccess}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

// A required field that was left empty, said under the field after an upload was tried.
function RequiredError({ children }: { children: string }) {
  return (
    <p className="mt-1 flex items-center gap-1 text-ui-sm text-danger">
      <StatusIcon tone="danger" size="sm" />
      {children}
    </p>
  );
}
