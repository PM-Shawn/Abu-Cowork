import { CheckCircle2, XCircle, AlertTriangle, MinusCircle, Loader2, ExternalLink, RefreshCw, Copy, Check, ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';
import { useSettingsStore, type SystemSettingsTab } from '@/stores/settingsStore';
import { useCustomizeStore } from '@/stores/customizeStore';
import { useDiagnosticStore } from '@/stores/diagnosticStore';
import type { CheckResult, SuggestedAction } from '@/core/diagnostic/types';

const STATUS_ICON = {
  passed: CheckCircle2,
  failed: XCircle,
  warning: AlertTriangle,
  skipped: MinusCircle,
  checking: Loader2,
} as const;

const STATUS_COLOR = {
  passed: 'text-emerald-500',
  failed: 'text-red-500',
  warning: 'text-amber-500',
  skipped: 'text-[var(--abu-text-muted)]',
  checking: 'text-[var(--abu-clay)]',
} as const;

function ItemActions({ result }: { result: CheckResult }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const runItem = useDiagnosticStore((s) => s.runItem);
  const reRunning = useDiagnosticStore((s) => Boolean(s.reRunning[result.id]));

  const onCopyError = async () => {
    const text = `[diagnostic] ${result.category}/${result.name}: ${result.errorDetail ?? result.errorMessage ?? '(no detail)'}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };

  const onAction = (a: SuggestedAction) => {
    if (a.type === 'open-settings' && a.target) {
      useSettingsStore.getState().openSystemSettings(a.target as SystemSettingsTab);
    } else if (a.type === 'open-toolbox') {
      useCustomizeStore.getState().openCustomize('mcp');
    } else if (a.type === 'retry') {
      runItem(result.id);
    }
  };

  return (
    <div className="flex items-center gap-1 shrink-0">
      {result.suggestedAction && (
        <button
          onClick={() => onAction(result.suggestedAction!)}
          className="text-[11px] px-2 py-1 rounded-md text-[var(--abu-clay)] hover:bg-[var(--abu-clay-bg)] transition-colors flex items-center gap-1"
          title={result.suggestedAction.label}
        >
          <ExternalLink className="h-3 w-3" />
          {result.suggestedAction.label}
        </button>
      )}
      <button
        onClick={() => runItem(result.id)}
        disabled={reRunning}
        className="p-1 rounded-md text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)] transition-colors disabled:opacity-50"
        title={t.diagnostic.actionRecheck}
      >
        <RefreshCw className={cn('h-3 w-3', reRunning && 'animate-spin')} />
      </button>
      <button
        onClick={onCopyError}
        className="p-1 rounded-md text-[var(--abu-text-tertiary)] hover:text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)] transition-colors"
        title={t.diagnostic.actionCopyError}
      >
        {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
      </button>
    </div>
  );
}

export default function DiagnosticItem({ result }: { result: CheckResult }) {
  const { t } = useI18n();
  const reRunning = useDiagnosticStore((s) => Boolean(s.reRunning[result.id]));
  const [detailExpanded, setDetailExpanded] = useState(false);
  const status = reRunning ? 'checking' : result.status;
  const Icon = STATUS_ICON[status];
  const showActions = status === 'failed' || status === 'warning';
  const hasDetail = Boolean(
    result.errorDetail && result.errorDetail.trim() && result.errorDetail !== result.errorMessage
  );

  return (
    <li className="px-4 py-2.5 flex items-start gap-3 hover:bg-[var(--abu-bg-hover)] transition-colors group">
      <Icon
        className={cn('h-4 w-4 shrink-0 mt-0.5', STATUS_COLOR[status], status === 'checking' && 'animate-spin')}
        aria-label={status}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-[13px] text-[var(--abu-text-primary)]">{result.name}</span>
          {result.metric && (
            <span className="text-[11px] text-[var(--abu-text-muted)] tabular-nums">{result.metric}</span>
          )}
          {/* Inline friendly error — same row as title to mirror the passed-state
              "name + metric" rhythm. Color shift (primary → red/amber) carries
              the visual segmentation; no explicit separator needed. */}
          {(status === 'failed' || status === 'warning') && result.errorMessage && (
            <span className={cn(
              'text-[12px] break-words',
              status === 'failed' ? 'text-red-600/90' : 'text-amber-600/90'
            )}>
              {result.errorMessage}
            </span>
          )}
        </div>
        {/* Folded raw error — exits for tech-savvy users without spamming the casual flow */}
        {hasDetail && (status === 'failed' || status === 'warning') && (
          <>
            <button
              type="button"
              onClick={() => setDetailExpanded((v) => !v)}
              className="mt-1 inline-flex items-center gap-1 text-[11px] text-[var(--abu-text-muted)] hover:text-[var(--abu-text-tertiary)] transition-colors"
            >
              {detailExpanded
                ? <ChevronDown className="h-3 w-3" />
                : <ChevronRight className="h-3 w-3" />
              }
              {detailExpanded ? t.diagnostic.detailHide : t.diagnostic.detailShow}
            </button>
            {detailExpanded && (
              <pre className="mt-1 px-2 py-1.5 rounded text-[11px] font-mono text-[var(--abu-text-tertiary)] bg-[var(--abu-bg-muted)] whitespace-pre-wrap break-all max-h-48 overflow-auto">
                {result.errorDetail}
              </pre>
            )}
          </>
        )}
      </div>
      {showActions && (
        <div className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          <ItemActions result={result} />
        </div>
      )}
    </li>
  );
}
