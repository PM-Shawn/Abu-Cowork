import { CheckCircle2, AlertTriangle, XCircle, Loader2, Activity, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n, format as i18nFormat } from '@/i18n';
import { useDiagnosticStore, getOverallStatus } from '@/stores/diagnosticStore';
import { formatRelativeTime } from '@/utils/messageTime';

const STYLES = {
  'all-passed': {
    bg: 'bg-emerald-50 border-emerald-200 text-emerald-900',
    icon: CheckCircle2,
    iconColor: 'text-emerald-600',
  },
  'has-warnings': {
    bg: 'bg-amber-50 border-amber-200 text-amber-900',
    icon: AlertTriangle,
    iconColor: 'text-amber-600',
  },
  'has-failures': {
    bg: 'bg-red-50 border-red-200 text-red-900',
    icon: XCircle,
    iconColor: 'text-red-600',
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
        <div className="text-[14px] font-medium">{verdict}</div>
        {lastCheckedAt && overall !== 'no-data' && (
          <div className="text-[11px] text-[var(--abu-text-muted)] mt-0.5">
            {i18nFormat(t.diagnostic.lastChecked, { when: formatRelativeTime(lastCheckedAt) })}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={runAll}
        disabled={isChecking}
        className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] font-medium bg-white border border-[var(--abu-border)] text-[var(--abu-text-primary)] hover:bg-[var(--abu-bg-hover)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <RefreshCw className={cn('h-3.5 w-3.5', isChecking && 'animate-spin')} />
        {overall === 'no-data' ? t.diagnostic.runAll : t.diagnostic.runAllAgain}
      </button>
    </div>
  );
}
