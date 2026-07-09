/**
 * Live end-to-end demonstration of ask_user_question, going through the SAME
 * dispatch path the agent loop uses (executeAnyTool → registry → tool.execute),
 * with the REAL permissionBridge (no mocks).
 *
 * Flow proven here:
 *   1. agent calls the tool → execute() suspends on requestUserQuestion
 *   2. the UI reads getPendingUserQuestions() to render the card  (← printed)
 *   3. user submits → resolveUserQuestion() with a rich answer set
 *   4. tool resumes and returns the tool_result string fed back to the model  (← printed)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { executeAnyTool } from '../registry';
import { registerBuiltinTools } from '../builtins';
import {
  getPendingUserQuestions,
  resolveUserQuestion,
  drainUserQuestions,
} from '../../agent/permissionBridge';
import type { UserQuestionResult } from '../../../types';

// 3 questions: single-select, multi-select, and single-select answered via "Other…"
const INPUT = {
  questions: [
    {
      header: '格式',
      question: '你希望输出什么格式？',
      multiSelect: false,
      options: [
        { label: '详细', description: '带示例的完整说明' },
        { label: '简洁', description: '只给要点' },
      ],
    },
    {
      header: '章节',
      question: '报告包含哪些部分？',
      multiSelect: true,
      options: [{ label: '引言' }, { label: '正文' }, { label: '结论' }],
    },
    {
      header: '部署',
      question: '部署到哪里？',
      multiSelect: false,
      options: [{ label: '本地' }, { label: '云端' }],
    },
  ],
};

describe('ask_user_question — live e2e through executeAnyTool', () => {
  beforeEach(() => {
    registerBuiltinTools();
    drainUserQuestions();
  });
  afterEach(() => drainUserQuestions());

  it('suspends, hands the card to the UI, resumes with the user answer', async () => {
    const ctx = { conversationId: 'conv-demo', toolCallId: 'tc-demo' };

    // 1) agent dispatches the tool exactly like agentLoop does — it suspends
    const toolPromise = executeAnyTool('ask_user_question', INPUT, undefined, undefined, ctx);

    // 2) what the UI sees while the model waits
    await new Promise<void>((r) => setTimeout(r, 0));
    const pending = getPendingUserQuestions();
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe('tc-demo');
    expect(pending[0].payload.questions).toHaveLength(3);

    console.log('\n──────── UI 会渲染的待答卡片（来自 pending 队列）────────');
    pending[0].payload.questions.forEach((q) => {
      const tag = q.multiSelect ? '多选' : '单选';
      console.log(`  [${q.header}] (${tag}) ${q.question}`);
      q.options.forEach((o) => console.log(`     ○ ${o.label}${o.description ? '  — ' + o.description : ''}`));
      console.log('     ○ 其他…（自由输入）');
    });

    // 3) user picks: 详细 / 引言+结论 / Other="我们内部的 K8s 集群"
    const userAnswer: UserQuestionResult = {
      answers: [
        { header: '格式', question: '你希望输出什么格式？', selected: ['详细'] },
        { header: '章节', question: '报告包含哪些部分？', selected: ['引言', '结论'] },
        { header: '部署', question: '部署到哪里？', selected: ['我们内部的 K8s 集群'] },
      ],
    };
    resolveUserQuestion('tc-demo', userAnswer);

    // 4) the tool_result string the model receives
    const result = (await toolPromise) as string;
    console.log('\n──────── 回传给模型的 tool_result ────────');
    console.log(result);
    console.log('────────────────────────────────────────\n');

    expect(result).toContain('User answered');
    expect(result).toContain('[格式] 你希望输出什么格式？');
    expect(result).toContain('→ 详细');
    expect(result).toContain('→ 引言、结论'); // multi-select joined
    expect(result).toContain('→ 我们内部的 K8s 集群'); // "Other" free text, not the word 其他
    expect(result).not.toContain('其他…');
    // queue is drained after resolve
    expect(getPendingUserQuestions()).toHaveLength(0);
  });

  it('returns the graceful fallback when the user cancels (drain/abort)', async () => {
    const ctx = { conversationId: 'conv-demo', toolCallId: 'tc-cancel' };
    const toolPromise = executeAnyTool('ask_user_question', INPUT, undefined, undefined, ctx);
    await new Promise<void>((r) => setTimeout(r, 0));

    drainUserQuestions(); // simulate user hitting Stop / aborting the agent
    const result = (await toolPromise) as string;
    console.log('\n──────── 取消/abort 时回传给模型 ────────\n' + result + '\n');
    expect(result).toContain('did not answer');
  });
});
