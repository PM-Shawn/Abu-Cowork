import { describe, it, expect } from 'vitest';
import { createEventCoalescer } from './eventCoalescer';
import type { StreamEvent } from '@/types';

const text = (t: string): StreamEvent => ({ type: 'text', text: t });
const thinking = (t: string): StreamEvent => ({ type: 'thinking', thinking: t });
const toolUse = (id: string): StreamEvent => ({ type: 'tool_use', id, name: 'foo', input: {} });
const toolResult = (id: string): StreamEvent => ({ type: 'tool_result', toolUseId: id, result: 'ok' });
const usage = (): StreamEvent => ({ type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } });
const done = (): StreamEvent => ({ type: 'done', stopReason: 'end_turn' });
const errorEvt = (): StreamEvent => ({ type: 'error', error: 'boom' });

describe('eventCoalescer', () => {
  describe('merge adjacency', () => {
    it('merges two consecutive text deltas into one, buffering (empty return)', () => {
      const c = createEventCoalescer();
      expect(c.push(text('Hel'))).toEqual([]);
      expect(c.push(text('lo'))).toEqual([]);
      expect(c.hasPending()).toBe(true);
      expect(c.flush()).toEqual([text('Hello')]);
    });

    it('merges three-plus consecutive text deltas in arrival order', () => {
      const c = createEventCoalescer();
      c.push(text('a'));
      c.push(text('b'));
      c.push(text('c'));
      expect(c.flush()).toEqual([text('abc')]);
    });

    it('merges two consecutive thinking deltas into one', () => {
      const c = createEventCoalescer();
      expect(c.push(thinking('foo '))).toEqual([]);
      expect(c.push(thinking('bar'))).toEqual([]);
      expect(c.flush()).toEqual([thinking('foo bar')]);
    });
  });

  describe('type separation (text vs thinking, and vs non-mergeable)', () => {
    it('a thinking delta after a pending text delta flushes the text first, then buffers thinking', () => {
      const c = createEventCoalescer();
      c.push(text('hello'));
      // Switching type: the pending text is returned immediately (flushed),
      // and the thinking delta becomes the new pending buffer (not returned yet).
      expect(c.push(thinking('reasoning'))).toEqual([text('hello')]);
      expect(c.hasPending()).toBe(true);
      expect(c.flush()).toEqual([thinking('reasoning')]);
    });

    it('a text delta after a pending thinking delta flushes the thinking first, then buffers text', () => {
      const c = createEventCoalescer();
      c.push(thinking('reasoning'));
      expect(c.push(text('hello'))).toEqual([thinking('reasoning')]);
      expect(c.flush()).toEqual([text('hello')]);
    });

    it('alternating text/thinking/text never merges across the type boundary and preserves order', () => {
      const c = createEventCoalescer();
      const out: StreamEvent[] = [];
      out.push(...c.push(text('a1')));
      out.push(...c.push(text('a2'))); // merges with a1
      out.push(...c.push(thinking('t1'))); // flushes a1+a2 merged
      out.push(...c.push(thinking('t2'))); // merges with t1
      out.push(...c.push(text('b1'))); // flushes t1+t2 merged
      out.push(...c.flush()); // flushes b1
      expect(out).toEqual([text('a1a2'), thinking('t1t2'), text('b1')]);
    });
  });

  describe('non-mergeable flush ordering', () => {
    const nonMergeableCases: Array<{ name: string; event: () => StreamEvent }> = [
      { name: 'tool_use', event: () => toolUse('t1') },
      { name: 'tool_result', event: () => toolResult('t1') },
      { name: 'usage', event: () => usage() },
      { name: 'done', event: () => done() },
      { name: 'error', event: () => errorEvt() },
    ];

    for (const { name, event } of nonMergeableCases) {
      it(`${name} forces an immediate flush of pending text, then goes out itself in the SAME push() return`, () => {
        const c = createEventCoalescer();
        c.push(text('pending'));
        const evt = event();
        expect(c.push(evt)).toEqual([text('pending'), evt]);
        expect(c.hasPending()).toBe(false);
      });

      it(`${name} with nothing pending just passes through immediately, never buffered`, () => {
        const c = createEventCoalescer();
        const evt = event();
        expect(c.push(evt)).toEqual([evt]);
        expect(c.hasPending()).toBe(false);
      });
    }

    it('consecutive non-mergeable events never merge with each other', () => {
      const c = createEventCoalescer();
      const u = toolUse('a');
      const d = done();
      expect(c.push(u)).toEqual([u]);
      expect(c.push(d)).toEqual([d]);
    });
  });

  describe('seq / total-order invariant', () => {
    it('total order across a mixed stream is preserved end to end', () => {
      const c = createEventCoalescer();
      const out: StreamEvent[] = [];
      const feed = (e: StreamEvent) => out.push(...c.push(e));

      feed(text('Hel'));
      feed(text('lo '));
      feed(toolUse('call-1'));
      feed(text('world'));
      feed(usage());
      out.push(...c.flush());
      feed(done());

      // The explicit flush() call between usage() and done() is a no-op here —
      // usage() (non-mergeable) already cleared any pending buffer when it was
      // pushed, so there's nothing left to flush before done() passes through.
      expect(out).toEqual([
        text('Hello '),
        toolUse('call-1'),
        text('world'),
        usage(),
        done(),
      ]);
    });
  });

  describe('flush()', () => {
    it('is idempotent — returns [] when nothing is pending', () => {
      const c = createEventCoalescer();
      expect(c.flush()).toEqual([]);
      expect(c.flush()).toEqual([]);
    });

    it('end-of-stream flush emits the final buffered delta', () => {
      const c = createEventCoalescer();
      c.push(text('partial'));
      expect(c.hasPending()).toBe(true);
      expect(c.flush()).toEqual([text('partial')]);
      expect(c.hasPending()).toBe(false);
      expect(c.flush()).toEqual([]);
    });
  });

  describe('hasPending()', () => {
    it('is false initially', () => {
      expect(createEventCoalescer().hasPending()).toBe(false);
    });

    it('is true after a buffered mergeable push, false after a non-mergeable push', () => {
      const c = createEventCoalescer();
      c.push(text('a'));
      expect(c.hasPending()).toBe(true);
      c.push(done());
      expect(c.hasPending()).toBe(false);
    });
  });
});
