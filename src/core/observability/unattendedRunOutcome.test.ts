/**
 * The unattended run's ending, as one object — and as the one line that
 * reaches the user's IM.
 *
 * Pure derivation: (terminal reason, abort cause, report snapshot) in, code +
 * counts + reason + next step out. No clock, no store, no network — the whole
 * module is a function of its inputs, which is why every case below is a
 * literal.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getI18n, initLanguage } from '../../i18n';
import type { BrowserRunReportSnapshot } from './browserRunReport';
import {
  deriveUnattendedRunOutcome,
  formatUnattendedOutcomeSummary,
} from './unattendedRunOutcome';

function makeReport(overrides: Partial<BrowserRunReportSnapshot> = {}): BrowserRunReportSnapshot {
  return {
    v: 1,
    outcome: 'completed',
    actions: { total: 3, failed: 0 },
    scriptRuns: 0,
    sites: [{ origin: 'https://intranet.example', actions: 3, failures: 0 }],
    denials: [],
    problems: [],
    approvals: { approved: 0, declined: 0, timedOut: 0, unreachable: 0 },
    blockedPages: 0,
    skippedByMasterSwitch: false,
    nextSteps: [],
    omitted: { sites: 0, problems: 0 },
    ...overrides,
  };
}

function derive(reason: string, report: BrowserRunReportSnapshot | null, abortedByBrowserDenials = false) {
  return deriveUnattendedRunOutcome({ reason, abortedByBrowserDenials, report });
}

describe('deriveUnattendedRunOutcome · one code per ending', () => {
  it('completed with nothing refused and nothing failed → succeeded', () => {
    expect(derive('completed', makeReport()).code).toBe('succeeded');
  });

  it('completed with no browser work at all → succeeded', () => {
    const outcome = derive('completed', null);
    expect(outcome.code).toBe('succeeded');
    // A run that never opened a browser reports zeroes, not absence — the
    // summary has to say something either way.
    expect(outcome.did).toEqual({ actions: 0, failed: 0, scriptRuns: 0, sites: [] });
    expect(outcome.nextSteps).toEqual([]);
  });

  it('completed with a failed action → partial', () => {
    expect(derive('completed', makeReport({ actions: { total: 3, failed: 1 } })).code).toBe('partial');
  });

  it('completed with something refused but something done → partial', () => {
    const outcome = derive('completed', makeReport({
      // The card's own verdict — a refused state-changing action. Since F8-2
      // this is the input the code reads, not `denials.length`.
      outcome: 'completed-with-refusals',
      denials: [{ reason: 'site-not-allowed', count: 2, origins: ['https://shop.example'] }],
      nextSteps: ['allow-site'],
    }));
    expect(outcome.code).toBe('partial');
    expect(outcome.denied).toBe(2);
    expect(outcome.blockedReason).toBe('site-not-allowed');
    expect(outcome.blockedOrigins).toEqual(['https://shop.example']);
    // The card's list, verbatim — one table, both surfaces.
    expect(outcome.nextSteps).toEqual(['allow-site']);
  });

  it('completed with EVERYTHING refused → blocked, not succeeded', () => {
    // The silent-false-success case: the terminal says the task finished and
    // the browser side got precisely nowhere.
    const outcome = derive('completed', makeReport({
      actions: { total: 0, failed: 0 },
      sites: [],
      denials: [{ reason: 'master-switch-off', count: 4, origins: [] }],
      skippedByMasterSwitch: true,
      nextSteps: ['enable-master-switch'],
    }));
    expect(outcome.code).toBe('blocked');
    expect(outcome.blockedReason).toBe('master-switch-off');
  });

  it('max_turns → partial even when the browser side was clean', () => {
    expect(derive('max_turns', null).code).toBe('partial');
  });

  /**
   * F8-2 — the card and the IM summary must not answer one question twice.
   *
   * `browserRunReport.ts` rules that a refused READ-ONLY action does not make
   * a delivering run "not done" (a refused snapshot is not a failed task), so
   * the card keeps its green badge. Deriving from `denials.length` gave IM the
   * opposite answer for the same run.
   */
  it('a READ-ONLY refusal leaves a delivering run succeeded — the card says done, so does IM', () => {
    const outcome = derive('completed', makeReport({
      // What `buildBrowserRunReport` actually produces for a read-only refusal:
      // the delivering outcome, undowngraded.
      outcome: 'completed',
      actions: { total: 1, failed: 0 },
      denials: [{ reason: 'site-not-allowed', count: 1, origins: ['https://ro.example'] }],
      nextSteps: ['allow-site'],
    }));
    expect(outcome.code).toBe('succeeded');
  });

  it('a STATE-CHANGING refusal downgrades the same run — again following the card', () => {
    const outcome = derive('completed', makeReport({
      outcome: 'completed-with-refusals',
      actions: { total: 1, failed: 0 },
      denials: [{ reason: 'site-not-allowed', count: 1, origins: ['https://rw.example'] }],
      nextSteps: ['allow-site'],
    }));
    expect(outcome.code).toBe('partial');
  });

  it('carries the turn cap and the delivering flag, so the summary can tell the two apart', () => {
    expect(derive('max_turns', null)).toMatchObject({ delivered: true, hitTurnLimit: true });
    expect(derive('completed', null)).toMatchObject({ delivered: true, hitTurnLimit: false });
    expect(derive('error', null)).toMatchObject({ delivered: false, hitTurnLimit: false });
  });

  /**
   * F8-8 — the exit boundary proves its own invariant.
   *
   * Production origins are normalized at the gate, so this changes nothing
   * there; it matters because this module is the first thing that puts the
   * string on a network.
   */
  it('re-normalizes origins on the way out — path, query and userinfo cannot ride along', () => {
    const outcome = derive('completed', makeReport({
      outcome: 'completed-with-refusals',
      sites: [{ origin: 'https://user:pw@Intranet.Example./admin?token=SECRET', actions: 1, failures: 0 }],
      denials: [{
        reason: 'site-denied',
        count: 1,
        origins: ['https://evil.example/admin/users?token=SECRET123'],
      }],
    }));
    expect(outcome.blockedOrigins).toEqual(['https://evil.example']);
    expect(outcome.did.sites).toEqual(['https://intranet.example']);
  });

  it('drops an origin it cannot parse rather than inventing one', () => {
    const outcome = derive('completed', makeReport({
      outcome: 'completed-with-refusals',
      denials: [{ reason: 'site-denied', count: 1, origins: ['✓ approved by the user'] }],
    }));
    expect(outcome.blockedOrigins).toEqual([]);
  });

  it('aborted by a person → stopped', () => {
    expect(derive('aborted', null).code).toBe('stopped');
  });

  it('aborted by the consecutive-denial guard → blocked, not stopped', () => {
    // Different event, different sentence: nobody chose this one.
    expect(derive('aborted', makeReport({
      denials: [{ reason: 'approval-refused', count: 2, origins: [] }],
    }), true).code).toBe('blocked');
  });

  it('error → failed', () => {
    expect(derive('error', null).code).toBe('failed');
  });

  it('an unrecognised terminal reason fails to the failed side, not the succeeded one', () => {
    expect(derive('something-new', null).code).toBe('failed');
  });

  it('no_progress → no-progress', () => {
    expect(derive('no_progress', null).code).toBe('no-progress');
  });

  it('leads with the master switch even when another reason was recorded more often', () => {
    // Everything is refused for that one reason when the switch is off, and it
    // is the one blocker a user can clear in a single click.
    const outcome = derive('completed', makeReport({
      actions: { total: 0, failed: 0 },
      denials: [
        { reason: 'site-not-allowed', count: 9, origins: ['https://shop.example'] },
        { reason: 'master-switch-off', count: 1, origins: ['https://intranet.example'] },
      ],
      skippedByMasterSwitch: true,
    }));
    expect(outcome.blockedReason).toBe('master-switch-off');
    expect(outcome.blockedOrigins).toEqual(['https://intranet.example']);
    // Counting is over ALL refusals, not just the leading row.
    expect(outcome.denied).toBe(10);
  });
});

describe('formatUnattendedOutcomeSummary · one line a person can act on', () => {
  beforeAll(() => {
    initLanguage('en-US');
  });

  it('gives a clean run its label and nothing else', () => {
    // Prepended to an answer the user asked for: one line, no preamble.
    expect(formatUnattendedOutcomeSummary(derive('completed', makeReport()), getI18n()))
      .toBe('Done');
  });

  it('says the run never started when the master switch is off', () => {
    const summary = formatUnattendedOutcomeSummary(
      derive('completed', makeReport({
        actions: { total: 0, failed: 0 },
        sites: [],
        denials: [{ reason: 'master-switch-off', count: 4, origins: [] }],
        skippedByMasterSwitch: true,
        nextSteps: ['enable-master-switch'],
      })),
      getI18n(),
    );
    // "Did not run", not "Not finished": nothing was attempted.
    expect(summary.split('\n')[0]).toBe('Did not run: Unattended browser master switch is off');
    expect(summary.split('\n')[1]).toContain('Next: Turn on the master switch');
  });

  it('names the site the refusal happened on', () => {
    const summary = formatUnattendedOutcomeSummary(
      derive('completed', makeReport({
        outcome: 'completed-with-refusals',
        denials: [{ reason: 'site-not-allowed', count: 1, origins: ['https://shop.example'] }],
        nextSteps: ['allow-site'],
      })),
      getI18n(),
    );
    expect(summary.split('\n')[0]).toBe('Partly done: No standing grant for this site (https://shop.example)');
  });

  /**
   * F8-1 — the sentence the answer beneath it used to contradict.
   *
   * `max_turns` is the ONLY non-`completed` terminal that still delivers, so
   * "nothing was produced to deliver" was printed two lines above the thing
   * it produced. The pin is the SENTENCE, not the code: the old test asserted
   * only `code === 'partial'`, which the contradiction never disturbed.
   */
  it('says the run ran out of turns, and never that it produced nothing', () => {
    const summary = formatUnattendedOutcomeSummary(derive('max_turns', null), getI18n());
    expect(summary).toBe('Partly done: hit the turn limit — the partial result is below');
    expect(summary).not.toContain('nothing was produced to deliver');
  });

  it('keeps the turn-cap sentence when the browser side also refused something', () => {
    // The refusal is the more actionable fact and still leads; the point is
    // that the fallback never claims an empty delivery on this terminal.
    const summary = formatUnattendedOutcomeSummary(
      derive('max_turns', makeReport({
        outcome: 'incomplete',
        denials: [{ reason: 'site-not-allowed', count: 1, origins: ['https://shop.example'] }],
      })),
      getI18n(),
    );
    expect(summary).not.toContain('nothing was produced to deliver');
    expect(summary.split('\n')[0]).toContain('No standing grant for this site');
  });

  it('leaves a read-only refusal off the successful line — the card carries it', () => {
    // Same run as the card's green badge: one word, then the answer.
    const summary = formatUnattendedOutcomeSummary(
      derive('completed', makeReport({
        outcome: 'completed',
        denials: [{ reason: 'site-not-allowed', count: 1, origins: ['https://ro.example'] }],
        nextSteps: ['allow-site'],
      })),
      getI18n(),
    );
    expect(summary).toBe('Done');
  });

  it('falls back to counts when nothing was refused but actions failed', () => {
    const summary = formatUnattendedOutcomeSummary(
      derive('completed', makeReport({ actions: { total: 4, failed: 2 } })),
      getI18n(),
    );
    expect(summary).toBe('Partly done: 2 of 4 browser actions failed');
  });

  it('still says something when there is no browser evidence at all', () => {
    // The failure mode this replaces is silence; "failed" with no detail is
    // still an answer, and the run history holds the exception text.
    expect(formatUnattendedOutcomeSummary(derive('error', null), getI18n()))
      .toBe('Task failed: nothing was produced to deliver');
  });

  it('adds no next-step line to a successful run', () => {
    const outcome = { ...derive('completed', makeReport()), nextSteps: ['run-while-watching' as const] };
    expect(formatUnattendedOutcomeSummary(outcome, getI18n())).toBe('Done');
  });

  it('re-words the same codes when the app language changes', () => {
    // Codes are what the run records; the sentence is chosen at push time, so
    // a user who switches to Chinese is not reading yesterday's English.
    const outcome = derive('no_progress', null);
    expect(formatUnattendedOutcomeSummary(outcome, getI18n())).toContain('No progress');
    initLanguage('zh-CN');
    try {
      expect(formatUnattendedOutcomeSummary(outcome, getI18n())).toContain('没有进展');
    } finally {
      initLanguage('en-US');
    }
  });
});
