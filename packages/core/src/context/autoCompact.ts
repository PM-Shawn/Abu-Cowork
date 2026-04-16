import type { ClockAdapter } from '../ports/adapters/clock';

export type ContextWarningLevel = 0 | 1 | 2 | 3;

const LEVEL_1_THRESHOLD = 0.6;
const LEVEL_2_THRESHOLD = 0.75;
const LEVEL_3_THRESHOLD = 0.85;

const MAX_CONSECUTIVE_FAILURES = 3;
const COOLDOWN_MS = 5 * 60 * 1000;
const AUTH_DISABLE_MS = 30 * 60 * 1000;

export function calculateWarningLevel(
  currentTokens: number,
  maxInputTokens: number
): ContextWarningLevel {
  if (maxInputTokens <= 0) return 0;
  const ratio = currentTokens / maxInputTokens;
  if (ratio >= LEVEL_3_THRESHOLD) return 3;
  if (ratio >= LEVEL_2_THRESHOLD) return 2;
  if (ratio >= LEVEL_1_THRESHOLD) return 1;
  return 0;
}

export function getUsagePercent(currentTokens: number, maxInputTokens: number): number {
  if (maxInputTokens <= 0) return 0;
  return Math.round((currentTokens / maxInputTokens) * 100);
}

/**
 * AutoCompactTracker —— 带熔断器的自动压缩状态机。
 *
 * 对比 Abu 原版改动：
 * - 原版直接调 `Date.now()`；
 * - 新版构造时注入 ClockAdapter，便于测试用 FakeClock 驱动冷却。
 */
export class AutoCompactTracker {
  private consecutiveFailures = 0;
  private disabledUntil = 0;
  private lastLevel: ContextWarningLevel = 0;

  constructor(private readonly clock: ClockAdapter) {}

  shouldCompact(level: ContextWarningLevel): boolean {
    if (this.clock.now() < this.disabledUntil) return false;
    return level >= 2;
  }

  shouldForceHardTruncation(level: ContextWarningLevel): boolean {
    return level >= 3;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.disabledUntil = 0;
  }

  recordFailure(errorCode?: string): void {
    if (
      errorCode === 'network_error' ||
      errorCode === 'rate_limit' ||
      errorCode === 'overloaded'
    ) {
      return;
    }
    if (errorCode === 'authentication') {
      this.disabledUntil = this.clock.now() + AUTH_DISABLE_MS;
      return;
    }
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      this.disabledUntil = this.clock.now() + COOLDOWN_MS;
      this.consecutiveFailures = 0;
    }
  }

  isDisabled(): boolean {
    return this.clock.now() < this.disabledUntil;
  }

  getLastLevel(): ContextWarningLevel {
    return this.lastLevel;
  }

  updateLevel(currentTokens: number, maxInputTokens: number): ContextWarningLevel {
    this.lastLevel = calculateWarningLevel(currentTokens, maxInputTokens);
    return this.lastLevel;
  }
}
