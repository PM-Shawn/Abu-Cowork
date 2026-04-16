import type { StorageAdapter, UnwatchFn } from '../ports/adapters/storage';
import type { ClockAdapter, TimerId } from '../ports/adapters/clock';
import type { LoggerAdapter } from '../ports/adapters/logger';
import type { TriggerRule } from '../ports/repos/trigger';
import { matchesGlob } from './fileMatcher';
import { scopedLogger } from '../logging/scopedLogger';

/**
 * FileTriggerWatcher —— 监听文件变化，按 rule.source.pattern/events 过滤后触发 executor。
 *
 * 对比 Abu 原版改动：
 * - 原 `triggerEngine.ts` 将 cron/file/http/im 四种来源耦合在一个大 class 里；
 * - core 拆分：cron → scheduler.DueTaskScheduler；file → 本类；http/im → shell 侧。
 * - 原版用 `@tauri-apps/plugin-fs` 的 watch；新版通过 StorageAdapter.watch 注入。
 */

const DEBOUNCE_MS = 200;

/**
 * 事件别名说明：Abu 的 `FileSource.events` 使用 `delete`，StorageAdapter 的
 * `FileChangeEvent.type` 使用 `remove`。对外统一为 `delete`（遵循 rule 定义）。
 */
export interface FileTriggerExecutor {
  (rule: TriggerRule, path: string, event: 'create' | 'modify' | 'delete'): Promise<void>;
}

export interface FileTriggerWatcherDeps {
  storage: StorageAdapter;
  clock: ClockAdapter;
  logger: LoggerAdapter;
  executor: FileTriggerExecutor;
}

interface Registration {
  rule: TriggerRule;
  unwatch: UnwatchFn;
  debounceTimer: TimerId | null;
  pendingEvents: Map<string, 'create' | 'modify' | 'delete'>;
}

export class FileTriggerWatcher {
  private registered = new Map<string, Registration>();
  private readonly log: ReturnType<typeof scopedLogger>;

  constructor(private readonly deps: FileTriggerWatcherDeps) {
    this.log = scopedLogger(deps.logger, 'fileTrigger');
  }

  /** 注册一条 file-source 的 rule。若同 id 已注册，先解注册 */
  register(rule: TriggerRule): void {
    if (rule.source.type !== 'file') return;
    if (this.registered.has(rule.id)) this.unregister(rule.id);

    const { path, events, pattern } = rule.source;
    const allowed = new Set(events);

    const reg: Registration = {
      rule,
      unwatch: () => {},
      debounceTimer: null,
      pendingEvents: new Map(),
    };

    reg.unwatch = this.deps.storage.watch(path, (evt) => {
      // Map fs event types → trigger event types (Abu rule 用 'delete'，storage 用 'remove')
      let tEvent: 'create' | 'modify' | 'delete' | null = null;
      if (evt.type === 'create') tEvent = 'create';
      else if (evt.type === 'modify') tEvent = 'modify';
      else if (evt.type === 'remove') tEvent = 'delete';
      if (!tEvent || !allowed.has(tEvent)) return;
      if (pattern && !matchesGlob(evt.path, pattern)) return;

      reg.pendingEvents.set(evt.path, tEvent);

      if (reg.debounceTimer !== null) this.deps.clock.clearTimeout(reg.debounceTimer);
      reg.debounceTimer = this.deps.clock.setTimeout(() => {
        reg.debounceTimer = null;
        const events = Array.from(reg.pendingEvents.entries());
        reg.pendingEvents.clear();
        for (const [p, ev] of events) {
          void this.fire(rule, p, ev);
        }
      }, DEBOUNCE_MS);
    });

    this.registered.set(rule.id, reg);
    this.log.info('registered', { ruleId: rule.id, path, events });
  }

  unregister(ruleId: string): void {
    const reg = this.registered.get(ruleId);
    if (!reg) return;
    reg.unwatch();
    if (reg.debounceTimer !== null) this.deps.clock.clearTimeout(reg.debounceTimer);
    this.registered.delete(ruleId);
    this.log.info('unregistered', { ruleId });
  }

  unregisterAll(): void {
    for (const id of Array.from(this.registered.keys())) this.unregister(id);
  }

  isRegistered(ruleId: string): boolean {
    return this.registered.has(ruleId);
  }

  private async fire(
    rule: TriggerRule,
    path: string,
    event: 'create' | 'modify' | 'delete'
  ): Promise<void> {
    try {
      await this.deps.executor(rule, path, event);
    } catch (err) {
      this.log.error('executor threw', {
        ruleId: rule.id,
        path,
        event,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
