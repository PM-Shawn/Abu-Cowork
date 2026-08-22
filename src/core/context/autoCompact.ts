/**
 * Auto-Compact — multi-level context warning and automatic compression.
 *
 * Provides a state machine that tracks context usage and decides when to
 * trigger compression. Replaces the simple 65% threshold in contextCompressor.ts
 * with a graduated 4-level system:
 *
 *   Level 0 (< 60%):  Normal — no action
 *   Level 1 (60-75%): Warning — UI shows yellow indicator
 *   Level 2 (75-85%): Compress — auto-trigger semantic compression
 *   Level 3 (> 85%):  Critical — force hard truncation + compression
 *
 * Circuit breaker: after 3 consecutive compression failures, auto-compact
 * is disabled for the rest of the session to avoid infinite retry loops.
 */

export type ContextWarningLevel = 0 | 1 | 2 | 3;

/** Thresholds as fractions of max input tokens */
const LEVEL_1_THRESHOLD = 0.60;
const LEVEL_2_THRESHOLD = 0.75;
const LEVEL_3_THRESHOLD = 0.85;

/** Max consecutive failures before circuit breaker trips */
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Calculate the context warning level based on current usage.
 *
 * @param currentTokens - Current total input tokens (system + messages + tools)
 * @param maxInputTokens - Maximum allowed input tokens (contextWindow - reserveForOutput)
 */
export function calculateWarningLevel(currentTokens: number, maxInputTokens: number): ContextWarningLevel {
  if (maxInputTokens <= 0) return 0;
  const ratio = currentTokens / maxInputTokens;

  if (ratio >= LEVEL_3_THRESHOLD) return 3;
  if (ratio >= LEVEL_2_THRESHOLD) return 2;
  if (ratio >= LEVEL_1_THRESHOLD) return 1;
  return 0;
}

/**
 * Get the raw usage percentage. Unclamped on purpose — the compaction and
 * truncation paths need to see how far PAST the budget a payload is.
 */
export function getUsagePercent(currentTokens: number, maxInputTokens: number): number {
  if (maxInputTokens <= 0) return 0;
  return Math.round((currentTokens / maxInputTokens) * 100);
}

/**
 * Usage percentage for anything a user reads. Clamped to 0–100 so an estimate
 * that runs over the window can never surface as "108% used": the request the
 * agent loop actually sends is guaranteed to fit by `enforceContextBudget`, so
 * a >100% reading is always a measurement artifact, never a real overflow.
 */
export function getDisplayPercent(currentTokens: number, maxInputTokens: number): number {
  return Math.min(100, Math.max(0, getUsagePercent(currentTokens, maxInputTokens)));
}

/**
 * Tracks auto-compact state within an agent loop session.
 * Created once per `runAgentLoop` call, reset on each new invocation.
 */
/** Cooldown period after circuit breaker trips (5 minutes) */
const COOLDOWN_MS = 5 * 60 * 1000;

export class AutoCompactTracker {
  private consecutiveFailures = 0;
  private disabledUntil = 0;
  private lastLevel: ContextWarningLevel = 0;

  /**
   * Check if auto-compact should be attempted at the given warning level.
   * Returns false if circuit breaker is in cooldown.
   */
  shouldCompact(level: ContextWarningLevel): boolean {
    if (Date.now() < this.disabledUntil) return false;
    return level >= 2;
  }

  /**
   * Check if hard truncation should be forced (Level 3 critical).
   */
  shouldForceHardTruncation(level: ContextWarningLevel): boolean {
    return level >= 3;
  }

  /**
   * Record a successful compression — resets the failure counter.
   */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.disabledUntil = 0;
  }

  /**
   * Record a failed compression — may trip the circuit breaker with cooldown.
   * Error-type-aware: network errors don't accumulate, auth errors disable immediately.
   */
  recordFailure(errorCode?: string): void {
    // Network/rate-limit errors are transient — don't punish the compressor
    if (errorCode === 'network_error' || errorCode === 'rate_limit' || errorCode === 'overloaded') {
      return;
    }
    // Authentication errors — disable for a long time (likely needs user action)
    if (errorCode === 'authentication') {
      this.disabledUntil = Date.now() + 30 * 60 * 1000; // 30 minutes
      return;
    }
    // Other errors (LLM quality, invalid request, etc.) — accumulate toward circuit breaker
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      this.disabledUntil = Date.now() + COOLDOWN_MS;
      this.consecutiveFailures = 0; // Reset for next round after cooldown
    }
  }

  /**
   * Whether auto-compact is currently in cooldown.
   */
  isDisabled(): boolean {
    return Date.now() < this.disabledUntil;
  }

  /**
   * Get the current warning level (last computed).
   */
  getLastLevel(): ContextWarningLevel {
    return this.lastLevel;
  }

  /**
   * Update and return the warning level for the given token counts.
   */
  updateLevel(currentTokens: number, maxInputTokens: number): ContextWarningLevel {
    this.lastLevel = calculateWarningLevel(currentTokens, maxInputTokens);
    return this.lastLevel;
  }
}
