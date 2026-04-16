import type { ClockAdapter } from '../ports/adapters/clock';
import type { LoggerAdapter } from '../ports/adapters/logger';
import type { TriggerRepo, TriggerRule } from '../ports/repos/trigger';
import { TickLoop } from './tickLoop';

/**
 * DueTaskScheduler —— 按 cron 间隔执行 TriggerRule。
 *
 * 架构决策：
 * - Abu 原 `scheduler/scheduler.ts` 和 `trigger/triggerEngine.ts` 在 V1 是两套东西；
 *   core 侧合并为"基于 TriggerRule (source.type === 'cron') 的调度"（见 Core接口草案 未决点 #5）；
 * - 本类只负责"到点 → 调 executor"。任务真正做什么（创建会话、调 agent、发 IM 推送）
 *   由 caller 通过 `deps.executor` 注入。
 * - 跑任务失败 / 成功由 executor 自己决定是否回写 TriggerRepo.recordRun。
 */

export type TaskExecutor = (rule: TriggerRule) => Promise<void>;

export interface DueTaskSchedulerDeps {
  triggers: TriggerRepo;
  clock: ClockAdapter;
  logger: LoggerAdapter;
  executor: TaskExecutor;
  /** tick 周期，默认 60s */
  intervalMs?: number;
}

export class DueTaskScheduler {
  private loop: TickLoop;
  private runningIds = new Set<string>();
  /** 上次执行时间（毫秒），用于 cron 到期判断 */
  private lastRunAt = new Map<string, number>();

  constructor(private readonly deps: DueTaskSchedulerDeps) {
    this.loop = new TickLoop({
      clock: deps.clock,
      logger: deps.logger,
      intervalMs: deps.intervalMs ?? 60_000,
      runImmediately: true,
      onTick: () => this.tick(),
    });
  }

  start(): void {
    this.loop.start();
  }

  stop(): void {
    this.loop.stop();
  }

  isRunning(): boolean {
    return this.loop.isRunning();
  }

  async runNow(ruleId: string): Promise<void> {
    const rule = await this.deps.triggers.getRule(ruleId);
    if (!rule) return;
    if (this.runningIds.has(rule.id)) return;
    this.runningIds.add(rule.id);
    try {
      await this.deps.executor(rule);
      this.lastRunAt.set(rule.id, this.deps.clock.now());
    } finally {
      this.runningIds.delete(rule.id);
    }
  }

  isTaskRunning(ruleId: string): boolean {
    return this.runningIds.has(ruleId);
  }

  /** 暴露供测试：返回当前 tick 到期的 rule 列表（不真正执行） */
  async getDueRules(now: number = this.deps.clock.now()): Promise<TriggerRule[]> {
    const rules = await this.deps.triggers.listRules();
    const due: TriggerRule[] = [];
    for (const rule of rules) {
      if (!rule.enabled) continue;
      if (rule.source.type !== 'cron') continue;
      const intervalSeconds = rule.source.intervalSeconds;
      if (!intervalSeconds || intervalSeconds <= 0) continue;
      const lastRun = this.lastRunAt.get(rule.id);
      if (lastRun == null) {
        due.push(rule);
      } else if (now - lastRun >= intervalSeconds * 1000) {
        due.push(rule);
      }
    }
    return due;
  }

  private async tick(): Promise<void> {
    const now = this.deps.clock.now();
    const due = await this.getDueRules(now);
    for (const rule of due) {
      if (this.runningIds.has(rule.id)) continue;
      this.runningIds.add(rule.id);
      this.lastRunAt.set(rule.id, now);
      void this.runAndRelease(rule);
    }
  }

  private async runAndRelease(rule: TriggerRule): Promise<void> {
    try {
      await this.deps.executor(rule);
    } catch (err) {
      this.deps.logger.log('error', 'scheduler', 'executor threw', {
        ruleId: rule.id,
        err: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.runningIds.delete(rule.id);
    }
  }
}
