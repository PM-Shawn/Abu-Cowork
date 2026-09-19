// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
type Runtime = { referenceBase: number; cancelAction?: (id: string) => void; handleAction?: (action: string, payload: Record<string, unknown>) => Promise<unknown> };
async function runtime(base: number) {
  vi.resetModules();
  const entry: Runtime = { referenceBase: base };
  (globalThis as unknown as Record<string, unknown>).__ABU_ELECTRON_BROWSER_RUNTIME__ = entry;
  await import('./index');
  return entry.handleAction!;
}
afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ''; });
it('built-in reinitialization cannot resolve a previous document reference to a new button', async () => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 20, bottom: 20, width: 20, height: 20, toJSON: () => ({}) });
  document.body.innerHTML = '<button>First</button>';
  const first = await runtime(1_000_000);
  const old = await first('snapshot', {}) as { elements: Array<{ ref: string }> };
  expect(old.elements[0].ref).toBe('e1000001');
  document.body.innerHTML = '<button>Second</button>';
  const click = vi.fn(); document.querySelector('button')!.addEventListener('click', click);
  const second = await runtime(2_000_000);
  const fresh = await second('snapshot', {}) as { elements: Array<{ ref: string }> };
  expect(fresh.elements[0].ref).toBe('e2000001');
  await expect(second('click', { locator: { ref: old.elements[0].ref } })).rejects.toThrow();
  expect(click).not.toHaveBeenCalled();
  await second('click', { locator: { ref: fresh.elements[0].ref } });
  expect(click).toHaveBeenCalledTimes(1);
});

it('cancelling a built-in wait releases observers and timers without waiting for its timeout', async () => {
  vi.useFakeTimers();
  try {
    const handle = await runtime(3_000_000);
    const pending = handle('wait_for', { condition: { type: 'appear', locator: { css: '#later' } }, timeout: 30000, __abuOperationId: 'wait-1' });
    const entry = (globalThis as unknown as { __ABU_ELECTRON_BROWSER_RUNTIME__: Runtime }).__ABU_ELECTRON_BROWSER_RUNTIME__;
    entry.cancelAction!('wait-1');
    await expect(pending).resolves.toMatchObject({ success: false, timedOut: false, message: 'Browser wait cancelled.' });
    expect(vi.getTimerCount()).toBe(0);
    // Completed operations leave no cancellation tombstone.
    document.body.innerHTML = '<input id="later">';
    await expect(handle('wait_for', { condition: { type: 'disappear', locator: { css: '#missing' } }, __abuOperationId: 'wait-1' })).resolves.toMatchObject({ success: true });
  } finally { vi.useRealTimers(); }
});
