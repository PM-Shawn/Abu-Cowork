// @vitest-environment happy-dom
/// <reference types="@testing-library/jest-dom" />
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { DesignSystemProvider } from '@/components/ds/provider';
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
        confirmButton: '确认执行',
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

const CONFIRM_PAYLOAD: UserQuestionPayload = {
  confirm: true,
  questions: [
    {
      header: '计划审批',
      question: '是否批准执行此计划？',
      multiSelect: false,
      options: [{ label: '批准执行' }, { label: '拒绝，重新规划' }],
    },
  ],
};

const iconButtonRenders = vi.hoisted(() => vi.fn());

// Counts renders of the dock's floating-layer controls (the pager and close buttons' tooltips).
vi.mock('@/components/ds/button', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ds/button')>();
  return {
    ...actual,
    IconButton: (props: ComponentProps<typeof actual.IconButton>) => {
      iconButtonRenders();
      return actual.IconButton(props);
    },
  };
});

// Defined once, like ChatView's useCallback, so only `tick` changes between renders.
const onSubmittedOnce = () => undefined;

// Stands in for ChatView re-rendering on every streamed token: `tick` changes, the dock's props do not.
function Host({ tick }: { tick: number }) {
  return (
    <DesignSystemProvider>
      <span data-tick={tick} />
      <UserQuestionDock conversationId="conv-a" messageId="msg-1" toolCallId="tc-host" payload={TWO_Q_PAYLOAD} onSubmitted={onSubmittedOnce} />
    </DesignSystemProvider>
  );
}

function renderDock(payload: UserQuestionPayload, toolCallId = 'tc-1') {
  return render(
    <UserQuestionDock
      conversationId="conv-a"
      messageId="msg-1"
      toolCallId={toolCallId}
      payload={payload}
    />,
    { wrapper: DesignSystemProvider },
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

  it('makes the submit button the only filled button', () => {
    renderDock(MULTI_PAYLOAD);
    const submit = screen.getByRole('button', { name: '提交' });
    const filled = screen.getAllByRole('button').filter((button) => button.classList.contains('bg-emphasis'));
    expect(filled).toEqual([submit]);
    expect(screen.getByRole('button', { name: '跳过' })).not.toHaveClass('bg-emphasis');
    expect(screen.getByRole('button', { name: '关闭' })).not.toHaveClass('bg-emphasis');
  });

  it('marks a chosen option with the selected fill', async () => {
    const user = userEvent.setup();
    renderDock(MULTI_PAYLOAD);
    const option = screen.getByText('引言').closest('button')!;
    expect(option).not.toHaveClass('bg-fill-selected');
    await user.click(option);
    expect(option).toHaveClass('bg-fill-selected');
  });

  it('does not re-render its pager tooltips while the chat view streams', () => {
    const { rerender } = render(<Host tick={0} />);
    const initial = iconButtonRenders.mock.calls.length;
    expect(initial).toBeGreaterThan(0);
    rerender(<Host tick={1} />);
    rerender(<Host tick={2} />);
    expect(iconButtonRenders).toHaveBeenCalledTimes(initial);
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

  // Regression (review): plan approval reused the single-select shortcut, so a
  // stray click on "批准执行" executed a destructive plan instantly. Confirm
  // mode requires an explicit second click on the confirm button.
  it('confirm mode: clicking an option only selects, never auto-submits', async () => {
    const user = userEvent.setup();
    const resolveSpy = vi.spyOn(bridge, 'resolveUserQuestion');
    renderDock(CONFIRM_PAYLOAD, 'tc-confirm');

    await user.click(screen.getByText('批准执行').closest('button')!);

    expect(resolveSpy).not.toHaveBeenCalled();
    expect(mockSetAnswers).not.toHaveBeenCalled();
    resolveSpy.mockRestore();
  });

  it('confirm mode: submits only via the explicit confirm button', async () => {
    const user = userEvent.setup();
    const resolveSpy = vi.spyOn(bridge, 'resolveUserQuestion');
    renderDock(CONFIRM_PAYLOAD, 'tc-confirm-2');

    const confirmBtn = screen.getByText('确认执行').closest('button')!;
    expect(confirmBtn).toBeDisabled(); // nothing selected yet
    await user.click(screen.getByText('批准执行').closest('button')!);
    expect(confirmBtn).not.toBeDisabled();
    await user.click(confirmBtn);

    expect(resolveSpy).toHaveBeenCalledWith(
      'tc-confirm-2',
      expect.objectContaining({
        answers: expect.arrayContaining([
          expect.objectContaining({ header: '计划审批', selected: ['批准执行'] }),
        ]),
      }),
    );
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

  it('confirm mode: keyboard ArrowDown→Enter to select then Enter again to submit', async () => {
    const user = userEvent.setup();
    const resolveSpy = vi.spyOn(bridge, 'resolveUserQuestion');
    renderDock(CONFIRM_PAYLOAD, 'tc-kbd');

    // Focus the container (it has tabIndex=-1)
    const container = document.querySelector('[tabindex="-1"]') as HTMLElement;
    container.focus();

    // ArrowDown: highlight moves from 0 (批准执行) to 1 (拒绝，重新规划)
    await user.keyboard('{ArrowDown}');
    // First Enter: 拒绝，重新规划 not yet selected → select it
    await user.keyboard('{Enter}');
    // Second Enter: 拒绝，重新规划 is now selected + canSubmit=true → submit
    await user.keyboard('{Enter}');

    expect(resolveSpy).toHaveBeenCalledWith(
      'tc-kbd',
      expect.objectContaining({
        answers: expect.arrayContaining([
          expect.objectContaining({ selected: ['拒绝，重新规划'] }),
        ]),
      }),
    );
    resolveSpy.mockRestore();
  });

  it('confirm mode: Enter on Tab-focused confirm button triggers submit without flipping selection', async () => {
    const user = userEvent.setup();
    const resolveSpy = vi.spyOn(bridge, 'resolveUserQuestion');
    renderDock(CONFIRM_PAYLOAD, 'tc-kbd-btn');

    // Select '批准执行' via click → confirm button becomes enabled
    await user.click(screen.getByText('批准执行').closest('button')!);
    expect(resolveSpy).not.toHaveBeenCalled(); // confirm mode: click only selects

    // Focus the confirm button directly
    const confirmBtn = screen.getByText('确认执行').closest('button')!;
    confirmBtn.focus();
    expect(document.activeElement).toBe(confirmBtn);

    // Press Enter — F2(a) guard fires: HTMLButtonElement → container returns early
    // Button's native click fires → handleSubmit → '批准执行' is still selected
    await user.keyboard('{Enter}');

    expect(resolveSpy).toHaveBeenCalledWith(
      'tc-kbd-btn',
      expect.objectContaining({
        answers: expect.arrayContaining([
          expect.objectContaining({ selected: ['批准执行'] }),
        ]),
      }),
    );
    resolveSpy.mockRestore();
  });

  // The dock takes the focus by itself when a question arrives, and Enter answers with the
  // highlighted option. The Enter that sent the message may still be down at that moment: its
  // repeats answer nothing. A held key is the first key-down followed by repeats.
  describe('a key that is still down when the question appears', () => {
    const dock = () => document.querySelector('[tabindex="-1"]') as HTMLElement;
    const pressed = (key: string) => fireEvent.keyDown(dock(), { key, code: key });
    const repeated = (key: string) => fireEvent.keyDown(dock(), { key, code: key, repeat: true });
    const released = (key: string) => fireEvent.keyUp(dock(), { key, code: key });
    const answered = (...selected: string[][]) => expect.objectContaining({
      answers: selected.map((choice) => expect.objectContaining({ selected: choice })),
    });

    afterEach(() => { vi.restoreAllMocks(); });

    it('takes the focus when it appears, and the first press of Enter answers a single-choice question', () => {
      const resolveSpy = vi.spyOn(bridge, 'resolveUserQuestion');
      renderDock(SINGLE_PAYLOAD, 'tc-first-press');
      expect(dock()).toHaveFocus();

      pressed('Enter');

      expect(resolveSpy).toHaveBeenCalledExactlyOnceWith('tc-first-press', answered(['详细']));
    });

    it('leaves a single-choice question unanswered under the repeats of a held Enter; released and pressed again, Enter answers', () => {
      const resolveSpy = vi.spyOn(bridge, 'resolveUserQuestion');
      renderDock(SINGLE_PAYLOAD, 'tc-held');

      for (let i = 0; i < 5; i += 1) repeated('Enter');

      expect(resolveSpy).not.toHaveBeenCalled();
      expect(mockSetAnswers).not.toHaveBeenCalled();
      expect(screen.getByText('你希望输出什么格式？')).toBeInTheDocument();

      released('Enter');
      pressed('Enter');

      expect(resolveSpy).toHaveBeenCalledExactlyOnceWith('tc-held', answered(['详细']));
    });

    it('answers one question per press: the repeats of the Enter that answered the first do not answer the next', () => {
      const resolveSpy = vi.spyOn(bridge, 'resolveUserQuestion');
      renderDock(TWO_Q_PAYLOAD, 'tc-held-two');

      pressed('Enter');
      expect(screen.getByText('2 / 2')).toBeInTheDocument();
      for (let i = 0; i < 5; i += 1) repeated('Enter');

      expect(resolveSpy).not.toHaveBeenCalled();
      expect(screen.getByText('第二题？')).toBeInTheDocument();

      released('Enter');
      pressed('Enter');

      expect(resolveSpy).toHaveBeenCalledExactlyOnceWith('tc-held-two', answered(['A'], ['C']));
    });

    it('confirm mode: the repeats of a held Enter neither choose an option nor confirm it', () => {
      const resolveSpy = vi.spyOn(bridge, 'resolveUserQuestion');
      renderDock(CONFIRM_PAYLOAD, 'tc-held-confirm');
      const confirmButton = screen.getByText('确认执行').closest('button')!;

      for (let i = 0; i < 5; i += 1) repeated('Enter');

      expect(confirmButton).toBeDisabled();
      expect(resolveSpy).not.toHaveBeenCalled();

      // One press chooses; held on, it does not go on to confirm.
      released('Enter');
      pressed('Enter');
      expect(confirmButton).not.toBeDisabled();
      for (let i = 0; i < 5; i += 1) repeated('Enter');
      expect(resolveSpy).not.toHaveBeenCalled();

      released('Enter');
      pressed('Enter');
      expect(resolveSpy).toHaveBeenCalledExactlyOnceWith('tc-held-confirm', answered(['批准执行']));
    });

    it('multiple choice: a held Enter ticks the option once', () => {
      renderDock(MULTI_PAYLOAD, 'tc-held-multi');
      const submit = screen.getByText('提交').closest('button')!;

      pressed('Enter');
      expect(submit).not.toBeDisabled();
      for (let i = 0; i < 3; i += 1) repeated('Enter');

      expect(submit).not.toBeDisabled();
    });

    it('prevents the default of a repeated Enter, and leaves a repeat inside the text field and on a button alone', async () => {
      const user = userEvent.setup();
      renderDock(MULTI_PAYLOAD, 'tc-held-inner');
      // fireEvent returns false once the default was prevented.
      expect(repeated('Enter')).toBe(false);

      await user.click(screen.getByText('其他…').closest('button')!);
      const field = screen.getByPlaceholderText('请输入自定义内容');
      expect(fireEvent.keyDown(field, { key: 'a', code: 'KeyA', repeat: true })).toBe(true);
      expect(fireEvent.keyDown(field, { key: 'Backspace', code: 'Backspace', repeat: true })).toBe(true);
    });

    it('keeps walking the options with a held arrow, and a held Escape still cancels', () => {
      const resolveSpy = vi.spyOn(bridge, 'resolveUserQuestion');
      renderDock(SINGLE_PAYLOAD, 'tc-held-arrow');

      pressed('ArrowDown');
      repeated('ArrowDown');
      repeated('ArrowDown');
      released('ArrowDown');
      // Three steps down from the first option end on 跳过; two steps up end on the second option.
      pressed('ArrowUp');
      pressed('ArrowUp');
      pressed('Enter');
      expect(resolveSpy).toHaveBeenCalledExactlyOnceWith('tc-held-arrow', answered(['简洁']));

      cleanup();
      resolveSpy.mockClear();
      renderDock(SINGLE_PAYLOAD, 'tc-held-escape');
      repeated('Escape');
      expect(resolveSpy).toHaveBeenCalledExactlyOnceWith('tc-held-escape', null);
    });
  });
});
