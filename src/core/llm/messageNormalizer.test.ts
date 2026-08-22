import { describe, it, expect } from 'vitest';
import { normalizeMessages } from './messageNormalizer';
import type { Message } from '../../types';

function makeMessage(overrides: Partial<Message> & Pick<Message, 'role' | 'content'>): Message {
  return {
    id: 'msg-default', // filler (TESTING.md §3) — normalizeMessages never keys off id
    timestamp: 1_700_000_000_000, // filler — not asserted on
    ...overrides,
  };
}

describe('messageNormalizer', () => {
  describe('normalizeMessages', () => {
    it('converts simple user + assistant messages', () => {
      const messages: Message[] = [
        makeMessage({ role: 'user', content: 'Hello' }),
        makeMessage({ role: 'assistant', content: 'Hi there' }),
      ];

      const turns = normalizeMessages(messages);

      expect(turns).toHaveLength(2);
      expect(turns[0]).toEqual({ kind: 'user', content: [{ type: 'text', text: 'Hello' }] });
      expect(turns[1]).toMatchObject({ kind: 'assistant', text: 'Hi there', toolCalls: [] });
    });

    it('skips system messages', () => {
      const messages: Message[] = [
        makeMessage({ role: 'system', content: 'System prompt' }),
        makeMessage({ role: 'user', content: 'Hello' }),
      ];

      const turns = normalizeMessages(messages);
      expect(turns).toHaveLength(1);
      expect(turns[0].kind).toBe('user');
    });

    it('preserves thinking content', () => {
      const messages: Message[] = [
        makeMessage({ role: 'user', content: 'Think about this' }),
        makeMessage({ role: 'assistant', content: 'Result', thinking: 'My internal reasoning' }),
      ];

      const turns = normalizeMessages(messages);
      const assistant = turns[1];
      expect(assistant.kind).toBe('assistant');
      if (assistant.kind === 'assistant') {
        expect(assistant.thinking).toBe('My internal reasoning');
      }
    });

    describe('thinking strip (prevents cross-turn reasoning loops)', () => {
      it('keeps thinking only on the most-recent assistant turn that produced output', () => {
        const messages: Message[] = [
          makeMessage({ role: 'user', content: 'Q1' }),
          makeMessage({ role: 'assistant', content: 'A1', thinking: 'reasoning 1' }),
          makeMessage({ role: 'user', content: 'Q2' }),
          makeMessage({ role: 'assistant', content: 'A2', thinking: 'reasoning 2' }),
        ];

        const turns = normalizeMessages(messages);
        // 4 turns total
        expect(turns).toHaveLength(4);
        // First assistant turn (idx 1) loses thinking
        if (turns[1].kind === 'assistant') {
          expect(turns[1].thinking).toBeUndefined();
          expect(turns[1].text).toBe('A1');
        }
        // Most-recent assistant turn (idx 3) keeps thinking
        if (turns[3].kind === 'assistant') {
          expect(turns[3].thinking).toBe('reasoning 2');
        }
      });

      it('strips thinking from latest assistant turn when it produced no text and no tool_use', () => {
        // Simulates a reasoning-model loop that exhausted max_tokens with only
        // repeated thinking output. The degenerate thinking must be stripped so
        // it does not re-prime the same loop on the next API call.
        const messages: Message[] = [
          makeMessage({ role: 'user', content: 'Q1' }),
          makeMessage({
            role: 'assistant',
            content: '',
            thinking: '让我列所有文件。让我列所有文件。让我列所有文件。',
          }),
        ];

        const turns = normalizeMessages(messages);
        expect(turns).toHaveLength(2);
        if (turns[1].kind === 'assistant') {
          expect(turns[1].thinking).toBeUndefined();
          // Tombstone restored since thinking is gone and turn is otherwise empty
          expect(turns[1].text).toBe('[未收到响应]');
        }
      });

      it('strips thinking when latest turn text is the echoed tombstone string', () => {
        // The model parroted '[未收到响应]' from prior normalizer-injected
        // history — same degenerate signal as an empty turn.
        const messages: Message[] = [
          makeMessage({ role: 'user', content: 'Q1' }),
          makeMessage({
            role: 'assistant',
            content: '\n\n\n[未收到响应]',
            thinking: 'looping reasoning',
          }),
        ];

        const turns = normalizeMessages(messages);
        if (turns[1].kind === 'assistant') {
          expect(turns[1].thinking).toBeUndefined();
        }
      });

      it('falls back to a prior output turn when later turns are empty', () => {
        // Bug case shape: one healthy turn, then several degenerate-empty turns.
        // The healthy turn's thinking should be preserved; the empty turns'
        // thinking should be stripped.
        const messages: Message[] = [
          makeMessage({ role: 'user', content: 'Q1' }),
          makeMessage({
            role: 'assistant',
            content: 'Real answer',
            thinking: 'productive reasoning',
          }),
          makeMessage({ role: 'user', content: 'Q2' }),
          makeMessage({
            role: 'assistant',
            content: '',
            thinking: 'looping reasoning',
          }),
        ];

        const turns = normalizeMessages(messages);
        if (turns[1].kind === 'assistant') {
          expect(turns[1].thinking).toBe('productive reasoning');
        }
        if (turns[3].kind === 'assistant') {
          expect(turns[3].thinking).toBeUndefined();
          expect(turns[3].text).toBe('[未收到响应]');
        }
      });

      it('keeps thinking on a turn that has tool_calls but empty text', () => {
        // tool_use alone is a valid "produced output" — its thinking is the
        // reasoning that led to the tool call and is worth preserving.
        const messages: Message[] = [
          makeMessage({ role: 'user', content: 'Read a file' }),
          makeMessage({
            role: 'assistant',
            content: '',
            thinking: 'I should call read_file',
            toolCallsForContext: [
              { name: 'read_file', input: { path: '/a' }, result: 'content' },
            ],
          }),
        ];

        const turns = normalizeMessages(messages);
        if (turns[1].kind === 'assistant') {
          expect(turns[1].thinking).toBe('I should call read_file');
        }
      });
    });

    describe('tool call pairing', () => {
      it('normalizes tool calls with results (from toolCallsForContext)', () => {
        const messages: Message[] = [
          makeMessage({ role: 'user', content: 'Read a file' }),
          makeMessage({
            role: 'assistant',
            content: 'Let me read that',
            toolCallsForContext: [
              { name: 'read_file', input: { path: '/tmp/test.txt' }, result: 'file content here' },
            ],
          }),
        ];

        const turns = normalizeMessages(messages);
        const assistant = turns[1];
        expect(assistant.kind).toBe('assistant');
        if (assistant.kind === 'assistant') {
          expect(assistant.toolCalls).toHaveLength(1);
          expect(assistant.toolCalls[0].name).toBe('read_file');
          expect(assistant.toolCalls[0].result).toBe('file content here');
          expect(assistant.toolCalls[0].isError).toBe(false);
          expect(assistant.toolCalls[0].id).toMatch(/^toolu_/);
        }
      });

      it('serializes byte-identical tool ids across repeated normalizations', () => {
        // Prompt caching is a byte-prefix match: the same stored history must
        // serialize identically on every request. A timestamp/random suffix in
        // the generated tool id used to change the bytes of every historical
        // tool call per request, busting the provider cache mid-history.
        const messages: Message[] = [
          makeMessage({ role: 'user', content: 'do it' }),
          makeMessage({
            role: 'assistant',
            content: 'ok',
            toolCalls: [{ id: 'orig', name: 'read_file', input: { path: '/a' }, result: 'x', isExecuting: false }],
          }),
        ];
        const first = normalizeMessages(messages);
        const second = normalizeMessages(messages);
        expect(JSON.stringify(second)).toBe(JSON.stringify(first));
      });

      it('prefers toolCallsForContext over toolCalls', () => {
        const messages: Message[] = [
          makeMessage({
            role: 'assistant',
            content: '',
            toolCalls: [
              { id: 'tc1', name: 'read_file', input: { path: '/a' }, result: 'old result' },
            ],
            toolCallsForContext: [
              { name: 'read_file', input: { path: '/a' }, result: 'context result' },
            ],
          }),
        ];

        const turns = normalizeMessages(messages);
        if (turns[0].kind === 'assistant') {
          expect(turns[0].toolCalls[0].result).toBe('context result');
        }
      });

      it('★ fixes orphaned tool_use with placeholder result', () => {
        const messages: Message[] = [
          makeMessage({
            role: 'assistant',
            content: 'Calling tool',
            toolCalls: [
              { id: 'tc1', name: 'run_command', input: { command: 'npm test' }, result: undefined, isExecuting: true },
            ],
          }),
        ];

        const turns = normalizeMessages(messages);
        if (turns[0].kind === 'assistant') {
          expect(turns[0].toolCalls).toHaveLength(1);
          expect(turns[0].toolCalls[0].result).toBe('[Tool execution was interrupted]');
          expect(turns[0].toolCalls[0].isError).toBe(true);
        }
      });

      it('★ fixes mixed: some results present, some missing', () => {
        const messages: Message[] = [
          makeMessage({
            role: 'assistant',
            content: '',
            toolCalls: [
              { id: 'tc1', name: 'read_file', input: { path: '/a' }, result: 'content A' },
              { id: 'tc2', name: 'read_file', input: { path: '/b' }, result: undefined, isExecuting: true },
              { id: 'tc3', name: 'read_file', input: { path: '/c' }, result: 'content C' },
            ],
          }),
        ];

        const turns = normalizeMessages(messages);
        if (turns[0].kind === 'assistant') {
          const tcs = turns[0].toolCalls;
          expect(tcs[0].result).toBe('content A');
          expect(tcs[0].isError).toBe(false);
          expect(tcs[1].result).toBe('[Tool execution was interrupted]');
          expect(tcs[1].isError).toBe(true);
          expect(tcs[2].result).toBe('content C');
          expect(tcs[2].isError).toBe(false);
        }
      });

      it('preserves isError flag from original tool call', () => {
        const messages: Message[] = [
          makeMessage({
            role: 'assistant',
            content: '',
            toolCalls: [
              { id: 'tc1', name: 'run_command', input: { command: 'bad' }, result: 'Error: command failed', isError: true },
            ],
          }),
        ];

        const turns = normalizeMessages(messages);
        if (turns[0].kind === 'assistant') {
          expect(turns[0].toolCalls[0].isError).toBe(true);
          expect(turns[0].toolCalls[0].result).toBe('Error: command failed');
        }
      });
    });

    describe('image handling', () => {
      it('extracts images from tool result content', () => {
        const messages: Message[] = [
          makeMessage({
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'tc1',
                name: 'screenshot',
                input: {},
                result: 'Screenshot taken',
                resultContent: [
                  { type: 'text', text: 'Screenshot taken' },
                  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
                ],
              },
            ],
          }),
        ];

        const turns = normalizeMessages(messages);
        if (turns[0].kind === 'assistant') {
          expect(turns[0].toolCalls[0].resultImages).toHaveLength(1);
          expect(turns[0].toolCalls[0].resultImages[0]).toEqual({
            mediaType: 'image/png',
            data: 'abc123',
          });
        }
      });

      it('strips images when supportsVision is false', () => {
        const messages: Message[] = [
          makeMessage({
            role: 'assistant',
            content: '',
            toolCalls: [
              {
                id: 'tc1',
                name: 'screenshot',
                input: {},
                result: 'Screenshot taken',
                resultContent: [
                  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
                ],
              },
            ],
          }),
        ];

        const turns = normalizeMessages(messages, { supportsVision: false });
        if (turns[0].kind === 'assistant') {
          expect(turns[0].toolCalls[0].resultImages).toHaveLength(0);
        }
      });

      it('converts user image content blocks', () => {
        const messages: Message[] = [
          makeMessage({
            role: 'user',
            content: [
              { type: 'text', text: 'What is this?' },
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'img123' } },
            ],
          }),
        ];

        const turns = normalizeMessages(messages);
        if (turns[0].kind === 'user') {
          expect(turns[0].content).toHaveLength(2);
          expect(turns[0].content[0]).toEqual({ type: 'text', text: 'What is this?' });
          expect(turns[0].content[1]).toEqual({ type: 'image', mediaType: 'image/jpeg', data: 'img123' });
        }
      });

      it('strips user images and adds hint when vision not supported', () => {
        const messages: Message[] = [
          makeMessage({
            role: 'user',
            content: [
              { type: 'text', text: 'Check this' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } },
            ],
          }),
        ];

        const turns = normalizeMessages(messages, { supportsVision: false });
        if (turns[0].kind === 'user') {
          expect(turns[0].content).toHaveLength(2);
          expect(turns[0].content[0]).toEqual({ type: 'text', text: 'Check this' });
          expect(turns[0].content[1]).toMatchObject({ type: 'text', text: expect.stringContaining('does not support image understanding') });
        }
      });
    });

    describe('edge cases', () => {
      it('handles empty message list', () => {
        expect(normalizeMessages([])).toEqual([]);
      });

      it('replaces empty ghost assistant message with tombstone', () => {
        const messages: Message[] = [
          makeMessage({ role: 'assistant', content: '' }),
        ];

        const turns = normalizeMessages(messages);
        expect(turns).toHaveLength(1);
        if (turns[0].kind === 'assistant') {
          expect(turns[0].text).toBe('[未收到响应]');
          expect(turns[0].toolCalls).toEqual([]);
        }
      });

      it('replaces ghost assistant between two user messages without consecutive-user violation', () => {
        const messages: Message[] = [
          makeMessage({ role: 'user', content: '整理桌面' }),
          makeMessage({ role: 'assistant', content: '' }),
          makeMessage({ role: 'user', content: '再试一次' }),
        ];

        const turns = normalizeMessages(messages);
        expect(turns).toHaveLength(3);
        expect(turns[0].kind).toBe('user');
        if (turns[1].kind === 'assistant') {
          expect(turns[1].text).toBe('[未收到响应]');
        }
        expect(turns[2].kind).toBe('user');
      });

      it('generates unique IDs per tool call', () => {
        const messages: Message[] = [
          makeMessage({
            role: 'assistant',
            content: '',
            toolCallsForContext: [
              { name: 'tool_a', input: {}, result: 'a' },
              { name: 'tool_b', input: {}, result: 'b' },
            ],
          }),
        ];

        const turns = normalizeMessages(messages);
        if (turns[0].kind === 'assistant') {
          const ids = turns[0].toolCalls.map((tc) => tc.id);
          expect(new Set(ids).size).toBe(2);
        }
      });

      it('handles multi-turn conversation with interleaved tool calls', () => {
        const messages: Message[] = [
          makeMessage({ role: 'user', content: 'Read two files' }),
          makeMessage({
            role: 'assistant',
            content: 'Reading files...',
            toolCalls: [
              { id: 'tc1', name: 'read_file', input: { path: '/a' }, result: 'content A' },
              { id: 'tc2', name: 'read_file', input: { path: '/b' }, result: 'content B' },
            ],
          }),
          makeMessage({ role: 'user', content: 'Now edit file A' }),
          makeMessage({
            role: 'assistant',
            content: 'Editing...',
            toolCalls: [
              { id: 'tc3', name: 'write_file', input: { path: '/a', content: 'new' }, result: 'Done' },
            ],
          }),
        ];

        const turns = normalizeMessages(messages);
        expect(turns).toHaveLength(4);
        expect(turns[0].kind).toBe('user');
        expect(turns[1].kind).toBe('assistant');
        if (turns[1].kind === 'assistant') {
          expect(turns[1].toolCalls).toHaveLength(2);
        }
        expect(turns[2].kind).toBe('user');
        expect(turns[3].kind).toBe('assistant');
        if (turns[3].kind === 'assistant') {
          expect(turns[3].toolCalls).toHaveLength(1);
        }
      });

      it('handles assistant message with only tool calls (no text)', () => {
        const messages: Message[] = [
          makeMessage({ role: 'user', content: 'Do it' }),
          makeMessage({
            role: 'assistant',
            content: [{ type: 'text', text: '' }],
            toolCalls: [
              { id: 'tc1', name: 'run_command', input: { command: 'ls' }, result: 'file.txt' },
            ],
          }),
        ];

        const turns = normalizeMessages(messages);
        if (turns[1].kind === 'assistant') {
          expect(turns[1].text).toBe('');
          expect(turns[1].toolCalls).toHaveLength(1);
        }
      });

      it('handles user message with empty string content', () => {
        const messages: Message[] = [
          makeMessage({ role: 'user', content: '' }),
        ];
        // Empty content should produce no turns
        const turns = normalizeMessages(messages);
        expect(turns).toHaveLength(0);
      });

      it('handles document content in user messages', () => {
        const messages: Message[] = [
          makeMessage({
            role: 'user',
            content: [
              { type: 'document', source: { type: 'base64', media_type: 'application/pdf' as const, data: 'pdf123' } },
            ],
          }),
        ];

        const turns = normalizeMessages(messages);
        if (turns[0].kind === 'user') {
          expect(turns[0].content[0]).toEqual({ type: 'document', mediaType: 'application/pdf', data: 'pdf123' });
        }
      });
    });
  });
});

describe('convertUserContent — resize notice', () => {
  const resized = { fromWidth: 2940, fromHeight: 1846, toWidth: 2000, toHeight: 1256 };

  function userWithResizedImage(): Message[] {
    return [{
      id: 'u1', role: 'user', timestamp: 1,
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'B64' }, resized },
        { type: 'text', text: '这张图是什么' },
      ],
    } as unknown as Message];
  }

  // The notice is produced here, not stored, so the chat UI never renders it —
  // but the model still has to learn it is not looking at original resolution,
  // or it reports pixel coordinates and fine print as if it were.
  it('emits the notice right after the image it describes', () => {
    const turns = normalizeMessages(userWithResizedImage(), { supportsVision: true });
    const blocks = turns[0].content as { type: string; text?: string }[];

    expect(blocks[0].type).toBe('image');
    expect(blocks[1].type).toBe('text');
    expect(blocks[1].text).toContain('<image_resize_notice>');
    expect(blocks[1].text).toContain('2940x1846');
    expect(blocks[1].text).toContain('2000x1256');
  });

  it('emits nothing for an image that was never resized', () => {
    const messages: Message[] = [{
      id: 'u1', role: 'user', timestamp: 1,
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'B64' } }],
    } as unknown as Message];
    const turns = normalizeMessages(messages, { supportsVision: true });
    expect(JSON.stringify(turns)).not.toContain('image_resize_notice');
  });

  // A text-only route never receives the image, so telling it how the image was
  // resized is noise the user pays tokens for.
  it('stays silent on a non-vision route, where the image is dropped anyway', () => {
    const turns = normalizeMessages(userWithResizedImage(), { supportsVision: false });
    expect(JSON.stringify(turns)).not.toContain('image_resize_notice');
  });
});
