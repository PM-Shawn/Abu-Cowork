/**
 * The one place an unattended run's browser report becomes a message.
 *
 * Split from `browserRunReport.ts` so that module stays pure (no store, no
 * clock, no id generator) and can be tested as a function of its inputs. This
 * file is the thin impure edge: read the buffer, aggregate, append.
 *
 * Entry points call it at the END of a run, once, whatever the terminal
 * reason — a run that failed or was stopped is precisely the one the user most
 * needs a report for.
 */
import { generateId } from '../../lib/utils';
import { createLogger } from '../logging/logger';
import { useChatStore } from '../../stores/chatStore';
import {
  buildBrowserDownloadsReport,
  buildBrowserRunReport,
  createBrowserRunReportMessage,
  type BrowserRunReportOutcome,
  type BrowserRunReportSnapshot,
} from './browserRunReport';
import { getRecentBrowserSignals } from './browserSignals';

const logger = createLogger('browserRunReport');

export interface EmitBrowserRunReportOptions {
  conversationId: string;
  /** `getBrowserSignalCursor()` captured immediately BEFORE the run started. */
  sinceSeq: number;
  outcome: BrowserRunReportOutcome;
  /** Injectable for tests; production reads the clock here and nowhere deeper. */
  now?: number;
  id?: string;
}

/**
 * Aggregate the run's browser facts WITHOUT touching the conversation.
 *
 * Split out for F7: the run's IM summary has to be built (and sent) before the
 * card message is appended — `outputSender`'s `last_message` extraction would
 * otherwise pick up this deliberately text-less card instead of the answer the
 * task produced — while both must describe the SAME aggregation. So the caller
 * builds once, summarizes, pushes, and appends the very same snapshot in its
 * `finally`. Re-deriving it twice would have been two aggregations that merely
 * look alike.
 *
 * Never throws, for the same reason `emitBrowserRunReport` never throws: an
 * explanation of what happened must not become a new way for the run that just
 * finished to fail. A failure here is logged, not swallowed silently.
 */
export function buildUnattendedBrowserReport(options: {
  conversationId: string;
  sinceSeq: number;
  outcome: BrowserRunReportOutcome;
}): BrowserRunReportSnapshot | null {
  try {
    return buildBrowserRunReport({
      signals: getRecentBrowserSignals(),
      conversationId: options.conversationId,
      sinceSeq: options.sinceSeq,
      outcome: options.outcome,
    });
  } catch (error) {
    logger.warn('failed to build the browser run report', {
      conversationId: options.conversationId,
      outcome: options.outcome,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Append an already-built snapshot as the run's card message. `null` (the run
 * never touched a browser) appends nothing.
 *
 * Never throws — see above.
 */
export function appendBrowserRunReportMessage(options: {
  conversationId: string;
  report: BrowserRunReportSnapshot | null;
  /** Injectable for tests; production reads the clock here and nowhere deeper. */
  now?: number;
  id?: string;
}): BrowserRunReportSnapshot | null {
  const { report } = options;
  if (!report) return null;
  try {
    useChatStore.getState().addMessage(
      options.conversationId,
      createBrowserRunReportMessage({
        id: options.id ?? generateId(),
        timestamp: options.now ?? Date.now(),
        report,
      }),
    );
    return report;
  } catch (error) {
    logger.warn('failed to emit the browser run report', {
      conversationId: options.conversationId,
      outcome: report.outcome,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Hand back the files an ORDINARY conversation's run downloaded, as the card's
 * downloads-only form (acceptance F3).
 *
 * The full report belongs to runs nobody watched. A person who typed 「导出月度
 * 报表」 in the chat window watched the whole thing — what they are missing is
 * not an account of the run, it is the file: somewhere to click that opens it
 * and somewhere to click that shows it in Finder. Until this existed the
 * downloaded file had no exit from an ordinary conversation at all, and the
 * model had to go and `read_file` it back to produce anything clickable.
 *
 * Appends nothing when the run downloaded nothing, which is almost every run.
 *
 * Never throws, for the same reason nothing else in this file does.
 */
export function emitBrowserDownloadsCard(options: {
  conversationId: string;
  /** `getBrowserSignalCursor()` captured immediately BEFORE the run started. */
  sinceSeq: number;
  now?: number;
  id?: string;
}): BrowserRunReportSnapshot | null {
  let report: BrowserRunReportSnapshot | null;
  try {
    report = buildBrowserDownloadsReport({
      signals: getRecentBrowserSignals(),
      conversationId: options.conversationId,
      sinceSeq: options.sinceSeq,
    });
  } catch (error) {
    logger.warn('failed to build the downloads card', {
      conversationId: options.conversationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  return appendBrowserRunReportMessage({
    conversationId: options.conversationId,
    report,
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.id !== undefined ? { id: options.id } : {}),
  });
}

/**
 * Append the run's report card to its conversation, or do nothing when the run
 * never touched the browser.
 *
 * Returns the snapshot that was appended (or `null`), so a caller can assert
 * on it without reaching into the store.
 *
 * Never throws. A report is an explanation of what happened; it must not
 * become a new way for the run that just finished to fail.
 */
export function emitBrowserRunReport(
  options: EmitBrowserRunReportOptions,
): BrowserRunReportSnapshot | null {
  try {
    const report = buildBrowserRunReport({
      signals: getRecentBrowserSignals(),
      conversationId: options.conversationId,
      sinceSeq: options.sinceSeq,
      outcome: options.outcome,
    });
    if (!report) return null;

    return appendBrowserRunReportMessage({
      conversationId: options.conversationId,
      report,
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.id !== undefined ? { id: options.id } : {}),
    });
  } catch (error) {
    /**
     * Still never throws — a report is an explanation of what happened, and it
     * must not become a new way for the run that just finished to fail.
     *
     * But it no longer fails INVISIBLY (U7 review / B5). A swallowed exception
     * here means the user's morning card silently does not exist, which looks
     * exactly like "the task did nothing all night" — the very thing this card
     * was built to rule out. Same blindness class as an audit trail that can
     * quietly become empty.
     */
    logger.warn('failed to emit the browser run report', {
      conversationId: options.conversationId,
      outcome: options.outcome,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
