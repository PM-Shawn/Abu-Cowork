import { describe, it, expect, beforeEach } from 'vitest';
import { useNoticeBadgeStore } from './noticeBadgeStore';

describe('noticeBadgeStore', () => {
  beforeEach(() => {
    useNoticeBadgeStore.setState({ counts: {} });
  });

  it('starts with empty counts', () => {
    expect(useNoticeBadgeStore.getState().counts).toEqual({});
  });

  it('increment adds 1 to conversation count', () => {
    useNoticeBadgeStore.getState().increment('c1');
    expect(useNoticeBadgeStore.getState().counts).toEqual({ c1: 1 });
  });

  it('increment stacks for same conversation', () => {
    const { increment } = useNoticeBadgeStore.getState();
    increment('c1');
    increment('c1');
    increment('c1');
    expect(useNoticeBadgeStore.getState().counts.c1).toBe(3);
  });

  it('increment tracks multiple conversations independently', () => {
    const { increment } = useNoticeBadgeStore.getState();
    increment('c1');
    increment('c2');
    increment('c1');
    const counts = useNoticeBadgeStore.getState().counts;
    expect(counts.c1).toBe(2);
    expect(counts.c2).toBe(1);
  });

  it('clear removes count for one conversation', () => {
    const { increment, clear } = useNoticeBadgeStore.getState();
    increment('c1');
    increment('c2');
    clear('c1');
    const counts = useNoticeBadgeStore.getState().counts;
    expect(counts.c1).toBeUndefined();
    expect(counts.c2).toBe(1);
  });

  it('clear is no-op for unknown conversation', () => {
    useNoticeBadgeStore.getState().clear('unknown');
    expect(useNoticeBadgeStore.getState().counts).toEqual({});
  });

  it('clearAll resets everything', () => {
    const { increment, clearAll } = useNoticeBadgeStore.getState();
    increment('c1');
    increment('c2');
    clearAll();
    expect(useNoticeBadgeStore.getState().counts).toEqual({});
  });
});
