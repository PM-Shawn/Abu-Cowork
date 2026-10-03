import { Button } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { AppIcons } from '@/components/ds/icons';
import { Spinner } from '@/components/ds/spinner';
import { StatusIcon } from '@/components/ds/status-icon';
import { cn } from '@/lib/utils';
import { useI18n, format as i18nFormat } from '@/i18n';
import { useDiagnosticStore, getOverallStatus } from '@/stores/diagnosticStore';
import { formatRelativeTime } from '@/utils/messageTime';

const SURFACE = {
  'all-passed': 'bg-success-soft',
  'has-warnings': 'bg-warning-soft',
  'has-failures': 'bg-danger-soft',
  'checking': 'bg-fill',
  'no-data': 'bg-fill',
} as const;

const TONE = {
  'all-passed': 'success',
  'has-warnings': 'warning',
  'has-failures': 'danger',
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
    <div className={cn('flex items-center gap-3 rounded-panel p-3', SURFACE[overall])}>
      {overall === 'no-data' && <Icon icon={AppIcons.diagnostic} size="lg" className="text-label-tertiary" />}
      {overall !== 'no-data' && overall !== 'checking' && <StatusIcon tone={TONE[overall]} size="lg" />}
      <div className="min-w-0 flex-1">
        {/* The one moving indicator of the page: the rows show a still icon while they are checked. */}
        {overall === 'checking'
          ? <Spinner label={verdict} />
          : <div className="text-ui font-medium text-label">{verdict}</div>}
        {lastCheckedAt && overall !== 'no-data' && (
          <div className="mt-1 text-caption text-label-secondary">
            {i18nFormat(t.diagnostic.lastChecked, { when: formatRelativeTime(lastCheckedAt) })}
          </div>
        )}
      </div>
      <Button variant="secondary" size="sm" icon={AppIcons.retry} onClick={runAll} disabled={isChecking}>
        {overall === 'no-data' ? t.diagnostic.runAll : t.diagnostic.runAllAgain}
      </Button>
    </div>
  );
}
