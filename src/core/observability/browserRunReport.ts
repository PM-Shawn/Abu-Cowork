/**
 * The unattended task report — pure aggregation, no I/O, no clock.
 *
 * ## What this is for
 *
 * A scheduled task ran at 3am. At 8am the user opens the conversation and has
 * exactly four questions: did it work / where did it go / was anything blocked
 * / if it failed, what do I do now. Everything else in the unattended feature
 * either works silently or refuses silently; this is the one surface a person
 * actually reads. An empty or stale card reads as "it did nothing all night".
 *
 * ## Ruling 1 — the output is a SNAPSHOT, never a live query
 *
 * `browserSignals.ts`'s buffer is in-memory, capped at 5000 entries, and gone
 * on restart. A card that re-derived itself at render time would therefore be
 * blank the next morning (restart) or hollowed out by a later busy run
 * (eviction) — in the one scenario the feature exists for. So the caller
 * builds this snapshot once, at run end, and stores it IN the message
 * (`Message.browserRunReport`). Nothing in the render path may read the
 * buffer.
 *
 * This repo has already paid for the same mistake once: tool-result images
 * displayed during execution and went blank after, because the snapshot DTO
 * dropped a field. Hence the deliberately flat, fully serializable shape below
 * and the round-trip assertion in the tests.
 *
 * ## Ruling 2 — the slice is "this run", not "this conversation"
 *
 * A conversation can host more than one run (a person types a follow-up into a
 * scheduled task's conversation; an IM session is long-lived). Slicing by
 * conversation alone would put yesterday's actions in today's report, which is
 * worse than no report.
 *
 * The run window is `seq > sinceSeq` ∧ `conversationId === <this run's>`:
 * - `seq` is a process-monotonic counter stamped by `recordBrowserSignal`, so
 *   the boundary survives clock skew, DST and NTP steps, which a timestamp
 *   window would not.
 * - the conversation predicate keeps concurrent runs in OTHER conversations
 *   out, and it is an equality test against a non-empty id, so a signal with
 *   NO conversationId can never be attributed to anyone.
 *
 * ## Ruling 3 — every page-derived string is untrusted data
 *
 * `origin` is derived from a URL the model was steered to by page content;
 * `errorClass` is a closed classifier vocabulary but is treated with the same
 * caution. Both are length-capped and row-capped here, and the card renders
 * them as plain text. No structural conclusion in this snapshot — outcome,
 * counts, `skippedByMasterSwitch`, `nextSteps` — is ever derived from one of
 * them: those come from the run's own terminal reason and from the gate's
 * closed reason codes. A page that titles itself "✓ approved by user" gets one
 * ordinary truncated text row and changes nothing.
 */
import type { Message } from '../../types';
import type { BrowserDenialReasonCode } from '../permissions/browserToolPolicy';
import type { StoredBrowserSignalRecord } from './browserSignals';

/** Bump only with a migration path in `browserRunReportSnapshot` consumers. */
export const BROWSER_RUN_REPORT_SNAPSHOT_VERSION = 1;

/** Longest page-derived string kept in a row. */
export const MAX_REPORT_ORIGIN_LENGTH = 120;
/** Longest classifier string kept in a row (defence in depth — the classifier
 *  vocabulary is closed, so this should never bite). */
export const MAX_REPORT_ERROR_CLASS_LENGTH = 64;
export const MAX_REPORT_SITES = 8;
export const MAX_REPORT_PROBLEMS = 5;
export const MAX_REPORT_ORIGINS_PER_ROW = 3;

/**
 * How the run ended, in the report's own vocabulary.
 *
 * Derived by the CALLER from the agent loop's terminal reason (and, for
 * `aborted-denials`, from `AgentLoopResult.abortCause`) — never from anything
 * a page said. See `browserRunReportOutcomeFor`.
 */
export type BrowserRunReportOutcome =
  | 'completed'
  /** Hit the turn cap — output delivered but possibly incomplete. */
  | 'incomplete'
  /** U4's consecutive-denial guard stopped the run itself. */
  | 'aborted-denials'
  /** Stopped for another reason (a person pressed Stop). */
  | 'aborted'
  | 'error'
  | 'no-progress';

export interface BrowserRunReportSite {
  origin: string;
  actions: number;
  failures: number;
}

export interface BrowserRunReportDenial {
  reason: BrowserDenialReasonCode;
  count: number;
  origins: string[];
}

export interface BrowserRunReportProblem {
  errorClass: string;
  count: number;
  origins: string[];
}

export interface BrowserRunReportApprovals {
  approved: number;
  declined: number;
  timedOut: number;
  /** Nobody could be asked: no IM binding, too many outstanding, undelivered,
   *  or the run was stopped while a prompt was live. */
  unreachable: number;
  /** When the first/last actual human decision landed (approve or decline).
   *  Absent when no human decided anything. */
  firstDecisionAt?: number;
  lastDecisionAt?: number;
}

/**
 * A machine code for "what the user should do now", localized at render time.
 *
 * Codes, not sentences: the snapshot is persisted, and a user who switches the
 * app to English must not be left with a Chinese card frozen into their
 * history. This keeps Ruling 1 (the aggregation is frozen) while letting the
 * wording follow the current locale.
 */
export type BrowserRunReportNextStep =
  | 'enable-master-switch'
  | 'allow-site'
  | 'unblock-site'
  | 'do-high-risk-yourself'
  | 'sign-in-then-rerun'
  | 'relax-policy'
  | 'raise-capability'
  | 'answer-approval'
  | 'run-while-watching';

export interface BrowserRunReportSnapshot {
  v: typeof BROWSER_RUN_REPORT_SNAPSHOT_VERSION;
  outcome: BrowserRunReportOutcome;
  actions: { total: number; failed: number };
  sites: BrowserRunReportSite[];
  denials: BrowserRunReportDenial[];
  problems: BrowserRunReportProblem[];
  approvals: BrowserRunReportApprovals;
  blockedPages: number;
  /**
   * R1 §1.2 — "the report records that it was skipped because the master
   * switch is off, never silently". The single most likely first-run
   * experience: the switch defaults to off, so the task looks like it
   * succeeded while doing nothing.
   */
  skippedByMasterSwitch: boolean;
  nextSteps: BrowserRunReportNextStep[];
  /** Rows the caps dropped, so the card can say "and N more" honestly rather
   *  than quietly showing a partial list as if it were the whole list. */
  omitted: { sites: number; problems: number };
}

export interface BuildBrowserRunReportInput {
  /** Usually `getRecentBrowserSignals()`. Taken as a parameter so the
   *  aggregation itself stays pure and testable. */
  signals: readonly StoredBrowserSignalRecord[];
  /** The conversation this run executed in. An empty string matches nothing. */
  conversationId: string;
  /** `getBrowserSignalCursor()` captured immediately BEFORE the run started. */
  sinceSeq: number;
  outcome: BrowserRunReportOutcome;
}

/** Untrusted text → a bounded single-line plain string. */
function clampUntrusted(value: string, max: number): string {
  const flattened = value.replace(/\s+/g, ' ').trim();
  return flattened.length <= max ? flattened : `${flattened.slice(0, max)}…`;
}

/** count desc, then key asc — a total order, so two runs with identical data
 *  always produce byte-identical snapshots. */
function byCountThenKey<T extends { count: number }>(
  key: (row: T) => string,
): (a: T, b: T) => number {
  return (a, b) => (b.count - a.count) || key(a).localeCompare(key(b));
}

/**
 * Fixed presentation order for next steps — the cheapest, most global fix
 * first, so a user with three problems reads them in the order that resolves
 * the most actions.
 */
const NEXT_STEP_ORDER: readonly BrowserRunReportNextStep[] = [
  'enable-master-switch',
  'raise-capability',
  'allow-site',
  'unblock-site',
  'sign-in-then-rerun',
  'answer-approval',
  'relax-policy',
  'do-high-risk-yourself',
  'run-while-watching',
];

/**
 * One denial reason → the thing to do about it.
 *
 * `undefined` means the reason has no user action attached (`user-cancelled`
 * is the user's own choice; there is nothing to advise).
 */
function nextStepForDenial(
  reason: BrowserDenialReasonCode,
): BrowserRunReportNextStep | undefined {
  switch (reason) {
    case 'master-switch-off': return 'enable-master-switch';
    case 'site-denied': return 'unblock-site';
    case 'high-risk-site': return 'do-high-risk-yourself';
    case 'policy-denied': return 'relax-policy';
    case 'capability-denied': return 'raise-capability';
    case 'origin-unverified': return 'run-while-watching';
    case 'login-required': return 'sign-in-then-rerun';
    case 'site-not-allowed': return 'allow-site';
    case 'approval-refused': return 'answer-approval';
    case 'user-cancelled': return undefined;
  }
}

/**
 * Build the report a person reads in the morning, or `null` when this run
 * never touched the browser (a task with no browser work must not be handed
 * an empty card).
 *
 * Pure: no `Date.now()`, no `Math.random()`, no store reads. Every timestamp
 * in the output came off a signal that was recorded with one.
 */
export function buildBrowserRunReport(
  input: BuildBrowserRunReportInput,
): BrowserRunReportSnapshot | null {
  const { conversationId, sinceSeq, outcome } = input;

  // Ruling 2. An empty conversation id matches nothing — a signal recorded
  // without a conversation is unattributable, and "unattributable" must never
  // resolve to "attribute it to whoever is asking".
  if (!conversationId) return null;
  const window = input.signals.filter(
    (s) => s.seq > sinceSeq && s.conversationId === conversationId,
  );
  if (window.length === 0) return null;

  const sites = new Map<string, BrowserRunReportSite>();
  const denials = new Map<BrowserDenialReasonCode, { count: number; origins: Set<string> }>();
  const problems = new Map<string, { count: number; origins: Set<string> }>();
  const approvals: BrowserRunReportApprovals = {
    approved: 0,
    declined: 0,
    timedOut: 0,
    unreachable: 0,
  };
  let total = 0;
  let failed = 0;
  let blockedPages = 0;

  for (const signal of window) {
    switch (signal.kind) {
      case 'tool_call': {
        total++;
        if (!signal.ok) failed++;
        if (signal.origin) {
          const origin = clampUntrusted(signal.origin, MAX_REPORT_ORIGIN_LENGTH);
          const row = sites.get(origin) ?? { origin, actions: 0, failures: 0 };
          row.actions++;
          if (!signal.ok) row.failures++;
          sites.set(origin, row);
        }
        if (!signal.ok && signal.errorClass) {
          const cls = clampUntrusted(signal.errorClass, MAX_REPORT_ERROR_CLASS_LENGTH);
          const row = problems.get(cls) ?? { count: 0, origins: new Set<string>() };
          row.count++;
          if (signal.origin) {
            row.origins.add(clampUntrusted(signal.origin, MAX_REPORT_ORIGIN_LENGTH));
          }
          problems.set(cls, row);
        }
        break;
      }
      case 'gate_denied': {
        const row = denials.get(signal.reason) ?? { count: 0, origins: new Set<string>() };
        row.count++;
        if (signal.origin) {
          row.origins.add(clampUntrusted(signal.origin, MAX_REPORT_ORIGIN_LENGTH));
        }
        denials.set(signal.reason, row);
        break;
      }
      case 'approval': {
        switch (signal.outcome) {
          case 'approved': approvals.approved++; break;
          case 'declined': approvals.declined++; break;
          case 'timeout': approvals.timedOut++; break;
          default: approvals.unreachable++; break;
        }
        // Only an actual answer is a "decision" — a timeout or an
        // undeliverable prompt is precisely the absence of one, and stamping
        // it with a time would tell the user a human acted when none did.
        if (signal.outcome === 'approved' || signal.outcome === 'declined') {
          approvals.firstDecisionAt = approvals.firstDecisionAt === undefined
            ? signal.ts
            : Math.min(approvals.firstDecisionAt, signal.ts);
          approvals.lastDecisionAt = approvals.lastDecisionAt === undefined
            ? signal.ts
            : Math.max(approvals.lastDecisionAt, signal.ts);
        }
        break;
      }
      case 'blocked_page':
        blockedPages++;
        break;
      default:
        // fallback_to_script / repeat_action / confirm_prompt / tab_lifetime /
        // task_end carry no row of their own in this card.
        break;
    }
  }

  const denialRows: BrowserRunReportDenial[] = [...denials.entries()]
    .map(([reason, row]) => ({
      reason,
      count: row.count,
      origins: [...row.origins].sort().slice(0, MAX_REPORT_ORIGINS_PER_ROW),
    }))
    .sort(byCountThenKey((row) => row.reason));

  // A run whose ONLY browser trace is a workspace tab opening/closing has
  // nothing to report — do not manufacture an empty card for it.
  const hasSomethingToSay =
    total > 0
    || denialRows.length > 0
    || blockedPages > 0
    || approvals.approved > 0
    || approvals.declined > 0
    || approvals.timedOut > 0
    || approvals.unreachable > 0;
  if (!hasSomethingToSay) return null;

  const allSites = [...sites.values()].sort(
    (a, b) => (b.actions - a.actions) || a.origin.localeCompare(b.origin),
  );
  const allProblems: BrowserRunReportProblem[] = [...problems.entries()]
    .map(([errorClass, row]) => ({
      errorClass,
      count: row.count,
      origins: [...row.origins].sort().slice(0, MAX_REPORT_ORIGINS_PER_ROW),
    }))
    .sort(byCountThenKey((row) => row.errorClass));

  const steps = new Set<BrowserRunReportNextStep>();
  for (const row of denialRows) {
    const step = nextStepForDenial(row.reason);
    if (step) steps.add(step);
  }
  // A run the denial guard stopped must always tell the user how to unblock
  // it, even if the denial signals themselves were evicted or never recorded.
  if (outcome === 'aborted-denials' && steps.size === 0) steps.add('answer-approval');

  return {
    v: BROWSER_RUN_REPORT_SNAPSHOT_VERSION,
    outcome,
    actions: { total, failed },
    sites: allSites.slice(0, MAX_REPORT_SITES),
    denials: denialRows,
    problems: allProblems.slice(0, MAX_REPORT_PROBLEMS),
    approvals,
    blockedPages,
    skippedByMasterSwitch: denials.has('master-switch-off'),
    nextSteps: NEXT_STEP_ORDER.filter((step) => steps.has(step)),
    omitted: {
      sites: Math.max(0, allSites.length - MAX_REPORT_SITES),
      problems: Math.max(0, allProblems.length - MAX_REPORT_PROBLEMS),
    },
  };
}

// ── The message carrier ───────────────────────────────────────────────────

export const BROWSER_RUN_REPORT_ID_PREFIX = 'browser-run-report-';

/**
 * True iff `msg` is a run-report marker: the id prefix AND the payload.
 *
 * Both halves are required, exactly as `isCompactBoundary` requires both. A
 * message with the prefix but no payload is not a card — rendering one would
 * produce the empty card this whole design exists to prevent.
 */
export function isBrowserRunReportMessage(msg: Message): boolean {
  return msg.id.startsWith(BROWSER_RUN_REPORT_ID_PREFIX) && msg.browserRunReport !== undefined;
}

/**
 * Build the marker message the card renders from.
 *
 * `role: 'system'` with no `isSystem` flag — the same combination the
 * compaction boundary marker uses, and it is load-bearing on both sides:
 * `isSystem` would HIDE it from the chat (`ChatView`'s visible-message
 * filter), while `role: 'system'` keeps it out of the LLM context
 * (`messageNormalizer` skips that role), so a later turn in the same
 * conversation neither re-reads the report nor pays tokens for it.
 *
 * No `loopId`: the card belongs to the run that just ended, not to a turn, and
 * an id-less message always starts its own group in `groupMessagesByLoop` —
 * which is what lets `ChatView` render it as a standalone card.
 *
 * `timestamp` is injected rather than read from the clock so the caller (and
 * its tests) owns time.
 */
export function createBrowserRunReportMessage(options: {
  id: string;
  timestamp: number;
  report: BrowserRunReportSnapshot;
}): Message {
  return {
    id: `${BROWSER_RUN_REPORT_ID_PREFIX}${options.id}`,
    role: 'system',
    content: '',
    timestamp: options.timestamp,
    browserRunReport: options.report,
  };
}

/**
 * The agent loop's terminal reason → the report's outcome vocabulary.
 *
 * The ONLY place this mapping lives. Note what it is derived from: the run's
 * own terminal reason and `abortCause`, both produced locally. No page-derived
 * string can reach it (Ruling 3) — a site cannot make its own failure look
 * like a success by what it puts in a title or an error body.
 */
export function browserRunReportOutcomeFor(
  reason: string,
  abortedByBrowserDenials: boolean,
): BrowserRunReportOutcome {
  switch (reason) {
    case 'completed': return 'completed';
    case 'max_turns': return 'incomplete';
    case 'no_progress': return 'no-progress';
    case 'aborted': return abortedByBrowserDenials ? 'aborted-denials' : 'aborted';
    default: return 'error';
  }
}
