// The impure edge of the run report: read the buffer, aggregate, append.
//
// The case that matters here is the FAILURE case (U7 review / B5). This
// function must never throw — a report explaining what happened must not
// become a new way for the run that just finished to fail — but it used to
// swallow the exception with a bare `catch {}`. A silently missing morning
// card looks exactly like "the task did nothing all night", which is the one
// conclusion this whole feature exists to rule out.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emitBrowserRunReport } from './browserRunReportEmitter';
import {
  buildBrowserSignalContext,
  buildBrowserSignalRecord,
  clearBrowserSignals,
  getBrowserSignalCursor,
  recordBrowserSignal,
} from './browserSignals';
import { clearLogs, getRecentLogs } from '../logging/logger';
import { useChatStore } from '../../stores/chatStore';

const T0 = 1_700_000_000_000;
const CONV = 'conv-emit';

function recordOneAction(): void {
  recordBrowserSignal(
    buildBrowserSignalRecord(
      { kind: 'tool_call', tool: 'abu-browser__navigate', ok: true, durationMs: 5, origin: 'https://ok.example' },
      buildBrowserSignalContext('builtin', CONV, T0),
    ),
  );
}

function warnings() {
  return getRecentLogs({ module: 'browserRunReport', level: 'warn' });
}

let realAddMessage: ReturnType<typeof useChatStore.getState>['addMessage'];

describe('emitBrowserRunReport', () => {
  beforeEach(() => {
    clearBrowserSignals();
    clearLogs();
    useChatStore.setState({ conversations: {}, conversationIndex: {}, activeConversationId: null });
    realAddMessage = useChatStore.getState().addMessage;
  });

  afterEach(() => {
    useChatStore.setState({ addMessage: realAddMessage });
    clearBrowserSignals();
    clearLogs();
  });

  it('appends the card and says nothing when all is well', () => {
    const sinceSeq = getBrowserSignalCursor();
    recordOneAction();
    const addMessage = vi.fn();
    useChatStore.setState({ addMessage: addMessage as never });

    const report = emitBrowserRunReport({
      conversationId: CONV, sinceSeq, outcome: 'completed', now: T0, id: 'r1',
    });

    expect(report).not.toBeNull();
    expect(addMessage).toHaveBeenCalledTimes(1);
    expect(addMessage.mock.calls[0][0]).toBe(CONV);
    expect(addMessage.mock.calls[0][1]).toMatchObject({ id: 'browser-run-report-r1', browserRunReport: report });
    expect(warnings()).toHaveLength(0);
  });

  it('does nothing, quietly, for a run that never touched the browser', () => {
    const sinceSeq = getBrowserSignalCursor();
    const addMessage = vi.fn();
    useChatStore.setState({ addMessage: addMessage as never });

    expect(emitBrowserRunReport({
      conversationId: CONV, sinceSeq, outcome: 'completed', now: T0, id: 'r1',
    })).toBeNull();
    expect(addMessage).not.toHaveBeenCalled();
    // "There was nothing to report" is not a failure.
    expect(warnings()).toHaveLength(0);
  });

  it('warns instead of failing silently when the append throws', () => {
    const sinceSeq = getBrowserSignalCursor();
    recordOneAction();
    useChatStore.setState({
      addMessage: (() => { throw new Error('store exploded'); }) as never,
    });

    const report = emitBrowserRunReport({
      conversationId: CONV, sinceSeq, outcome: 'error', now: T0, id: 'r1',
    });

    // Still swallowed: the run does not fail because its report did.
    expect(report).toBeNull();
    // But no longer invisible.
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0].message).toContain('failed to emit');
    expect(warnings()[0].data).toMatchObject({ conversationId: CONV, outcome: 'error' });
    expect(String(warnings()[0].data?.error)).toContain('store exploded');
  });
});
