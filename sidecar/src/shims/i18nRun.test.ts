import { describe, it, expect } from 'vitest';
import { subagentRunContext } from '../subagentRunContext';
import { getI18n } from './i18nRun';

const fullBag = {
  'chat.subagent.taskCancelled': '任务已取消',
  'chat.subagent.outputLimitIncomplete': '输出未完成',
  'chat.subagent.stoppedIncomplete': '已停止',
  'chat.subagent.cancelled': '已取消',
  'chat.subagent.hookBlocked': '被拦截',
  'chat.subagent.noContent': '无内容',
  'chat.errorEmptyBody': '空响应',
};

function withRunContext<T>(bag: Record<string, string>, fn: () => T): T {
  return subagentRunContext.run(
    { runId: 'r1', locale: 'zh-CN', uiStrings: bag as never, resolvedCreds: { apiKey: '', baseUrl: undefined, forceOpenAiCompatible: false } },
    fn,
  );
}

describe('i18nRun shim', () => {
  it('resolves every key subagentLoop.ts actually reads, from the per-run bag', () => {
    withRunContext(fullBag, () => {
      const t = getI18n();
      expect(t.chat.subagent.taskCancelled).toBe('任务已取消');
      expect(t.chat.subagent.outputLimitIncomplete).toBe('输出未完成');
      expect(t.chat.subagent.stoppedIncomplete).toBe('已停止');
      expect(t.chat.subagent.cancelled).toBe('已取消');
      expect(t.chat.subagent.hookBlocked).toBe('被拦截');
      expect(t.chat.subagent.noContent).toBe('无内容');
      expect(t.chat.errorEmptyBody).toBe('空响应');
    });
  });

  it('throws a clear, actionable error when a required key is MISSING from the bag — drift is caught, not silently swallowed', () => {
    const incompleteBag = { ...fullBag };
    delete (incompleteBag as Record<string, string>)['chat.subagent.noContent'];

    withRunContext(incompleteBag, () => {
      const t = getI18n();
      expect(() => t.chat.subagent.noContent).toThrow(/Missing uiStrings key "chat\.subagent\.noContent"/);
    });
  });

  it('throws when a chat.* (non-subagent) key is missing too', () => {
    const incompleteBag = { ...fullBag };
    delete (incompleteBag as Record<string, string>)['chat.errorEmptyBody'];

    withRunContext(incompleteBag, () => {
      const t = getI18n();
      expect(() => t.chat.errorEmptyBody).toThrow(/Missing uiStrings key "chat\.errorEmptyBody"/);
    });
  });

  it('throws immediately when called OUTSIDE any subagent run context (no AsyncLocalStorage scope)', () => {
    expect(() => getI18n()).toThrow(/subagent run context accessed outside/);
  });
});
