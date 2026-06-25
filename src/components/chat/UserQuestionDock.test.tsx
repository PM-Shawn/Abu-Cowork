/// <reference types="@testing-library/jest-dom" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import UserQuestionDock from './UserQuestionDock';
import * as bridge from '@/core/agent/permissionBridge';
import type { UserQuestionPayload } from '@/types';

// ── Mocks ───────────────────────────────────────────────────────────────

vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: {
      userQuestion: {
        singleSelectHint: '单选',
        multiSelectHint: '可多选',
        otherOptionLabel: '其他…',
        otherInputPlaceholder: '请输入自定义内容',
        submitButton: '提交',
        submitDisabledHint: '请为每道题选择或填写答案',
        pager: '{current} / {total}',
        skip: '跳过',
        skippedMarker: '（已跳过）',
        navHint: '导航提示',
        prevQuestion: '上一题',
        nextQuestion: '下一题',
        close: '关闭',
      },
    },
    format: (tpl: string, v: Record<string, string | number>) =>
      tpl.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? '')),
  }),
}));

const mockSetAnswers = vi.fn();
vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (s: unknown) => unknown) =>
    selector({ setToolCallUserQuestionAnswers: mockSetAnswers }),
}));

// ── Fixtures ─────────────────────────────────────────────────────────────

const SINGLE_PAYLOAD: UserQuestionPayload = {
  questions: [
    {
      header: '格式',
      question: '你希望输出什么格式？',
      multiSelect: false,
      options: [{ label: '详细', description: '带示例' }, { label: '简洁' }],
    },
  ],
};

const MULTI_PAYLOAD: UserQuestionPayload = {
  questions: [
    {
      header: 'Sections',
      question: '包含哪些部分？',
      multiSelect: true,
      options: [{ label: '引言' }, { label: '结论' }, { label: '示例' }],
    },
  ],
};

const TWO_Q_PAYLOAD: UserQuestionPayload = {
  questions: [
    { header: 'Q1', question: '第一题？', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] },
    { header: 'Q2', question: '第二题？', multiSelect: false, options: [{ label: 'C' }, { label: 'D' }] },
  ],
};

function renderDock(payload: UserQuestionPayload, toolCallId = 'tc-1') {
  return render(
    <UserQuestionDock
      conversationId="conv-a"
      messageId="msg-1"
      toolCallId={toolCallId}
      payload={payload}
    />,
  );
}

describe('UserQuestionDock', () => {
  beforeEach(() => {
    mockSetAnswers.mockClear();
  });

  afterEach(() => {
    cleanup();
    bridge.drainUserQuestions();
  });

  it('renders header, question text, numbered options, Other and Skip', () => {
    renderDock(SINGLE_PAYLOAD);
    expect(screen.getByText('格式')).toBeInTheDocument();
    expect(screen.getByText('你希望输出什么格式？')).toBeInTheDocument();
    expect(screen.getByText('详细')).toBeInTheDocument();
    expect(screen.getByText('简洁')).toBeInTheDocument();
    expect(screen.getByText('其他…')).toBeInTheDocument();
    expect(screen.getByText('跳过')).toBeInTheDocument();
  });

  it('shows the pager counter', () => {
    renderDock(TWO_Q_PAYLOAD);
    expect(screen.getByText('1 / 2')).toBeInTheDocument();
  });

  it('single-select on the last/only question submits via setAnswers + resolveUserQuestion', async () => {
    const user = userEvent.setup();
    const resolveSpy = vi.spyOn(bridge, 'resolveUserQuestion');
    renderDock(SINGLE_PAYLOAD, 'tc-single');

    // Clicking a single-select option on the last question auto-submits.
    await user.click(screen.getByText('详细').closest('button')!);

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

  it('multi-select keeps the dock open and Submit becomes enabled after a choice', async () => {
    const user = userEvent.setup();
    renderDock(MULTI_PAYLOAD, 'tc-multi');

    expect(screen.getByText('提交').closest('button')).toBeDisabled();
    await user.click(screen.getByText('引言').closest('button')!);
    await user.click(screen.getByText('结论').closest('button')!);
    expect(screen.getByText('提交').closest('button')).not.toBeDisabled();
  });

  it('keeps Submit disabled when Other is checked but empty', async () => {
    const user = userEvent.setup();
    renderDock(MULTI_PAYLOAD, 'tc-multi-other');

    await user.click(screen.getByText('其他…').closest('button')!);
    expect(screen.getByText('提交').closest('button')).toBeDisabled();
  });

  it('advances pages and submits with one skipped question', async () => {
    const user = userEvent.setup();
    const resolveSpy = vi.spyOn(bridge, 'resolveUserQuestion');
    renderDock(TWO_Q_PAYLOAD, 'tc-two');

    // Skip question 1 → advances to question 2.
    await user.click(screen.getByText('跳过').closest('button')!);
    expect(screen.getByText('2 / 2')).toBeInTheDocument();

    // Answer question 2 (single-select, last page → auto submit).
    await user.click(screen.getByText('C').closest('button')!);

    expect(resolveSpy).toHaveBeenCalledWith(
      'tc-two',
      expect.objectContaining({
        answers: expect.arrayContaining([
          expect.objectContaining({ header: 'Q1', selected: ['（已跳过）'] }),
          expect.objectContaining({ header: 'Q2', selected: ['C'] }),
        ]),
      }),
    );
    resolveSpy.mockRestore();
  });

  it('close button cancels with null', async () => {
    const user = userEvent.setup();
    const resolveSpy = vi.spyOn(bridge, 'resolveUserQuestion');
    renderDock(SINGLE_PAYLOAD, 'tc-cancel');

    await user.click(screen.getByLabelText('关闭'));
    expect(resolveSpy).toHaveBeenCalledWith('tc-cancel', null);
    resolveSpy.mockRestore();
  });
});
