import { Package, ChevronRight, ChevronDown, Loader2, Upload, Check } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';
import { useToastStore } from '@/stores/toastStore';
import { useDiagnosticStore } from '@/stores/diagnosticStore';
import { Toggle } from '@/components/ui/toggle';
import { Textarea } from '@/components/ui/textarea';
import { produceBundle, collectAndZip, type ProduceResult } from '@/core/diagnostic/bundle';
import { mapPermissionsError } from '@/core/diagnostic/errorMap';
import { uploadDiagnosticBundle } from '@/utils/consoleDiagnostic';

interface Props {
  onExportSuccess: (r: ProduceResult) => void;
  description: string;
  onDescriptionChange: (v: string) => void;
}

const BUNDLE_CONTENTS = [
  'meta.json',
  'diagnostic-snapshot.json',
  'conversation/messages.jsonl',
  'conversation/index-entry.json',
  'settings/settings.json',
  'settings/providers.json',
  'skills/installed.json',
  'mcp/servers.json',
  'permissions/capabilities.json',
  'permissions/grants.json',
  'README.txt',
];

export default function DiagnosticUpload({ onExportSuccess, description, onDescriptionChange }: Props) {
  const { t } = useI18n();
  const includeRawText = useDiagnosticStore((s) => s.includeRawText);
  const setIncludeRawText = useDiagnosticStore((s) => s.setIncludeRawText);
  const exportInProgress = useDiagnosticStore((s) => s.exportInProgress);
  const setExportInProgress = useDiagnosticStore((s) => s.setExportInProgress);
  const setLastExportPath = useDiagnosticStore((s) => s.setLastExportPath);
  const addToast = useToastStore((s) => s.addToast);

  const [includedExpanded, setIncludedExpanded] = useState(false);
  const [privacyExpanded, setPrivacyExpanded] = useState(false);
  const [uploadInProgress, setUploadInProgress] = useState(false);
  const [uploadDone, setUploadDone] = useState(false);

  const onToggleRaw = (next: boolean) => {
    setIncludeRawText(next);
    if (next) {
      addToast({ title: t.diagnostic.exportIncludeRawWarning, type: 'warning', duration: 4000 });
    }
  };

  const onUpload = async () => {
    if (uploadInProgress || exportInProgress) return;
    setUploadInProgress(true);
    setUploadDone(false);
    try {
      const { bytes, filename } = await collectAndZip({ includeRawText });
      await uploadDiagnosticBundle(bytes, filename, description.trim() || undefined);
      setUploadDone(true);
      setTimeout(() => setUploadDone(false), 4000);
      addToast({ title: t.diagnostic.uploadSuccess, type: 'success', duration: 3000 });
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
      const res = await produceBundle({ includeRawText });
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
    <section>
      <h3 className="text-[14px] font-medium text-[var(--abu-text-primary)] mb-1">
        {t.diagnostic.exportTitle}
      </h3>
      <p className="text-[12px] text-[var(--abu-text-tertiary)] mb-4">
        {t.diagnostic.exportDesc}
      </p>

      {/* Disclosure 1: bundle contents */}
      <button
        type="button"
        onClick={() => setIncludedExpanded((v) => !v)}
        className="w-full flex items-center gap-2 py-1.5 text-[12px] text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] transition-colors"
      >
        {includedExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span>{t.diagnostic.exportIncluded}</span>
      </button>
      {includedExpanded && (
        <div className="mb-2 pl-5 py-2 text-[11px] text-[var(--abu-text-tertiary)] bg-[var(--abu-bg-muted)] rounded-md">
          <div className="mb-1 font-medium">{t.diagnostic.exportIncludedListTitle}</div>
          <ul className="font-mono space-y-0.5">
            {BUNDLE_CONTENTS.map((f) => <li key={f}>· {f}</li>)}
          </ul>
        </div>
      )}

      {/* Disclosure 2: privacy */}
      <button
        type="button"
        onClick={() => setPrivacyExpanded((v) => !v)}
        className="w-full flex items-center gap-2 py-1.5 text-[12px] text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] transition-colors"
      >
        {privacyExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span>{t.diagnostic.exportPrivacy}</span>
      </button>
      {privacyExpanded && (
        <div className="mb-2 pl-5 py-2 text-[11px] text-[var(--abu-text-tertiary)] bg-[var(--abu-bg-muted)] rounded-md leading-relaxed">
          {t.diagnostic.exportPrivacyText}
        </div>
      )}

      {/* Raw text toggle */}
      <div className="mt-3 flex items-center justify-between py-2">
        <label htmlFor="diag-include-raw" className="text-[12px] text-[var(--abu-text-secondary)] flex-1">
          {t.diagnostic.exportIncludeRaw}
        </label>
        <Toggle
          checked={includeRawText}
          onChange={() => onToggleRaw(!includeRawText)}
          size="md"
        />
      </div>

      {/* Problem description textarea */}
      <div className="mt-3">
        <Textarea
          value={description}
          onChange={(e) => onDescriptionChange(e.target.value)}
          placeholder={t.diagnostic.uploadDescriptionPlaceholder}
          className="min-h-[72px] text-[12px] resize-none"
          disabled={uploadInProgress || exportInProgress}
        />
      </div>

      {/* Primary: upload to console */}
      <button
        type="button"
        onClick={onUpload}
        disabled={uploadInProgress || exportInProgress}
        className={cn(
          'mt-4 w-full py-2.5 rounded-lg text-[14px] font-medium transition-colors flex items-center justify-center gap-2',
          uploadDone
            ? 'bg-green-600/15 text-green-500 cursor-default'
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
        className="mt-2 w-full py-2 flex items-center justify-center gap-1.5 text-[12px] text-[var(--abu-text-muted)] hover:text-[var(--abu-text-secondary)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
    </section>
  );
}
