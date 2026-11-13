/**
 * Tests for askUserQuestionTool execute()
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { askUserQuestionTool } from './askUserQuestionTool';
import * as bridge from '../../agent/permissionBridge';
import type { UserQuestionResult } from '../../../types';
import { getLanguageSetting, setLanguage } from '@/i18n';

const VALID_INPUT = {
  questions: [
    {
      header: '格式',
      question: '你希望输出什么格式？',
      multiSelect: false,
      options: [{ label: '详细' }, { label: '简洁' }],
    },
  ],
};

const VALID_CONTEXT = { conversationId: 'conv-test', toolCallId: 'tc-test' };

const MOCK_RESULT: UserQuestionResult = {
  answers: [{ header: '格式', question: '你希望输出什么格式？', selected: ['详细'] }],
};

describe('askUserQuestionTool', () => {
  beforeEach(() => {
    bridge.drainUserQuestions();
  });

  afterEach(() => {
    bridge.drainUserQuestions();
  });

  describe('input validation', () => {
    it('throws on empty questions array', async () => {
      await expect(
        askUserQuestionTool.execute({ questions: [] }, VALID_CONTEXT),
      ).rejects.toThrow(/questions array length/);
    });

    it('throws on more than 4 questions', async () => {
      const questions = Array.from({ length: 5 }, (_, i) => ({
        header: `题${i + 1}`,
        question: `问题${i + 1}`,
        multiSelect: false,
        options: [{ label: 'A' }, { label: 'B' }],
      }));
      await expect(
        askUserQuestionTool.execute({ questions }, VALID_CONTEXT),
      ).rejects.toThrow(/questions array length/);
    });

    it('throws when header exceeds 12 chars', async () => {
      const input = {
        questions: [{
          header: '这个标签超过了十二个字数限制',
          question: '问题',
          multiSelect: false,
          options: [{ label: 'A' }, { label: 'B' }],
        }],
      };
      await expect(
        askUserQuestionTool.execute(input, VALID_CONTEXT),
      ).rejects.toThrow(/header.*exceeds 12 characters/);
    });

    it('throws when header is empty', async () => {
      const input = {
        questions: [{
          header: '',
          question: '问题',
          multiSelect: false,
          options: [{ label: 'A' }, { label: 'B' }],
        }],
      };
      await expect(
        askUserQuestionTool.execute(input, VALID_CONTEXT),
      ).rejects.toThrow(/header cannot be an empty string/);
    });

    it('throws when a question has fewer than 2 options', async () => {
      const input = {
        questions: [{
          header: '格式',
          question: '问题',
          multiSelect: false,
          options: [{ label: 'A' }],
        }],
      };
      await expect(
        askUserQuestionTool.execute(input, VALID_CONTEXT),
      ).rejects.toThrow(/options length/);
    });

    it('throws when a question has more than 4 options', async () => {
      const input = {
        questions: [{
          header: '格式',
          question: '问题',
          multiSelect: false,
          options: [
            { label: 'A' }, { label: 'B' }, { label: 'C' }, { label: 'D' }, { label: 'E' },
          ],
        }],
      };
      await expect(
        askUserQuestionTool.execute(input, VALID_CONTEXT),
      ).rejects.toThrow(/options length/);
    });

    it('throws when multiSelect is not a boolean', async () => {
      const input = {
        questions: [{
          header: '格式',
          question: '问题',
          multiSelect: 'yes',
          options: [{ label: 'A' }, { label: 'B' }],
        }],
      };
      await expect(
        askUserQuestionTool.execute(input, VALID_CONTEXT),
      ).rejects.toThrow(/multiSelect must be a boolean/);
    });

    it('throws when toolCallId is not injected', async () => {
      await expect(
        askUserQuestionTool.execute(VALID_INPUT, { conversationId: 'conv-x' }),
      ).rejects.toThrow(/toolCallId was not injected/);
    });
  });

  describe('happy path', () => {
    it('awaits requestUserQuestion and formats the resolved result', async () => {
      const executePromise = askUserQuestionTool.execute(VALID_INPUT, VALID_CONTEXT);

      // Flush microtasks so the tool registers the pending question
      await new Promise<void>((r) => setTimeout(r, 0));
      bridge.resolveUserQuestion('tc-test', MOCK_RESULT);

      const result = await executePromise;
      expect(typeof result).toBe('string');
      expect(result).toContain('User answered');
      expect(result).toContain('[格式]');
      expect(result).toContain('详细');
    });

    it('passes on a reply written in the chat once, whatever the number of questions', async () => {
      const twoQuestions = {
        questions: [
          VALID_INPUT.questions[0],
          { header: '范围', question: '包括哪几个月？', multiSelect: true, options: [{ label: '九月' }, { label: '十月' }] },
        ],
      };
      const executePromise = askUserQuestionTool.execute(twoQuestions, VALID_CONTEXT);

      await new Promise<void>((r) => setTimeout(r, 0));
      bridge.resolveUserQuestion('tc-test', { answers: [], chatReply: '先别做了，改成汇总表 {format}' });

      const result = await executePromise as string;
      expect(result).toContain('replied in the chat instead');
      expect(result.split('先别做了，改成汇总表 {format}')).toHaveLength(2);
      expect(result).not.toContain('User answered');
      expect(result).not.toContain('[范围]');
    });

    // Re-review addition (P7): the same result in the Chinese interface, with
    // text that looks like the template's own placeholder and a `$&` that a
    // string replacement would expand.
    it('passes on a reply written in the chat once in the Chinese interface, as written', async () => {
      const previous = getLanguageSetting();
      setLanguage('zh-CN');
      try {
        const executePromise = askUserQuestionTool.execute(VALID_INPUT, VALID_CONTEXT);
        await new Promise<void>((r) => setTimeout(r, 0));
        const reply = '不用选了，按 {text} 和 $& 原样写进标题';
        bridge.resolveUserQuestion('tc-test', { answers: [], chatReply: reply });

        const result = await executePromise as string;
        expect(result).toContain('用户没有在卡片上选择，而是在对话里回复了');
        expect(result.split(reply)).toHaveLength(2);
        expect(result).not.toContain('用户已作答');
      } finally {
        setLanguage(previous);
      }
    });

    it('returns a fallback message when result is null', async () => {
      const executePromise = askUserQuestionTool.execute(VALID_INPUT, VALID_CONTEXT);

      await new Promise<void>((r) => setTimeout(r, 0));
      bridge.resolveUserQuestion('tc-test', null);

      const result = await executePromise;
      expect(typeof result).toBe('string');
      expect(result).toContain('did not answer');
    });
  });

  it('is not concurrency safe', () => {
    expect(askUserQuestionTool.isConcurrencySafe).toBe(false);
  });
});
