import { describe, it, expect } from 'vitest';
import {
  ContextBudgetError,
  enforceContextBudget,
  prepareContextMessages,
  trimOldScreenshots,
} from './contextManager';
import { normalizeMessages } from '../llm/messageNormalizer';
import { estimateMessageTokens, estimateTokens } from './tokenEstimator';
import { clearLogs, getRecentLogs } from '../logging/logger';
import type { Message } from '../../types';

let messageSequence = 0;
function makeMsg(role: 'user' | 'assistant', content: string): Message {
  messageSequence += 1;
  return { id: `message-${messageSequence}`, role, content, timestamp: 1_800_000_000_000 };
}

describe('contextManager', () => {
  const systemPrompt = 'You are a helpful assistant.';

  // ── Fast path: everything fits ──
  describe('fast path — everything fits', () => {
    it('returns all messages when within limit', () => {
      const messages = [
        makeMsg('user', 'Hello'),
        makeMsg('assistant', 'Hi!'),
      ];
      const result = prepareContextMessages(messages, systemPrompt, 100000, 4000);
      expect(result).toHaveLength(2);
      expect(result).toEqual(messages);
    });

    it('reports the safe budget and leaves a safety margin', () => {
      const result = enforceContextBudget(
        [makeMsg('user', 'Hello')],
        systemPrompt,
        10_000,
        1_000,
      );

      expect(result.strategy).toBe('unchanged');
      expect(result.inputBudget).toBeLessThan(9_000);
      expect(result.tokensAfter).toBeLessThanOrEqual(result.inputBudget);
      expect(result.safetyMarginTokens).toBeGreaterThan(0);
    });
  });

  // ── Round identification ──
  describe('round identification and compression', () => {
    it('keeps first and last rounds, compresses middle', () => {
      // Create 8 rounds to trigger compression
      const messages: Message[] = [];
      for (let i = 0; i < 8; i++) {
        messages.push(makeMsg('user', `Question ${i} ${'x'.repeat(500)}`));
        messages.push(makeMsg('assistant', `Answer ${i} ${'y'.repeat(500)}`));
      }

      // Set a limit that forces compression
      const result = prepareContextMessages(messages, systemPrompt, 3000, 500);
      // Should have fewer messages/shorter content than original
      expect(result.length).toBeLessThanOrEqual(messages.length);
    });
  });

  // ── Compression of assistant messages ──
  describe('assistant message compression', () => {
    it('truncates long assistant messages in middle rounds', () => {
      const messages: Message[] = [];
      // First round
      messages.push(makeMsg('user', 'Task: do something important'));
      messages.push(makeMsg('assistant', 'A'.repeat(2000)));
      // Middle rounds with long content (need enough to exceed limit)
      for (let i = 0; i < 8; i++) {
        messages.push(makeMsg('user', `Follow up ${i} with some extra context`));
        messages.push(makeMsg('assistant', `Response ${i}: ${'B'.repeat(2000)}`));
      }
      // Last rounds
      messages.push(makeMsg('user', 'Final question'));
      messages.push(makeMsg('assistant', 'Final answer'));

      // Token limit tight enough to force compression
      // Total ~18000 chars / 4 = ~4500 tokens for content + overhead
      // Set contextWindow small enough to force compression
      const result = prepareContextMessages(messages, systemPrompt, 3000, 500);
      // Result should be shorter than input
      const totalContentLength = result
        .filter((m) => m.role === 'assistant')
        .reduce((acc, m) => acc + (typeof m.content === 'string' ? m.content.length : 0), 0);
      const originalContentLength = messages
        .filter((m) => m.role === 'assistant')
        .reduce((acc, m) => acc + (typeof m.content === 'string' ? m.content.length : 0), 0);
      expect(totalContentLength).toBeLessThan(originalContentLength);
    });
  });

  // ── Aggressive mode ──
  describe('aggressive mode — drop middle entirely', () => {
    it('falls back to first + last 2 rounds when very constrained', () => {
      const messages: Message[] = [];
      for (let i = 0; i < 10; i++) {
        messages.push(makeMsg('user', `Q${i} ${'x'.repeat(200)}`));
        messages.push(makeMsg('assistant', `A${i} ${'y'.repeat(200)}`));
      }

      // Very tight limit
      const result = prepareContextMessages(messages, systemPrompt, 500, 100);
      const safeBudget = enforceContextBudget(messages, systemPrompt, 500, 100);
      expect(safeBudget.tokensAfter).toBeLessThanOrEqual(safeBudget.inputBudget);
      expect(result.length).toBeLessThan(messages.length);
    });
  });

  // ── Single round ──
  describe('single round', () => {
    it('compacts an oversized assistant response instead of returning it over budget', () => {
      const messages = [
        makeMsg('user', 'Hello'),
        makeMsg('assistant', 'x'.repeat(20_000)),
      ];
      const result = enforceContextBudget(messages, systemPrompt, 1_000, 200);

      expect(result.strategy).toMatch(/last_round_compacted|latest_user_only/);
      expect(result.tokensAfter).toBeLessThanOrEqual(result.inputBudget);
      expect(result.messages[0]).toEqual(messages[0]);
      expect(estimateMessageTokens(result.messages)).toBeLessThan(estimateMessageTokens(messages));
    });

    it('rejects a latest user input that cannot fit by itself', () => {
      const messages = [makeMsg('user', 'x'.repeat(20_000))];

      expect(() => enforceContextBudget(messages, systemPrompt, 1_000, 200))
        .toThrowError(ContextBudgetError);
      try {
        enforceContextBudget(messages, systemPrompt, 1_000, 200);
      } catch (error) {
        expect(error).toMatchObject({ code: 'INPUT_TOO_LARGE' });
      }
    });
  });

  // ── Preserves first user message ──
  describe('user message preservation', () => {
    it('prefers the latest user instruction when only one message can fit', () => {
      const messages: Message[] = [];
      messages.push(makeMsg('user', 'TASK_CONTEXT_IMPORTANT'));
      for (let i = 0; i < 10; i++) {
        messages.push(makeMsg('assistant', `A${i} ${'x'.repeat(2_000)}`));
        messages.push(makeMsg('user', `Q${i + 1} ${'z'.repeat(50)}`));
      }
      messages.push(makeMsg('assistant', `Final ${'y'.repeat(20_000)}`));

      const result = enforceContextBudget(messages, systemPrompt, 500, 100);
      const latestUser = [...result.messages].reverse().find((message) => message.role === 'user');
      expect(latestUser?.content).toContain('Q10');
      expect(result.tokensAfter).toBeLessThanOrEqual(result.inputBudget);
    });
  });

  // ── Tool calls in context ──
  describe('tool call context compression', () => {
    it('strips tool calls from compressed assistant messages', () => {
      const messages: Message[] = [];
      messages.push(makeMsg('user', 'Start'));
      messages.push({
        ...makeMsg('assistant', 'Running tools'),
        toolCalls: [{ id: 'tc1', name: 'read_file', input: { path: '/tmp/a.txt' }, result: 'content' }],
        toolCallsForContext: [{ name: 'read_file', input: { path: '/tmp/a.txt' }, result: 'content' }],
      });
      // Add enough rounds to trigger compression
      for (let i = 0; i < 6; i++) {
        messages.push(makeMsg('user', `Q${i} ${'x'.repeat(300)}`));
        messages.push(makeMsg('assistant', `A${i} ${'y'.repeat(300)}`));
      }

      const result = prepareContextMessages(messages, systemPrompt, 2000, 500);
      // The compressed assistant messages in middle should not have toolCalls
      const compressed = result.find(
        (m) => m.role === 'assistant' && m.content !== 'Running tools' && !m.toolCalls
      );
      // At least some assistant messages should be stripped
      expect(compressed?.toolCalls).toBeUndefined();
    });

    it('excludes subagent-recorded tool calls from fallback compression summaries', () => {
      const messages: Message[] = [];
      for (let i = 0; i < 7; i++) {
        messages.push(makeMsg('user', `Question ${i}`));
        const assistant = makeMsg('assistant', `Answer ${i}: ${'x'.repeat(1_000)}`);
        if (i === 1) {
          messages.push({
            ...assistant,
            toolCalls: [
              { id: 'parent-tool', name: 'read_file', input: {}, result: 'parent result' },
              {
                id: 'child-tool',
                name: 'computer_screenshot',
                input: {},
                result: 'child result',
                hidden: true,
                fromSubagent: true,
              },
            ],
          });
        } else {
          messages.push(assistant);
        }
      }

      const result = prepareContextMessages(messages, systemPrompt, 2_000, 100);
      const compressed = result.find((message) => (
        message.role === 'assistant' && typeof message.content === 'string'
          && message.content.includes('Answer 1:')
      ));

      expect(compressed?.content).toContain('[read_file]');
      expect(compressed?.content).not.toContain('[computer_screenshot]');
    });

    it('does not summarize orphaned subagent-recorded tool calls into LLM context', () => {
      const messages: Message[] = [
        makeMsg('user', 'Start'),
        {
          ...makeMsg('assistant', ''),
          toolCalls: [{
            id: 'child-tool',
            name: 'abu-browser__screenshot',
            input: {},
            hidden: true,
            fromSubagent: true,
          }],
        },
      ];

      const result = enforceContextBudget(messages, systemPrompt, 200, 50);

      expect(JSON.stringify(result.messages)).not.toContain('[abu-browser__screenshot]');
      expect(JSON.stringify(result.messages)).not.toContain('tool results lost during context compression');
      expect(result.messages[1]?.toolCalls).toEqual(messages[1].toolCalls);
    });

    it('truncates a giant latest tool result and preserves the outbound invariant', () => {
      const messages: Message[] = [
        makeMsg('user', 'Inspect the file'),
        {
          ...makeMsg('assistant', 'Reading the file'),
          toolCallsForContext: [{
            id: 'tool-1',
            name: 'read_file',
            input: { path: '/tmp/large.txt' },
            result: 'data'.repeat(20_000),
          }],
        },
      ];

      const result = enforceContextBudget(messages, systemPrompt, 2_000, 400);
      expect(result.tokensAfter).toBeLessThanOrEqual(result.inputBudget);
      expect(result.messages[0]).toEqual(messages[0]);
      expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
      expect(result.messages[1]?.toolCallsForContext?.[0]?.id).toBe('tool-1');
    });

    it('counts and removes rich tool-result images when the latest round is over budget', () => {
      const resultContent = Array.from({ length: 8 }, () => ({
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: 'image/png', data: 'image-data' },
      }));
      const messages: Message[] = [
        makeMsg('user', 'Inspect the screenshots'),
        {
          ...makeMsg('assistant', 'Captured screenshots'),
          toolCallsForContext: [{
            id: 'tool-images',
            name: 'computer_screenshot',
            input: {},
            result: '',
            resultContent,
          }],
        },
      ];

      const result = enforceContextBudget(messages, systemPrompt, 4_000, 500);
      expect(result.tokensBefore).toBeGreaterThan(result.inputBudget);
      expect(result.tokensAfter).toBeLessThanOrEqual(result.inputBudget);
      expect(result.messages[1]?.toolCallsForContext?.[0]?.resultContent)
        .toEqual([{ type: 'text', text: '' }]);
    });

    it('includes tool schemas in the fixed context budget', () => {
      const toolSchemaTokens = 1_000;
      expect(() => enforceContextBudget(
        [makeMsg('user', 'Hello')],
        systemPrompt,
        1_000,
        200,
        toolSchemaTokens,
      )).toThrowError(expect.objectContaining({ code: 'FIXED_CONTEXT_TOO_LARGE' }));
    });

    it('does not double-count the UI and context copies of the same tool call', () => {
      const base = makeMsg('assistant', 'Tool finished');
      const toolCall = {
        id: 'tool-mirrored',
        name: 'read_file',
        input: { path: '/tmp/file.txt' },
        result: 'file content',
      };
      const withUiCopy: Message = {
        ...base,
        toolCalls: [toolCall],
        toolCallsForContext: [toolCall],
      };
      const contextOnly: Message = {
        ...base,
        toolCallsForContext: [toolCall],
      };

      expect(estimateMessageTokens([withUiCopy])).toBe(estimateMessageTokens([contextOnly]));
    });
  });

  it.each([500, 1_000, 2_000, 4_000])(
    'never returns an estimated payload above a %i-token context window',
    (contextWindow) => {
      const messages: Message[] = [];
      for (let index = 0; index < 12; index++) {
        messages.push(makeMsg('user', `Question ${index} ${'q'.repeat(120)}`));
        messages.push(makeMsg('assistant', `Answer ${index} ${'a'.repeat(1_500)}`));
      }

      const result = enforceContextBudget(messages, systemPrompt, contextWindow, 100);
      const independentlyEstimated = estimateTokens(systemPrompt) + estimateMessageTokens(result.messages);
      expect(result.tokensAfter).toBeLessThanOrEqual(result.inputBudget);
      expect(independentlyEstimated).toBeLessThanOrEqual(result.inputBudget);
    },
  );

  it('rejects a near-limit latest user turn whose delegated image refs would exceed the input budget', () => {
    const delegatedRefs = Array.from({ length: 20 }, (_, index) => ({
      type: 'delegated_media_ref',
      originConversationId: 'conv-parent',
      attachment: {
        id: `media_${index}`,
        sha256: `${index}`.padStart(64, 'a'),
        mediaType: 'image/png',
        bytes: 123,
      },
    }));
    const messages: Message[] = [{
      id: 'latest-user',
      role: 'user',
      timestamp: 1_800_000_000_000,
      content: [
        { type: 'text', text: 'Please inspect every delegated image.' },
        ...delegatedRefs,
      ] as unknown as Message['content'],
    }];

    expect(() => enforceContextBudget(messages, systemPrompt, 33_000, 1_000))
      .toThrow(ContextBudgetError);
    expect(() => enforceContextBudget(messages, systemPrompt, 33_000, 1_000))
      .toThrow(/INPUT_TOO_LARGE/);
  });
});

// trimOldScreenshots drops all but the most recent few screenshots. That policy
// matches every comparable harness (DSH offloads oldest-first, Codex spends a
// retained-history budget, Claude Code strips on a media budget) — the risk is
// not the trimming, it is leaving the surrounding text pointing at a picture
// that is no longer there.
describe('trimOldScreenshots — the model is told what happened', () => {
  const TS = 1_700_000_000_000;

  /** A computer-use turn whose text instructs the model to look at the shot. */
  function screenshotTurn(id: string, marker: string): Message {
    const resultContent = [
      { type: 'text' as const, text: 'Auto-screenshot after action: 1280x800\nExamine the screenshot to verify the action result.' },
      { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: marker } },
    ];
    const call = {
      id: `tc-${id}`,
      name: 'computer',
      input: {},
      result: 'Auto-screenshot after action: 1280x800\nExamine the screenshot to verify the action result.',
      resultContent,
    };
    return { id, role: 'assistant', content: '', timestamp: TS, toolCalls: [call] } as Message;
  }

  // Six screenshots, tight context → only the newest 2 survive.
  const many = ['a', 'b', 'c', 'd', 'e', 'f'].map((m, i) => screenshotTurn(`m${i}`, m));

  it('keeps only the most recent screenshots', () => {
    const wire = JSON.stringify(normalizeMessages(trimOldScreenshots(many, 90), { supportsVision: true }));
    expect(wire).not.toContain('"a"');
    expect(wire).toContain('"f"'); // newest survives
  });

  // The regression this test exists for. The note used to be appended to
  // resultContent, which normalizeMessages reads only via extractImages — so it
  // reached nobody, while "Examine the screenshot" stayed in the result string.
  // The model was told to inspect a picture that had been removed.
  it('puts the removal note in the text the model actually receives', () => {
    const wire = JSON.stringify(normalizeMessages(trimOldScreenshots(many, 90), { supportsVision: true }));
    expect(wire).toContain('screenshot(s) removed from history');
  });

  it('leaves the turns it keeps untouched', () => {
    const few = [screenshotTurn('only', 'z')];
    const wire = JSON.stringify(normalizeMessages(trimOldScreenshots(few, 90), { supportsVision: true }));
    expect(wire).toContain('"z"');
    expect(wire).not.toContain('screenshot(s) removed from history');
  });

  // Legacy toolCallsForContext entries can lack ids. In that case the whole
  // context side stays untouched rather than guessing from request-order indices,
  // and no bogus "[0 screenshot(s) removed…]" note reaches the model.
  it('says nothing when legacy context calls cannot be matched safely', () => {
    const call = { id: 'tc-x', name: 'read_file', input: {}, result: 'file contents', resultContent: [] };
    const withImage = screenshotTurn('img', 'q');
    const mismatched = {
      ...withImage,
      toolCallsForContext: [{ name: 'read_file', input: {}, result: 'file contents', resultContent: [] }],
      toolCalls: [...(withImage.toolCalls ?? []), call],
    } as Message;

    const out = trimOldScreenshots([mismatched, ...many], 90);
    expect(JSON.stringify(out)).not.toContain('[0 screenshot(s) removed');
  });

  // Subagent-recorded entries (fromSubagent) never reach the LLM — they are
  // the display/backfill persistence home for a child step's image. Counting
  // them against the screenshot budget would strip REAL screenshots the model
  // can still see, to make room for pictures it never sees.
  it('ignores fromSubagent entries: they neither consume the budget nor get stripped', () => {
    const subagentEntry = {
      id: 'tc-sub',
      name: 'computer',
      input: {},
      result: 'Image: /tmp/sub.png',
      resultContent: [
        { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'SUBAGENT_SHOT' } },
      ],
      hidden: true,
      fromSubagent: true,
    };
    // 2 real screenshots + 1 subagent entry under a tight budget that keeps 2.
    // Without the skip, the subagent entry would push the older real one out.
    const twoReal = [screenshotTurn('r1', 'REAL_OLD'), screenshotTurn('r2', 'REAL_NEW')];
    const withSubagent = {
      ...twoReal[0],
      toolCalls: [...(twoReal[0].toolCalls ?? []), subagentEntry],
    } as Message;

    const out = trimOldScreenshots([withSubagent, twoReal[1]], 90);
    const raw = JSON.stringify(out);
    expect(raw).toContain('REAL_OLD');
    expect(raw).toContain('REAL_NEW');
    expect(raw).toContain('SUBAGENT_SHOT');
    expect(raw).not.toContain('screenshot(s) removed from history');
  });

  it('matches completion-order context calls by tool_use id', () => {
    const imageCall = (id: string, marker: string) => ({
      id,
      name: 'computer',
      input: {},
      result: marker,
      resultContent: [
        { type: 'text' as const, text: marker },
        { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: marker } },
      ],
    });
    const textCall = { id: 'text', name: 'read_file', input: {}, result: 'text result', resultContent: [] };
    const message: Message = {
      ...makeMsg('assistant', 'Parallel tools finished'),
      // Model request order: the oldest screenshot is "a" at index 1.
      toolCalls: [textCall, imageCall('a', 'a'), imageCall('b', 'b'), imageCall('c', 'c')],
      // Completion order differs, putting "a" at index 2.
      toolCallsForContext: [imageCall('c', 'c'), imageCall('b', 'b'), imageCall('a', 'a'), textCall],
    };

    const out = trimOldScreenshots([message], 90);
    const contextCalls = out[0].toolCallsForContext!;

    expect(contextCalls[0].resultContent?.some((block) => block.type === 'image')).toBe(true);
    expect(contextCalls[1].resultContent?.some((block) => block.type === 'image')).toBe(true);
    expect(contextCalls[2].resultContent?.some((block) => block.type === 'image')).toBe(false);
    expect(contextCalls[2].result).toContain('screenshot(s) removed from history');
  });

  it('retains a message context intact when legacy calls lack tool_use ids', () => {
    clearLogs();
    const imageCall = (id: string, marker: string) => ({
      id,
      name: 'computer',
      input: {},
      result: marker,
      resultContent: [
        { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: marker } },
      ],
    });
    const message: Message = {
      ...makeMsg('assistant', 'Legacy context'),
      toolCalls: [imageCall('a', 'a'), imageCall('b', 'b'), imageCall('c', 'c')],
      toolCallsForContext: [
        { name: 'computer', input: {}, result: 'a', resultContent: imageCall('a', 'a').resultContent },
        imageCall('b', 'b'),
        imageCall('c', 'c'),
      ],
    };

    const out = trimOldScreenshots([message], 90);

    expect(out[0].toolCalls?.[0].resultContent?.some((block) => block.type === 'image')).toBe(false);
    expect(out[0].toolCallsForContext?.[0].resultContent?.some((block) => block.type === 'image')).toBe(true);
    expect(getRecentLogs({ module: 'contextManager' })).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: 'Skipped trimming tool call context without tool_use ids' }),
    ]));
  });

  it('retains message context when the request-order side lacks a tool_use id', () => {
    clearLogs();
    const imageCall = (id: string, marker: string) => ({
      id,
      name: 'computer',
      input: {},
      result: marker,
      resultContent: [
        { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: marker } },
      ],
    });
    const legacyRequestCall = { ...imageCall('a', 'a'), id: undefined };
    const message: Message = {
      ...makeMsg('assistant', 'Legacy request call'),
      toolCalls: [
        legacyRequestCall as unknown as NonNullable<Message['toolCalls']>[number],
        imageCall('b', 'b'),
        imageCall('c', 'c'),
      ],
      toolCallsForContext: [imageCall('a', 'a'), imageCall('b', 'b'), imageCall('c', 'c')],
    };

    const out = trimOldScreenshots([message], 90);

    expect(out[0].toolCalls?.[0].resultContent?.some((block) => block.type === 'image')).toBe(false);
    expect(out[0].toolCallsForContext?.[0].resultContent?.some((block) => block.type === 'image')).toBe(true);
    expect(getRecentLogs({ module: 'contextManager' })).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: 'Skipped trimming tool call context without tool_use ids' }),
    ]));
  });
});
