// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import UserQuestionCard from './UserQuestionCard';
import type { ToolCall } from '@/types';

// ── Mocks ───────────────────────────────────────────────────────────────

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      userQuestion: {
        cardTitle: '请选择',
        cancelledLabel: '已取消',
        yourChoiceLabel: '你的选择',
        repliedInChatLabel: '你在对话里回复了',
      },
    },
    format: (tpl: string, v: Record<string, string | number>) =>
      tpl.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? '')),
  }),
}));

// ── Fixtures ─────────────────────────────────────────────────────────────

const SETTLED_TC: ToolCall = {
  id: 'tc-settled',
  name: 'ask_user_question',
  input: {
    questions: [
      {
        header: '格式',
        question: '你希望输出什么格式？',
        multiSelect: false,
        options: [{ label: '详细' }, { label: '简洁' }],
      },
    ],
  },
  userQuestionAnswers: {
    answers: [{ header: '格式', question: '你希望输出什么格式？', selected: ['详细'] }],
  },
};

describe('UserQuestionCard (settled, read-only)', () => {
  afterEach(() => cleanup());

  it('renders a left-aligned "your choices" card with question and answer', () => {
    render(<UserQuestionCard toolCall={SETTLED_TC} />);

    // "Your choices" header present
    expect(screen.getByText('你的选择')).toBeInTheDocument();
    // Question + answer text present
    expect(screen.getByText('你希望输出什么格式？')).toBeInTheDocument();
    expect(screen.getByText('详细')).toBeInTheDocument();
    // No interactive submit control
    expect(screen.queryByText('提交')).not.toBeInTheDocument();
  });

  it('shows a reply written in the chat once, instead of the questions', () => {
    render(<UserQuestionCard toolCall={{
      ...SETTLED_TC,
      userQuestionAnswers: { answers: [], chatReply: '先别做报表了，改成汇总表' },
    }} />);

    expect(screen.getByText('你在对话里回复了')).toBeInTheDocument();
    expect(screen.getAllByText('先别做报表了，改成汇总表')).toHaveLength(1);
    expect(screen.queryByText('你的选择')).not.toBeInTheDocument();
    expect(screen.queryByText('你希望输出什么格式？')).not.toBeInTheDocument();
  });

  it('draws the settled answers as a flat card', () => {
    render(<UserQuestionCard toolCall={SETTLED_TC} />);
    const card = screen.getByText('你的选择').parentElement!;
    expect(card).toHaveClass('rounded-panel');
    expect(card).toHaveClass('border-separator');
    expect(card).toHaveClass('bg-surface');
    expect(screen.getByText('详细')).toHaveClass('text-label');
  });

  it('joins multi-select answers with 、', () => {
    const multiTc: ToolCall = {
      ...SETTLED_TC,
      id: 'tc-multi',
      userQuestionAnswers: {
        answers: [{ header: 'Sections', question: '包含哪些部分？', selected: ['引言', '结论'] }],
      },
    };
    render(<UserQuestionCard toolCall={multiTc} />);
    expect(screen.getByText('引言、结论')).toBeInTheDocument();
  });

  it('renders a cancelled marker when there are no answers', () => {
    const cancelledTc: ToolCall = { ...SETTLED_TC, id: 'tc-cancel', userQuestionAnswers: undefined };
    render(<UserQuestionCard toolCall={cancelledTc} />);
    expect(screen.getByText(/已取消/)).toBeInTheDocument();
  });
});
