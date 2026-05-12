import { Package, ChevronRight, ChevronDown, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';
import { useToastStore } from '@/stores/toastStore';
import { useDiagnosticStore } from '@/stores/diagnosticStore';
import { Toggle } from '@/components/ui/toggle';
import { produceBundle, type ProduceResult } from '@/core/diagnostic/bundle';
import { mapPermissionsError } from '@/core/diagnostic/errorMap';

interface Props {
  onExportSuccess: (r: ProduceResult) => void;
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

export default function ExportPanel({ onExportSuccess }: Props) {
  const { t } = useI18n();
  const includeRawText = useDiagnosticStore((s) => s.includeRawText);
  const setIncludeRawText = useDiagnosticStore((s) => s.setIncludeRawText);
  const exportInProgress = useDiagnosticStore((s) => s.exportInProgress);
  const setExportInProgress = useDiagnosticStore((s) => s.setExportInProgress);
  const setLastExportPath = useDiagnosticStore((s) => s.setLastExportPath);
  const addToast = useToastStore((s) => s.addToast);

  const [includedExpanded, setIncludedExpanded] = useState(false);
  const [privacyExpanded, setPrivacyExpanded] = useState(false);

  const onToggleRaw = (next: boolean) => {
    setIncludeRawText(next);
    if (next) {
      addToast({ title: t.diagnostic.exportIncludeRawWarning, type: 'warning', duration: 4000 });
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
    <section className="border-t border-[var(--abu-border)] pt-6">
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

      {/* Export button */}
      <button
        type="button"
        onClick={onExport}
        disabled={exportInProgress}
        className={cn(
          'mt-4 w-full py-2.5 rounded-lg text-[14px] font-medium transition-colors flex items-center justify-center gap-2',
          'bg-[var(--abu-clay)] text-white hover:bg-[var(--abu-clay-hover)] disabled:opacity-50 disabled:cursor-not-allowed'
        )}
      >
        {exportInProgress ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            {t.diagnostic.exportInProgress}
          </>
        ) : (
          <>
            <Package className="h-4 w-4" />
            {t.diagnostic.exportButton}
          </>
        )}
      </button>
    </section>
  );
}
