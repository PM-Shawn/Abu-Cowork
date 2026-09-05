/**
 * How an unattended run ENDED, in one object both surfaces read.
 *
 * ## The gap this closes (external review F7)
 *
 * A scheduled task runs at 9am while nobody is at the machine. Until now the
 * IM channel the user bound to that task heard from it in exactly one case:
 * the run reached a delivering terminal (`completed` / `max_turns`). Every
 * other ending — stopped, errored, no progress, or blocked by the browser
 * gate — pushed nothing at all (`scheduler.ts`'s `else` branch and its outer
 * `catch` only raised a DESKTOP notification, which is precisely what nobody
 * is standing in front of). In IM, "the task failed" and "the task never ran"
 * looked identical: silence.
 *
 * And the two things that DID exist described the run from two different
 * sources — the IM push extracted the conversation's last assistant text
 * (`outputSender`, `extractMode: 'last_message'`), while the report card
 * aggregated the browser signal buffer (`browserRunReport.ts`). Same run, two
 * vocabularies, no way to keep them honest with each other.
 *
 * ## What this module is
 *
 * A pure derivation: (terminal reason, abort cause, the run's report
 * snapshot) → one `UnattendedRunOutcome`. The snapshot it reads is the SAME
 * object the card renders, built once per run, so "the card and the IM
 * summary agree" is a structural property here rather than a promise: there is
 * only one aggregation, and this is a function of it.
 *
 * ## Deliberately NOT here
 *
 * - **No raw error text.** `AgentLoopResult.error` and tool error bodies can
 *   quote page content; this summary carries only closed codes, counts and
 *   the origins the aggregator already clamped (`browserRunReport.ts`,
 *   Ruling 3). A page cannot write itself into an IM message this way.
 * - **No re-derivation of the card's badge.** The card keeps its own
 *   seven-value vocabulary, which distinguishes facts this coarser
 *   product-level taxonomy deliberately merges (`incomplete` is the card's
 *   ONLY carrier of "hit the turn cap"). This taxonomy answers the question a
 *   person asks in IM — did it work, and if not, what do I do — and the card
 *   answers "what exactly happened". Both read the one snapshot.
 * - **No artifact links.** Nothing in the run produces an addressable
 *   artifact today (a run's output is conversation text and, for browser
 *   work, the card). A field nobody can populate is schema debt that looks
 *   like a feature; add it with its first producer.
 */
import { format, type TranslationDict } from '../../i18n';
import type { BrowserDenialReasonCode } from '../permissions/browserToolPolicy';
import type { BrowserRunReportNextStep, BrowserRunReportSnapshot } from './browserRunReport';
import { reasonLabel, rawCode, stepLabel } from './browserRunReportCopy';

/**
 * The endings a person cares about, at the altitude they care about them.
 *
 * Coarser than `BrowserRunReportOutcome` on purpose — see the module header.
 */
export type UnattendedOutcomeCode =
  /** Delivered, nothing refused, nothing failed. */
  | 'succeeded'
  /** Delivered, but something was refused or failed along the way — or the
   *  run hit the turn cap and the answer may be half of one. */
  | 'partial'
  /** Nothing got through: the gate refused everything it was asked to do, or
   *  the consecutive-denial guard stopped the run. */
  | 'blocked'
  /** Ended in an error. */
  | 'failed'
  /** A person pressed Stop. */
  | 'stopped'
  /** The model produced no usable tool calls. */
  | 'no-progress';

export interface UnattendedRunOutcome {
  code: UnattendedOutcomeCode;
  /** What the run actually got done, in local counts only. */
  did: {
    actions: number;
    failed: number;
    scriptRuns: number;
    /** Origins the aggregator already clamped and capped. */
    sites: string[];
  };
  /** How many actions the gate refused — "what did NOT get done". */
  denied: number;
  /** Where it got stuck, as a closed code. Absent when nothing was refused. */
  blockedReason?: BrowserDenialReasonCode;
  /** The origins that refusal happened on (already clamped and capped). */
  blockedOrigins: string[];
  /** The card's「接下来可以做什么」list, verbatim — same codes, same order. */
  nextSteps: BrowserRunReportNextStep[];
}

export interface DeriveUnattendedRunOutcomeInput {
  /** `AgentLoopResult.reason`, verbatim. */
  reason: string;
  /** `abortCause === BROWSER_DENIAL_ABORT_CAUSE` — the run stopped ITSELF. */
  abortedByBrowserDenials: boolean;
  /** This run's report snapshot, or `null` when it never touched a browser. */
  report: BrowserRunReportSnapshot | null;
}

/** The terminals that hand the user an answer. Mirrors both engines' branch. */
function delivered(reason: string): boolean {
  return reason === 'completed' || reason === 'max_turns';
}

/**
 * The refusal to lead with.
 *
 * `skippedByMasterSwitch` wins over the busiest denial row: when the master
 * switch is off EVERY browser call is refused for that one reason, and it is
 * also the only reason on this list a user can be certain they can fix in one
 * click. Otherwise take the top row — `buildBrowserRunReport` already sorted
 * denials by count desc, then code, so this is a total order and two runs with
 * identical data always summarize identically.
 */
function leadingDenial(
  report: BrowserRunReportSnapshot,
): { reason: BrowserDenialReasonCode; origins: string[] } | undefined {
  if (report.skippedByMasterSwitch) {
    const row = report.denials.find((d) => d.reason === 'master-switch-off');
    return { reason: 'master-switch-off', origins: row?.origins ?? [] };
  }
  const top = report.denials[0];
  return top ? { reason: top.reason, origins: top.origins } : undefined;
}

/**
 * Terminal reason + report → the one outcome object both surfaces read.
 *
 * Pure: no clock, no store, no I/O.
 */
export function deriveUnattendedRunOutcome(
  input: DeriveUnattendedRunOutcomeInput,
): UnattendedRunOutcome {
  const { reason, abortedByBrowserDenials, report } = input;
  const denials = report?.denials ?? [];
  const denied = denials.reduce((sum, row) => sum + row.count, 0);
  const lead = report ? leadingDenial(report) : undefined;

  let code: UnattendedOutcomeCode;
  if (!delivered(reason)) {
    // A run that stopped ITSELF after consecutive refusals is blocked, not
    // cancelled: the user did not choose this, the gate did, and the two need
    // different sentences (and different next steps).
    code = abortedByBrowserDenials
      ? 'blocked'
      : reason === 'aborted'
        ? 'stopped'
        : reason === 'no_progress'
          ? 'no-progress'
          : 'failed';
  } else if (denials.length > 0 && (report?.actions.total ?? 0) === 0) {
    // Delivering terminal, but the browser side got nowhere at all — the
    // "task looks green while doing nothing" case the master-switch line was
    // added for, generalized to every refusal reason.
    code = 'blocked';
  } else if (denials.length > 0 || (report?.actions.failed ?? 0) > 0 || reason === 'max_turns') {
    code = 'partial';
  } else {
    code = 'succeeded';
  }

  return {
    code,
    did: {
      actions: report?.actions.total ?? 0,
      failed: report?.actions.failed ?? 0,
      scriptRuns: report?.scriptRuns ?? 0,
      sites: report?.sites.map((site) => site.origin) ?? [],
    },
    denied,
    ...(lead ? { blockedReason: lead.reason } : {}),
    blockedOrigins: lead?.origins ?? [],
    nextSteps: report?.nextSteps ?? [],
  };
}

function outcomeLabel(code: UnattendedOutcomeCode, blockedByMasterSwitch: boolean, t: TranslationDict): string {
  const o = t.unattendedRun.outcome;
  switch (code) {
    case 'succeeded': return o.succeeded;
    case 'partial': return o.partial;
    // "未运行" rather than "未完成" when the master switch is off: nothing was
    // attempted, and telling someone a run fell short when it never started
    // sends them looking for the wrong problem.
    case 'blocked': return blockedByMasterSwitch ? o.notRun : o.blocked;
    case 'failed': return o.failed;
    case 'stopped': return o.stopped;
    case 'no-progress': return o.noProgress;
  }
  return rawCode(code);
}

/**
 * The one-line (occasionally two-line) summary that goes out over IM.
 *
 * Shape, deliberately: `结局：原因（站点）` and, when the run left something
 * for the user to do, a second line `接下来：…` taken from the card's own
 * next-step table. A successful run gets the label alone — it is prepended to
 * an answer the user asked for, and nobody wants three lines of preamble on a
 * report that worked.
 *
 * Pure function of (outcome, dict). Contains no page text: every part is a
 * closed code's translation, a local count, or an origin the aggregator
 * already clamped.
 */
export function formatUnattendedOutcomeSummary(
  outcome: UnattendedRunOutcome,
  t: TranslationDict,
): string {
  const u = t.unattendedRun;
  const byMasterSwitch = outcome.blockedReason === 'master-switch-off';
  const label = outcomeLabel(outcome.code, byMasterSwitch, t);

  let detail = '';
  if (outcome.blockedReason) {
    const reason = reasonLabel(outcome.blockedReason, t);
    detail = outcome.blockedOrigins.length > 0
      ? format(u.detailWithOrigins, { reason, origins: outcome.blockedOrigins.join('、') })
      : reason;
  } else if (outcome.did.failed > 0) {
    detail = format(u.detailActionsFailed, {
      failed: String(outcome.did.failed),
      total: String(outcome.did.actions),
    });
  } else if (outcome.code !== 'succeeded') {
    detail = u.detailNothingDelivered;
  }

  const first = detail ? format(u.summaryWithDetail, { label, detail }) : label;
  const step = outcome.code === 'succeeded' ? undefined : outcome.nextSteps[0];
  return step ? `${first}\n${format(u.nextStep, { step: stepLabel(step, t) })}` : first;
}
