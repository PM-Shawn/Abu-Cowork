import type { ClockAdapter, TimerId } from '../ports/adapters/clock';

export interface Heartbeat {
  reset(): void;
  clear(): void;
}

/**
 * 对比 Abu 原版改动：
 * - 原版直接使用 globalThis.setTimeout；
 * - 新版通过 ClockAdapter 注入，便于 FakeClock 推进测试。
 */
export function createHeartbeat(
  clock: ClockAdapter,
  timeoutMs: number,
  onTimeout: () => void
): Heartbeat {
  let timer: TimerId | null = null;

  function reset(): void {
    if (timer !== null) clock.clearTimeout(timer);
    timer = clock.setTimeout(onTimeout, timeoutMs);
  }

  function clear(): void {
    if (timer !== null) {
      clock.clearTimeout(timer);
      timer = null;
    }
  }

  return { reset, clear };
}
