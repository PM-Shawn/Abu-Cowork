import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Conversation } from '@/types';

const kickGoalDriver = vi.fn();
vi.mock('./goalDriver', () => ({ kickGoalDriver: (id: string) => kickGoalDriver(id) }));

import { getLanguageSetting, initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import { applyGoalCommand, checkGoalCreatable, createGoalFromCommand, parseGoalCommand } from './goalCommand';
import { disarmGoal, isGoalArmed, resetGoalActivationsForTest } from './goalActivation';
import { getGoal } from './goalService';

const cancelStreaming = vi.fn();

function seed(over: Partial<Conversation> = {}): void {
  useChatStore.setState({
    conversations: { c1: { id: 'c1', title: 't', createdAt: 1, updatedAt: 1, status: 'completed', messages: [], ...over } },
    conversationIndex: { c1: { id: 'c1', title: 't', createdAt: 1, updatedAt: 1, messageCount: 0 } },
    cancelStreaming,
  } as never);
}

describe('goalCommand', () => {
  describe('parseGoalCommand', () => {
    it('ignores anything that is not /goal', () => {
      expect(parseGoalCommand('hello')).toBeNull();
      expect(parseGoalCommand('/goals do it')).toBeNull();
      expect(parseGoalCommand('please /goal x')).toBeNull();
    });

    it('parses every form', () => {
      expect(parseGoalCommand('/goal')).toEqual({ kind: 'status' });
      expect(parseGoalCommand('  /GOAL  ')).toEqual({ kind: 'status' });
      expect(parseGoalCommand('/goal pause')).toEqual({ kind: 'pause' });
      expect(parseGoalCommand('/goal clear')).toEqual({ kind: 'clear' });
      expect(parseGoalCommand('/goal resume')).toEqual({ kind: 'resume' });
      expect(parseGoalCommand('/goal resume 20')).toEqual({ kind: 'resume', extraRounds: 20 });
      expect(parseGoalCommand('/goal resume +20')).toEqual({ kind: 'resume', extraRounds: 20 });
      expect(parseGoalCommand('/goal edit 只处理 2025 年的合同')).toEqual({ kind: 'edit', objective: '只处理 2025 年的合同' });
      expect(parseGoalCommand('/goal 把合同全部提取成表格')).toEqual({ kind: 'create', objective: '把合同全部提取成表格' });
    });

    it('treats a sentence that merely starts with a keyword as an objective', () => {
      expect(parseGoalCommand('/goal pause every job after 6pm')).toEqual({ kind: 'create', objective: 'pause every job after 6pm' });
      expect(parseGoalCommand('/goal clear the downloads folder')).toEqual({ kind: 'create', objective: 'clear the downloads folder' });
      expect(parseGoalCommand('/goal resume writing chapter 3')).toEqual({ kind: 'create', objective: 'resume writing chapter 3' });
    });

    it('keeps a multi-line objective', () => {
      expect(parseGoalCommand('/goal line one\nline two')).toEqual({ kind: 'create', objective: 'line one\nline two' });
    });
  });

  describe('create', () => {
    let previousLanguage: ReturnType<typeof getLanguageSetting>;
    beforeEach(() => {
      previousLanguage = getLanguageSetting();
      initLanguage('zh-CN');
      resetGoalActivationsForTest();
      vi.clearAllMocks();
      seed();
    });
    afterEach(() => initLanguage(previousLanguage));

    it('allows creating in a brand-new conversation that does not exist yet', () => {
      expect(checkGoalCreatable(undefined, 'do it')).toEqual({ ok: true, message: '' });
    });

    it('rejects an empty objective, automated conversations and a live goal', () => {
      expect(checkGoalCreatable('c1', '  ').ok).toBe(false);
      seed({ scheduledTaskId: 's1' });
      expect(checkGoalCreatable('c1', 'do it')).toMatchObject({ ok: false, message: expect.stringContaining('定时任务') });
      seed();
      expect(createGoalFromCommand('c1', 'first').ok).toBe(true);
      expect(checkGoalCreatable('c1', 'second')).toMatchObject({ ok: false, message: expect.stringContaining('first') });
    });

    it('creates an armed goal with the default budget', () => {
      const outcome = createGoalFromCommand('c1', '把合同全部提取成表格');
      expect(outcome).toMatchObject({ ok: true, message: expect.stringContaining('256') });
      expect(isGoalArmed('c1', getGoal('c1')?.id)).toBe(true);
    });
  });

  describe('applyGoalCommand', () => {
    let previousLanguage: ReturnType<typeof getLanguageSetting>;
    beforeEach(() => {
      previousLanguage = getLanguageSetting();
      initLanguage('zh-CN');
      resetGoalActivationsForTest();
      vi.clearAllMocks();
      seed();
    });
    afterEach(() => initLanguage(previousLanguage));

    it('reports that there is no goal', () => {
      expect(applyGoalCommand('c1', { kind: 'status' })).toEqual({ ok: true, message: expect.stringContaining('没有目标') });
      expect(applyGoalCommand('c1', { kind: 'pause' }).ok).toBe(false);
      expect(applyGoalCommand(undefined, { kind: 'clear' }).ok).toBe(false);
    });

    it('shows the status of the current goal', () => {
      createGoalFromCommand('c1', '整理合同');
      expect(applyGoalCommand('c1', { kind: 'status' }).message).toContain('整理合同');
    });

    it('pausing stops the round in flight', () => {
      createGoalFromCommand('c1', 'o');
      seed({ goal: getGoal('c1'), status: 'running' });
      expect(applyGoalCommand('c1', { kind: 'pause' }).ok).toBe(true);
      expect(getGoal('c1')?.phase).toBe('paused');
      expect(cancelStreaming).toHaveBeenCalledWith('c1');
    });

    it('resume re-arms the goal and kicks the driver', () => {
      createGoalFromCommand('c1', 'o');
      const goal = getGoal('c1')!;
      disarmGoal('c1', goal.id, 'restart');
      expect(applyGoalCommand('c1', { kind: 'resume' }).ok).toBe(true);
      expect(isGoalArmed('c1', goal.id)).toBe(true);
      expect(kickGoalDriver).toHaveBeenCalledWith('c1');
    });

    it('resume after the budget is spent needs extra rounds', () => {
      createGoalFromCommand('c1', 'o');
      const goal = getGoal('c1')!;
      useChatStore.getState().setConversationGoal('c1', {
        ...goal, revision: goal.revision + 1, phase: 'blocked', roundsStarted: goal.maxRounds,
        blockedReason: { code: 'round-limit', message: '' },
      });
      expect(applyGoalCommand('c1', { kind: 'resume' })).toMatchObject({ ok: false, message: expect.stringContaining('256') });
      expect(applyGoalCommand('c1', { kind: 'resume', extraRounds: 10 }).ok).toBe(true);
      expect(getGoal('c1')).toMatchObject({ phase: 'active', maxRounds: 266 });
    });

    it('edits and clears', () => {
      createGoalFromCommand('c1', 'o');
      expect(applyGoalCommand('c1', { kind: 'edit', objective: '  ' }).ok).toBe(false);
      expect(applyGoalCommand('c1', { kind: 'edit', objective: 'new scope' }).ok).toBe(true);
      expect(getGoal('c1')?.objective).toBe('new scope');
      expect(applyGoalCommand('c1', { kind: 'clear' }).ok).toBe(true);
      expect(getGoal('c1')).toBeUndefined();
    });
  });
});
