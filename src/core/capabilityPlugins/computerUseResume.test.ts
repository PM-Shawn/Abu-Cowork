import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@/types';
import {
  COMPUTER_USE_RESUME_TTL_MS,
  consumeComputerUseResumeToken,
  hashComputerUseTaskSummary,
  latestUserTaskSummary,
  resumeTokenMatchesTask,
  routedComputerUseTaskSummary,
  saveComputerUseResumeToken,
} from './computerUseResume';

function userMessage(content: Message['content']): Message {
  return { id: 'user-1', role: 'user', content, timestamp: 1 };
}

describe('Computer Use permission relaunch recovery', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('persists only the minimal one-shot token and never raw task text', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const rawTask = 'Open Notes and type a private sentence';
    const taskSummaryHash = await hashComputerUseTaskSummary(rawTask);
    expect(saveComputerUseResumeToken({
      id: 'request-1',
      target: 'computer',
      source: 'task',
      conversationId: 'conversation-1',
      toolCallId: 'tool-1',
      taskSummaryHash,
      computerUseRequirements: { screenRead: false, uiControl: true },
    })).toBe(true);

    expect(JSON.stringify(localStorage)).not.toContain(rawTask);
    expect(consumeComputerUseResumeToken(1_001)).toEqual({
      version: 1,
      conversationId: 'conversation-1',
      taskSummaryHash,
      requirements: { screenRead: false, uiControl: true },
      createdAt: 1_000,
    });
    expect(consumeComputerUseResumeToken(1_001)).toBeNull();
  });

  it('rejects expired and future-dated tokens', async () => {
    const taskSummaryHash = await hashComputerUseTaskSummary('task');
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    saveComputerUseResumeToken({
      id: 'request-1',
      target: 'computer',
      source: 'task',
      conversationId: 'conversation-1',
      taskSummaryHash,
      computerUseRequirements: { screenRead: true, uiControl: true },
    });
    expect(consumeComputerUseResumeToken(1_000 + COMPUTER_USE_RESUME_TTL_MS + 1)).toBeNull();

    saveComputerUseResumeToken({
      id: 'request-2',
      target: 'computer',
      source: 'task',
      conversationId: 'conversation-1',
      taskSummaryHash,
      computerUseRequirements: { screenRead: true, uiControl: true },
    });
    expect(consumeComputerUseResumeToken(999)).toBeNull();
  });

  it('correlates the token to the latest user task before reopening setup', async () => {
    const rawTask = 'Use the current app';
    const token = {
      version: 1 as const,
      conversationId: 'conversation-1',
      taskSummaryHash: await hashComputerUseTaskSummary(rawTask),
      requirements: { screenRead: false, uiControl: true },
      createdAt: 1,
    };
    const messages = [
      userMessage([{ type: 'text', text: rawTask }]),
      { id: 'assistant-1', role: 'assistant' as const, content: 'Working', timestamp: 2 },
    ];
    expect(latestUserTaskSummary(messages)).toBe(rawTask);
    await expect(resumeTokenMatchesTask(token, messages)).resolves.toBe(true);
    await expect(resumeTokenMatchesTask(token, [userMessage('Different task')])).resolves.toBe(false);
    expect(routedComputerUseTaskSummary({
      ...userMessage(rawTask),
      delegateAgent: { name: 'desktop' },
    })).toBe(`@desktop ${rawTask}`);
  });
});
