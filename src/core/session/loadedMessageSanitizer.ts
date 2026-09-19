/**
 * Clean-up of messages read back from a conversation ledger.
 *
 * A ledger row is whatever the writer had at the moment it wrote: a run state
 * that was still active when the process died, a streaming flag, an empty
 * assistant placeholder whose content never arrived. Every reader that turns
 * ledger rows into a conversation runs this module over them — the renderer
 * does it when it loads a conversation (`chatStore.ts`) — so readers see the
 * same history, and an empty assistant row never reaches a provider.
 *
 * Pure: no store, no i18n, no I/O. The two user-facing strings it writes into
 * a row arrive through `SanitizeLoadedMessagesOptions.text`, because a reader
 * outside the renderer has no locale of its own. Nothing here writes to disk:
 * the renderer persists the rows this module recovered.
 */
import type { Message, UpstreamErrorDetails } from '@/types';
import { normalizeUpstreamErrorDetails, sanitizeUntrustedLlmErrorText } from '@/core/llm/adapter';

export interface LoadedMessageSanitizerText {
  /** `chat.runRecoveredAfterRestart` in the reader's locale. */
  runRecoveredAfterRestart: string;
  /** `chat.errorEmptyBody` in the reader's locale. */
  errorEmptyBody: string;
}

export interface SanitizeLoadedMessagesOptions {
  text: LoadedMessageSanitizerText;
  /**
   * The user row of the run that is being started right now. Its ledger row
   * is `pending` by construction, which is its true state and no leftover of
   * a dead process, so its run state is left as it is.
   */
  currentRunMessageId?: string;
}

export const ACTIVE_RUN_STATES: ReadonlySet<Message['runState']> = new Set<Message['runState']>([
  'pending',
  'accepted',
  'running',
  'recovering',
]);
export const TERMINAL_RUN_STATES: ReadonlySet<Message['runState']> = new Set<Message['runState']>([
  'completed',
  'failed',
  'connection-failed',
  'interrupted',
]);
export const RUN_FAILURE_STATES: ReadonlySet<Message['runState']> = new Set<Message['runState']>([
  'failed',
  'connection-failed',
]);

/**
 * #549: the closed set of pre-accept failure causes a failed user row may
 * carry. Anything else (including a value hand-edited into the ledger) is
 * dropped — the field drives UI affordances, so it is never trusted from disk.
 */
const RUN_ERROR_KINDS = new Set<NonNullable<Message['runErrorKind']>>([
  'payload_too_large',
  'sidecar_unavailable',
  'dispatch_failed',
]);

export function sanitizeRunErrorKind(value: unknown): Message['runErrorKind'] {
  return RUN_ERROR_KINDS.has(value as NonNullable<Message['runErrorKind']>)
    ? value as Message['runErrorKind']
    : undefined;
}

export function recoverInterruptedUserRun(
  msg: Message,
  options: { recoveredText: string; answeredLoopIds?: ReadonlySet<string>; currentRunMessageId?: string },
): Message {
  if (msg.role !== 'user' || !ACTIVE_RUN_STATES.has(msg.runState)) return msg;
  if (options.currentRunMessageId !== undefined && msg.id === options.currentRunMessageId) return msg;
  // A stale-active row whose loop demonstrably produced a substantive reply
  // did complete — only its terminal runState revision never reached the
  // ledger. Branding such a row "发送失败" invites a retry of a turn that
  // already succeeded.
  if (msg.loopId && options.answeredLoopIds?.has(msg.loopId)) {
    return { ...msg, runState: 'completed' };
  }
  // `runErrorKind` is dropped on purpose (#549): a row branded failed by
  // restart recovery is not one of the pre-accept causes, so it must not
  // inherit their affordances (e.g. the oversize 「新建对话」 button) from a
  // kind that happened to be sitting in the ledger.
  const { runErrorKind: _recoveredKind, ...withoutKind } = msg;
  return {
    ...withoutKind,
    runState: 'failed',
    runError: options.recoveredText,
  };
}

function safeRunErrorFallback(errorDetails: UpstreamErrorDetails | undefined, emptyBodyText: string): string {
  const statusFallback = errorDetails ? `HTTP ${errorDetails.status}` : emptyBodyText;
  return errorDetails?.summary
    ? sanitizeUntrustedLlmErrorText(errorDetails.summary, statusFallback)
    : statusFallback;
}

export function sanitizeRunErrorText(
  value: unknown,
  errorDetails: UpstreamErrorDetails | undefined,
  emptyBodyText: string,
): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return sanitizeUntrustedLlmErrorText(value, safeRunErrorFallback(errorDetails, emptyBodyText));
}

export function enforceRunErrorState(message: Message): Message {
  if (RUN_FAILURE_STATES.has(message.runState)) return message;
  const {
    runError: _runError,
    runErrorDetails: _runErrorDetails,
    runErrorKind: _runErrorKind,
    ...withoutRunError
  } = message;
  return withoutRunError as Message;
}

/** A non-ghost assistant row: real text, tool activity, or thinking. Shared
 * by the ghost filter below and the completed-run inference above it. */
function isSubstantiveAssistant(msg: Message): boolean {
  if (msg.role !== 'assistant') return false;
  const text = typeof msg.content === 'string'
    ? msg.content
    : msg.content.filter(c => c.type === 'text').map(c => (c as { type: 'text'; text: string }).text).join('');
  return text.trim().length > 0
    || (msg.toolCalls?.length ?? 0) > 0
    || (msg.toolCallsForContext?.length ?? 0) > 0
    || !!msg.thinking;
}

/** loopIds whose turn demonstrably finished: a substantive assistant reply
 * bearing `usage`. Substantive text alone is not proof — a stream that died
 * mid-sentence leaves non-empty text too, and inferring 'completed' there
 * would hide the retry affordance behind a half reply. `usage` is only
 * written at a clean stream end (message_stop), so it separates the two:
 * every normally-finished turn carries it, a crashed stream never does.
 * Shared by the disk-load and import paths so the same ledger sanitizes
 * identically through either. */
export function collectAnsweredLoopIds(messages: readonly Message[]): ReadonlySet<string> {
  const answeredLoopIds = new Set<string>();
  for (const msg of messages) {
    if (msg.loopId && msg.role === 'assistant' && msg.usage && isSubstantiveAssistant(msg)) {
      answeredLoopIds.add(msg.loopId);
    }
  }
  return answeredLoopIds;
}

/**
 * Ledger rows as a conversation may use them: run-error fields re-sanitised,
 * executing and streaming flags cleared, interrupted sandbox recoveries
 * rewritten, stale active runs recovered, and ghost assistant rows (empty
 * placeholders written before any content arrived) removed. Ghost rows must
 * not reach the LLM.
 */
export function sanitizeLoadedLedgerMessages(
  messages: Message[],
  options: SanitizeLoadedMessagesOptions,
): Message[] {
  const answeredLoopIds = collectAnsweredLoopIds(messages);
  return messages
    .map((msg) => {
      const {
        runErrorDetails: untrustedRunErrorDetails,
        runError: untrustedRunError,
        runErrorKind: untrustedRunErrorKind,
        ...messageWithoutErrorDetails
      } = msg;
      const runErrorDetails = normalizeUpstreamErrorDetails(untrustedRunErrorDetails);
      const runError = sanitizeRunErrorText(untrustedRunError, runErrorDetails, options.text.errorEmptyBody);
      const runErrorKind = sanitizeRunErrorKind(untrustedRunErrorKind);
      const toolCalls = msg.toolCalls?.map((tc) => {
        const safeToRetryRecovery =
          tc.sandboxRecoveryAction === 'pending'
          || tc.sandboxRecoveryAction === 'enqueued';
        return {
          ...tc,
          isExecuting: false,
          sandboxRecoveryAction: tc.sandboxRecoveryAction === 'started'
            ? 'needs-review' as const
            : safeToRetryRecovery
            ? 'failed' as const
            : tc.sandboxRecoveryAction,
        };
      });
      return enforceRunErrorState(recoverInterruptedUserRun({
        ...messageWithoutErrorDetails,
        ...(runError ? { runError } : {}),
        ...(runErrorDetails ? { runErrorDetails } : {}),
        ...(runErrorKind ? { runErrorKind } : {}),
        isStreaming: false,
        toolCalls,
      }, {
        recoveredText: options.text.runRecoveredAfterRestart,
        answeredLoopIds,
        currentRunMessageId: options.currentRunMessageId,
      }));
    })
    .filter(msg => msg.role !== 'assistant' || isSubstantiveAssistant(msg));
}
