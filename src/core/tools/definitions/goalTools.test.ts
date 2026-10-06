import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getLanguageSetting, initLanguage } from '@/i18n';
import { useChatStore } from '@/stores/chatStore';
import type { Conversation, Message, ToolExecutionContext } from '@/types';
import { manageGoalTool } from './goalTools';
import { getGoal } from '../../goal/goalService';
import { disarmGoal, isGoalArmed, resetGoalActivationsForTest } from '../../goal/goalActivation';

const humanMessage: Message = { id: 'u1', role: 'user', content: '把 300 份合同全部提取完再停', timestamp: 1, loopId: 'L1' };
const roundMessage: Message = {
  id: 'u2', role: 'user', content: '<goal_round/>', timestamp: 2, loopId: 'L2', isSystem: true,
  goalRound: { goalId: 'g', revision: 1, round: 1 },
};

function seed(over: Partial<Conversation> = {}): void {
  useChatStore.setState({
    conversations: {
      c1: { id: 'c1', title: 't', createdAt: 1, updatedAt: 1, status: 'running', messages: [humanMessage, roundMessage], ...over },
    },
    conversationIndex: { c1: { id: 'c1', title: 't', createdAt: 1, updatedAt: 1, messageCount: 2 } },
  } as never);
}

const humanRun: ToolExecutionContext = { conversationId: 'c1', loopId: 'L1', initiatedBy: 'user', interactionMode: 'foreground' };
const goalRoundRun: ToolExecutionContext = { ...humanRun, loopId: 'L2' };

async function run(input: Record<string, unknown>, context: ToolExecutionContext = humanRun): Promise<string> {
  return String(await manageGoalTool.execute(input, context));
}

describe('manage_goal tool', () => {
  // The Chinese copy is asserted below; restore the worker-wide locale so
  // later files keep the en-US host locale (TESTING.md §6 "Locale").
  let previousLanguage: ReturnType<typeof getLanguageSetting>;

  beforeEach(() => {
    previousLanguage = getLanguageSetting();
    initLanguage('zh-CN');
    resetGoalActivationsForTest();
    seed();
  });

  afterEach(() => {
    initLanguage(previousLanguage);
  });

  describe('create', () => {
    it('creates an armed goal from a human-initiated run', async () => {
      const text = await run({ action: 'create', objective: '提取全部 300 份合同到 summary.xlsx' });
      expect(text).toContain('已设定目标');
      expect(text).not.toContain('256');
      const goal = getGoal('c1');
      expect(goal?.phase).toBe('active');
      expect(isGoalArmed('c1', goal?.id)).toBe(true);
    });

    it('respects a user-requested round limit', async () => {
      await run({ action: 'create', objective: 'o', max_rounds: 12 });
      expect(getGoal('c1')?.maxRounds).toBe(12);
    });

    it('refuses to create from an automatic goal round', async () => {
      const text = await run({ action: 'create', objective: 'o' }, goalRoundRun);
      expect(text).toMatch(/^Error:/);
      expect(getGoal('c1')).toBeUndefined();
    });

    it('refuses to silently replace an unfinished goal', async () => {
      await run({ action: 'create', objective: 'first' });
      const text = await run({ action: 'create', objective: 'second' });
      expect(text).toMatch(/^Error:.*first/);
      expect(getGoal('c1')?.objective).toBe('first');
    });

    it('is unavailable in automated conversations', async () => {
      seed({ imChannelId: 'im-1' });
      expect(await run({ action: 'create', objective: 'o' })).toMatch(/^Error:/);
    });
  });

  describe('edit / pause', () => {
    it('edits and pauses in a human-initiated run only', async () => {
      expect(await run({ action: 'edit', objective: 'x' })).toBe('当前对话没有目标。');
      await run({ action: 'create', objective: 'first scope' });
      expect(await run({ action: 'edit', objective: '  ' })).toMatch(/^Error:/);
      expect(await run({ action: 'edit', objective: 'second scope' }, goalRoundRun)).toMatch(/^Error:/);
      expect(await run({ action: 'edit', objective: 'second scope' })).toContain('second scope');
      expect(await run({ action: 'pause' }, goalRoundRun)).toMatch(/^Error:/);
      expect(await run({ action: 'pause' })).toBe('目标已暂停。');
      expect(getGoal('c1')).toMatchObject({ objective: 'second scope', phase: 'paused' });
      // A paused goal is not armed and cannot be paused twice.
      expect(isGoalArmed('c1', getGoal('c1')?.id)).toBe(false);
      expect(await run({ action: 'pause' })).toMatch(/^Error:/);
    });
  });

  describe('complete', () => {
    it('completes only with evidence, including from an automatic round', async () => {
      await run({ action: 'create', objective: 'o' });
      expect(await run({ action: 'complete', summary: 'done', evidence: [] }, goalRoundRun)).toMatch(/^Error:/);
      expect(await run({ action: 'complete', summary: 'done', evidence: ['summary.xlsx: 300 rows'] }, goalRoundRun)).toBe('目标已标记完成。');
      expect(getGoal('c1')).toMatchObject({ phase: 'complete', settledLoopId: 'L2' });
    });
  });

  describe('block', () => {
    it('blocks only after enough rounds', async () => {
      await run({ action: 'create', objective: 'o' });
      expect(await run({ action: 'block', reason: 'needs VPN' }, goalRoundRun)).toMatch(/^Error:.*3/);
      const goal = getGoal('c1');
      useChatStore.getState().setConversationGoal('c1', { ...goal!, roundsStarted: 3 });
      expect(await run({ action: 'block', reason: 'needs VPN' }, goalRoundRun)).toContain('needs VPN');
      expect(getGoal('c1')?.phase).toBe('blocked');
    });
  });

  describe('get', () => {
    it('reads the goal status', async () => {
      expect(await run({ action: 'get' })).toBe('当前对话没有目标。');
      await run({ action: 'create', objective: '整理合同' });
      const text = await run({ action: 'get' });
      expect(text).toContain('整理合同');
      expect(text).toContain('进行中');
      expect(text).toContain('已自动推进：0 次（上限 256 次）');
    });
  });

  describe('resume', () => {
    it('resumes a paused goal when the user\'s own message asks, and arms it without kicking a round', async () => {
      await run({ action: 'create', objective: 'o' });
      await run({ action: 'pause' });
      expect(await run({ action: 'resume' })).toBe('目标已继续。');
      const goal = getGoal('c1');
      expect(goal?.phase).toBe('active');
      expect(isGoalArmed('c1', goal?.id)).toBe(true);
    });

    it('re-arms a goal that stopped after a restart or an error', async () => {
      await run({ action: 'create', objective: 'o' });
      const goal = getGoal('c1')!;
      disarmGoal('c1', goal.id, 'restart');
      expect(await run({ action: 'resume' })).toBe('目标已继续。');
      expect(isGoalArmed('c1', goal.id)).toBe(true);
    });

    it('says so, without an error, when the goal is already in progress', async () => {
      await run({ action: 'create', objective: 'o' });
      const before = getGoal('c1');
      expect(await run({ action: 'resume' })).toBe('目标正在进行中。');
      expect(getGoal('c1')).toEqual(before);
    });

    it('is refused in an automatic goal round: a goal cannot restart itself', async () => {
      await run({ action: 'create', objective: 'o' });
      await run({ action: 'pause' });
      expect(await run({ action: 'resume' }, goalRoundRun)).toMatch(/^Error:/);
      expect(getGoal('c1')?.phase).toBe('paused');
    });

    it('cannot resume a completed goal or a conversation without one', async () => {
      expect(await run({ action: 'resume' })).toBe('当前对话没有目标。');
      await run({ action: 'create', objective: 'o' });
      await run({ action: 'complete', summary: 's', evidence: ['e'] });
      expect(await run({ action: 'resume' })).toMatch(/^Error:/);
    });
  });

  describe('authority', () => {
    it('refuses every action from a delegated subagent / team member', async () => {
      const text = await run({ action: 'get' }, { ...humanRun, agentRunId: 'sar-1' });
      expect(text).toMatch(/^Error:/);
    });

    it('rejects unknown actions', async () => {
      expect(await run({ action: 'restart' })).toMatch(/^Error:/);
    });
  });
});
