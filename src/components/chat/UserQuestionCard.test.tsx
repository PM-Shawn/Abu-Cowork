/// <reference types="@testing-library/jest-dom" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import UserQuestionCard from './UserQuestionCard';
import * as bridge from '@/core/agent/permissionBridge';
import type { ToolCall, UserQuestionPayload } from '@/types';

// ── Mocks ───────────────────────────────────────────────────────────────

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      userQuestion: {
        cardTitle: '请选择',
        singleSelectHint: '单选',
        multiSelectHint: '可多选',
        otherOptionLabel: '其他…',
        otherInputPlaceholder: '请输入自定义内容',
        submitButton: '提交',
        answeredLabel: '已作答',
        submitDisabledHint: '请为每道题选择或填写答案',
        cancelledLabel: '已取消',
      },
    },
  }),
}));

const mockSetAnswers = vi.fn();
vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (s: unknown) => unknown) =>
    selector({ setToolCallUserQuestionAnswers: mockSetAnswers }),
}));

// ── Fixtures ─────────────────────────────────────────────────────────────

const SINGLE_TC: ToolCall = {
  id: 'tc-single',
  name: 'ask_user_question',
  input: {
    questions: [
      {
        header: '格式',
        question: '你希望输出什么格式？',
        multiSelect: false,
        options: [{ label: '详细', description: '带示例' }, { label: '简洁' }],
      },
    ],
  },
};

const MULTI_TC: ToolCall = {
  id: 'tc-multi',
  name: 'ask_user_question',
  input: {
    questions: [
      {
        header: 'Sections',
        question: '包含哪些部分？',
        multiSelect: true,
        options: [{ label: '引言' }, { label: '结论' }, { label: '示例' }],
      },
    ],
  },
};

function makePending(tc: ToolCall) {
  bridge.requestUserQuestion(tc.id, 'conv-a', tc.input as unknown as UserQuestionPayload);
}

describe('UserQuestionCard', () => {
  beforeEach(() => {
    bridge.drainUserQuestions();
    mockSetAnswers.mockClear();
  });

  afterEach(() => {
    cleanup();
    bridge.drainUserQuestions();
  });

  it('renders question header, text, options, and the Other option', () => {
    makePending(SINGLE_TC);
    render(<UserQuestionCard conversationId="conv-a" messageId="msg-1" toolCall={SINGLE_TC} />);

    expect(screen.getByText('请选择')).toBeInTheDocument();
    expect(screen.getByText('格式')).toBeInTheDocument();
    expect(screen.getByText('你希望输出什么格式？')).toBeInTheDocument();
    expect(screen.getByText('详细')).toBeInTheDocument();
    expect(screen.getByText('简洁')).toBeInTheDocument();
    expect(screen.getByText('其他…')).toBeInTheDocument();
  });

  it('disables submit until an option is chosen', () => {
    makePending(SINGLE_TC);
    render(<UserQuestionCard conversationId="conv-a" messageId="msg-1" toolCall={SINGLE_TC} />);
    expect(screen.getByText('提交').closest('button')).toBeDisabled();
  });

  it('enables submit after a single-select choice', async () => {
    const user = userEvent.setup();
    makePending(SINGLE_TC);
    render(<UserQuestionCard conversationId="conv-a" messageId="msg-1" toolCall={SINGLE_TC} />);

    await user.click(screen.getByText('详细').closest('button')!);
    expect(screen.getByText('提交').closest('button')).not.toBeDisabled();
  });

  it('keeps submit disabled when Other is checked but empty', async () => {
    const user = userEvent.setup();
    makePending(SINGLE_TC);
    render(<UserQuestionCard conversationId="conv-a" messageId="msg-1" toolCall={SINGLE_TC} />);

    await user.click(screen.getByText('其他…').closest('button')!);
    expect(screen.getByText('提交').closest('button')).toBeDisabled();
  });

  it('submit calls setAnswers and resolveUserQuestion', async () => {
    const user = userEvent.setup();
    const resolveSpy = vi.spyOn(bridge, 'resolveUserQuestion');
    makePending(SINGLE_TC);
    render(<UserQuestionCard conversationId="conv-a" messageId="msg-1" toolCall={SINGLE_TC} />);

    await user.click(screen.getByText('详细').closest('button')!);
    await user.click(screen.getByText('提交').closest('button')!);

    expect(mockSetAnswers).toHaveBeenCalledWith(
      'conv-a',
      'msg-1',
      'tc-single',
      expect.objectContaining({
        answers: expect.arrayContaining([
          expect.objectContaining({ header: '格式', selected: ['详细'] }),
        ]),
      }),
    );
    expect(resolveSpy).toHaveBeenCalledWith('tc-single', expect.any(Object));
    resolveSpy.mockRestore();
  });

  it('renders read-only settled state when answered', () => {
    const settledTc: ToolCall = {
      ...SINGLE_TC,
      userQuestionAnswers: {
        answers: [{ header: '格式', question: '你希望输出什么格式？', selected: ['详细'] }],
      },
    };
    render(<UserQuestionCard conversationId="conv-a" messageId="msg-1" toolCall={settledTc} />);

    expect(screen.getByText('已作答')).toBeInTheDocument();
    expect(screen.queryByText('提交')).not.toBeInTheDocument();
  });

  it('multi-select allows multiple choices', async () => {
    const user = userEvent.setup();
    makePending(MULTI_TC);
    render(<UserQuestionCard conversationId="conv-a" messageId="msg-2" toolCall={MULTI_TC} />);

    await user.click(screen.getByText('引言').closest('button')!);
    await user.click(screen.getByText('结论').closest('button')!);

    expect(screen.getByText('提交').closest('button')).not.toBeDisabled();
  });
});
