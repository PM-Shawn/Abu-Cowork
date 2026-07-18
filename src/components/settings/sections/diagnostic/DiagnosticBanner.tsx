import { CheckCircle2, AlertTriangle, XCircle, Loader2, Activity, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n, format as i18nFormat } from '@/i18n';
import { useDiagnosticStore, getOverallStatus } from '@/stores/diagnosticStore';
import { formatRelativeTime } from '@/utils/messageTime';

const STYLES = {
  'all-passed': {
    bg: 'bg-[var(--abu-success-bg)] border-[var(--abu-success)] text-[var(--abu-success)]',
    icon: CheckCircle2,
    iconColor: 'text-[var(--abu-success)]',
  },
  'has-warnings': {
    bg: 'bg-[var(--abu-warning-bg)] border-[var(--abu-warning)] text-[var(--abu-warning)]',
    icon: AlertTriangle,
    iconColor: 'text-[var(--abu-warning)]',
  },
  'has-failures': {
    bg: 'bg-[var(--abu-danger-bg)] border-[var(--abu-danger)] text-[var(--abu-danger)]',
    icon: XCircle,
    iconColor: 'text-[var(--abu-danger)]',
  },
  'checking': {
    bg: 'bg-[var(--abu-clay-bg)] border-[var(--abu-clay-bg-15)] text-[var(--abu-text-primary)]',
    icon: Loader2,
    iconColor: 'text-[var(--abu-clay)]',
  },
  'no-data': {
    bg: 'bg-[var(--abu-bg-muted)] border-[var(--abu-border)] text-[var(--abu-text-tertiary)]',
    icon: Activity,
    iconColor: 'text-[var(--abu-text-muted)]',
  },
} as const;

export default function DiagnosticBanner() {
  const { t } = useI18n();
  const overall = useDiagnosticStore(getOverallStatus);
  const lastCheckedAt = useDiagnosticStore((s) => s.lastCheckedAt);
  const isChecking = useDiagnosticStore((s) => s.isChecking);
  const runAll = useDiagnosticStore((s) => s.runAll);
  const results = useDiagnosticStore((s) => s.results);

  const failCount = Object.values(results).filter((r) => r.status === 'failed').length;
  const warnCount = Object.values(results).filter((r) => r.status === 'warning').length;
  const totalCount = Object.values(results).length;

  const style = STYLES[overall];
  const Icon = style.icon;

  // While checking, surface what's already settled so the user sees progress
  // even if the AI-services probe (capped at ~8s) is still in flight.
  const checkingVerdict = totalCount > 0
    ? `${t.diagnostic.bannerChecking}（${totalCount}）`
    : t.diagnostic.bannerChecking;

  const verdict =
    overall === 'all-passed' ? t.diagnostic.bannerAllPassed :
    overall === 'has-warnings' ? i18nFormat(t.diagnostic.bannerHasWarnings, { n: warnCount }) :
    overall === 'has-failures' ? i18nFormat(t.diagnostic.bannerHasFailures, { n: failCount }) :
    overall === 'checking' ? checkingVerdict :
    t.diagnostic.bannerNoData;

  return (
    <div className={cn('rounded-lg border p-3 flex items-center gap-3', style.bg)}>
      <Icon className={cn('h-5 w-5 shrink-0', style.iconColor, overall === 'checking' && 'animate-spin')} />
      <div className="flex-1 min-w-0">
        <div className="text-h-sm font-medium">{verdict}</div>
        {lastCheckedAt && overall !== 'no-data' && (
          <div className="text-caption text-[var(--abu-text-muted)] mt-0.5">
            {i18nFormat(t.diagnostic.lastChecked, { when: formatRelativeTime(lastCheckedAt) })}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={runAll}
        disabled={isChecking}
        className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-minor font-medium bg-[var(--abu-bg-base)] border border-[var(--abu-border)] text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <RefreshCw className={cn('h-3.5 w-3.5', isChecking && 'animate-spin')} />
        {overall === 'no-data' ? t.diagnostic.runAll : t.diagnostic.runAllAgain}
      </button>
    </div>
  );
}
