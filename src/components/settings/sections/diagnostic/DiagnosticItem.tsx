import { useState } from 'react';
import { Button, IconButton } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Pressable } from '@/components/ds/pressable';
import { StatusIcon } from '@/components/ds/status-icon';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';
import { useSettingsStore, type SystemSettingsTab } from '@/stores/settingsStore';
import { useCustomizeStore } from '@/stores/customizeStore';
import { useDiagnosticStore } from '@/stores/diagnosticStore';
import type { CheckResult, CheckStatus, SuggestedAction } from '@/core/diagnostic/types';

const STATUS_TONE = { passed: 'success', failed: 'danger', warning: 'warning' } as const;

// A check that is running shows a still icon: the summary at the top of the page holds the one
// indicator that turns.
function StatusMark({ status }: { status: CheckStatus }) {
  return (
    <span aria-label={status} className="flex h-5 shrink-0 items-center">
      {status === 'checking' && <Icon icon={AppIcons.loading} className="text-label-secondary" />}
      {status === 'skipped' && <Icon icon={AppIcons.notChecked} className="text-label-tertiary" />}
      {status !== 'checking' && status !== 'skipped' && <StatusIcon tone={STATUS_TONE[status]} />}
    </span>
  );
}

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
    <div className="flex shrink-0 items-center gap-1">
      {result.suggestedAction && (
        <Button
          variant="secondary"
          size="sm"
          icon={AppIcons.openExternal}
          onClick={() => onAction(result.suggestedAction!)}
          title={result.suggestedAction.label}
        >
          {result.suggestedAction.label}
        </Button>
      )}
      <IconButton
        size="sm"
        icon={AppIcons.retry}
        label={t.diagnostic.actionRecheck}
        onClick={() => runItem(result.id)}
        disabled={reRunning}
      />
      <IconButton
        size="sm"
        icon={copied ? AppIcons.done : AppIcons.copy}
        label={t.diagnostic.actionCopyError}
        onClick={onCopyError}
      />
    </div>
  );
}

export default function DiagnosticItem({ result }: { result: CheckResult }) {
  const { t } = useI18n();
  const reRunning = useDiagnosticStore((s) => Boolean(s.reRunning[result.id]));
  const [detailExpanded, setDetailExpanded] = useState(false);
  const status = reRunning ? 'checking' : result.status;
  const showActions = status === 'failed' || status === 'warning';
  const hasDetail = Boolean(
    result.errorDetail && result.errorDetail.trim() && result.errorDetail !== result.errorMessage
  );

  return (
    <li className="group flex items-start gap-3 px-4 py-2 transition-colors duration-fast hover:bg-fill-hover">
      <StatusMark status={status} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-ui text-label">{result.name}</span>
          {result.metric && (
            <span className="text-caption tabular-nums text-label-tertiary">{result.metric}</span>
          )}
          {/* Inline friendly error — same row as title to mirror the passed-state
              "name + metric" rhythm. The status mark at the start of the row says
              which kind it is; the color repeats it. */}
          {(status === 'failed' || status === 'warning') && result.errorMessage && (
            <span className={cn(
              'break-words text-ui-sm',
              status === 'failed' ? 'text-danger' : 'text-warning'
            )}>
              {result.errorMessage}
            </span>
          )}
        </div>
        {/* Folded raw error — exits for tech-savvy users without spamming the casual flow */}
        {hasDetail && (status === 'failed' || status === 'warning') && (
          <>
            <Pressable
              onClick={() => setDetailExpanded((v) => !v)}
              aria-expanded={detailExpanded}
              className="mt-1 inline-flex items-center gap-1 rounded-control text-caption text-label-tertiary hover:text-label-secondary"
            >
              <Icon icon={detailExpanded ? AppIcons.expand : AppIcons.disclose} size="sm" />
              {detailExpanded ? t.diagnostic.detailHide : t.diagnostic.detailShow}
            </Pressable>
            {detailExpanded && (
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-control bg-fill p-2 font-code text-caption text-label-secondary">
                {result.errorDetail}
              </pre>
            )}
          </>
        )}
      </div>
      {showActions && (
        <div className="opacity-0 transition-opacity duration-fast group-hover:opacity-100 group-focus-within:opacity-100">
          <ItemActions result={result} />
        </div>
      )}
    </li>
  );
}
