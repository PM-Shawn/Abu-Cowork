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
import { useChatStore } from '../../stores/chatStore';
import {
  buildBrowserRunReport,
  createBrowserRunReportMessage,
  type BrowserRunReportOutcome,
  type BrowserRunReportSnapshot,
} from './browserRunReport';
import { getRecentBrowserSignals } from './browserSignals';

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

    useChatStore.getState().addMessage(
      options.conversationId,
      createBrowserRunReportMessage({
        id: options.id ?? generateId(),
        timestamp: options.now ?? Date.now(),
        report,
      }),
    );
    return report;
  } catch {
    return null;
  }
}
