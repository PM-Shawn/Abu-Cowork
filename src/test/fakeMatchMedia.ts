type Listener = () => void;

// Stand-in for window.matchMedia: tests set each query's answer and fire change events.
export function fakeMatchMedia(initial: Record<string, boolean>) {
  const state: Record<string, boolean> = { ...initial };
  const listeners = new Map<string, Set<Listener>>();
  const matchMedia = (query: string) => ({
    media: query,
    get matches() { return state[query] ?? false; },
    addEventListener: (_type: string, listener: Listener) => {
      if (!listeners.has(query)) listeners.set(query, new Set());
      listeners.get(query)!.add(listener);
    },
    removeEventListener: (_type: string, listener: Listener) => { listeners.get(query)?.delete(listener); },
  });
  return {
    matchMedia: matchMedia as unknown as typeof window.matchMedia,
    change(query: string, value: boolean) {
      state[query] = value;
      listeners.get(query)?.forEach((listener) => listener());
    },
    listenerCount: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
  };
}
