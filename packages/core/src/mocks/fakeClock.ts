import type { ClockAdapter, TimerId } from '../ports/adapters/clock';

interface ScheduledTask {
  id: number;
  fireAt: number;
  cb: () => void;
  intervalMs?: number;
  active: boolean;
}

/**
 * FakeClockAdapter —— 可控时间 + 手动推进的时钟。
 * 测试时 `clock.advance(ms)` 推进并触发回调。
 */
export class FakeClockAdapter implements ClockAdapter {
  private current = 0;
  private nextId = 1;
  private tasks = new Map<number, ScheduledTask>();

  constructor(initialTime = 0) {
    this.current = initialTime;
  }

  now(): number {
    return this.current;
  }

  setTimeout(cb: () => void, ms: number): TimerId {
    const id = this.nextId++;
    this.tasks.set(id, { id, fireAt: this.current + ms, cb, active: true });
    return id;
  }

  clearTimeout(id: TimerId): void {
    const t = this.tasks.get(id as number);
    if (t) t.active = false;
    this.tasks.delete(id as number);
  }

  setInterval(cb: () => void, ms: number): TimerId {
    const id = this.nextId++;
    this.tasks.set(id, {
      id,
      fireAt: this.current + ms,
      cb,
      intervalMs: ms,
      active: true,
    });
    return id;
  }

  clearInterval(id: TimerId): void {
    this.clearTimeout(id);
  }

  /** 推进时间 ms，触发所有到期任务 */
  advance(ms: number): void {
    const target = this.current + ms;
    // 循环处理，防止 interval 在推进过程中连续到期
    while (true) {
      const due = [...this.tasks.values()]
        .filter((t) => t.active && t.fireAt <= target)
        .sort((a, b) => a.fireAt - b.fireAt);
      if (due.length === 0) break;
      const t = due[0];
      this.current = t.fireAt;
      t.cb();
      if (t.intervalMs != null && t.active) {
        t.fireAt = this.current + t.intervalMs;
      } else {
        this.tasks.delete(t.id);
      }
    }
    this.current = target;
  }
}

/** 真实系统时钟实现（用于非测试场景） */
export class SystemClockAdapter implements ClockAdapter {
  private timers = new Map<number, ReturnType<typeof setTimeout>>();
  private intervals = new Map<number, ReturnType<typeof setInterval>>();
  private nextId = 1;

  now(): number {
    return Date.now();
  }

  setTimeout(cb: () => void, ms: number): TimerId {
    const id = this.nextId++;
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        cb();
      }, ms)
    );
    return id;
  }

  clearTimeout(id: TimerId): void {
    const t = this.timers.get(id as number);
    if (t) {
      clearTimeout(t);
      this.timers.delete(id as number);
    }
  }

  setInterval(cb: () => void, ms: number): TimerId {
    const id = this.nextId++;
    this.intervals.set(id, setInterval(cb, ms));
    return id;
  }

  clearInterval(id: TimerId): void {
    const t = this.intervals.get(id as number);
    if (t) {
      clearInterval(t);
      this.intervals.delete(id as number);
    }
  }
}
