import { AlertTriangle, Ban, Check, CircleStop, Globe, ShieldAlert, UserCheck, X } from 'lucide-react';
import { useI18n, format, type TranslationDict } from '@/i18n';
import type { Message } from '@/types';
import type {
  BrowserRunReportNextStep,
  BrowserRunReportOutcome,
  BrowserRunReportSnapshot,
} from '@/core/observability/browserRunReport';
import type { BrowserDenialReasonCode } from '@/core/permissions/browserToolPolicy';

/**
 * The one thing a person reads after an overnight unattended run.
 *
 * Everything it shows comes from `message.browserRunReport` — the snapshot
 * frozen when the run ended. It NEVER reads the signal buffer (Ruling 1): that
 * buffer holds 5000 entries and is empty after a restart, so a card that
 * re-derived itself would be blank exactly in the scenario this feature
 * exists for. If you are tempted to add a live lookup here, read
 * `browserRunReport.ts`'s header first.
 *
 * Every page-derived string (origins) is rendered as PLAIN TEXT (Ruling 3) —
 * no markdown, no HTML, no link. The aggregator already truncated and capped
 * them; this file must not undo that by, say, rendering an origin as an
 * anchor. The card's status — the badge, the counts, the master-switch line —
 * is read from local fields only, so a page cannot dress itself up into a
 * different verdict.
 */

function outcomeLabel(outcome: BrowserRunReportOutcome, t: TranslationDict): string {
  const o = t.browserRunReport.outcome;
  switch (outcome) {
    case 'completed': return o.completed;
    case 'incomplete': return o.incomplete;
    case 'aborted-denials': return o.abortedDenials;
    case 'aborted': return o.aborted;
    case 'error': return o.error;
    case 'no-progress': return o.noProgress;
  }
}

function OutcomeIcon({ outcome }: { outcome: BrowserRunReportOutcome }) {
  const cls = 'h-3.5 w-3.5 flex-shrink-0';
  switch (outcome) {
    case 'completed':
      return <Check aria-hidden="true" className={`${cls} text-[var(--abu-success)]`} />;
    case 'incomplete':
      return <AlertTriangle aria-hidden="true" className={`${cls} text-[var(--abu-warning)]`} />;
    case 'aborted-denials':
      return <ShieldAlert aria-hidden="true" className={`${cls} text-[var(--abu-warning)]`} />;
    case 'aborted':
      return <CircleStop aria-hidden="true" className={`${cls} text-[var(--abu-text-muted)]`} />;
    default:
      return <X aria-hidden="true" className={`${cls} text-[var(--abu-danger)]`} />;
  }
}

function reasonLabel(reason: BrowserDenialReasonCode, t: TranslationDict): string {
  const r = t.browserRunReport.reason;
  switch (reason) {
    case 'master-switch-off': return r.masterSwitchOff;
    case 'site-denied': return r.siteDenied;
    case 'high-risk-site': return r.highRiskSite;
    case 'policy-denied': return r.policyDenied;
    case 'capability-denied': return r.capabilityDenied;
    case 'origin-unverified': return r.originUnverified;
    case 'login-required': return r.loginRequired;
    case 'site-not-allowed': return r.siteNotAllowed;
    case 'approval-refused': return r.approvalRefused;
    case 'user-cancelled': return r.userCancelled;
  }
}

function stepLabel(step: BrowserRunReportNextStep, t: TranslationDict): string {
  const s = t.browserRunReport.step;
  switch (step) {
    case 'enable-master-switch': return s.enableMasterSwitch;
    case 'allow-site': return s.allowSite;
    case 'unblock-site': return s.unblockSite;
    case 'do-high-risk-yourself': return s.doHighRiskYourself;
    case 'sign-in-then-rerun': return s.signInThenRerun;
    case 'relax-policy': return s.relaxPolicy;
    case 'raise-capability': return s.raiseCapability;
    case 'answer-approval': return s.answerApproval;
    case 'run-while-watching': return s.runWhileWatching;
  }
}

/**
 * `classifyBrowserToolError`'s closed class set, humanized. An unrecognised
 * class falls back to its raw token rather than being dropped — a problem the
 * user cannot name is still a problem they should see.
 */
function errorClassLabel(errorClass: string, t: TranslationDict): string {
  const e = t.browserRunReport.errorClass;
  switch (errorClass) {
    case 'timeout': return e.timeout;
    case 'not_connected': return e.notConnected;
    case 'not_found': return e.notFound;
    case 'locator_ambiguous': return e.locatorAmbiguous;
    case 'aborted': return e.aborted;
    case 'unknown_error': return e.unknownError;
    default: return errorClass;
  }
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="px-3 py-2 border-t border-[var(--abu-border-subtle)]">
      <div className="text-caption text-[var(--abu-text-muted)] mb-1">{title}</div>
      {children}
    </div>
  );
}

/** Page-derived text. Rendered plain, wrapped so a long origin cannot push the
 *  card wide, and never as a link. */
function Origins({ origins }: { origins: string[] }) {
  if (origins.length === 0) return null;
  return (
    <div className="text-caption text-[var(--abu-text-tertiary)] break-all">
      {origins.join('  ·  ')}
    </div>
  );
}

export default function BrowserRunReportCard({ message }: { message: Message }) {
  const { t } = useI18n();
  const report: BrowserRunReportSnapshot | undefined = message.browserRunReport;
  // Defensive: `isBrowserRunReportMessage` already requires the payload, so
  // this only fires if a caller renders the card directly.
  if (!report) return null;

  const tr = t.browserRunReport;
  const { approvals } = report;
  const humanDecisions = approvals.approved + approvals.declined;
  const showApprovals =
    humanDecisions > 0 || approvals.timedOut > 0 || approvals.unreachable > 0;

  return (
    <section
      className="my-2 rounded-lg border border-[var(--abu-border-subtle)] bg-[var(--abu-bg-muted)] overflow-hidden"
      aria-label={tr.title}
    >
      <header className="flex items-center gap-2 px-3 py-2">
        <Globe aria-hidden="true" className="h-3.5 w-3.5 flex-shrink-0 text-[var(--abu-text-muted)]" />
        <span className="text-h-xs text-[var(--abu-text-primary)]">{tr.title}</span>
        <span className="flex items-center gap-1 ml-auto text-minor text-[var(--abu-text-secondary)]">
          <OutcomeIcon outcome={report.outcome} />
          {outcomeLabel(report.outcome, t)}
        </span>
      </header>

      {report.skippedByMasterSwitch && (
        <div className="mx-3 mb-2 flex items-start gap-2 rounded-md bg-[var(--abu-warning-bg)] px-2 py-1.5">
          <Ban aria-hidden="true" className="h-3.5 w-3.5 flex-shrink-0 mt-0.5 text-[var(--abu-warning)]" />
          <span className="text-minor text-[var(--abu-text-primary)]">{tr.masterSwitchOff}</span>
        </div>
      )}

      <div className="px-3 pb-2 text-body text-[var(--abu-text-secondary)]">
        {report.actions.total === 0
          ? tr.noActions
          : report.actions.failed > 0
            ? format(tr.actionsSummary, {
                total: String(report.actions.total),
                failed: String(report.actions.failed),
              })
            : format(tr.actionsSummaryClean, { total: String(report.actions.total) })}
        {report.blockedPages > 0 && (
          <div className="text-minor text-[var(--abu-text-tertiary)] mt-0.5">
            {format(tr.blockedPages, { count: String(report.blockedPages) })}
          </div>
        )}
      </div>

      {report.sites.length > 0 && (
        <Section title={tr.sitesTitle}>
          <ul className="space-y-0.5">
            {report.sites.map((site) => (
              <li key={site.origin} className="flex items-baseline gap-2 text-minor">
                <span className="text-[var(--abu-text-primary)] break-all">{site.origin}</span>
                <span className="ml-auto flex-shrink-0 text-caption text-[var(--abu-text-tertiary)]">
                  {site.failures > 0
                    ? format(tr.siteCounts, {
                        actions: String(site.actions),
                        failures: String(site.failures),
                      })
                    : format(tr.siteCountsClean, { actions: String(site.actions) })}
                </span>
              </li>
            ))}
          </ul>
          {report.omitted.sites > 0 && (
            <div className="mt-1 text-caption text-[var(--abu-text-tertiary)]">
              {format(tr.moreSites, { count: String(report.omitted.sites) })}
            </div>
          )}
        </Section>
      )}

      {report.denials.length > 0 && (
        <Section title={tr.deniedTitle}>
          <ul className="space-y-1">
            {report.denials.map((denial) => (
              <li key={denial.reason}>
                <div className="flex items-baseline gap-2 text-minor">
                  <Ban aria-hidden="true" className="h-3 w-3 flex-shrink-0 self-center text-[var(--abu-text-muted)]" />
                  <span className="text-[var(--abu-text-primary)]">{reasonLabel(denial.reason, t)}</span>
                  <span className="ml-auto flex-shrink-0 text-caption text-[var(--abu-text-tertiary)]">
                    {format(tr.occurrenceCount, { count: String(denial.count) })}
                  </span>
                </div>
                <div className="pl-5">
                  <Origins origins={denial.origins} />
                </div>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {report.problems.length > 0 && (
        <Section title={tr.problemsTitle}>
          <ul className="space-y-1">
            {report.problems.map((problem) => (
              <li key={problem.errorClass}>
                <div className="flex items-baseline gap-2 text-minor">
                  <span className="text-[var(--abu-text-primary)]">
                    {errorClassLabel(problem.errorClass, t)}
                  </span>
                  <span className="ml-auto flex-shrink-0 text-caption text-[var(--abu-text-tertiary)]">
                    {format(tr.occurrenceCount, { count: String(problem.count) })}
                  </span>
                </div>
                <Origins origins={problem.origins} />
              </li>
            ))}
          </ul>
          {report.omitted.problems > 0 && (
            <div className="mt-1 text-caption text-[var(--abu-text-tertiary)]">
              {format(tr.moreProblems, { count: String(report.omitted.problems) })}
            </div>
          )}
        </Section>
      )}

      {showApprovals && (
        <Section title={tr.approvalsTitle}>
          <div className="flex items-center gap-2 text-minor text-[var(--abu-text-primary)]">
            <UserCheck aria-hidden="true" className="h-3 w-3 flex-shrink-0 text-[var(--abu-text-muted)]" />
            {format(tr.approvalsSummary, {
              approved: String(approvals.approved),
              declined: String(approvals.declined),
            })}
          </div>
          {approvals.timedOut > 0 && (
            <div className="pl-5 text-caption text-[var(--abu-text-tertiary)]">
              {format(tr.approvalsTimeout, { count: String(approvals.timedOut) })}
            </div>
          )}
          {approvals.unreachable > 0 && (
            <div className="pl-5 text-caption text-[var(--abu-text-tertiary)]">
              {format(tr.approvalsUnreachable, { count: String(approvals.unreachable) })}
            </div>
          )}
          {approvals.lastDecisionAt !== undefined && (
            <div className="pl-5 text-caption text-[var(--abu-text-tertiary)]">
              {format(tr.approvalsLastDecision, {
                time: new Date(approvals.lastDecisionAt).toLocaleString(),
              })}
            </div>
          )}
        </Section>
      )}

      {report.nextSteps.length > 0 && (
        <Section title={tr.nextStepsTitle}>
          <ul className="space-y-1">
            {report.nextSteps.map((step) => (
              <li key={step} className="text-minor text-[var(--abu-text-primary)]">
                {stepLabel(step, t)}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </section>
  );
}
