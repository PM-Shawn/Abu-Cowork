import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { replyToDockedQuestion, sendWhileRunning } from './sendWhileRunning';
import {
  beginSteeringRun,
  clearInputQueue,
  endSteeringRun,
  getQueuedInputs,
  isSteeringInput,
} from '@/core/agent/userInputQueue';
import {
  drainUserQuestions,
  getPendingUserQuestions,
  requestUserQuestion,
} from '@/core/agent/permissionBridge';
import { useChatStore } from '@/stores/chatStore';
import type { Message, UserQuestionPayload } from '@/types';

const CONV = 'conv-send-while-running';
const QUESTION_CALL = 'call-question-1';

const twoQuestions: UserQuestionPayload = {
  questions: [
    { header: '格式', question: '要什么格式？', multiSelect: false, options: [{ label: 'Word' }, { label: 'PDF' }] },
    { header: '范围', question: '包括哪几个月？', multiSelect: true, options: [{ label: '九月' }, { label: '十月' }] },
  ],
};

function seedConversation(toolName = 'ask_user_question', extraCalls: Array<{ id: string; name: string }> = []): void {
  const step: Message = {
    id: 'step-1',
    role: 'assistant',
    content: '',
    timestamp: 1,
    loopId: 'loop-1',
    toolCalls: [
      { id: QUESTION_CALL, name: toolName, input: {}, isExecuting: true },
      ...extraCalls.map((call) => ({ ...call, input: {}, isExecuting: true })),
    ],
  };
  useChatStore.setState((state) => ({
    conversations: {
      ...state.conversations,
      [CONV]: {
        id: CONV, title: 't', createdAt: 0, updatedAt: 0, status: 'running',
        messages: [{ id: 'u1', role: 'user', content: '做报表', timestamp: 0, loopId: 'loop-1' }, step],
      },
    },
  }));
}

describe('sendWhileRunning', () => {
  beforeEach(() => {
    clearInputQueue(CONV);
    beginSteeringRun(CONV, 'loop-1');
    seedConversation();
  });
  afterEach(() => {
    drainUserQuestions();
    clearInputQueue(CONV);
    useChatStore.setState((state) => {
      const { [CONV]: _gone, ...rest } = state.conversations;
      return { conversations: rest };
    });
  });

  it('stages plain text as steering', () => {
    expect(sendWhileRunning(CONV, '改成蓝色')).toBe(true);
    expect(getQueuedInputs(CONV).map((item) => [item.text, isSteeringInput(item)])).toEqual([['改成蓝色', true]]);
  });

  it('stages a message for after the task when the live run reads no steering message (scheduled, triggered, IM)', () => {
    endSteeringRun(CONV, 'loop-1');
    expect(sendWhileRunning(CONV, '改成蓝色')).toBe(true);
    expect(getQueuedInputs(CONV).map((item) => [item.text, isSteeringInput(item)])).toEqual([['改成蓝色', false]]);
  });

  it('stages nothing for empty text', () => {
    expect(sendWhileRunning(CONV, '   ')).toBe(false);
    expect(getQueuedInputs(CONV)).toHaveLength(0);
  });

  it('answers the open question card once, as a reply written in the chat, and queues nothing', async () => {
    const answer = requestUserQuestion(QUESTION_CALL, CONV, twoQuestions);
    expect(getPendingUserQuestions()).toHaveLength(1);

    expect(sendWhileRunning(CONV, '  就用Word，九月和十月都要  ')).toBe(true);

    const expected = { answers: [], chatReply: '就用Word，九月和十月都要' };
    await expect(answer).resolves.toEqual(expected);
    expect(getPendingUserQuestions()).toHaveLength(0);
    // The settled card in the conversation says the same as the tool result.
    const card = useChatStore.getState().conversations[CONV].messages[1].toolCalls?.[0];
    expect(card?.userQuestionAnswers).toEqual(expected);
    // The answer is the message: nothing more reaches the task.
    expect(getQueuedInputs(CONV)).toHaveLength(0);
  });

  it('answers only the oldest open card; a second message then steers', async () => {
    const first = requestUserQuestion(QUESTION_CALL, CONV, twoQuestions);

    sendWhileRunning(CONV, '用Word');
    sendWhileRunning(CONV, '另外标题加粗');

    await expect(first).resolves.toEqual({ answers: [], chatReply: '用Word' });
    expect(getQueuedInputs(CONV).map((item) => [item.text, isSteeringInput(item)])).toEqual([['另外标题加粗', true]]);
  });

  it('leaves a plan waiting for approval open: typed words are no consent', async () => {
    seedConversation('report_plan');
    const answer = requestUserQuestion(QUESTION_CALL, CONV, { ...twoQuestions, confirm: true });

    sendWhileRunning(CONV, '第三步先别做');

    expect(getPendingUserQuestions().map((question) => question.id)).toEqual([QUESTION_CALL]);
    expect(getQueuedInputs(CONV).filter(isSteeringInput)).toHaveLength(1);
    drainUserQuestions();
    await expect(answer).resolves.toBeNull();
  });

  it('leaves the card open for text that names its own route; it waits for the end of the task', async () => {
    const answer = requestUserQuestion(QUESTION_CALL, CONV, twoQuestions);

    sendWhileRunning(CONV, '/ppt 做一份汇报');

    expect(getPendingUserQuestions()).toHaveLength(1);
    expect(getQueuedInputs(CONV).map((item) => [item.text, isSteeringInput(item)])).toEqual([['/ppt 做一份汇报', false]]);
    drainUserQuestions();
    await expect(answer).resolves.toBeNull();
  });

  it('answers only the cards of its own conversation', async () => {
    const other = requestUserQuestion('call-other', 'conv-other', twoQuestions);

    sendWhileRunning(CONV, '改成蓝色');

    expect(getPendingUserQuestions().map((question) => question.id)).toEqual(['call-other']);
    expect(getQueuedInputs(CONV).filter(isSteeringInput).map((item) => item.text)).toEqual(['改成蓝色']);
    drainUserQuestions();
    await expect(other).resolves.toBeNull();
  });

  // Found by the tester: a long NEW instruction typed while a card is open
  // became the 「其他」 answer of every question on the card, word for word
  // (three copies for three questions). The card is answered once: the result
  // carries the text once, as a reply written in the chat, so the model can
  // take it as a new instruction.
  it('a long new instruction typed while a card is open answers the card once, with the whole text', async () => {
    const threeQuestions: UserQuestionPayload = {
      questions: [
        { header: '格式', question: '要什么格式？', multiSelect: false, options: [{ label: 'Word' }, { label: 'PDF' }] },
        { header: '范围', question: '包括哪几个月？', multiSelect: true, options: [{ label: '九月' }, { label: '十月' }] },
        { header: '风格', question: '要正式还是简洁？', multiSelect: false, options: [{ label: '正式' }, { label: '简洁' }] },
      ],
    };
    const instruction = '先别做报表了，改成把九月和十月的数据按部门汇总成一张Excel表，发给财务部的王会计，表头用公司的标准模板，金额保留两位小数';
    const answer = requestUserQuestion(QUESTION_CALL, CONV, threeQuestions);

    expect(sendWhileRunning(CONV, instruction)).toBe(true);

    const result = await answer;
    expect(result).toEqual({ answers: [], chatReply: instruction });
    expect(getQueuedInputs(CONV)).toHaveLength(0);
  });

  // Found by the reviewer: the dock shows the conversation's first pending
  // question, while the text answered the first one that was no plan
  // approval, a card the user could not see.
  it('answers the card the dock shows, never one behind it', async () => {
    seedConversation('report_plan', [{ id: 'call-question-2', name: 'ask_user_question' }]);
    const plan = requestUserQuestion(QUESTION_CALL, CONV, { ...twoQuestions, confirm: true });
    const hidden = requestUserQuestion('call-question-2', CONV, twoQuestions);

    sendWhileRunning(CONV, '第三步先别做');

    // The dock shows the plan, which typed words do not approve: the text steers.
    expect(getPendingUserQuestions().map((question) => question.id)).toEqual([QUESTION_CALL, 'call-question-2']);
    expect(getQueuedInputs(CONV).filter(isSteeringInput).map((item) => item.text)).toEqual(['第三步先别做']);
    drainUserQuestions();
    await expect(plan).resolves.toBeNull();
    await expect(hidden).resolves.toBeNull();
  });

  it('another surface (the pet) answers the docked card once the same way, and stages nothing itself', async () => {
    const answer = requestUserQuestion(QUESTION_CALL, CONV, twoQuestions);

    expect(replyToDockedQuestion(CONV, '  就用Word  ')).toBe(true);

    await expect(answer).resolves.toEqual({ answers: [], chatReply: '就用Word' });
    expect(getQueuedInputs(CONV)).toHaveLength(0);
  });

  it('another surface answers nothing without a card it may answer: the caller sends as usual', async () => {
    expect(replyToDockedQuestion(CONV, '改成蓝色')).toBe(false); // no card open
    const answer = requestUserQuestion(QUESTION_CALL, CONV, twoQuestions);
    expect(replyToDockedQuestion(CONV, '   ')).toBe(false);
    expect(replyToDockedQuestion(CONV, '/ppt 做一份汇报')).toBe(false);
    expect(getPendingUserQuestions().map((question) => question.id)).toEqual([QUESTION_CALL]);
    expect(getQueuedInputs(CONV)).toHaveLength(0);
    drainUserQuestions();
    await expect(answer).resolves.toBeNull();
  });

  it('answers no card the dock cannot show (its tool call is not in the conversation)', async () => {
    const orphan = requestUserQuestion('call-elsewhere', CONV, twoQuestions);

    sendWhileRunning(CONV, '改成蓝色');

    expect(getPendingUserQuestions().map((question) => question.id)).toEqual(['call-elsewhere']);
    expect(getQueuedInputs(CONV).filter(isSteeringInput).map((item) => item.text)).toEqual(['改成蓝色']);
    drainUserQuestions();
    await expect(orphan).resolves.toBeNull();
  });
});
