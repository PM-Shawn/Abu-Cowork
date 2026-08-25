import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Skill } from '../../../types';
import { useChatStore } from '../../../stores/chatStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import { skillLoader } from '../../skill/loader';
import { clearAllSkillHooks, clearSkillHooksByLoop, useSkillTool } from './agentTools';

const activateSkillHooksMock = vi.hoisted(() => vi.fn());
vi.mock('../../skill/skillHooks', () => ({
  activateSkillHooks: (...args: unknown[]) => activateSkillHooksMock(...args),
}));

describe('useSkillTool conversation ownership', () => {
  let desktopConversationId: string;
  let runConversationId: string;

  beforeEach(() => {
    desktopConversationId = useChatStore.getState().createConversation(null, { skipActivate: true });
    runConversationId = useChatStore.getState().createConversation(null, { skipActivate: true });
    useChatStore.setState({ activeConversationId: desktopConversationId });
    useSettingsStore.setState({ disabledSkills: [] });
    clearAllSkillHooks();
    activateSkillHooksMock.mockReset();
    vi.spyOn(skillLoader, 'getSkill').mockReturnValue({
      name: 'owner-test',
      description: 'test',
      content: 'instructions',
      filePath: '/tmp/owner-test/SKILL.md',
      skillDir: '/tmp/owner-test',
    } satisfies Skill);
  });

  afterEach(() => {
    clearAllSkillHooks();
    vi.restoreAllMocks();
    useChatStore.setState((state) => {
      delete state.conversations[desktopConversationId];
      delete state.conversations[runConversationId];
      delete state.conversationIndex[desktopConversationId];
      delete state.conversationIndex[runConversationId];
      state.activeConversationId = null;
    });
  });

  it('records a headless or concurrent activation on the tool context conversation, not the active desktop tab', async () => {
    await useSkillTool.execute(
      { skill_name: 'owner-test' },
      { conversationId: runConversationId, loopId: 'run-loop' },
    );

    expect(useChatStore.getState().conversations[runConversationId].activeSkills).toEqual(['owner-test']);
    expect(useChatStore.getState().conversations[desktopConversationId].activeSkills).toBeUndefined();
  });

  it('clears an old loop without removing a newer loop hook in the same conversation', async () => {
    const oldCleanup = vi.fn();
    const newCleanup = vi.fn();
    vi.spyOn(skillLoader, 'getSkill').mockReturnValue({
      name: 'owner-test',
      description: 'test',
      content: 'instructions',
      filePath: '/tmp/owner-test/SKILL.md',
      skillDir: '/tmp/owner-test',
      hooks: { PreToolUse: [] },
    } satisfies Skill);
    activateSkillHooksMock
      .mockReturnValueOnce(oldCleanup)
      .mockReturnValueOnce(newCleanup);

    await useSkillTool.execute(
      { skill_name: 'owner-test' },
      { conversationId: runConversationId, loopId: 'loop-old' },
    );
    useChatStore.setState((state) => {
      state.conversations[runConversationId].activeSkills = [];
    });
    await useSkillTool.execute(
      { skill_name: 'owner-test' },
      { conversationId: runConversationId, loopId: 'loop-new' },
    );

    clearSkillHooksByLoop('loop-old');

    expect(oldCleanup).toHaveBeenCalledOnce();
    expect(newCleanup).not.toHaveBeenCalled();
    clearSkillHooksByLoop('loop-new');
    expect(newCleanup).toHaveBeenCalledOnce();
  });
});
