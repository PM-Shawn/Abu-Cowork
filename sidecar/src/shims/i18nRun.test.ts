import { describe, it, expect } from 'vitest';
import { agentRunContext, type AgentRunContext } from '../agentRunContext';
import { subagentRunContext } from '../subagentRunContext';
import { getI18n, getLocale, format } from './i18nRun';
import zhCN from '@/i18n/locales/zh-CN';
import enUS from '@/i18n/locales/en-US';

/** Minimal fake main-loop context — only `locale` matters for this shim. */
function makeAgentCtx(locale: string): AgentRunContext {
  return {
    runId: 'run-1',
    conversationId: 'conv-1',
    chatDelta: {} as AgentRunContext['chatDelta'],
    conversationReader: {} as AgentRunContext['conversationReader'],
    executionPort: {} as AgentRunContext['executionPort'],
    abortRegistry: {} as AgentRunContext['abortRegistry'],
    scratchpadPort: {} as AgentRunContext['scratchpadPort'],
    capsPort: {} as AgentRunContext['capsPort'],
    workspaceReader: {} as AgentRunContext['workspaceReader'],
    toolInvoker: {} as AgentRunContext['toolInvoker'],
    resolvedCreds: { apiKey: '', baseUrl: undefined, forceOpenAiCompatible: false },
    locale,
    pushFrame: () => {},
  };
}

function withAgentRunContext<T>(locale: string, fn: () => T): T {
  return agentRunContext.run(makeAgentCtx(locale), fn);
}

function withSubagentRunContext<T>(locale: string, fn: () => T): T {
  return subagentRunContext.run(
    { runId: 'r1', locale, uiStrings: {} as never, resolvedCreds: { apiKey: '', baseUrl: undefined, forceOpenAiCompatible: false } },
    fn,
  );
}

describe('i18nRun shim (full-dict, P1-3B-3B)', () => {
  describe('main-loop path (agentRunContext)', () => {
    it('getI18n() returns the REAL zh-CN dict object', () => {
      withAgentRunContext('zh-CN', () => {
        expect(getI18n()).toBe(zhCN);
        expect(getI18n().common.appName).toBe('阿布');
        expect(getI18n().chat.errorEmptyBody).toBe(zhCN.chat.errorEmptyBody);
      });
    });

    it('getI18n() returns the REAL en-US dict object', () => {
      withAgentRunContext('en-US', () => {
        expect(getI18n()).toBe(enUS);
        expect(getI18n().common.appName).toBe('Abu');
      });
    });

    it('getLocale() resolves from agentRunContext', () => {
      withAgentRunContext('zh-CN', () => {
        expect(getLocale()).toBe('zh-CN');
      });
    });
  });

  describe('subagent path (subagentRunContext fallback)', () => {
    it('getI18n() resolves the real dict when only subagentRunContext is active', () => {
      withSubagentRunContext('en-US', () => {
        expect(getI18n()).toBe(enUS);
      });
    });

    it('getLocale() resolves from subagentRunContext when agentRunContext is not active', () => {
      withSubagentRunContext('zh-CN', () => {
        expect(getLocale()).toBe('zh-CN');
      });
    });
  });

  describe('nested subagent-inside-main-loop (agentRunContext takes priority)', () => {
    it('a subagent run nested inside a main-loop scope resolves the MAIN loop\'s locale, not any stale subagent one', () => {
      // Mirrors shims/subagentRunnerRun.ts's real shape: a nested subagent
      // shares the parent's agentRunContext scope with NO separate
      // subagentRunContext.run() wrapper — so only agentRunContext is ever
      // active for it. This test instead proves the EXPLICIT priority rule:
      // when both scopes happen to be active (e.g. a future caller nests
      // them), agentRunContext wins.
      withSubagentRunContext('en-US', () => {
        withAgentRunContext('zh-CN', () => {
          expect(getLocale()).toBe('zh-CN');
          expect(getI18n()).toBe(zhCN);
        });
      });
    });
  });

  describe('error handling', () => {
    it('throws a clear error when called OUTSIDE both agentRunContext and subagentRunContext', () => {
      expect(() => getLocale()).toThrow(/no run context available/);
      expect(() => getI18n()).toThrow(/no run context available/);
    });

    it('throws when the run context carries an unsupported locale value, rather than silently defaulting', () => {
      withAgentRunContext('fr-FR', () => {
        expect(() => getLocale()).toThrow(/Unsupported locale "fr-FR"/);
      });
    });
  });

  describe('format()', () => {
    it('substitutes placeholders, matching the real src/i18n/index.ts format()', () => {
      expect(format('{count} files', { count: 5 })).toBe('5 files');
      expect(format('no placeholders here', {})).toBe('no placeholders here');
      expect(format('{missing}', {})).toBe('{missing}');
    });
  });
});
