// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
/**
 * A message the user typed while a run worked and the run took at a step
 * boundary (`Message.steered`) stays inside that run's block: shown once, at
 * the step it followed, and still shown when the finished run folds its
 * process away.
 */
import { cleanup, fireEvent, render as renderBare, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemProvider } from '@/components/ds/provider';
import { initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { useWorkProcessFoldStore } from '@/stores/workProcessFoldStore';
import type { Conversation, Message } from '@/types';
import MessageGroup from './MessageGroup';
import { groupMessagesByLoop } from './messageGrouping';

vi.mock('@/core/session/outputSnapshots', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/core/session/outputSnapshots')>(),
  resolveFileSource: vi.fn().mockResolvedValue({ status: 'missing', basename: 'a.md', originalPath: '/tmp/a.md' }),
}));

const render = (ui: ReactElement) => renderBare(ui, { wrapper: DesignSystemProvider });

const CONV = 'conv-steered-group';
const request: Message = { id: 'request', role: 'user', content: '整理九月的销售表', timestamp: 1000, loopId: 'loop-1' };
const toolStep: Message = {
  id: 'step-1', role: 'assistant', content: '', timestamp: 2000, loopId: 'loop-1',
  toolCalls: [{ id: 'read-1', name: 'read_file', input: { path: '/w/sales.xlsx' }, result: 'rows' }],
};
const steered: Message = { id: 'steer-q1', role: 'user', content: '只要华东区的', timestamp: 2500, loopId: 'loop-1', steered: true };
const answer: Message = { id: 'answer', role: 'assistant', content: '华东区九月销售额如下', timestamp: 3000, loopId: 'loop-1' };

function seed(messages: Message[], status: Conversation['status'] = 'idle'): void {
  useChatStore.setState({
    activeConversationId: CONV,
    conversations: { [CONV]: { id: CONV, title: 't', messages, createdAt: 0, updatedAt: 0, status } },
    agentStates: new Map(),
  });
}

const bubbles = (container: HTMLElement, id: string) => container.querySelectorAll(`[data-message-id="${id}"]`);

describe('MessageGroup with a steered message', () => {
  beforeEach(() => {
    initLanguage('en-US');
    useWorkProcessFoldStore.getState().reset();
  });
  afterEach(() => {
    cleanup();
    useWorkProcessFoldStore.getState().reset();
  });

  it('is one block: the request on top, the steered message once, between the step and the answer', () => {
    const messages = [request, toolStep, steered, answer];
    seed(messages);
    const groups = groupMessagesByLoop(messages);
    expect(groups).toHaveLength(1);

    const { container } = render(<MessageGroup conversationId={CONV} messages={groups[0]} isLastGroup isLastGroupOfLoop />);

    expect(bubbles(container, 'request')).toHaveLength(1);
    expect(bubbles(container, 'steer-q1')).toHaveLength(1);
    const text = container.textContent ?? '';
    expect(text.indexOf('整理九月的销售表')).toBeLessThan(text.indexOf('只要华东区的'));
    expect(text.indexOf('只要华东区的')).toBeLessThan(text.indexOf('华东区九月销售额如下'));
  });

  it('stays visible when the finished run folds its steps away, and after unfolding', () => {
    const messages = [request, toolStep, steered, answer];
    seed(messages);
    const { container } = render(<MessageGroup conversationId={CONV} messages={messages} isLastGroup isLastGroupOfLoop />);

    const fold = screen.getByRole('button', { name: /Worked for/ });
    expect(fold).toHaveAttribute('aria-expanded', 'false');
    expect(bubbles(container, 'steer-q1')).toHaveLength(1);
    fireEvent.click(fold);
    expect(bubbles(container, 'steer-q1')).toHaveLength(1);
  });

  it('in a group that does not start with a request (a goal round) is still shown once, at its step', () => {
    const messages = [toolStep, steered, answer];
    seed([request, ...messages]);

    const { container } = render(<MessageGroup conversationId={CONV} messages={messages} isLastGroup isLastGroupOfLoop />);

    expect(bubbles(container, 'steer-q1')).toHaveLength(1);
    expect(screen.getByText('只要华东区的')).toBeInTheDocument();
  });

  it('offers no edit on the steered message', () => {
    const messages = [request, toolStep, steered, answer];
    seed(messages);
    const { container } = render(<MessageGroup conversationId={CONV} messages={messages} isLastGroup isLastGroupOfLoop />);
    const steeredBubble = bubbles(container, 'steer-q1')[0] as HTMLElement;
    const requestBubble = bubbles(container, 'request')[0] as HTMLElement;

    expect(steeredBubble.querySelector('[aria-label="Edit"]')).toBeNull();
    expect(requestBubble.querySelector('[aria-label="Edit"]')).not.toBeNull();
  });
});

// Tester addition (P7): a transcript written before steering existed. The old
// queue injected a follow-up into the running loopId without any mark; it must
// still render as its own turn, each user message exactly once.
describe('MessageGroup with an old transcript (no steered field)', () => {
  beforeEach(() => {
    initLanguage('en-US');
    useWorkProcessFoldStore.getState().reset();
  });
  afterEach(() => {
    cleanup();
    useWorkProcessFoldStore.getState().reset();
  });

  it('renders the old same-loop follow-up as its own request, each user message once', () => {
    const oldFollowUp: Message = { id: 'old-follow-up', role: 'user', content: '再加一列同比', timestamp: 2500, loopId: 'loop-1' };
    const secondAnswer: Message = { id: 'answer-2', role: 'assistant', content: '已加上同比列', timestamp: 4000, loopId: 'loop-1' };
    const messages = [request, toolStep, answer, oldFollowUp, secondAnswer];
    seed(messages);
    const groups = groupMessagesByLoop(messages);
    expect(groups.map((group) => group[0].id)).toEqual(['request', 'old-follow-up']);

    const first = render(<MessageGroup conversationId={CONV} messages={groups[0]} isLastGroupOfLoop={false} />);
    expect(bubbles(first.container, 'request')).toHaveLength(1);
    expect(bubbles(first.container, 'old-follow-up')).toHaveLength(0);
    first.unmount();

    const second = render(<MessageGroup conversationId={CONV} messages={groups[1]} isLastGroup isLastGroupOfLoop />);
    expect(bubbles(second.container, 'old-follow-up')).toHaveLength(1);
    expect(second.container.textContent).toContain('已加上同比列');
  });
});
