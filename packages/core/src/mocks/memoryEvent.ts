import type { EventAdapter, Unsubscribe } from '../ports/adapters/event';

export class MemoryEventAdapter implements EventAdapter {
  private handlers = new Map<string, Set<(p: unknown) => void>>();

  emit<T = unknown>(event: string, payload?: T): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const h of Array.from(set)) h(payload);
  }

  on<T = unknown>(event: string, handler: (payload: T) => void): Unsubscribe {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    const wrapped = handler as (p: unknown) => void;
    set.add(wrapped);
    return () => {
      set!.delete(wrapped);
      if (set!.size === 0) this.handlers.delete(event);
    };
  }

  once<T = unknown>(event: string, handler: (payload: T) => void): Unsubscribe {
    const off = this.on<T>(event, (p) => {
      off();
      handler(p);
    });
    return off;
  }
}
