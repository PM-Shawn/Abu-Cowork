/**
 * Ephemeral, session-only record of the most recent real LLM-call outcome per
 * provider id. Written by the agent loop when a run completes or fails; read by
 * the AI-services diagnostic so a provider whose real conversations are currently
 * failing shows a warning even though the cheap connectivity probe passes. A
 * later success overwrites a failure (self-healing) — unlike scanning the raw
 * error-log buffer, which never clears. Not persisted; resets on app restart
 * (same lifetime as the logger ring buffer).
 */
import type { LLMErrorCode } from './adapter';

export interface ProviderCallOutcome {
  ok: boolean;
  /** LLMError code when ok === false (e.g. 'not_found'). */
  code?: string;
  /** Date.now() of the outcome. */
  at: number;
}

/**
 * Error codes that indicate a persistent provider / model / endpoint
 * misconfiguration — the kind a user can act on via Settings → Models, and the
 * kind a cheap connectivity probe can miss. Transient conditions (rate limits,
 * upstream 5xx, network blips, user cancels) are deliberately excluded: recording
 * them would mislabel a correctly-configured provider as broken and steer the
 * user to change settings that are actually fine.
 */
const CONFIG_FAILURE_CODES: ReadonlySet<LLMErrorCode> = new Set<LLMErrorCode>([
  'not_found',
  'authentication',
  'invalid_request',
]);

/** True when an LLMError code reflects a persistent config problem worth surfacing. */
export function isConfigFailureCode(code: LLMErrorCode): boolean {
  return CONFIG_FAILURE_CODES.has(code);
}

const outcomes = new Map<string, ProviderCallOutcome>();

export function recordProviderCallOutcome(providerId: string | undefined, outcome: ProviderCallOutcome): void {
  if (!providerId) return;
  outcomes.set(providerId, outcome);
}

export function getProviderCallHealth(providerId: string): ProviderCallOutcome | undefined {
  return outcomes.get(providerId);
}

/** Test-only: clear all recorded outcomes. */
export function __resetProviderCallHealth(): void {
  outcomes.clear();
}
