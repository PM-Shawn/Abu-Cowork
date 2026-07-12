import { describe, it, expect, beforeEach } from 'vitest';
import { useTaskExecutionStore } from '../../stores/taskExecutionStore';
import { useChatStore } from '../../stores/chatStore';
import { formatPlannedStepsForPrompt } from './plannedStepsPrompt';
import type { Conversation, Message } from '../../types/index';

function makeConversation(id: string, messages: Message[]): Conversation {
  return {
    id,
    title: 'test',
    messages,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'idle',
  };
}

function makeMessage(overrides: Partial<Message>): Message {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('formatPlannedStepsForPrompt', () => {
  beforeEach(() => {
    useTaskExecutionStore.setState({ executions: {}, activeExecutionId: null, loopIdIndex: {} });
    useChatStore.setState({ conversations: {} });
  });

  it('returns empty string when there is no execution and no message snapshot', () => {
    expect(formatPlannedStepsForPrompt('nope')).toBe('');
  });

  it('formats steps with emoji and completed count', () => {
    const store = useTaskExecutionStore.getState();
    const exec = store.createExecution('conv-1', 'loop-1');
    store.setPlannedSteps(exec.id, [
      { index: 1, description: 'Scan', status: 'completed' },
      { index: 2, description: 'Build', status: 'in_progress' },
    ]);
    const out = formatPlannedStepsForPrompt('conv-1');
    expect(out).toContain('1/2');
    expect(out).toContain('✅');
    expect(out).toContain('🔄');
    expect(out).toContain('Scan');
  });

  // LLM-facing system prompts must be English (CLAUDE.md language convention);
  // response language is controlled separately by the response-language section.
  it('uses an English header, not Chinese', () => {
    const store = useTaskExecutionStore.getState();
    const exec = store.createExecution('conv-1', 'loop-1');
    store.setPlannedSteps(exec.id, [{ index: 1, description: 'Scan', status: 'completed' }]);
    const out = formatPlannedStepsForPrompt('conv-1');
    expect(out).toContain('Current task plan');
    expect(out).toContain('1/1 completed');
    expect(out).not.toContain('已完成');
  });

  it('falls back to the latest message snapshot when the live execution has no planned steps', () => {
    useChatStore.setState({
      conversations: {
        'conv-1': makeConversation('conv-1', [
          makeMessage({ id: 'm1', content: 'hi' }),
          makeMessage({
            id: 'm2',
            plannedSteps: [
              { index: 1, description: 'Scan', status: 'completed' },
              { index: 2, description: 'Build', status: 'in_progress' },
            ],
          }),
        ]),
      },
    });

    const out = formatPlannedStepsForPrompt('conv-1');
    expect(out).toContain('1/2');
    expect(out).toContain('Scan');
    expect(out).toContain('✅');
    expect(out).toContain('🔄');
  });

  it('prefers the live execution plannedSteps over an older message snapshot', () => {
    const store = useTaskExecutionStore.getState();
    const exec = store.createExecution('conv-1', 'loop-1');
    store.setPlannedSteps(exec.id, [{ index: 1, description: 'Live', status: 'pending' }]);

    useChatStore.setState({
      conversations: {
        'conv-1': makeConversation('conv-1', [
          makeMessage({
            id: 'm1',
            plannedSteps: [{ index: 1, description: 'Stale', status: 'completed' }],
          }),
        ]),
      },
    });

    const out = formatPlannedStepsForPrompt('conv-1');
    expect(out).toContain('Live');
    expect(out).not.toContain('Stale');
    expect(out).toContain('0/1 completed');
  });
});
