import { describe, it, expect, vi, beforeEach } from 'vitest';

const publish = vi.fn();
vi.mock('@/core/notice/bus', () => ({ publish: (...args: unknown[]) => publish(...args) }));
const isGoalDrivingConversation = vi.fn((_id: string) => false);
vi.mock('@/core/goal/goalService', () => ({
  isGoalDrivingConversation: (id: string) => isGoalDrivingConversation(id),
}));

import { notifyGoalBlocked, notifyTaskCompleted } from './notifications';

describe('notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isGoalDrivingConversation.mockReturnValue(false);
  });

  describe('notifyTaskCompleted', () => {
    it('publishes a task_complete notice', async () => {
      await notifyTaskCompleted('周报', 'c1');
      expect(publish).toHaveBeenCalledWith(expect.objectContaining({
        type: 'task_complete',
        payload: { conversationTitle: '周报', conversationId: 'c1' },
      }));
    });

    it('stays quiet for each round while a goal is driving the conversation', async () => {
      isGoalDrivingConversation.mockReturnValue(true);
      await notifyTaskCompleted('周报', 'c1');
      expect(publish).not.toHaveBeenCalled();
      expect(isGoalDrivingConversation).toHaveBeenCalledWith('c1');
    });

    it('still notifies when no conversation is known', async () => {
      isGoalDrivingConversation.mockReturnValue(true);
      await notifyTaskCompleted('周报');
      expect(publish).toHaveBeenCalledTimes(1);
    });
  });

  describe('notifyGoalBlocked', () => {
    it('publishes a stuck notice for the conversation', async () => {
      await notifyGoalBlocked('目标卡住了：整理合同', 'c1');
      expect(publish).toHaveBeenCalledWith(expect.objectContaining({
        type: 'stuck_detection',
        source: 'agent',
        payload: { title: '目标卡住了：整理合同', conversationId: 'c1' },
      }));
    });
  });
});
