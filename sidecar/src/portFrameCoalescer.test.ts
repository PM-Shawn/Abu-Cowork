import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPortFrameCoalescer, type PortFrame } from './portFrameCoalescer';

const appendText = (convId: string, token: string, msgId?: string): PortFrame => ({
  p: 'chat',
  m: 'appendText',
  a: [convId, token, msgId],
});
const appendThinking = (convId: string, thinking: string, msgId?: string): PortFrame => ({
  p: 'chat',
  m: 'appendThinking',
  a: [convId, thinking, msgId],
});
const setMessageToolCalls = (convId: string, msgId: string, toolCalls: unknown[]): PortFrame => ({
  p: 'chat',
  m: 'setMessageToolCalls',
  a: [convId, msgId, toolCalls],
});
const addStep = (execId: string, step: unknown): PortFrame => ({
  p: 'exec',
  m: 'addStep',
  a: [execId, step],
});
const addEntry = (entry: unknown): PortFrame => ({ p: 'scratchpad', m: 'addEntry', a: [entry] });

describe('portFrameCoalescer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('merge of consecutive appendText same-target', () => {
    it('merges two consecutive appendText frames for the same convId+msgId, buffering (no send until flush)', () => {
      const send = vi.fn();
      const c = createPortFrameCoalescer(send);
      c.push(appendText('conv-1', 'Hel', 'msg-1'));
      c.push(appendText('conv-1', 'lo', 'msg-1'));
      expect(send).not.toHaveBeenCalled();
      expect(c.pendingCount()).toBe(1);
      c.flush();
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith([appendText('conv-1', 'Hello', 'msg-1')]);
    });

    it('merges three-plus consecutive appendThinking frames', () => {
      const send = vi.fn();
      const c = createPortFrameCoalescer(send);
      c.push(appendThinking('conv-1', 'a', 'msg-1'));
      c.push(appendThinking('conv-1', 'b', 'msg-1'));
      c.push(appendThinking('conv-1', 'c', 'msg-1'));
      c.flush();
      expect(send).toHaveBeenCalledWith([appendThinking('conv-1', 'abc', 'msg-1')]);
    });

    it('merges consecutive appendText frames that both omit msgId (undefined target is still "same target")', () => {
      const send = vi.fn();
      const c = createPortFrameCoalescer(send);
      c.push(appendText('conv-1', 'a'));
      c.push(appendText('conv-1', 'b'));
      c.flush();
      expect(send).toHaveBeenCalledWith([appendText('conv-1', 'ab')]);
    });
  });

  describe('no merge across different targets', () => {
    it('does not merge appendText frames with different msgId', () => {
      const send = vi.fn();
      const c = createPortFrameCoalescer(send);
      c.push(appendText('conv-1', 'a', 'msg-1'));
      c.push(appendText('conv-1', 'b', 'msg-2'));
      c.flush();
      expect(send).toHaveBeenCalledWith([appendText('conv-1', 'a', 'msg-1'), appendText('conv-1', 'b', 'msg-2')]);
    });

    it('does not merge appendText frames with different convId', () => {
      const send = vi.fn();
      const c = createPortFrameCoalescer(send);
      c.push(appendText('conv-1', 'a', 'msg-1'));
      c.push(appendText('conv-2', 'b', 'msg-1'));
      c.flush();
      expect(send).toHaveBeenCalledWith([appendText('conv-1', 'a', 'msg-1'), appendText('conv-2', 'b', 'msg-1')]);
    });

    it('does not merge appendText with appendThinking even for the same target', () => {
      const send = vi.fn();
      const c = createPortFrameCoalescer(send);
      c.push(appendText('conv-1', 'a', 'msg-1'));
      c.push(appendThinking('conv-1', 'b', 'msg-1'));
      c.flush();
      expect(send).toHaveBeenCalledWith([appendText('conv-1', 'a', 'msg-1'), appendThinking('conv-1', 'b', 'msg-1')]);
    });

    it('does not merge across different ports even with a coincidentally-matching method name', () => {
      const send = vi.fn();
      const c = createPortFrameCoalescer(send);
      c.push(appendText('conv-1', 'a', 'msg-1'));
      c.push({ p: 'exec', m: 'appendText', a: ['conv-1', 'b', 'msg-1'] });
      c.flush();
      expect(send).toHaveBeenCalledWith([
        appendText('conv-1', 'a', 'msg-1'),
        { p: 'exec', m: 'appendText', a: ['conv-1', 'b', 'msg-1'] },
      ]);
    });
  });

  describe('no merge when a discrete frame interleaves', () => {
    it('a discrete frame (setMessageToolCalls) interleaved between two appendText calls prevents merging across it', () => {
      const send = vi.fn();
      const c = createPortFrameCoalescer(send);
      c.push(appendText('conv-1', 'a', 'msg-1'));
      c.push(setMessageToolCalls('conv-1', 'msg-1', []));
      c.push(appendText('conv-1', 'b', 'msg-1'));
      c.flush();
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[0][0]).toEqual([appendText('conv-1', 'a', 'msg-1'), setMessageToolCalls('conv-1', 'msg-1', [])]);
      expect(send.mock.calls[1][0]).toEqual([appendText('conv-1', 'b', 'msg-1')]);
    });

    it('discrete frame with nothing pending sends immediately in its own batch', () => {
      const send = vi.fn();
      const c = createPortFrameCoalescer(send);
      c.push(addStep('exec-1', { id: 'step-1' }));
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith([addStep('exec-1', { id: 'step-1' })]);
    });
  });

  describe('flush()', () => {
    it('sends immediately and clears the pending buffer', () => {
      const send = vi.fn();
      const c = createPortFrameCoalescer(send);
      c.push(appendText('conv-1', 'partial', 'msg-1'));
      expect(c.pendingCount()).toBe(1);
      c.flush();
      expect(c.pendingCount()).toBe(0);
      expect(send).toHaveBeenCalledWith([appendText('conv-1', 'partial', 'msg-1')]);
    });

    it('is idempotent — a second flush with nothing pending does not call send again', () => {
      const send = vi.fn();
      const c = createPortFrameCoalescer(send);
      c.push(appendText('conv-1', 'x', 'msg-1'));
      c.flush();
      expect(send).toHaveBeenCalledTimes(1);
      c.flush();
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('flush() with nothing ever pushed is a no-op', () => {
      const send = vi.fn();
      const c = createPortFrameCoalescer(send);
      c.flush();
      expect(send).not.toHaveBeenCalled();
    });

    it('clears the window timer — a flush() followed by advancing past windowMs does not double-send', () => {
      const send = vi.fn();
      const c = createPortFrameCoalescer(send, { windowMs: 16 });
      c.push(appendText('conv-1', 'x', 'msg-1'));
      c.flush();
      expect(send).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(100);
      expect(send).toHaveBeenCalledTimes(1);
    });
  });

  describe('window timer', () => {
    it('fires send() automatically after windowMs with no explicit flush()', () => {
      const send = vi.fn();
      const c = createPortFrameCoalescer(send, { windowMs: 16 });
      c.push(appendText('conv-1', 'a', 'msg-1'));
      expect(send).not.toHaveBeenCalled();
      vi.advanceTimersByTime(16);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith([appendText('conv-1', 'a', 'msg-1')]);
    });

    it('defaults to a 16ms window when opts is omitted', () => {
      const send = vi.fn();
      const c = createPortFrameCoalescer(send);
      c.push(appendText('conv-1', 'a', 'msg-1'));
      vi.advanceTimersByTime(15);
      expect(send).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('a merge within the window does not re-arm past the original deadline', () => {
      const send = vi.fn();
      const c = createPortFrameCoalescer(send, { windowMs: 16 });
      c.push(appendText('conv-1', 'a', 'msg-1'));
      vi.advanceTimersByTime(10);
      c.push(appendText('conv-1', 'b', 'msg-1')); // merges, window already armed
      vi.advanceTimersByTime(6);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith([appendText('conv-1', 'ab', 'msg-1')]);
    });
  });

  describe('order preservation across mixed frames', () => {
    it('preserves total order across merge runs, discrete frames, and different ports', () => {
      const send = vi.fn();
      const batches: PortFrame[][] = [];
      const c = createPortFrameCoalescer((frames) => batches.push(frames));
      void send;

      c.push(appendText('conv-1', 'a1', 'msg-1'));
      c.push(appendText('conv-1', 'a2', 'msg-1')); // merges with a1
      c.push(addStep('exec-1', { id: 's1' })); // discrete — flushes a1+a2 merged, then itself
      c.push(addEntry({ title: 't' })); // discrete — no pending, sends alone
      c.push(appendThinking('conv-1', 't1', 'msg-1'));
      c.push(appendThinking('conv-1', 't2', 'msg-1')); // merges with t1
      c.flush(); // flushes t1+t2 merged

      const flat = batches.flat();
      expect(flat).toEqual([
        appendText('conv-1', 'a1a2', 'msg-1'),
        addStep('exec-1', { id: 's1' }),
        addEntry({ title: 't' }),
        appendThinking('conv-1', 't1t2', 'msg-1'),
      ]);
    });
  });

  describe('pendingCount()', () => {
    it('is 0 initially', () => {
      const c = createPortFrameCoalescer(vi.fn());
      expect(c.pendingCount()).toBe(0);
    });

    it('is 1 after a buffered mergeable push, 0 after a discrete push', () => {
      const c = createPortFrameCoalescer(vi.fn());
      c.push(appendText('conv-1', 'a', 'msg-1'));
      expect(c.pendingCount()).toBe(1);
      c.push(addStep('exec-1', {}));
      expect(c.pendingCount()).toBe(0);
    });
  });
});
