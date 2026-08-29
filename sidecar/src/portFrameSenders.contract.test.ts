/**
 * Wire-contract test — SENDER side. Pins `portFrameSenders.ts`'s frame shape
 * for every method in the shared fixture (see
 * `@/core/agent/__contractFixtures__/portFrameFixtures.ts` for why this
 * fixture is shared with the RECEIVER-side contract test,
 * `src/core/agent/frameApplier.contract.test.ts`, and what's out of scope).
 *
 * This intentionally overlaps with `portFrameSenders.test.ts` (which already
 * exercises every method's local-mirror behavior + frame shape one-off) —
 * the difference is this file's fixture is the SAME literal data the
 * receiver-side test reads, so a positional-argument drift on EITHER side
 * shows up as a red test on THAT side specifically, not just "some test
 * somewhere is red". Not runtime validation, not codegen — a plain
 * data-driven pin.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { createFrameChatDelta, createFrameExecutionPort, createFrameScratchpadPort } from './portFrameSenders';
import type { PortFrame } from './portFrameCoalescer';
import { CHAT_CONTRACT_FIXTURES, EXEC_CONTRACT_FIXTURES } from '@/core/agent/__contractFixtures__/portFrameFixtures';
import { createInProcessChatDelta } from '@/core/agent/ports/chatDelta';
import { createInProcessExecutionPort } from '@/core/agent/ports/executionPort';
import { sidecarValueHasOpaqueMediaRefs } from '@/core/subagent/delegatedUserTurnMaterializer';

const delegatedMediaStoreMocks = vi.hoisted(() => ({
  persistDelegatedMedia: vi.fn(),
  readDelegatedMedia: vi.fn(),
}));

vi.mock('@/core/subagent/delegatedMediaStore', () => delegatedMediaStoreMocks);

/** Methods with their own dedicated special-case test above (id-preserving
 *  or signature-translating) — deliberately excluded from the generic
 *  fixture's completeness check, not just forgotten. */
const CHAT_SPECIAL_CASED = new Set(['cancelStreaming']);
const CHAT_SENDER_MEDIA_PREPARED = new Set(['appendMessageToolCall']);
const EXEC_SPECIAL_CASED = new Set([
  'createExecution',
  // Reads never travel as frames at all (see frameApplier.ts's module doc) —
  // not part of the generic-dispatch WRITE surface this fixture covers.
  'getExecutionByLoopId',
  'getExecutionByConversationId',
]);

describe('portFrameSenders wire contract — chat (generic dispatch)', () => {
  beforeEach(() => {
    delegatedMediaStoreMocks.persistDelegatedMedia.mockReset();
    delegatedMediaStoreMocks.readDelegatedMedia.mockReset();
  });

  it('covers setContextUsage frames both with and without a breakdown payload', () => {
    const usageFixtures = CHAT_CONTRACT_FIXTURES
      .filter(({ method }) => method === 'setContextUsage')
      .map(({ args }) => args[1] as Record<string, unknown>);

    expect(usageFixtures).toHaveLength(2);
    expect(usageFixtures.some((usage) => 'breakdown' in usage)).toBe(true);
    expect(usageFixtures.some((usage) => !('breakdown' in usage))).toBe(true);
  });

  it.each(CHAT_CONTRACT_FIXTURES.filter(({ method }) => !CHAT_SENDER_MEDIA_PREPARED.has(method)))('$method pushes {p:"chat", m:"$method", a: <fixture args, same order>}', ({ method, args }) => {
    const frames: PortFrame[] = [];
    const delta = createFrameChatDelta((f) => frames.push(f)) as unknown as Record<string, (...a: unknown[]) => unknown>;

    expect(typeof delta[method]).toBe('function');
    delta[method](...args);

    const expectedArgs = method === 'setMessageToolCalls'
      ? ['conv-1', 'msg-1', [{ id: 'tc1', name: 'read_file', input: { path: '[REDACTED:path]' } }]]
      : args;
    expect(frames).toEqual([{ p: 'chat', m: method, a: expectedArgs }]);
    if (method === 'setContextUsage') {
      const usage = frames[0].a[1] as Record<string, unknown>;
      expect(usage).toMatchObject({
        percent: expect.any(Number),
        tokensUsed: expect.any(Number),
        tokensMax: expect.any(Number),
        messageCountAtPublish: expect.any(Number),
      });
      if ('breakdown' in (args[1] as Record<string, unknown>)) {
        expect(usage).toMatchObject({
          breakdown: {
            version: 1,
            systemPrompt: expect.any(Number),
            tools: expect.any(Number),
            mcp: expect.any(Number),
            skills: expect.any(Number),
            conversation: expect.any(Number),
          },
        });
      } else {
        expect(usage).not.toHaveProperty('breakdown');
      }
    }
  });

  it('appendMessageToolCall persists inline media as an opaque ref before pushing the fixture frame', async () => {
    delegatedMediaStoreMocks.persistDelegatedMedia.mockResolvedValueOnce({
      id: 'media_contract_tool_call',
      sha256: 'b'.repeat(64),
      mediaType: 'image/png',
      bytes: 2,
    });
    const fixture = CHAT_CONTRACT_FIXTURES.find(({ method }) => method === 'appendMessageToolCall');
    expect(fixture).toBeDefined();
    const frames: PortFrame[] = [];
    const delta = createFrameChatDelta((f) => frames.push(f));

    delta.appendMessageToolCall(...fixture!.args as Parameters<typeof delta.appendMessageToolCall>);
    await delta.drain();

    expect(frames).toHaveLength(1);
    expect(frames[0].p).toBe('chat');
    expect(frames[0].m).toBe('appendMessageToolCall');
    expect(frames[0].a.slice(0, 2)).toEqual(fixture!.args.slice(0, 2));
    const wire = JSON.stringify(frames[0]);
    expect(wire).not.toContain('aGk=');
    expect(wire).not.toContain('/tmp/shot.png');
    expect(sidecarValueHasOpaqueMediaRefs(frames[0])).toBe(true);
  });
});

describe('portFrameSenders wire contract — exec (generic dispatch)', () => {
  it.each(EXEC_CONTRACT_FIXTURES)('$method pushes {p:"exec", m:"$method", a: <fixture args, same order>}', ({ method, args }) => {
    const frames: PortFrame[] = [];
    const port = createFrameExecutionPort((f) => frames.push(f)) as unknown as Record<string, (...a: unknown[]) => unknown>;

    // Every exec method here needs a live execution to mutate locally
    // (createExecution itself is the one method NOT in this generic
    // fixture — see its own dedicated test below), so seed one under the
    // exact execId/loopId this fixture's entries all use ('loop-1').
    (port.createExecution as (...a: unknown[]) => unknown)('conv-1', 'loop-1');
    frames.length = 0; // drop the seed frame — only assert the fixture's own method

    expect(typeof port[method]).toBe('function');
    port[method](...args);

    expect(frames).toEqual([{ p: 'exec', m: method, a: args }]);
  });
});

describe('portFrameSenders wire contract — special cases (asymmetric wire shape)', () => {
  it('chat cancelStreaming: call takes only convId, wire frame carries only [convId] (fromSidecarFrame is synthesized RECEIVER-side, never sent)', () => {
    const frames: PortFrame[] = [];
    const delta = createFrameChatDelta((f) => frames.push(f));
    delta.cancelStreaming('conv-1');
    expect(frames).toEqual([{ p: 'chat', m: 'cancelStreaming', a: ['conv-1'] }]);
  });

  it('exec createExecution: wire frame carries [conversationId, loopId] — no separate id, since id === loopId by convention', () => {
    const frames: PortFrame[] = [];
    const port = createFrameExecutionPort((f) => frames.push(f));
    const exec = port.createExecution('conv-1', 'loop-1');
    expect(exec.id).toBe('loop-1');
    expect(frames).toEqual([{ p: 'exec', m: 'createExecution', a: ['conv-1', 'loop-1'] }]);
  });

  it('scratchpad addEntry: wire frame carries [generatedId, entry] — the SAME id returned to the caller', () => {
    const frames: PortFrame[] = [];
    const port = createFrameScratchpadPort((f) => frames.push(f));
    const entry = { conversationId: 'conv-1', title: 't', type: 'summary' as const, content: 'x' };
    const id = port.addEntry(entry);
    expect(frames).toEqual([{ p: 'scratchpad', m: 'addEntry', a: [id, entry] }]);
  });
});

describe('portFrameSenders wire contract — fixture completeness', () => {
  // Compares against the REAL interface's method key set (via its
  // canonical in-process implementation), not a hardcoded count — a newly
  // added ChatDelta/ExecutionPort method with no fixture entry (and no
  // dedicated special-case test) turns this red instead of silently going
  // uncovered.
  it('the shared fixture covers every generic-dispatch ChatDelta method (all of them, minus the special-cased ones)', () => {
    const realMethods = new Set(Object.keys(createInProcessChatDelta()));
    const expectedGenericMethods = [...realMethods].filter((m) => !CHAT_SPECIAL_CASED.has(m)).sort();
    const fixtureMethods = [...new Set(CHAT_CONTRACT_FIXTURES.map((f) => f.method))].sort();
    expect(fixtureMethods).toEqual(expectedGenericMethods);
  });

  it('the shared fixture covers every generic-dispatch ExecutionPort WRITE method (all of them, minus the special-cased ones)', () => {
    const realMethods = new Set(Object.keys(createInProcessExecutionPort()));
    const expectedGenericMethods = [...realMethods].filter((m) => !EXEC_SPECIAL_CASED.has(m)).sort();
    const fixtureMethods = EXEC_CONTRACT_FIXTURES.map((f) => f.method).sort();
    expect(fixtureMethods).toEqual(expectedGenericMethods);
  });
});
