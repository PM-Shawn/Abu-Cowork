import { memo } from 'react';
import { useI18n, format, type TranslationDict } from '@/i18n';
import { IconButton } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { AppIcons, type AppIconName } from '@/components/ds/icons';
import { InlineMessage } from '@/components/ds/inline-message';
import { Pressable } from '@/components/ds/pressable';
import { StatusIcon } from '@/components/ds/status-icon';
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
    <li className="group/artifact flex items-center gap-2 text-ui-sm">
      <Pressable
        onClick={() => openPreview(artifact.path)}
        title={`${artifact.path}\n${tr.artifactOpenHint}`}
        className="min-w-0 flex-1 truncate rounded-control text-left text-label hover:underline"
      >
        {artifact.name}
      </Pressable>
      <span className="shrink-0 text-caption text-label-tertiary">
        {formatBytes(artifact.bytes)}
      </span>
      <IconButton
        size="sm"
        icon={AppIcons.folderOpen}
        label={tr.artifactReveal}
        onClick={reveal}
        className="opacity-0 group-hover/artifact:opacity-100 focus-visible:opacity-100"
      />
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
  switch (outcome) {
    case 'completed':
      return <StatusIcon tone="success" size="sm" />;
    // Warning tone, not success green and not failure red: the run delivered,
    // but something it tried to change was refused. Same visual weight as
    // `incomplete`'s "possibly incomplete" flag; `block` because it is the icon
    // the blocked-actions section below already uses for the same fact.
    case 'completed-with-refusals':
      return <Icon icon={AppIcons.block} size="sm" className="text-warning" />;
    case 'incomplete':
      return <StatusIcon tone="warning" size="sm" />;
    case 'aborted-denials':
      return <Icon icon={AppIcons.shield} size="sm" className="text-warning" />;
    case 'aborted':
      return <Icon icon={AppIcons.stopped} size="sm" className="text-label-tertiary" />;
    default:
      return <StatusIcon tone="danger" size="sm" />;
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
      <ul className="space-y-1">
        {report.artifacts?.map((artifact) => (
          <ArtifactRow key={artifact.downloadId} artifact={artifact} />
        ))}
      </ul>
      {(report.omitted.artifacts ?? 0) > 0 && (
        <div className="mt-1 text-caption text-label-tertiary">
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
    <div className="border-t border-separator px-3 py-2">
      <div className="mb-1 text-ui-sm font-medium text-label-tertiary">{title}</div>
      {children}
    </div>
  );
}

/** Page-derived text. Rendered plain, wrapped so a long origin cannot push the
 *  card wide, and never as a link. */
function Origins({ origins }: { origins: string[] }) {
  if (origins.length === 0) return null;
  return (
    <div className="break-all text-caption text-label-tertiary">
      {origins.join('  ·  ')}
    </div>
  );
}

/** A row's leading icon, in a 16px box so the lines under it can indent by pl-6. */
function LeadIcon({ name }: { name: AppIconName }) {
  return (
    <span className="flex w-4 shrink-0 justify-center self-center">
      <Icon icon={AppIcons[name]} size="sm" className="text-label-tertiary" />
    </span>
  );
}

// ChatView re-renders every visible group on each streamed token; the card's
// message does not change, so memo keeps the reveal button's tooltip still.
export default memo(function BrowserRunReportCard({ message }: { message: Message }) {
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
        className="my-2 overflow-hidden rounded-panel border border-separator bg-surface"
        aria-label={tr.artifactsTitle}
      >
        <header className="flex items-center gap-2 px-3 pt-2">
          <Icon icon={AppIcons.folderOpen} size="sm" className="text-label-secondary" />
          <span className="text-ui font-medium text-label">{tr.artifactsTitle}</span>
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
      className="my-2 overflow-hidden rounded-panel border border-separator bg-surface"
      aria-label={tr.title}
    >
      <header className="flex items-center gap-2 px-3 py-2">
        <Icon icon={AppIcons.webPage} size="sm" className="text-label-secondary" />
        <span className="text-ui font-medium text-label">{tr.title}</span>
        <span className="ml-auto flex items-center gap-1 text-ui-sm text-label-secondary">
          <OutcomeIcon outcome={report.outcome} />
          {outcomeLabel(report.outcome, t)}
        </span>
      </header>

      {report.skippedByMasterSwitch && (
        <div className="mx-3 mb-2">
          <InlineMessage tone="warning">{tr.masterSwitchOff}</InlineMessage>
        </div>
      )}

      <div className="px-3 pb-2 text-ui text-label-secondary">
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
          <div className="mt-1 text-ui-sm text-label-secondary">
            {format(tr.scriptRuns, { count: String(report.scriptRuns) })}
          </div>
        )}
        {report.blockedPages > 0 && (
          <div className="mt-1 text-ui-sm text-label-tertiary">
            {format(tr.blockedPages, { count: String(report.blockedPages) })}
          </div>
        )}
      </div>

      {report.sites.length > 0 && (
        <Section title={tr.sitesTitle}>
          <ul className="space-y-1">
            {report.sites.map((site) => (
              <li key={site.origin} className="flex items-baseline gap-2 text-ui-sm">
                <span className="break-all text-label">{site.origin}</span>
                <span className="ml-auto shrink-0 text-caption text-label-tertiary">
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
            <div className="mt-1 text-caption text-label-tertiary">
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
                <div className="flex items-baseline gap-2 text-ui-sm">
                  <LeadIcon name="block" />
                  <span className="text-label">{reasonLabel(denial.reason, t)}</span>
                  <span className="ml-auto shrink-0 text-caption text-label-tertiary">
                    {format(tr.occurrenceCount, { count: String(denial.count) })}
                  </span>
                </div>
                <div className="pl-6">
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
                <div className="flex items-baseline gap-2 text-ui-sm">
                  <span className="text-label">
                    {errorClassLabel(problem.errorClass, t)}
                  </span>
                  <span className="ml-auto shrink-0 text-caption text-label-tertiary">
                    {format(tr.occurrenceCount, { count: String(problem.count) })}
                  </span>
                </div>
                <Origins origins={problem.origins} />
              </li>
            ))}
          </ul>
          {report.omitted.problems > 0 && (
            <div className="mt-1 text-caption text-label-tertiary">
              {format(tr.moreProblems, { count: String(report.omitted.problems) })}
            </div>
          )}
        </Section>
      )}

      {showApprovals && (
        <Section title={tr.approvalsTitle}>
          <div className="flex items-baseline gap-2 text-ui-sm text-label">
            <LeadIcon name="userCheck" />
            {format(tr.approvalsSummary, {
              approved: String(approvals.approved),
              declined: String(approvals.declined),
            })}
          </div>
          {approvals.timedOut > 0 && (
            <div className="pl-6 text-caption text-label-tertiary">
              {format(tr.approvalsTimeout, { count: String(approvals.timedOut) })}
            </div>
          )}
          {approvals.unreachable > 0 && (
            <div className="pl-6 text-caption text-label-tertiary">
              {format(tr.approvalsUnreachable, { count: String(approvals.unreachable) })}
            </div>
          )}
          {approvals.lastDecisionAt !== undefined && (
            <div className="pl-6 text-caption text-label-tertiary">
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
              <li key={step} className="text-ui-sm text-label">
                {stepLabel(step, t)}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </section>
  );
});
