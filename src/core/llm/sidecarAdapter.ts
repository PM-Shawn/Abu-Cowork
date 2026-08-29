/**
 * Sidecar-backed LLM adapter — routes `chat()` through the sidecar process
 * (see sidecar/src/llmHost.ts) over the JSON-RPC pipe instead of running the
 * Claude/OpenAI-compatible HTTP request in-process in the webview. This is
 * the narrowest cross-process slice of P1-1: tool execution, the agent loop
 * body, and persistence all stay in the webview this phase — only the LLM
 * transport itself moves.
 *
 * Selected by `selectChatAdapter()` (falls back to the local in-process
 * adapter whenever the sidecar isn't `'running'`), so callers never see this
 * class directly touch the network — `LLMAdapter.chat()`'s external contract
 * (event ordering, `LLMError` shape, abort semantics) must stay
 * indistinguishable from the local adapters for `withRetry` and the
 * agent/subagent loops to keep working unmodified.
 */

import type { LLMAdapter, ChatOptions, LLMErrorCode, AdapterKind } from './adapter';
import {
  isLLMErrorCode,
  isUpstreamErrorDetails,
  LLMError,
  normalizeUpstreamErrorDetails,
  sanitizeUntrustedLlmErrorText,
} from './adapter';
import type { Message, StreamEvent, UpstreamErrorDetails } from '../../types';
import { request, notifySidecar, onSidecarNotification, SidecarRpcError } from '../sidecar/sidecarManager';
import { createLogger } from '../logging/logger';

const logger = createLogger('sidecarAdapter');

/**
 * Defensive ceiling on top of the `llm.abort` notification: if the sidecar
 * hangs (bug, wedged event loop) and never settles the `llm.chat` request
 * after we've asked it to abort, don't leave the caller awaiting forever —
 * synthesize the same terminal shape a local adapter's cancel path produces.
 */
const ABORT_GRACE_MS = 5_000;

interface LlmEventNotificationParams {
  callId: string;
  seq: number;
  event: StreamEvent;
}

interface LlmChatMetaNotificationParams {
  callId: string;
  kind: 'maxTokensLimitDiscovered';
  limit: number;
}

interface SidecarLlmErrorData {
  name: 'LLMError';
  code?: LLMErrorCode;
  retryable?: boolean;
  retryAfterMs?: number;
  statusCode?: number;
  upstream?: UpstreamErrorDetails;
  message?: string;
}

const SIDECAR_LLM_ERROR_DATA_KEYS = new Set([
  'name',
  'code',
  'retryable',
  'retryAfterMs',
  'statusCode',
  'upstream',
  'message',
]);
const WIRE_RETRYABLE_LLM_CODES: ReadonlySet<LLMErrorCode> = new Set([
  'rate_limit',
  'overloaded',
  'server_error',
  'network_error',
]);
const WIRE_HTTP_STATUS_BY_CODE: Partial<Record<LLMErrorCode, ReadonlySet<number>>> = {
  authentication: new Set([401, 403]),
  content_policy: new Set([403]),
  context_too_long: new Set([400]),
  invalid_request: new Set([400]),
  not_found: new Set([404]),
  overloaded: new Set([503, 529]),
  rate_limit: new Set([429]),
  server_error: new Set([500, 502]),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSidecarLlmErrorData(value: unknown): value is SidecarLlmErrorData {
  if (!isRecord(value) || value.name !== 'LLMError') return false;
  if (Object.keys(value).some((key) => !SIDECAR_LLM_ERROR_DATA_KEYS.has(key))) return false;
  if (value.code !== undefined && !isLLMErrorCode(value.code)) return false;
  if (value.retryable !== undefined && typeof value.retryable !== 'boolean') return false;
  if (value.retryable === true && (!value.code || !WIRE_RETRYABLE_LLM_CODES.has(value.code))) return false;
  if (value.retryAfterMs !== undefined
    && (!Number.isFinite(value.retryAfterMs as number) || (value.retryAfterMs as number) < 0 || value.retryable !== true)) {
    return false;
  }
  if (value.statusCode !== undefined
    && (!Number.isInteger(value.statusCode) || (value.statusCode as number) < 100 || (value.statusCode as number) > 599)) {
    return false;
  }
  if (value.upstream !== undefined && !isUpstreamErrorDetails(value.upstream)) return false;
  if (value.statusCode !== undefined && isUpstreamErrorDetails(value.upstream)
    && value.statusCode !== value.upstream.status) {
    return false;
  }
  const effectiveStatus = typeof value.statusCode === 'number'
    ? value.statusCode
    : isUpstreamErrorDetails(value.upstream) ? value.upstream.status : undefined;
  if (value.code && effectiveStatus !== undefined) {
    const allowedStatuses = WIRE_HTTP_STATUS_BY_CODE[value.code];
    if (allowedStatuses && !allowedStatuses.has(effectiveStatus)) return false;
  }
  return value.message === undefined || typeof value.message === 'string';
}

function isLlmEventParams(v: unknown): v is LlmEventNotificationParams {
  return typeof v === 'object' && v !== null && 'callId' in v && 'seq' in v && 'event' in v;
}

function isLlmChatMetaParams(v: unknown): v is LlmChatMetaNotificationParams {
  return typeof v === 'object' && v !== null && 'callId' in v && 'kind' in v;
}

/** Same shape/message local adapters produce for an already-aborted or forcibly-cancelled call. */
function cancelledError(): LLMError {
  return new LLMError('Request cancelled', 'cancelled', { retryable: false });
}

/**
 * Reconstruct the LLMError the sidecar's adapter actually threw, from the
 * JSON-RPC error's `data` payload (see sidecar/src/llmHost.ts's
 * `errorDataFor()`, and `SidecarRpcError` in sidecarManager.ts which is what
 * carries `data` through the reject path).
 */
function reconstructError(err: unknown): LLMError {
  // Already a well-formed LLMError (e.g. our own abort-grace-timeout
  // synthesizes cancelledError() directly) — pass through unchanged, don't
  // re-wrap it as a generic network_error.
  if (err instanceof LLMError) return err;
  if (err instanceof SidecarRpcError) {
    const data = err.data;
    if (isSidecarLlmErrorData(data)) {
      const upstream = normalizeUpstreamErrorDetails(data.upstream);
      const code = data.code ?? 'unknown';
      const message = upstream?.summary
        ?? sanitizeUntrustedLlmErrorText(data.message, code);
      return new LLMError(message, code, {
        retryable: data.retryable,
        retryAfterMs: data.retryAfterMs,
        statusCode: typeof data.statusCode === 'number' ? data.statusCode : undefined,
        upstream,
      });
    }
    if (isRecord(data) && data.name === 'LLMError') {
      // A malformed LLM-shaped response is protocol corruption, not a basis
      // for trusting retryability or provider text supplied by the wire.
      return new LLMError('Invalid sidecar LLM error response', 'unknown', { retryable: false });
    }
    // The sidecar threw something that wasn't an LLMError (e.g. a bug in the
    // adapter, an unexpected exception) — surface as a retryable transport
    // failure rather than silently losing the shape withRetry expects.
    return new LLMError('Sidecar request failed', 'network_error', { retryable: true });
  }
  // Not even a SidecarRpcError — e.g. the manager's request() rejected for a
  // transport reason (see the close-mid-stream case handled in chat() below,
  // and this is the generic fallback for anything else unexpected).
  const message = sanitizeUntrustedLlmErrorText(
    err instanceof Error ? err.message : String(err),
    'Sidecar transport failed',
  );
  return new LLMError(message, 'network_error', { retryable: true });
}

let callIdCounter = 0;
function generateCallId(): string {
  // Matches the ID idiom used elsewhere in the codebase (Date.now + random),
  // plus a monotonic counter to guarantee uniqueness even under back-to-back
  // synchronous calls within the same millisecond.
  callIdCounter += 1;
  return `sc-${Date.now().toString(36)}-${callIdCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class SidecarLLMAdapter implements LLMAdapter {
  private readonly kind: AdapterKind;

  constructor(kind: AdapterKind) {
    this.kind = kind;
  }

  async chat(
    messages: Message[],
    options: ChatOptions,
    onEvent: (event: StreamEvent) => void,
  ): Promise<void> {
    if (options.signal?.aborted) {
      throw cancelledError();
    }

    const callId = generateCallId();
    let lastSeq = -1;

    const { signal, onMaxTokensLimitDiscovered, ...serializableOptions } = options;

    const unsubEvent = onSidecarNotification('llm.event', (params: unknown) => {
      if (!isLlmEventParams(params) || params.callId !== callId) return;
      if (params.seq !== lastSeq + 1) {
        logger.warn('llm.event seq gap or duplicate — forwarding anyway', {
          callId,
          expectedAfter: lastSeq,
          got: params.seq,
        });
      }
      lastSeq = params.seq;
      onEvent(params.event);
    });

    const unsubMeta = onSidecarNotification('llm.chatMeta', (params: unknown) => {
      if (!isLlmChatMetaParams(params) || params.callId !== callId) return;
      if (params.kind === 'maxTokensLimitDiscovered') {
        onMaxTokensLimitDiscovered?.(params.limit);
      }
    });

    const cleanup = (): void => {
      unsubEvent();
      unsubMeta();
    };

    // timeoutMs: 0 — llm.chat streams are unbounded; hang protection lives
    // in the adapters' own heartbeat/idle-timeout machinery, which the
    // sidecar-side adapter instance still runs (see sidecar/src/llmHost.ts).
    // The underlying request() promise is intentionally left un-awaited-on
    // directly (raced below) — attach a no-op catch so a LATE rejection
    // (e.g. the sidecar's real error response arriving after the abort-grace
    // timer below already won the race) doesn't surface as an unhandled
    // promise rejection.
    const requestPromise = request(
      'llm.chat',
      { callId, adapterKind: this.kind, messages, options: serializableOptions },
      0,
    );
    requestPromise.catch(() => {});

    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let rejectOnGraceTimeout: ((err: Error) => void) | undefined;
    const gracePromise = new Promise<never>((_, reject) => {
      rejectOnGraceTimeout = reject;
    });
    // Never-settling promises are a legitimate pattern for Promise.race
    // "loser" arms, but Node/browsers still complain about the executor's
    // implicit unhandled-rejection tracking unless something observes it —
    // attach a no-op catch on the SAME promise object used in the race below.
    gracePromise.catch(() => {});

    const onAbort = (): void => {
      notifySidecar('llm.abort', { callId });
      // Defensive: if the sidecar never settles the llm.chat request after
      // being asked to abort (wedged event loop, dropped notification),
      // don't leave the caller awaiting forever.
      graceTimer = setTimeout(() => {
        rejectOnGraceTimeout?.(cancelledError());
      }, ABORT_GRACE_MS);
    };
    // Already-aborted case is handled by the early throw above; this only
    // needs to cover an abort that arrives WHILE the call is in flight.
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      await Promise.race([requestPromise, gracePromise]);
    } catch (err) {
      throw reconstructError(err);
    } finally {
      if (graceTimer) clearTimeout(graceTimer);
      signal?.removeEventListener('abort', onAbort);
      cleanup();
    }
  }
}
