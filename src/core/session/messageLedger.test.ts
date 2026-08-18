import { describe, it, expect } from 'vitest';
import { createLedgerEvent, foldMessageLog, type LedgerLine } from './messageLedger';
import { loadFoldFixtures, projectFolded } from '@/test/foldFixtures';
import type { Message } from '@/types';

/**
 * The pre-ledger dedup that `loadMessages` used before `foldMessageLog`.
 * Kept verbatim here so the equivalence test below is a real comparison
 * against the old behaviour, not against a paraphrase of it.
 */
function legacyDedupMessagesById(messages: Message[]): Message[] {
  const lastIndex = new Map<string, number>();
  messages.forEach((m, i) => lastIndex.set(m.id, i));
  if (lastIndex.size === messages.length) return messages;
  return messages.filter((m, i) => lastIndex.get(m.id) === i);
}

function legacyLoad(lines: string[]): Message[] {
  const parsed: Message[] = [];
  for (const line of lines.filter((l) => l.length > 0)) {
    try {
      parsed.push(JSON.parse(line) as Message);
    } catch {
      /* skip corrupt line */
    }
  }
  return legacyDedupMessagesById(parsed);
}

describe('messageLedger', () => {
  describe('foldMessageLog', () => {
    for (const testCase of loadFoldFixtures()) {
      it(`fixture: ${testCase.name}`, () => {
        const result = foldMessageLog(testCase.lines);
        expect(projectFolded(result.messages)).toEqual(testCase.expected.messages);
        expect(result.corruptCount).toBe(testCase.expected.corruptCount);
        expect(result.totalLines).toBe(testCase.expected.totalLines);
      });
    }

    it('is a strictly sequential replay — a truncate never deletes lines written after it', () => {
      // Edit-and-resend: deleteMessagesFrom(m2) is followed immediately by the
      // new turn's messages. A "collect the delete set, apply at the end" fold
      // would swallow the entire resent turn (plan §3.3).
      const result = foldMessageLog([
        JSON.stringify({ id: 'm1', role: 'user', content: 'a', timestamp: 1 }),
        JSON.stringify({ id: 'm2', role: 'assistant', content: 'b', timestamp: 2 }),
        JSON.stringify(createLedgerEvent('msg.truncate', { id: 'ev1', timestamp: 3, from: 'm2' })),
        JSON.stringify({ id: 'm3', role: 'user', content: 'edited', timestamp: 4 }),
      ]);
      expect(result.messages.map((m) => m.id)).toEqual(['m1', 'm3']);
    });

    it('keeps the last revision at the ORIGINAL position, not at the end', () => {
      const result = foldMessageLog([
        JSON.stringify({ id: 'a', role: 'user', content: '1', timestamp: 1 }),
        JSON.stringify({ id: 'b', role: 'assistant', content: '2', timestamp: 2 }),
        JSON.stringify({ id: 'c', role: 'user', content: '3', timestamp: 3 }),
        JSON.stringify({ id: 'a', role: 'user', content: '1-revised', timestamp: 4 }),
      ]);
      expect(result.messages.map((m) => m.id)).toEqual(['a', 'b', 'c']);
      expect(result.messages[0].content).toBe('1-revised');
    });

    it('does not mutate the input lines array', () => {
      const lines = [JSON.stringify({ id: 'a', role: 'user', content: '1', timestamp: 1 })];
      const snapshot = [...lines];
      foldMessageLog(lines);
      expect(lines).toEqual(snapshot);
    });
  });

  describe('equivalence with the pre-ledger dedup', () => {
    it('matches legacy output exactly for a log of bare Message lines', () => {
      const lines = [
        JSON.stringify({ id: 'm1', role: 'user', content: 'a', timestamp: 1 }),
        JSON.stringify({ id: 'm2', role: 'assistant', content: 'b', timestamp: 2 }),
        JSON.stringify({ id: 'm3', role: 'user', content: 'c', timestamp: 3 }),
      ];
      expect(foldMessageLog(lines).messages).toEqual(legacyLoad(lines));
    });

    it('matches legacy output when a corrupt line sits in the middle', () => {
      const lines = [
        JSON.stringify({ id: 'm1', role: 'user', content: 'a', timestamp: 1 }),
        '{"id":"m2","role":"user","content":"trun',
        JSON.stringify({ id: 'm3', role: 'user', content: 'c', timestamp: 3 }),
      ];
      expect(foldMessageLog(lines).messages).toEqual(legacyLoad(lines));
    });

    it('DIVERGES from legacy only on duplicate ids — legacy moved the survivor to the end', () => {
      // This is the one deliberate difference (plan §3.3 vs §5's "identical
      // output" claim): the old dedup was a positional filter, so a duplicated
      // id reordered the conversation. Appending revisions makes duplicate ids
      // the normal case, so the in-place rule is the one that has to win.
      const lines = [
        JSON.stringify({ id: 'm1', role: 'user', content: 'v1', timestamp: 1 }),
        JSON.stringify({ id: 'm2', role: 'assistant', content: 'b', timestamp: 2 }),
        JSON.stringify({ id: 'm1', role: 'user', content: 'v2', timestamp: 3 }),
      ];
      expect(legacyLoad(lines).map((m) => m.id)).toEqual(['m2', 'm1']);
      expect(foldMessageLog(lines).messages.map((m) => m.id)).toEqual(['m1', 'm2']);
      // Same set, same survivors — only the order differs.
      expect(new Set(foldMessageLog(lines).messages.map((m) => m.content)))
        .toEqual(new Set(legacyLoad(lines).map((m) => m.content)));
    });
  });

  describe('createLedgerEvent', () => {
    const KINDS = ['msg.tomb', 'msg.truncate', 'msg.loopDrop'] as const;

    for (const kind of KINDS) {
      it(`${kind} is also a legal, invisible Message (rollback safety, plan §5.2)`, () => {
        const event = createLedgerEvent(kind, { id: 'ev1', timestamp: 1000, target: 'm1', from: 'm1', loopId: 'L1' });
        // Required by Message: content must exist (older renderers do content.length).
        expect(event.content).toBe('');
        expect(typeof event.content).toBe('string');
        // Hidden by existing UI and harmless in an older build's LLM context.
        expect(event.isSystem).toBe(true);
        expect(event.role).toBe('system');
        expect(event.id).toBe('ev1');
        expect(event.timestamp).toBe(1000);
        expect(event.lk).toBe(kind);
      });
    }

    it('survives a JSON round-trip through the fold as an event, not a message', () => {
      const event = createLedgerEvent('msg.tomb', { id: 'ev1', timestamp: 5, target: 'm1' });
      const result = foldMessageLog([
        JSON.stringify({ id: 'm1', role: 'user', content: 'a', timestamp: 1 }),
        JSON.stringify(event),
      ]);
      expect(result.messages).toEqual([]);
      expect(result.corruptCount).toBe(0);
    });

    it('omits optional payload fields that were not supplied', () => {
      const event: LedgerLine = createLedgerEvent('msg.tomb', { id: 'ev1', timestamp: 5, target: 'm1' });
      expect(event.from).toBeUndefined();
      expect(event.loopId).toBeUndefined();
      expect(event.pid).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(event, 'from')).toBe(false);
    });
  });
});
