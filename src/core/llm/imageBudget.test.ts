import { describe, it, expect } from 'vitest';
import type { Message, MessageContent, ToolResultContent } from '../../types';
import { enforceImageBudget, OFFLOADED_IMAGE_NOTE } from './imageBudget';
import { normalizeMessages } from './messageNormalizer';

// Filler timestamp (TESTING.md §3) — never asserted on.
const TS = 1_700_000_000_000;

/** Exactly `bytes` characters of payload — `.slice` so a multi-character marker
 *  cannot silently inflate the size the budget sees. */
function payload(bytes: number, marker: string): string {
  return marker.repeat(bytes).slice(0, bytes);
}

/** An image block whose base64 payload is exactly `bytes` characters long. */
function image(bytes: number, marker = 'x'): Extract<MessageContent, { type: 'image' }> {
  return { type: 'image', source: { type: 'base64', media_type: 'image/png', data: payload(bytes, marker) } };
}

function userWith(...content: MessageContent[]): Message {
  return { id: `u${content.length}`, role: 'user', content, timestamp: TS };
}

function assistantWithToolImage(bytes: number, marker: string, key: 'toolCalls' | 'toolCallsForContext' = 'toolCalls'): Message {
  const resultContent: ToolResultContent[] = [
    { type: 'text', text: 'Screenshot taken' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: payload(bytes, marker) } },
  ];
  const call = { id: 'tc1', name: 'computer', input: {}, result: 'Screenshot taken', resultContent };
  return { id: 'a1', role: 'assistant', content: '', timestamp: TS, [key]: [call] } as Message;
}

/** Every image payload still present, in send order. */
function survivingPayloads(messages: Message[]): string[] {
  const out: string[] = [];
  for (const message of messages) {
    if (Array.isArray(message.content)) {
      for (const block of message.content) if (block.type === 'image') out.push(block.source.data);
    }
    const calls = message.toolCallsForContext ?? message.toolCalls;
    for (const call of calls ?? []) {
      for (const block of call.resultContent ?? []) if (block.type === 'image') out.push(block.source.data);
    }
    // (tool-result images are also asserted through normalizeMessages below)
  }
  return out;
}

/**
 * How many times the note reaches the MODEL — counted on the normalized turns,
 * not on the message tree.
 *
 * The original version stringified `Message[]`, which certified nothing: a text
 * block sitting in a tool result looks present there but is dropped by
 * `normalizeMessages` (it builds the `tool` message from the `result` string and
 * reads `resultContent` only via `extractImages`). That gap shipped once and the
 * test stayed green through it.
 */
function noteCount(messages: Message[]): number {
  const turns = normalizeMessages(messages, { supportsVision: true });
  return JSON.stringify(turns).split(OFFLOADED_IMAGE_NOTE).length - 1;
}

describe('enforceImageBudget', () => {
  it('leaves a fitting request untouched, same array reference', () => {
    const messages = [userWith(image(100), { type: 'text', text: 'hi' })];
    expect(enforceImageBudget(messages, 1000)).toBe(messages);
  });

  it('drops the OLDEST images and keeps the newest', () => {
    const messages = [userWith(image(100, 'a')), userWith(image(100, 'b')), userWith(image(100, 'c'))];
    const out = enforceImageBudget(messages, 150);

    // 300 total, budget 150 → drop until it fits: a, then b. c survives.
    expect(survivingPayloads(out)).toEqual([payload(100, 'c')]);
    expect(noteCount(out)).toBe(2);
  });

  // The current turn is almost always about the newest image, so the newest is
  // the last thing to go — the opposite choice would drop exactly what the user
  // just attached.
  it('keeps the newest image even when it alone fills the budget', () => {
    const messages = [userWith(image(100, 'a')), userWith(image(100, 'b'))];
    const out = enforceImageBudget(messages, 100);
    expect(survivingPayloads(out)).toEqual([payload(100, 'b')]);
  });

  // Keeping it would guarantee the very 413 this function exists to prevent.
  it('drops a lone image that is bigger than the entire budget', () => {
    const messages = [userWith(image(500, 'a'), { type: 'text', text: 'look' })];
    const out = enforceImageBudget(messages, 100);
    expect(survivingPayloads(out)).toEqual([]);
    expect(noteCount(out)).toBe(1);
    expect(JSON.stringify(out)).toContain('look'); // text survives
  });

  // Replay safety: the request must be a pure function of (history, policy).
  it('is deterministic — same input twice yields identical output', () => {
    const build = () => [userWith(image(100, 'a')), userWith(image(100, 'b')), userWith(image(100, 'c'))];
    expect(JSON.stringify(enforceImageBudget(build(), 150)))
      .toBe(JSON.stringify(enforceImageBudget(build(), 150)));
  });

  // Position, not object identity, decides. Two byte-identical images are NOT
  // interchangeable: a replay has to drop the one in the same slot.
  it('picks by position even when two images are byte-identical', () => {
    const twin = image(100, 'a');
    const messages = [userWith(twin), userWith(twin), userWith(image(100, 'z'))];
    const out = enforceImageBudget(messages, 150);
    expect(survivingPayloads(out)).toEqual([payload(100, 'z')]);
  });

  it('does not mutate the input messages', () => {
    const messages = [userWith(image(100, 'a')), userWith(image(100, 'b'))];
    const before = JSON.stringify(messages);
    enforceImageBudget(messages, 50);
    expect(JSON.stringify(messages)).toBe(before);
  });

  // Tool-result screenshots are inlined into the request body exactly like user
  // uploads, so a budget that ignored them would not bound the body.
  it('counts and drops tool-result images too', () => {
    const messages = [assistantWithToolImage(200, 'a'), userWith(image(100, 'b'))];
    const out = enforceImageBudget(messages, 150);
    expect(survivingPayloads(out)).toEqual([payload(100, 'b')]);
    expect(noteCount(out)).toBe(1);
  });

  // toolCallsForContext is the canonical send representation; reading both would
  // charge one tool exchange twice and over-drop.
  it('reads toolCallsForContext only, not the toolCalls fallback, when both exist', () => {
    const base = assistantWithToolImage(100, 'c', 'toolCallsForContext');
    const withBoth = {
      ...base,
      toolCalls: [{ id: 'tc1', name: 'computer', input: {}, result: 'x', resultContent: [image(100, 'u')] }],
    } as Message;

    // Only the 100-char context image counts, so a 150 budget fits and nothing
    // drops. Were the toolCalls fallback counted too, the total would read 200
    // and this would over-drop.
    const messages = [withBoth];
    expect(enforceImageBudget(messages, 150)).toBe(messages);
    expect(noteCount(enforceImageBudget(messages, 150))).toBe(0);

    // And when the budget genuinely bites, the dropped image is the context one.
    const tightened = enforceImageBudget(messages, 50);
    expect(survivingPayloads(tightened)).toEqual([]);
    expect(noteCount(tightened)).toBe(1);
  });

  it('ignores string-content messages and images with no payload', () => {
    const messages: Message[] = [
      { id: 's1', role: 'user', content: 'plain text', timestamp: TS },
      userWith({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } }),
    ];
    expect(enforceImageBudget(messages, 10)).toBe(messages);
  });

  it('treats a non-positive or non-finite budget as "no budget"', () => {
    const messages = [userWith(image(500, 'a'))];
    expect(enforceImageBudget(messages, 0)).toBe(messages);
    expect(enforceImageBudget(messages, -1)).toBe(messages);
    expect(enforceImageBudget(messages, Number.NaN)).toBe(messages);
  });

  it('tells the model how to recover rather than thinning history silently', () => {
    const out = enforceImageBudget([userWith(image(500, 'a'))], 100);
    expect(OFFLOADED_IMAGE_NOTE).toMatch(/omitted/i);
    expect(JSON.stringify(out)).toContain(OFFLOADED_IMAGE_NOTE);
  });
});

// The regression these tests exist for: the note has to survive normalization
// and land in the request, not merely sit in the message tree. Asserted on the
// serialized turns, the same way openai-vision-gating.test.ts checks images.
describe('enforceImageBudget — the note actually reaches the model', () => {
  it('puts the note in the tool message the model reads, not in a dropped block', () => {
    const messages = [assistantWithToolImage(200, 'a'), userWith(image(100, 'b'))];
    const turns = normalizeMessages(enforceImageBudget(messages, 150), { supportsVision: true });
    const wire = JSON.stringify(turns);

    expect(wire).toContain(OFFLOADED_IMAGE_NOTE);
    // The original tool text survives alongside it.
    expect(wire).toContain('Screenshot taken');
    // And the dropped screenshot is gone from what the model sees.
    expect(wire).not.toContain(payload(200, 'a'));
  });

  it('carries the note for a dropped user image too', () => {
    const turns = normalizeMessages(enforceImageBudget([userWith(image(500, 'a'))], 100), { supportsVision: true });
    expect(JSON.stringify(turns)).toContain(OFFLOADED_IMAGE_NOTE);
  });

  it('says nothing when the request already fits', () => {
    const turns = normalizeMessages(enforceImageBudget([userWith(image(50, 'a'))], 1000), { supportsVision: true });
    expect(JSON.stringify(turns)).not.toContain(OFFLOADED_IMAGE_NOTE);
  });
});
