import { describe, it, expect } from 'vitest';
import { cancelDispatch, createSubagentController, isDispatchActive, withDispatchController } from './subagentAbort';

describe('dispatch keys (team member stop)', () => {
  it('cancelDispatch aborts only the run registered under that key', () => {
    const a = createSubagentController('zz取数员', undefined, 'tc-1:0');
    const b = createSubagentController('zz撰写员', undefined, 'tc-1:1');
    expect(isDispatchActive('tc-1:0')).toBe(true);
    expect(cancelDispatch('tc-1:0')).toBe(true);
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
    expect(isDispatchActive('tc-1:0')).toBe(false);
    expect(cancelDispatch('tc-1:0')).toBe(false);
    b.cleanup();
    expect(isDispatchActive('tc-1:1')).toBe(false);
  });

  it('withDispatchController registers for the duration of the run and cascades the parent abort', async () => {
    const parent = new AbortController();
    let seen: AbortSignal | undefined;
    const done = withDispatchController('m', parent.signal, 'tc-2:0', async (signal) => {
      seen = signal;
      expect(isDispatchActive('tc-2:0')).toBe(true);
      await new Promise((r) => setTimeout(r, 5));
      return 'ok';
    });
    parent.abort();
    expect(seen?.aborted).toBe(true);
    await expect(done).resolves.toBe('ok');
    expect(isDispatchActive('tc-2:0')).toBe(false);
  });
});
