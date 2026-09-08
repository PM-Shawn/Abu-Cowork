import { AlertTriangle, Ban, Check, CircleStop, FolderOpen, Globe, ShieldAlert, UserCheck, X } from 'lucide-react';
import { useI18n, format, type TranslationDict } from '@/i18n';
import type { Message } from '@/types';
import type {
  BrowserRunReportArtifact,
  BrowserRunReportOutcome,
  BrowserRunReportSnapshot,
} from '@/core/observability/browserRunReport';
import { rawCode, reasonLabel, stepLabel } from '@/core/observability/browserRunReportCopy';
import { formatBytes } from '@/core/permissions/browserUploadFiles';
import { usePreviewStore } from '@/stores/previewStore';

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
 *
 * The denial-reason and next-step wording lives in
 * `core/observability/browserRunReportCopy.ts`, not here: the IM summary this
 * run also sends (F7) quotes the very same codes, and one table is the only
 * way the card and that message cannot drift apart.
 */

/**
 * One downloaded file, opened the way every other file in this app is opened.
 *
 * The preview panel and 「在文件夹中显示」 are the mechanisms attachments and
 * workspace files already use (`FileAttachment.tsx`, `WorkspaceFileTree.tsx`)
 * — a card that grew its own file viewer would be a second answer to a
 * question this product has already answered.
 *
 * The name is page-influenceable (it comes from a `Content-Disposition`
 * header, sanitized by the host and clamped by the aggregator), so it is
 * rendered as PLAIN TEXT like every origin on this card — never as a link.
 */
function ArtifactRow({ artifact }: { artifact: BrowserRunReportArtifact }) {
  const { t } = useI18n();
  const tr = t.browserRunReport;
  const openPreview = usePreviewStore((s) => s.openPreview);
  const reveal = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
      await revealItemInDir(artifact.path);
    } catch { /* the desktop shell said no; the path is still on the row */ }
  };
  return (
    <li className="group/artifact flex items-baseline gap-2 text-minor">
      <button
        type="button"
        onClick={() => openPreview(artifact.path)}
        title={`${artifact.path}\n${tr.artifactOpenHint}`}
        className="min-w-0 flex-1 truncate text-left text-[var(--abu-text-primary)] hover:underline"
      >
        {artifact.name}
      </button>
      <span className="flex-shrink-0 text-caption text-[var(--abu-text-tertiary)]">
        {formatBytes(artifact.bytes)}
      </span>
      <button
        type="button"
        onClick={reveal}
        title={tr.artifactReveal}
        aria-label={tr.artifactReveal}
        className="flex-shrink-0 text-[var(--abu-text-tertiary)] opacity-0 transition-opacity group-hover/artifact:opacity-100 hover:text-[var(--abu-text-secondary)]"
      >
        <FolderOpen aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}

function outcomeLabel(outcome: BrowserRunReportOutcome, t: TranslationDict): string {
  const o = t.browserRunReport.outcome;
  switch (outcome) {
    case 'completed': return o.completed;
    case 'completed-with-refusals': return o.completedWithRefusals;
    case 'incomplete': return o.incomplete;
    case 'aborted-denials': return o.abortedDenials;
    case 'aborted': return o.aborted;
    case 'error': return o.error;
    case 'no-progress': return o.noProgress;
  }
  return rawCode(outcome);
}

function OutcomeIcon({ outcome }: { outcome: BrowserRunReportOutcome }) {
  const cls = 'h-3.5 w-3.5 flex-shrink-0';
  switch (outcome) {
    case 'completed':
      return <Check aria-hidden="true" className={`${cls} text-[var(--abu-success)]`} />;
    // Warning tone, not success green and not failure red: the run delivered,
    // but something it tried to change was refused. Same visual weight as
    // `incomplete`'s "possibly incomplete" flag; `Ban` because it is the icon
    // the blocked-actions section below already uses for the same fact.
    case 'completed-with-refusals':
      return <Ban aria-hidden="true" className={`${cls} text-[var(--abu-warning)]`} />;
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

/**
 * The rows themselves, shared by both forms of the card.
 *
 * Also rendered when the list is empty but something was dropped: a run that
 * produced one file whose path was too long to carry (`browserRunReport.ts`,
 * N3) must still say a file exists, not look like a run that downloaded
 * nothing.
 */
function ArtifactList({ report }: { report: BrowserRunReportSnapshot }) {
  const { t } = useI18n();
  const tr = t.browserRunReport;
  return (
    <>
      <ul className="space-y-0.5">
        {report.artifacts?.map((artifact) => (
          <ArtifactRow key={artifact.downloadId} artifact={artifact} />
        ))}
      </ul>
      {(report.omitted.artifacts ?? 0) > 0 && (
        <div className="mt-1 text-caption text-[var(--abu-text-tertiary)]">
          {format(tr.moreArtifacts, { count: String(report.omitted.artifacts) })}
        </div>
      )}
    </>
  );
}

function hasArtifacts(report: BrowserRunReportSnapshot): boolean {
  return (report.artifacts?.length ?? 0) > 0 || (report.omitted.artifacts ?? 0) > 0;
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

  /**
   * The ordinary-conversation form (acceptance F3): the files, and nothing
   * else. No outcome badge, no action count, no approval tally — the person
   * was sitting here while it happened, and everything this card would
   * otherwise say they already watched. The snapshot itself carries nothing
   * else either (`buildBrowserDownloadsReport`), so this is a rendering of
   * everything it has rather than a filtered view of more.
   */
  if (report.variant === 'downloads') {
    if (!hasArtifacts(report)) return null;
    return (
      <section
        className="my-2 rounded-lg border border-[var(--abu-border-subtle)] bg-[var(--abu-bg-muted)] overflow-hidden"
        aria-label={tr.artifactsTitle}
      >
        <header className="flex items-center gap-2 px-3 pt-2">
          <FolderOpen aria-hidden="true" className="h-3.5 w-3.5 flex-shrink-0 text-[var(--abu-text-muted)]" />
          <span className="text-h-xs text-[var(--abu-text-primary)]">{tr.artifactsTitle}</span>
        </header>
        <div className="px-3 py-2">
          <ArtifactList report={report} />
        </div>
      </section>
    );
  }

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
        {/*
          Automatic-task scripting is an OPT-IN (2026-09-04 ruling), off by
          default. When it is on, "code ran inside my logged-in session while I
          was asleep" is the fact this card most owes the reader — and it is
          the one thing every other line here would hide, since a script
          otherwise counts anonymously in `actions.total` next to a click.

          `?? 0` because the field is newer than the snapshots on disk: a card
          written before it existed must render as "no scripts", not as NaN.
        */}
        {(report.scriptRuns ?? 0) > 0 && (
          <div className="text-minor text-[var(--abu-text-secondary)] mt-0.5">
            {format(tr.scriptRuns, { count: String(report.scriptRuns) })}
          </div>
        )}
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

      {hasArtifacts(report) && (
        <Section title={tr.artifactsTitle}>
          <ArtifactList report={report} />
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
