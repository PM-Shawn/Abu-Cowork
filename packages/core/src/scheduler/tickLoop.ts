import type { ClockAdapter, TimerId } from '../ports/adapters/clock';
import type { LoggerAdapter } from '../ports/adapters/logger';

export interface TickLoopDeps {
  clock: ClockAdapter;
  logger: LoggerAdapter;
  intervalMs: number;
  onTick: () => void | Promise<void>;
  /** 是否在 start() 时立即执行一次 */
  runImmediately?: boolean;
}

/**
 * TickLoop —— 独立于业务的"周期性执行"基元。
 *
 * 对比 Abu 原版改动：
 * - 原 `SchedulerEngine` 自己管 `setInterval` 定时器；
 * - 新版抽出 TickLoop：只负责 tick 循环 + 错误隔离；
 * - 具体任务执行逻辑由 `onTick` 注入，测试时用 FakeClock.advance 驱动。
 */
export class TickLoop {
  private timerId: TimerId | null = null;
  private ticking = false;

  constructor(private readonly deps: TickLoopDeps) {}

  start(): void {
    if (this.timerId !== null) return;
    const { clock, intervalMs, runImmediately } = this.deps;
    if (runImmediately) void this.safeTick();
    this.timerId = clock.setInterval(() => void this.safeTick(), intervalMs);
  }

  stop(): void {
    if (this.timerId !== null) {
      this.deps.clock.clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  private async safeTick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.deps.onTick();
    } catch (err) {
      this.deps.logger.log(
        'error',
        'tickLoop',
        'onTick threw',
        err instanceof Error ? { message: err.message, stack: err.stack } : { err }
      );
    } finally {
      this.ticking = false;
    }
  }

  isRunning(): boolean {
    return this.timerId !== null;
  }
}
