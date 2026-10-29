import { describe, expect, it } from 'vitest';
import type { Message, ToolCall } from '@/types';
import { buildContextFromBoundary } from '@/core/context/compactBoundary';
import { sanitizeLoadedLedgerMessages } from './loadedMessageSanitizer';
import { createMaxTurnsNoticeMessage } from '@/core/agent/maxTurnsNotice';
import { normalizeMessages } from '@/core/llm/messageNormalizer';
import {
  buildConversationBranchHistory,
  ConversationBranchHistoryError,
  getConversationBranchEligibility,
  type ConversationBranchHistoryOptions,
} from './conversationBranchHistory';

function user(id = 'u1', overrides: Partial<Message> = {}): Message {
  return { id, role: 'user', content: 'Question', timestamp: 100, loopId: 'loop1', runState: 'completed', ...overrides };
}

function answer(id = 'a1', overrides: Partial<Message> = {}): Message {
  return { id, role: 'assistant', content: 'Answer', timestamp: 200, loopId: 'loop1', streamEnded: true, ...overrides };
}

function build(messages: Message[], targetMessageId = 'a1', overrides: Partial<ConversationBranchHistoryOptions> = {}) {
  let nextId = 0;
  return buildConversationBranchHistory({
    sourceConversationId: 'parent', childConversationId: 'child', sourceTitle: 'Source title',
    messages, targetMessageId, accessAllowed: true,
    createId: kind => `new-${kind}-${++nextId}`,
    ...overrides,
  });
}

function summary(overrides: Partial<NonNullable<Message['compactBoundary']>> = {}): Message {
  return {
    id: 'compact-boundary-old', role: 'system', content: '', timestamp: 250,
    compactBoundary: {
      version: 2, status: 'done', summaryText: 'Earlier question and answer',
      summarizedFromId: 'u1', summarizedToId: 'a1', keptUserMessageIds: ['u1'],
      createdAt: 250, source: 'auto', ...overrides,
    },
  };
}

describe('getConversationBranchEligibility', () => {
  it('allows a completed earlier turn while a later turn is streaming with a reused loopId', () => {
    const messages = [user(), answer(), user('u2', { runState: 'running' }), answer('a2', { isStreaming: true })];
    expect(getConversationBranchEligibility(messages, 'a1', true)).toEqual({ eligible: true, targetIndex: 1, turnStartIndex: 0 });
    expect(getConversationBranchEligibility(messages, 'a2', true)).toEqual({ eligible: false, reason: 'incomplete' });
  });

  it.each(['pending', 'accepted', 'running', 'recovering'] as const)(
    'rejects a %s user turn even if an assistant stream finished', runState => {
      expect(getConversationBranchEligibility([user('u1', { runState }), answer()], 'a1', true))
        .toEqual({ eligible: false, reason: 'incomplete' });
    },
  );

  it.each(['completed', 'failed', 'connection-failed', 'interrupted'] as const)(
    'branches from an ended %s turn with partial text and unfinished tool records', runState => {
      const messages = [user('u1', { runState }), answer('a1', {
        isStreaming: true, streamEnded: undefined, stopReason: 'user',
        toolCalls: [{ id: 'write', name: 'write_file', input: { path: '/work/report.txt' }, isExecuting: true }],
        toolCallsForContext: JSON.parse('[{"id":"write","name":"write_file","input":{"path":"/work/report.txt"}}]'),
      })];
      expect(getConversationBranchEligibility(messages, 'a1', true).eligible).toBe(true);
      const child = build(messages);
      expect(child.messages[1].isStreaming).toBe(false);
      expect(child.messages[1].toolCalls?.[0]).toMatchObject({ isExecuting: false, isError: true });
      const prepared = normalizeMessages(child.messages);
      expect(prepared[1]).toMatchObject({ kind: 'assistant', toolCalls: [{ isError: true,
        result: expect.stringContaining('Its outcome is unknown') }] });
      expect(JSON.stringify(prepared)).toContain('Do not automatically replay it');
      expect(messages[1].toolCalls?.[0].result).toBeUndefined();
      expect(messages[1].isStreaming).toBe(true);
    },
  );

  it.each([
    { streamEnded: undefined, usage: { outputTokens: 12 } },
    { streamEnded: true as const },
  ])('accepts legacy final evidence without a runState or loopId: %j', evidence => {
    expect(getConversationBranchEligibility([
      user('u1', { runState: undefined, loopId: undefined }),
      answer('a1', { loopId: undefined, ...evidence }),
    ], 'a1', true).eligible).toBe(true);
  });

  it('allows saved legacy replies without usage or an end marker', () => {
    const messages = [
      user('u1', { runState: undefined }),
      answer('tools', { usage: { outputTokens: 10 }, toolCalls: [{ id: 't1', name: 'read_file', input: {}, result: 'ok' }] }),
      answer('a1', { streamEnded: undefined, isStreaming: false }),
    ];
    expect(getConversationBranchEligibility(messages, 'a1', true).eligible).toBe(true);
    expect(getConversationBranchEligibility(messages, 'tools', true).eligible).toBe(false);
  });

  it('allows partial replies after the reader has recovered an ended run', () => {
    const messages = sanitizeLoadedLedgerMessages([
      user('u1', { runState: 'running' }),
      answer('tools', { usage: { outputTokens: 10 }, toolCalls: [{ id: 't1', name: 'read_file', input: {}, result: 'ok' }] }),
      answer('a1', { streamEnded: undefined, isStreaming: true }),
    ], { text: { errorEmptyBody: 'Empty error' } });
    expect(messages[0].runState).toBe('completed');
    expect(getConversationBranchEligibility(messages, 'a1', true).eligible).toBe(true);
    expect(build(messages).messages.at(-1)?.content).toBe('Answer');
  });

  it('allows a turn that reached its limit and an earlier completed turn', () => {
    const messages = [user('earlier-user'), answer('earlier-answer'), user(), answer(),
      createMaxTurnsNoticeMessage({ id: 'limit', timestamp: 300, limit: 20, streak: 1 })];
    expect(getConversationBranchEligibility(messages, 'a1', true).eligible).toBe(true);
    expect(getConversationBranchEligibility(messages, 'earlier-answer', true).eligible).toBe(true);
  });

  it('ends inherited history at the chosen reply before a hidden continuation prompt', () => {
    const messages = [
      user(), answer('a1', { usage: { outputTokens: 10 } }),
      user('continue', { isSystem: true, runState: undefined }),
    ];
    expect(getConversationBranchEligibility(messages, 'a1', true).eligible).toBe(true);
    expect(build(messages).messages).toHaveLength(2);
  });

  it('hides the action when the turn has no reply or tool activity', () => {
    expect(getConversationBranchEligibility([user(), answer('a1', { content: '' })], 'a1', true))
      .toEqual({ eligible: false, reason: 'unavailable' });
  });

  it('allows a tool-only reply and preserves its recorded result', () => {
    const messages = [user(), answer('a1', { content: '', toolCalls: [
      { id: 't1', name: 'write_file', input: { path: '/work/report.txt' }, result: 'File saved' },
    ] })];
    expect(getConversationBranchEligibility(messages, 'a1', true).eligible).toBe(true);
    expect(build(messages).messages[1].toolCalls?.[0].result).toBe('File saved');
  });

  it.each(['[Tool execution interrupted by user]', '[Cancelled]', '[已取消]'])(
    'keeps recorded cancellation %s as an unknown outcome in model history', result => {
      const tool = { id: 'write', name: 'write_file', input: { path: '/work/report.txt' }, result };
      const messages = [user('u1', { runState: 'interrupted' }), answer('a1', {
        content: '', stopReason: 'user', toolCalls: [{ ...tool, isError: true }], toolCallsForContext: [tool],
      })];
      expect(normalizeMessages(build(messages).messages)[1]).toMatchObject({ kind: 'assistant',
        toolCalls: [{ isError: true, result: expect.stringContaining('Its outcome is unknown') }] });
      expect(messages[1].toolCallsForContext?.[0].result).toBe(result);
    },
  );

  it('keeps a known tool failure when the context projection lacks its error flag', () => {
    const tool = { id: 'read', name: 'read_file', input: {}, result: 'File missing' };
    const child = build([user(), answer('a1', { toolCalls: [{ ...tool, isError: true }], toolCallsForContext: [tool] })]);
    expect(normalizeMessages(child.messages)[1]).toMatchObject({ kind: 'assistant',
      toolCalls: [{ isError: true, result: 'File missing' }] });
  });

  it('keeps a legacy streaming reply unavailable until it has ended', () => {
    expect(getConversationBranchEligibility([user('u1', { runState: undefined }),
      answer('a1', { isStreaming: true })], 'a1', true).eligible).toBe(false);
  });

  it.each([
    { isExecuting: true, result: 'partial' },
    { result: 'blocked', sandboxRecoveryAction: 'pending' as const },
    { result: 'blocked', sandboxRecoveryAction: 'started' as const },
    { result: 'blocked', sandboxRecoveryAction: 'enqueued' as const },
  ])('blocks active legacy tools: %j', overrides => {
    const tool: ToolCall = { id: 't1', name: 'run_command', input: {}, ...overrides };
    expect(getConversationBranchEligibility([user('u1', { runState: undefined }), answer('tools', { toolCalls: [tool] }), answer()], 'a1', true).eligible).toBe(false);
  });

  it('accepts a tool error and an empty successful result followed by a completed answer', () => {
    const messages = [user(), answer('tools', { toolCalls: [
      { id: 't1', name: 'read_file', input: {}, result: 'File missing', isError: true },
      { id: 't2', name: 'run_command', input: {}, result: '' },
    ] }), answer()];
    expect(getConversationBranchEligibility(messages, 'a1', true).eligible).toBe(true);
  });

  it('keeps hidden recovery prompts under the visible user run state', () => {
    const messages = [user('u1', { runState: 'running' }), user('recovery', { isSystem: true, runState: undefined }), answer()];
    expect(getConversationBranchEligibility(messages, 'a1', true).eligible).toBe(false);
    messages[0].runState = 'completed';
    expect(getConversationBranchEligibility(messages, 'a1', true).eligible).toBe(true);
  });

  it('rejects an empty conversation, missing target, standalone greeting and internal message', () => {
    expect(getConversationBranchEligibility([], 'a1', true).eligible).toBe(false);
    expect(getConversationBranchEligibility([user(), answer()], 'removed', true).eligible).toBe(false);
    expect(getConversationBranchEligibility([answer()], 'a1', true).eligible).toBe(false);
    expect(getConversationBranchEligibility([user(), answer('a1', { isSystem: true })], 'a1', true).eligible).toBe(false);
    expect(getConversationBranchEligibility([user(), answer('a1', { introduction: { kind: 'agent', key: 'agent:x', name: 'Expert' } })], 'a1', true).eligible).toBe(false);
  });

  it('checks access again when building even if the menu previously allowed creation', () => {
    const messages = [user(), answer()];
    expect(getConversationBranchEligibility(messages, 'a1', true).eligible).toBe(true);
    expect(() => build(messages, 'a1', { accessAllowed: false })).toThrow(new ConversationBranchHistoryError('inaccessible'));
  });
});

describe('buildConversationBranchHistory', () => {
  it('copies exactly through the selected reply and records the immediate source', () => {
    const messages = [user(), answer(), user('u2'), answer('a2')];
    const result = build(messages);
    expect(result.messages.map(message => message.content)).toEqual(['Question', 'Answer']);
    expect(result.messages.every(message => message.inheritedFromBranch && !messages.some(source => source.id === message.id))).toBe(true);
    expect(result.branchOrigin).toEqual({
      version: 1, sourceConversationId: 'parent', sourceMessageId: 'a1', sourceTitle: 'Source title',
      inheritedThroughMessageId: result.messages[1].id,
    });
    expect(result.messageIdMap.get('a1')).toBe(result.messages[1].id);
    expect(result.messageIdMap.has('a2')).toBe(false);
    let grandchildId = 0;
    const grandchild = build(result.messages, result.messages[1].id, {
      sourceConversationId: 'child', childConversationId: 'grandchild', createId: kind => `grandchild-${kind}-${++grandchildId}`,
    });
    expect(grandchild.branchOrigin.sourceConversationId).toBe('child');
    expect(grandchild.branchOrigin.sourceMessageId).toBe(result.messages[1].id);
  });

  it('assigns each user turn its own loop even when old loopIds were reused', () => {
    const result = build([user(), answer(), user('u2'), answer('a2')], 'a2');
    expect(result.messages[0].loopId).toBe(result.messages[1].loopId);
    expect(result.messages[2].loopId).toBe(result.messages[3].loopId);
    expect(result.messages[0].loopId).not.toBe(result.messages[2].loopId);
    expect(result.messages.every(message => message.loopId !== 'loop1')).toBe(true);
  });

  it('makes nested content independent while preserving text, thinking and tool provider identities', () => {
    const messages = [user(), answer('tools', {
      thinking: 'Thought', thinkingSignature: 'signature', redactedThinking: ['opaque'],
      toolCalls: [{ id: 'provider-t1', name: 'read_file', input: { path: 'u1' }, result: 'a1' }],
      toolCallsForContext: [{ id: 'provider-t1', name: 'read_file', input: { path: 'u1' }, result: 'a1' }],
    }), answer('a1', { content: [{ type: 'text', text: 'u1 a1 loop1' }], usage: { outputTokens: 30 } })];
    const original = structuredClone(messages);
    const result = build(messages);
    expect(result.messages[1].toolCalls?.[0].id).toBe('provider-t1');
    expect(result.messages[1].toolCallsForContext?.[0].id).toBe('provider-t1');
    expect(result.messages[1]).toMatchObject({ thinking: 'Thought', thinkingSignature: 'signature', redactedThinking: ['opaque'] });
    expect(result.messages[2]).toMatchObject({ content: [{ type: 'text', text: 'u1 a1 loop1' }], usage: { outputTokens: 30 }, timestamp: 200 });
    result.messages[1].toolCalls![0].input.path = 'changed';
    expect(messages).toEqual(original);
  });

  it('removes run correlation and ends older active history without rewriting earlier errors', () => {
    const oldUser = user('old-user', { runState: 'interrupted', runError: 'original error', runId: 'old-run', clientMessageId: 'old-client' });
    const oldAnswer = answer('old-answer', { isStreaming: true, toolCalls: [
      { id: 'old-tool', name: 'run_command', input: {}, isExecuting: true, sandboxRecoveryAction: 'started', result: 'blocked' },
    ] });
    const result = build([oldUser, oldAnswer, user('stale', { runState: 'recovering' }), user(), answer()]);
    expect(result.messages[0]).toMatchObject({ runState: 'interrupted', runError: 'original error' });
    expect(result.messages[0]).not.toHaveProperty('runId');
    expect(result.messages[0]).not.toHaveProperty('clientMessageId');
    expect(result.messages[1].toolCalls?.[0]).toMatchObject({ isExecuting: false, sandboxRecoveryAction: 'stopped' });
    expect(result.messages[2].runState).toBe('interrupted');
  });

  it('remaps nested execution snapshots and batch ownership while keeping tool IDs paired', () => {
    const steps: NonNullable<Message['executionSteps']> = [{
      id: 'step-old', toolCallId: 't1', type: 'delegate', label: 'Delegate', status: 'completed', toolName: 'run_agent_batch',
      childSteps: [{ id: 'child-step-old', type: 'tool', label: 'Read', status: 'completed', toolName: 'read_file',
        detailBlocks: [{ id: 'detail-old', title: 'Result', type: 'result', content: 'step-old' }] }],
    }];
    const result = build([user(), answer('tools', {
      executionSteps: steps,
      toolCalls: [{ id: 't1', name: 'run_agent_batch', input: {}, result: 'Complete', batchTerminalSummary: {
        version: 1, batch: { conversationId: 'parent', assistantMessageId: 'tools', batchToolCallId: 't1' },
        taskCount: 1, counts: { succeeded: 1, failed: 0, stopped: 0, incomplete: 0 },
        tasks: [{ taskIndex: 0, status: 'succeeded', terminalReason: 'completed' }],
      } }],
    }), answer()]);
    const copied = result.messages[1];
    expect(copied.executionSteps?.[0].id).not.toBe('step-old');
    expect(copied.executionSteps?.[0].childSteps?.[0].id).not.toBe('child-step-old');
    expect(copied.executionSteps?.[0].childSteps?.[0].detailBlocks?.[0]).toMatchObject({ content: 'step-old' });
    expect(copied.executionSteps?.[0].toolCallId).toBe('t1');
    expect(copied.toolCalls?.[0].batchTerminalSummary?.batch).toEqual({ conversationId: 'child', assistantMessageId: copied.id, batchToolCallId: 't1' });
    expect(steps[0].id).toBe('step-old');
  });

  it('keeps successful summary references closed within the copied prefix', () => {
    const boundary = summary({ cutUserMessage: { id: 'u1', text: 'Part of question' }, restoredFiles: [{ path: '/project/file', content: 'Then' }] });
    const result = build([user(), answer(), boundary, user('u2'), answer('a2')], 'a2');
    const copied = result.messages[2];
    expect(copied.id.startsWith('compact-boundary-')).toBe(true);
    expect(copied.compactBoundary).toMatchObject({
      summarizedFromId: result.messages[0].id, summarizedToId: result.messages[1].id,
      keptUserMessageIds: [result.messages[0].id], cutUserMessage: { id: result.messages[0].id, text: 'Part of question' },
    });
    const context = buildContextFromBoundary(result.messages);
    expect(context[0].content).toBe('Part of question');
    expect(context.some(message => typeof message.content === 'string' && message.content.includes('Earlier question and answer'))).toBe(true);
    expect(boundary.compactBoundary?.summarizedFromId).toBe('u1');
  });

  it('keeps a failed empty-range marker and excludes summaries after the selected reply', () => {
    const failed = summary({ status: 'failed', summaryText: '', summarizedFromId: '', summarizedToId: '', keptUserMessageIds: undefined });
    failed.id = 'compact-boundary-failed';
    const later = summary({ summaryText: 'FUTURE INFORMATION' });
    const result = build([user(), failed, answer(), later, user('u2'), answer('a2')]);
    expect(result.messages[1].compactBoundary).toMatchObject({ status: 'failed', summarizedFromId: '', summarizedToId: '' });
    expect(buildContextFromBoundary(result.messages)).toBe(result.messages);
    expect(JSON.stringify(result.messages)).not.toContain('FUTURE INFORMATION');
  });

  it.each([
    { summarizedFromId: 'gone' },
    { summarizedToId: 'a2' },
    { summarizedFromId: 'a1', summarizedToId: 'u1' },
    { keptUserMessageIds: ['a1'] },
    { keptUserMessageIds: ['u2'] },
    { cutUserMessage: { id: 'u2', text: 'cut' } },
  ])('rejects invalid summary references: %j', overrides => {
    expect(() => build([user(), answer(), summary(overrides), user('u2'), answer('a2')], 'a2'))
      .toThrow(new ConversationBranchHistoryError('invalid-history'));
  });

  it('preserves marker prefixes used by history renderers', () => {
    const markers: Message[] = ['browser-run-report-', 'max-turns-', 'expert-introduction:'].map((prefix, index) => ({
      id: `${prefix}${index}`, role: 'system', content: 'Historical marker', timestamp: 1,
    }));
    const result = build([...markers, user(), answer()]);
    markers.forEach((marker, index) => {
      expect(result.messages[index].id).not.toBe(marker.id);
      expect(result.messages[index].id.startsWith(marker.id.slice(0, -1))).toBe(true);
    });
  });

  it('rejects duplicate source IDs and reused, empty or source-owned generated IDs', () => {
    expect(() => build([user(), answer('duplicate'), answer('duplicate'), answer()])).toThrow(new ConversationBranchHistoryError('invalid-history'));
    for (const id of ['', 'u1', 'loop1', 'parent', 'child', 'same']) {
      expect(() => build([user(), answer()], 'a1', { createId: () => id })).toThrow(new ConversationBranchHistoryError('invalid-id'));
    }
    expect(() => build([user(), answer()], 'a1', { childConversationId: 'parent' })).toThrow(new ConversationBranchHistoryError('invalid-id'));
  });
});
