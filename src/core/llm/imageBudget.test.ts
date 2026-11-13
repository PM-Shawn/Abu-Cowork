import { describe, it, expect } from 'vitest';
import type { Message, MessageContent, ToolResultContent } from '../../types';
import { dropOldImages, omittedImagesNote } from './imageBudget';
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
  return (JSON.stringify(turns).match(/omitted from this request to keep it within/g) ?? []).length;
}

describe('dropOldImages (maxBytes)', () => {
  it('leaves a fitting request untouched, same array reference', () => {
    const messages = [userWith(image(100), { type: 'text', text: 'hi' })];
    expect(dropOldImages(messages, { maxBytes: 1000 })).toBe(messages);
  });

  it('drops the OLDEST images and keeps the newest', () => {
    const messages = [userWith(image(100, 'a')), userWith(image(100, 'b')), userWith(image(100, 'c'))];
    const out = dropOldImages(messages, { maxBytes: 150 });

    // 300 total, budget 150 → drop until it fits: a, then b. c survives.
    expect(survivingPayloads(out)).toEqual([payload(100, 'c')]);
    expect(noteCount(out)).toBe(2);
  });

  // The current turn is almost always about the newest image, so the newest is
  // the last thing to go — the opposite choice would drop exactly what the user
  // just attached.
  it('keeps the newest image even when it alone fills the budget', () => {
    const messages = [userWith(image(100, 'a')), userWith(image(100, 'b'))];
    const out = dropOldImages(messages, { maxBytes: 100 });
    expect(survivingPayloads(out)).toEqual([payload(100, 'b')]);
  });

  // Keeping it would guarantee the very 413 this function exists to prevent.
  it('drops a lone image that is bigger than the entire budget', () => {
    const messages = [userWith(image(500, 'a'), { type: 'text', text: 'look' })];
    const out = dropOldImages(messages, { maxBytes: 100 });
    expect(survivingPayloads(out)).toEqual([]);
    expect(noteCount(out)).toBe(1);
    expect(JSON.stringify(out)).toContain('look'); // text survives
  });

  // Replay safety: the request must be a pure function of (history, policy).
  it('is deterministic — same input twice yields identical output', () => {
    const build = () => [userWith(image(100, 'a')), userWith(image(100, 'b')), userWith(image(100, 'c'))];
    expect(JSON.stringify(dropOldImages(build(), { maxBytes: 150 })))
      .toBe(JSON.stringify(dropOldImages(build(), { maxBytes: 150 })));
  });

  // Position, not object identity, decides. Two byte-identical images are NOT
  // interchangeable: a replay has to drop the one in the same slot.
  it('picks by position even when two images are byte-identical', () => {
    const twin = image(100, 'a');
    const messages = [userWith(twin), userWith(twin), userWith(image(100, 'z'))];
    const out = dropOldImages(messages, { maxBytes: 150 });
    expect(survivingPayloads(out)).toEqual([payload(100, 'z')]);
  });

  it('does not mutate the input messages', () => {
    const messages = [userWith(image(100, 'a')), userWith(image(100, 'b'))];
    const before = JSON.stringify(messages);
    dropOldImages(messages, { maxBytes: 50 });
    expect(JSON.stringify(messages)).toBe(before);
  });

  // Tool-result screenshots are inlined into the request body exactly like user
  // uploads, so a budget that ignored them would not bound the body.
  it('counts and drops tool-result images too', () => {
    const messages = [assistantWithToolImage(200, 'a'), userWith(image(100, 'b'))];
    const out = dropOldImages(messages, { maxBytes: 150 });
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
    expect(dropOldImages(messages, { maxBytes: 150 })).toBe(messages);
    expect(noteCount(dropOldImages(messages, { maxBytes: 150 }))).toBe(0);

    // And when the budget genuinely bites, the dropped image is the context one.
    const tightened = dropOldImages(messages, { maxBytes: 50 });
    expect(survivingPayloads(tightened)).toEqual([]);
    expect(noteCount(tightened)).toBe(1);
  });

  it('ignores string-content messages and images with no payload', () => {
    const messages: Message[] = [
      { id: 's1', role: 'user', content: 'plain text', timestamp: TS },
      userWith({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } }),
    ];
    expect(dropOldImages(messages, { maxBytes: 10 })).toBe(messages);
  });

  it('treats a non-positive or non-finite budget as "no budget"', () => {
    const messages = [userWith(image(500, 'a'))];
    expect(dropOldImages(messages, { maxBytes: 0 })).toBe(messages);
    expect(dropOldImages(messages, { maxBytes: -1 })).toBe(messages);
    expect(dropOldImages(messages, { maxBytes: Number.NaN })).toBe(messages);
  });

  it('tells the model how to recover rather than thinning history silently', () => {
    const out = dropOldImages([userWith(image(500, 'a'))], { maxBytes: 100 });
    expect(JSON.stringify(out)).toContain(omittedImagesNote(1));
    expect(omittedImagesNote(1)).toMatch(/re-attach/);
  });
});

// The regression these tests exist for: the note has to survive normalization
// and land in the request, not merely sit in the message tree. Asserted on the
// serialized turns, the same way openai-vision-gating.test.ts checks images.
describe('dropOldImages (maxBytes) — the note actually reaches the model', () => {
  it('puts the note in the tool message the model reads, not in a dropped block', () => {
    const messages = [assistantWithToolImage(200, 'a'), userWith(image(100, 'b'))];
    const turns = normalizeMessages(dropOldImages(messages, { maxBytes: 150 }), { supportsVision: true });
    const wire = JSON.stringify(turns);

    expect(wire).toContain(omittedImagesNote(1));
    // The original tool text survives alongside it.
    expect(wire).toContain('Screenshot taken');
    // And the dropped screenshot is gone from what the model sees.
    expect(wire).not.toContain(payload(200, 'a'));
  });

  it('carries the note for a dropped user image too', () => {
    const turns = normalizeMessages(dropOldImages([userWith(image(500, 'a'))], { maxBytes: 100 }), { supportsVision: true });
    expect(JSON.stringify(turns)).toContain(omittedImagesNote(1));
  });

  it('says nothing when the request already fits', () => {
    const turns = normalizeMessages(dropOldImages([userWith(image(50, 'a'))], { maxBytes: 1000 }), { supportsVision: true });
    expect(JSON.stringify(turns)).not.toContain(omittedImagesNote(1));
  });
});

// One pass, two limits, one stand-in note. Before this the context manager's
// screenshot trim and the byte budget were separate passes that left different
// notes ("[1 screenshot(s) removed from history to save context]" and a fixed
// "an earlier image was omitted ... provider size limit" sentence), so a long
// session could carry both phrasings for the same loss.
describe('dropOldImages — both limits in one pass', () => {
  const shot = (id: string, marker: string, bytes = 100): NonNullable<Message['toolCalls']>[number] => ({
    id, name: 'computer', input: {}, result: 'Screenshot taken',
    resultContent: [{ type: 'text', text: 'Screenshot taken' }, image(bytes, marker)],
  });
  const turn = (id: string, ...calls: NonNullable<Message['toolCalls']>): Message =>
    ({ id, role: 'assistant', content: '', timestamp: TS, toolCalls: calls });
  /** How many times each distinct stand-in sentence reaches the model. */
  const notes = (messages: Message[]) => {
    const wire = JSON.stringify(normalizeMessages(messages, { supportsVision: true }));
    return (wire.match(/\[(?:An|\d+) earlier images? (?:was|were) omitted[^\]]*\]/g) ?? []).map((note) => note.replace(/\d+ earlier images were/, 'An earlier image was'));
  };

  it('applies the call limit and the byte limit together, oldest first, with one kind of note', () => {
    const messages = [userWith(image(100, 'u')), turn('t1', shot('a', 'a')), turn('t2', shot('b', 'b')), turn('t3', shot('c', 'c'))];
    // Keep 2 tool calls: a goes. The 300 bytes left are over 150: the user image goes, then b.
    const out = dropOldImages(messages, { keepToolCalls: 2, maxBytes: 150 });
    expect(survivingPayloads(out)).toEqual([payload(100, 'c')]);
    // a (call limit), the user image and b (byte limit): three losses, one sentence.
    expect(notes(out)).toEqual([omittedImagesNote(1), omittedImagesNote(1), omittedImagesNote(1)]);
  });

  it('counts only tool calls against the call limit, never message images', () => {
    const messages = [userWith(image(10, 'u')), turn('t1', shot('a', 'a')), turn('t2', shot('b', 'b'))];
    expect(survivingPayloads(dropOldImages(messages, { keepToolCalls: 1 }))).toEqual([payload(10, 'u'), payload(100, 'b')]);
  });

  it('writes one note per call that lost images, saying how many', () => {
    const two: NonNullable<Message['toolCalls']>[number] = {
      id: 'x', name: 'read_file', input: {}, result: 'pages',
      resultContent: [image(10, 'p'), image(10, 'q')],
    };
    const out = dropOldImages([turn('t1', two), turn('t2', shot('b', 'b'))], { keepToolCalls: 1 });
    expect(out[0].toolCalls![0].result).toBe(`pages\n\n${omittedImagesNote(2)}`);
    expect(out[0].toolCalls![0].resultContent).toEqual([]);
  });

  it('ignores calls recorded from a sub-agent: they are never sent', () => {
    const sub = { ...shot('s', 's', 500), fromSubagent: true };
    const messages = [turn('t1', sub, shot('a', 'a')), turn('t2', shot('b', 'b'))];
    const out = dropOldImages(messages, { keepToolCalls: 2, maxBytes: 250 });
    expect(out).toBe(messages);
  });
});

// The byte budget bounds what `normalizeMessages` sends, so it is measured and
// enforced on that list, picture by picture.
describe('dropOldImages (maxBytes) — the list that is actually sent', () => {
  const BUDGET = 92;
  const pic = (marker: string): ToolResultContent => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: payload(BUDGET, marker) } });
  const callOf = (id: string | undefined, ...markers: string[]) => ({
    ...(id === undefined ? {} : { id }), name: 'read_file', input: {}, result: 'pages', resultContent: markers.map(pic),
  });
  /** Characters of picture data the request carries, counted on the normalized turns. */
  const sentChars = (messages: Message[]): number => normalizeMessages(messages, { supportsVision: true })
    .flatMap((turn) => (turn.kind === 'assistant' ? turn.toolCalls.flatMap((call) => call.resultImages) : []))
    .reduce((sum, image) => sum + image.data.length, 0);

  it('bounds an old message whose context list has a call without an id', () => {
    const message = {
      id: 'a', role: 'assistant', content: '', timestamp: TS,
      toolCalls: [callOf('t1', 'a', 'b')],
      toolCallsForContext: [callOf(undefined, 'a', 'b')],
    } as unknown as Message;
    expect(sentChars(dropOldImages([message], { maxBytes: BUDGET }))).toBeLessThanOrEqual(BUDGET);
  });

  it('bounds a context list that holds a call the request-order list does not', () => {
    const message = {
      id: 'a', role: 'assistant', content: '', timestamp: TS,
      toolCalls: [callOf('t1', 'a', 'b')],
      toolCallsForContext: [callOf('t1', 'a', 'b'), callOf('t2', 'c', 'd')],
    } as unknown as Message;
    expect(sentChars(dropOldImages([message], { maxBytes: BUDGET }))).toBeLessThanOrEqual(BUDGET);
  });

  it('does not count a sub-agent call that is not sent', () => {
    const sub = { ...callOf('s', 's', 't'), fromSubagent: true };
    const message = { id: 'a', role: 'assistant', content: '', timestamp: TS, toolCalls: [sub, callOf('t1', 'a')] } as unknown as Message;
    expect(dropOldImages([message], { maxBytes: BUDGET })).toEqual([message]);
  });

  it('keeps the newest picture of a call when the budget fits only one, instead of dropping the whole call', () => {
    const message = { id: 'a', role: 'assistant', content: '', timestamp: TS, toolCalls: [callOf('t1', 'a', 'b')] } as unknown as Message;
    const out = dropOldImages([message], { maxBytes: BUDGET });
    expect(survivingPayloads(out)).toEqual([payload(BUDGET, 'b')]);
    expect(out[0].toolCalls![0].result).toBe(`pages\n\n${omittedImagesNote(1)}`);
    expect(sentChars(out)).toBe(BUDGET);
  });
});
