/**
 * Error mapping — turns raw provider/system errors into one-sentence Chinese
 * explanations + actionable suggestions for the diagnostic UI.
 *
 * Two layers:
 *
 * 1. **Structural layer**: when we have an `LLMErrorCode` (set by
 *    classifyError on HTTP status), map directly. This is the authoritative
 *    path for known failure modes (auth/rate-limit/etc.).
 *
 * 2. **Substring layer**: for cases without a structured code (provider
 *    returns 200 but JSON `{ "error": ... }`, or shell-style errors), match
 *    against well-known substrings. Order matters — first hit wins; put
 *    more specific patterns first.
 *
 * What lives where:
 *  - i18n keys for human messages stay in the locale files
 *    (`diagnostic.errMap.*`) — no Chinese strings hardcoded here
 *  - `SuggestedAction.label` is filled here (already-resolved string),
 *    callers pass through verbatim
 */

import { getI18n } from '@/i18n';
import type { LLMErrorCode } from '@/core/llm/adapter';
import type { SuggestedAction } from './types';

export interface FriendlyError {
  /** One-sentence user-facing message (resolved Chinese / English). */
  message: string;
  /** Optional action button. */
  action?: SuggestedAction;
}

// ──────────────────────────────────────────────────────────────────────
// AI service errors
// ──────────────────────────────────────────────────────────────────────

interface MapAIErrorOpts {
  errorCode?: LLMErrorCode;
  statusCode?: number;
  rawMessage: string;
}

export function mapAIServiceError(opts: MapAIErrorOpts): FriendlyError {
  const t = getI18n();
  const raw = opts.rawMessage ?? '';

  // Substring layer FIRST for high-signal patterns (provider may return 200
  // with a JSON error body, in which case errorCode is missing).
  if (/budget.has.been.exceeded|budget_exceeded/i.test(raw)) {
    return {
      message: t.diagnostic.errMap.aiBudgetExceeded,
      action: {
        type: 'open-settings',
        target: 'ai-services',
        label: t.diagnostic.errMap.actionOpenAIServices,
      },
    };
  }
  if (/UnsupportedModel|does.not.support|model.not.found/i.test(raw)) {
    return {
      message: t.diagnostic.errMap.aiModelUnsupported,
      action: {
        type: 'open-settings',
        target: 'ai-services',
        label: t.diagnostic.errMap.actionSwitchModel,
      },
    };
  }
  // Ollama CORS 403 — body is literally "forbidden\n"
  if (opts.statusCode === 403 && /^forbidden\s*$/i.test(raw.trim())) {
    return {
      message: t.diagnostic.errMap.aiOllamaForbidden,
      action: { type: 'open-settings', target: 'ai-services', label: t.diagnostic.errMap.actionOpenAIServices },
    };
  }
  if (/^timeout\s*\(/i.test(raw)) {
    return {
      message: t.diagnostic.errMap.aiTimeout,
      action: {
        type: 'retry',
        label: t.diagnostic.errMap.actionRetry,
      },
    };
  }

  // Structural layer
  switch (opts.errorCode) {
    case 'authentication':
      return {
        message: t.diagnostic.errMap.aiAuth,
        action: {
          type: 'open-settings',
          target: 'ai-services',
          label: t.diagnostic.errMap.actionFixApiKey,
        },
      };
    case 'rate_limit':
      return {
        message: t.diagnostic.errMap.aiRateLimit,
        action: { type: 'retry', label: t.diagnostic.errMap.actionRetry },
      };
    case 'overloaded':
      return {
        message: t.diagnostic.errMap.aiOverloaded,
        action: { type: 'retry', label: t.diagnostic.errMap.actionRetry },
      };
    case 'server_error':
      return {
        message: t.diagnostic.errMap.aiServerError,
        action: { type: 'retry', label: t.diagnostic.errMap.actionRetry },
      };
    case 'context_too_long':
      // Should not happen for a "Hi" probe, but keep mapped for completeness.
      return { message: t.diagnostic.errMap.aiContextTooLong };
    case 'invalid_request':
      return {
        message: t.diagnostic.errMap.aiInvalidRequest,
        action: {
          type: 'open-settings',
          target: 'ai-services',
          label: t.diagnostic.errMap.actionOpenAIServices,
        },
      };
    case 'not_found':
      return {
        message: t.diagnostic.errMap.aiModelUnsupported,
        action: {
          type: 'open-settings',
          target: 'ai-services',
          label: t.diagnostic.errMap.actionSwitchModel,
        },
      };
    case 'network_error':
      return {
        message: t.diagnostic.errMap.aiNetworkError,
        action: { type: 'retry', label: t.diagnostic.errMap.actionRetry },
      };
  }

  // Final fallback — at least don't leak raw JSON into the headline.
  return {
    message: t.diagnostic.errMap.unknown,
    action: { type: 'retry', label: t.diagnostic.errMap.actionRetry },
  };
}

// ──────────────────────────────────────────────────────────────────────
// Permissions errors
// ──────────────────────────────────────────────────────────────────────

export function mapPermissionsError(rawMessage: string): FriendlyError {
  const t = getI18n();
  const raw = rawMessage ?? '';

  // Tauri capability scope mismatch — this is *our* configuration bug.
  // The diagnostic-bundle export route is the user's path to flag it.
  //
  // Tauri 2.x error format changed between versions:
  //   Old: "forbidden path: /some/path allow-write-text-file"  (includes capability id)
  //   New: "forbidden path: D:/workspace/Abu/file.tmp"         (no capability suffix)
  // Match on "forbidden path:" alone to catch both formats.
  if (/forbidden\s+path:/i.test(raw)) {
    return { message: t.diagnostic.errMap.permTauriScope };
  }
  if (/EACCES|permission denied/i.test(raw)) {
    return { message: t.diagnostic.errMap.permOSDenied };
  }
  if (/ENOSPC|disk\s*full/i.test(raw)) {
    return { message: t.diagnostic.errMap.permDiskFull };
  }
  return { message: t.diagnostic.errMap.unknown };
}

// ──────────────────────────────────────────────────────────────────────
// Network errors
// ──────────────────────────────────────────────────────────────────────

export function mapNetworkError(rawMessage: string): FriendlyError {
  const t = getI18n();
  const raw = rawMessage ?? '';

  if (/timeout|TimedOut|ETIMEDOUT/i.test(raw)) {
    return {
      message: t.diagnostic.errMap.netTimeout,
      action: { type: 'retry', label: t.diagnostic.errMap.actionRetry },
    };
  }
  if (/Load failed|Failed to fetch|NetworkError|ENOTFOUND|ECONNREFUSED|connect.*refused|getaddrinfo|dns/i.test(raw)) {
    return { message: t.diagnostic.errMap.netUnreachable };
  }
  return { message: t.diagnostic.errMap.netGeneric };
}
