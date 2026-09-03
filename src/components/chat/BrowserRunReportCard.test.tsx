// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />

// The morning card. The user story it has to satisfy: a scheduled task ran at
// 3am; at 8am a person opens the conversation and wants four answers — did it
// work / where did it go / was anything blocked / what do I do now.
//
// The case that matters most is `after a restart` below: it is the exact shape
// of a defect this repo has already shipped once (tool-result images that
// displayed during execution and went blank afterwards, because the snapshot
// dropped a field). The card must be complete with the signal buffer empty.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { initLanguage } from '@/i18n';
import type { Message } from '@/types';
import {
  buildBrowserRunReport,
  createBrowserRunReportMessage,
  type BrowserRunReportOutcome,
  type BrowserRunReportSnapshot,
} from '@/core/observability/browserRunReport';
import {
  buildBrowserSignalContext,
  buildBrowserSignalRecord,
  clearBrowserSignals,
  getBrowserSignalCursor,
  getRecentBrowserSignals,
  recordBrowserSignal,
  type BrowserSignalEvent,
} from '@/core/observability/browserSignals';
import BrowserRunReportCard from './BrowserRunReportCard';

const T0 = 1_700_000_000_000;
const CONV = 'conv-report';

function record(event: BrowserSignalEvent, ts = T0): void {
  recordBrowserSignal(
    buildBrowserSignalRecord(event, buildBrowserSignalContext('builtin', CONV, ts, 'loop-1')),
  );
}

function snapshotOf(
  emit: () => void,
  outcome: BrowserRunReportOutcome = 'completed',
): BrowserRunReportSnapshot {
  const cursor = getBrowserSignalCursor();
  emit();
  const report = buildBrowserRunReport({
    signals: getRecentBrowserSignals(),
    conversationId: CONV,
    sinceSeq: cursor,
    outcome,
  });
  if (!report) throw new Error('expected a report');
  return report;
}

function messageFor(report: BrowserRunReportSnapshot): Message {
  return createBrowserRunReportMessage({ id: 'r1', timestamp: T0, report });
}

describe('BrowserRunReportCard', () => {
  beforeEach(() => {
    initLanguage('en-US');
    clearBrowserSignals();
  });

  afterEach(() => {
    cleanup();
    clearBrowserSignals();
  });

  it('shows a successful run: what it did and where', () => {
    const report = snapshotOf(() => {
      record({ kind: 'tool_call', tool: 'abu-browser__navigate', ok: true, durationMs: 12, origin: 'https://intranet.example' });
      record({ kind: 'tool_call', tool: 'abu-browser__click', ok: true, durationMs: 8, origin: 'https://intranet.example' });
    });

    render(<BrowserRunReportCard message={messageFor(report)} />);

    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.getByText('2 browser actions')).toBeInTheDocument();
    expect(screen.getByText('https://intranet.example')).toBeInTheDocument();
    expect(screen.getByText('Sites visited')).toBeInTheDocument();
    // A clean run has nothing to advise.
    expect(screen.queryByText('What you can do next')).not.toBeInTheDocument();
  });

  it('shows a failed run WITH an actionable next step, not just "an error"', () => {
    const report = snapshotOf(() => {
      record({ kind: 'tool_call', tool: 'abu-browser__click', ok: false, durationMs: 5, errorClass: 'timeout', origin: 'https://intranet.example' });
      record({
        kind: 'gate_denied',
        tool: 'abu-browser__click',
        opClass: 'interactive',
        origin: 'https://intranet.example',
        reason: 'login-required',
        runMode: 'unattended',
      });
    }, 'error');

    render(<BrowserRunReportCard message={messageFor(report)} />);

    expect(screen.getByText('Stopped with an error')).toBeInTheDocument();
    expect(screen.getByText("The site's sign-in has expired")).toBeInTheDocument();
    expect(screen.getByText('Timed out')).toBeInTheDocument();
    expect(screen.getByText('What you can do next')).toBeInTheDocument();
    expect(
      screen.getByText('Open these sites, sign in again, then run the task once more.'),
    ).toBeInTheDocument();
  });

  it('names the reason when the run stopped itself after repeated refusals', () => {
    const report = snapshotOf(() => {
      record({
        kind: 'gate_denied',
        tool: 'abu-browser__execute_js',
        opClass: 'scripting',
        reason: 'approval-refused',
        runMode: 'unattended',
      });
      record({ kind: 'approval', via: 'im', outcome: 'declined', opClass: 'scripting' }, T0 + 60_000);
    }, 'aborted-denials');

    render(<BrowserRunReportCard message={messageFor(report)} />);

    expect(screen.getByText('Stopped after repeated refusals')).toBeInTheDocument();
    expect(screen.getByText('The approval was declined or never answered')).toBeInTheDocument();
    // G2: the human decision is visible — this is the only moment a person was
    // involved all night.
    expect(screen.getByText('Your approvals')).toBeInTheDocument();
    expect(screen.getByText('0 approved · 1 declined')).toBeInTheDocument();
  });

  it('says the run was skipped because the master switch is off, never silently', () => {
    // R1 §1.2. The switch defaults to OFF, so this is the most likely
    // first-run experience: the task reports success while doing nothing.
    const report = snapshotOf(() => {
      record({
        kind: 'gate_denied',
        tool: 'abu-browser__navigate',
        opClass: 'interactive',
        reason: 'master-switch-off',
        runMode: 'unattended',
      });
    }, 'completed');

    render(<BrowserRunReportCard message={messageFor(report)} />);

    expect(screen.getByText(/master switch for unattended browser access is off/)).toBeInTheDocument();
    expect(screen.getByText('No browser action was carried out')).toBeInTheDocument();
    expect(
      screen.getByText(/Turn on the unattended master switch/),
    ).toBeInTheDocument();
  });

  // ── Ruling 1 ────────────────────────────────────────────────────────────
  it('renders completely after the signal buffer has been cleared (a restart)', () => {
    const report = snapshotOf(() => {
      record({ kind: 'tool_call', tool: 'abu-browser__navigate', ok: true, durationMs: 12, origin: 'https://intranet.example' });
      record({ kind: 'tool_call', tool: 'abu-browser__click', ok: false, durationMs: 3, errorClass: 'not_found', origin: 'https://intranet.example' });
      record({
        kind: 'gate_denied',
        tool: 'abu-browser__execute_js',
        opClass: 'scripting',
        origin: 'https://intranet.example',
        reason: 'site-not-allowed',
        runMode: 'unattended',
      });
      record({ kind: 'approval', via: 'im', outcome: 'approved', opClass: 'interactive' }, T0 + 30_000);
    }, 'incomplete');

    const message = messageFor(report);

    // The buffer this was aggregated from is in-memory, 5000 entries, and
    // empty after a restart. Simulate exactly that.
    clearBrowserSignals();
    expect(getRecentBrowserSignals()).toHaveLength(0);

    render(<BrowserRunReportCard message={message} />);

    expect(screen.getByText('Possibly incomplete (hit the turn limit)')).toBeInTheDocument();
    expect(screen.getByText('2 browser actions, 1 of them failed')).toBeInTheDocument();
    // Once as a visited site, once as the origin the refusal happened on.
    expect(screen.getAllByText('https://intranet.example').length).toBeGreaterThan(0);
    expect(screen.getByText('No standing grant for this site')).toBeInTheDocument();
    expect(screen.getByText('Target element or tab not found')).toBeInTheDocument();
    expect(screen.getByText('1 approved · 0 declined')).toBeInTheDocument();
    expect(screen.getByText('What you can do next')).toBeInTheDocument();
  });

  it('survives a JSON round-trip, the way it comes back off disk', () => {
    const report = snapshotOf(() => {
      record({ kind: 'tool_call', tool: 'abu-browser__navigate', ok: true, durationMs: 12, origin: 'https://intranet.example' });
    });
    const revived = JSON.parse(JSON.stringify(messageFor(report))) as Message;
    clearBrowserSignals();

    render(<BrowserRunReportCard message={revived} />);
    expect(screen.getByText('1 browser actions')).toBeInTheDocument();
  });

  // ── Ruling 3 ────────────────────────────────────────────────────────────
  it('renders a page-controlled origin as inert text and keeps the real verdict', () => {
    const report = snapshotOf(() => {
      record({
        kind: 'tool_call',
        tool: 'abu-browser__navigate',
        ok: false,
        durationMs: 4,
        errorClass: 'timeout',
        // A page trying to talk its way into a different card status.
        origin: 'https://evil.example/<img src=x onerror=alert(1)>-Completed-approved-by-user',
      });
    }, 'error');

    const { container } = render(<BrowserRunReportCard message={messageFor(report)} />);

    // The badge still says what the RUN said, not what the page said.
    expect(screen.getByText('Stopped with an error')).toBeInTheDocument();
    expect(screen.queryByText('Your approvals')).not.toBeInTheDocument();
    // The hostile string is present only as text, with no structure of its own.
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('renders nothing for a message with no snapshot', () => {
    const { container } = render(
      <BrowserRunReportCard message={{ id: 'browser-run-report-x', role: 'system', content: '', timestamp: T0 }} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the same snapshot in the other locale', () => {
    const report = snapshotOf(() => {
      record({
        kind: 'gate_denied',
        tool: 'abu-browser__navigate',
        opClass: 'interactive',
        reason: 'master-switch-off',
        runMode: 'unattended',
      });
    });
    initLanguage('zh-CN');

    render(<BrowserRunReportCard message={messageFor(report)} />);
    // The snapshot stores codes, not sentences, so switching language
    // re-renders an old card correctly instead of freezing it in one language.
    expect(screen.getByText('浏览器任务报告')).toBeInTheDocument();
    expect(screen.getByText('无人值守浏览器总开关已关闭')).toBeInTheDocument();
  });
});
