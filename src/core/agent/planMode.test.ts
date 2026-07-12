/**
 * Tests for planMode.ts — Plan Mode state management and gate decision logic.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getPlanMode,
  setPlanMode,
  clearPlanMode,
  evaluatePlanGate,
  READONLY_FALLBACK_TOOLS,
  type PlanModeState,
} from './planMode';
import { TOOL_NAMES } from '@/core/tools/toolNames';

// ── State Map ──

describe('planMode state map', () => {
  beforeEach(() => {
    // Reset any state from prior tests
    clearPlanMode('conv-a');
    clearPlanMode('conv-b');
    clearPlanMode('conv-x');
  });

  it('returns "off" by default when no entry exists', () => {
    expect(getPlanMode('conv-a')).toBe('off');
  });

  it('set then get returns the stored state', () => {
    setPlanMode('conv-a', 'planning');
    expect(getPlanMode('conv-a')).toBe('planning');
  });

  it('set then get works for "approved"', () => {
    setPlanMode('conv-a', 'approved');
    expect(getPlanMode('conv-a')).toBe('approved');
  });

  it('clearPlanMode resets to "off"', () => {
    setPlanMode('conv-a', 'planning');
    clearPlanMode('conv-a');
    expect(getPlanMode('conv-a')).toBe('off');
  });

  it('clearPlanMode on an absent id is a no-op (still returns "off")', () => {
    clearPlanMode('conv-x');
    expect(getPlanMode('conv-x')).toBe('off');
  });

  it('state is independent per conversationId', () => {
    setPlanMode('conv-a', 'planning');
    setPlanMode('conv-b', 'approved');
    expect(getPlanMode('conv-a')).toBe('planning');
    expect(getPlanMode('conv-b')).toBe('approved');
  });

  it('overwriting state works', () => {
    setPlanMode('conv-a', 'planning');
    setPlanMode('conv-a', 'approved');
    expect(getPlanMode('conv-a')).toBe('approved');
  });
});

// ── runAgentLoop reset contract ──────────────────────────────────────────────

// runAgentLoop calls clearPlanMode(conversationId) at the start of every new
// turn so a conversation abandoned mid-plan cannot leak its 'planning' or
// 'approved' state into the next run. The integration wiring is verified by
// reading agentLoop.ts; this test documents and regression-guards the
// clearPlanMode → 'off' invariant that the loop relies on.
describe('runAgentLoop reset contract (clearPlanMode invariant)', () => {
  beforeEach(() => {
    clearPlanMode('conv-reset');
  });

  it('clearPlanMode resets "planning" to "off" (abandoned-plan-lock prevention)', () => {
    // Simulates: model submitted report_plan → user ignored it → new run starts
    setPlanMode('conv-reset', 'planning');
    clearPlanMode('conv-reset');
    expect(getPlanMode('conv-reset')).toBe('off');
  });

  it('clearPlanMode resets "approved" to "off" (stale-approval prevention)', () => {
    // Simulates: plan was approved but loop crashed → new run must start clean
    setPlanMode('conv-reset', 'approved');
    clearPlanMode('conv-reset');
    expect(getPlanMode('conv-reset')).toBe('off');
  });

  it.each([['planning' as PlanModeState], ['approved' as PlanModeState]])(
    'getPlanMode returns "off" after clearPlanMode from any prior state (%s)',
    (prior) => {
      setPlanMode('conv-reset', prior);
      clearPlanMode('conv-reset');
      expect(getPlanMode('conv-reset')).toBe('off');
    },
  );
});

// ── evaluatePlanGate ──

describe('evaluatePlanGate', () => {
  describe('planMode "off"', () => {
    it('allows any tool call, including write tools', () => {
      const result = evaluatePlanGate({
        toolName: TOOL_NAMES.WRITE_FILE,
        toolReadOnly: undefined,
        planMode: 'off',
      });
      expect(result.allow).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('allows even when toolReadOnly is false', () => {
      const result = evaluatePlanGate({
        toolName: TOOL_NAMES.RUN_COMMAND,
        toolReadOnly: false,
        planMode: 'off',
      });
      expect(result.allow).toBe(true);
    });
  });

  describe('planMode "approved"', () => {
    it('allows write tools after approval', () => {
      const result = evaluatePlanGate({
        toolName: TOOL_NAMES.WRITE_FILE,
        toolReadOnly: false,
        planMode: 'approved',
      });
      expect(result.allow).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('allows even tools not in fallback list', () => {
      const result = evaluatePlanGate({
        toolName: TOOL_NAMES.RUN_COMMAND,
        toolReadOnly: undefined,
        planMode: 'approved',
      });
      expect(result.allow).toBe(true);
    });
  });

  describe('planMode "planning"', () => {
    it('allows when toolReadOnly is explicitly true', () => {
      const result = evaluatePlanGate({
        toolName: 'some_unknown_tool',
        toolReadOnly: true,
        planMode: 'planning',
      });
      expect(result.allow).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('allows READ_FILE (fallback allowlist) even with toolReadOnly undefined', () => {
      const result = evaluatePlanGate({
        toolName: TOOL_NAMES.READ_FILE,
        toolReadOnly: undefined,
        planMode: 'planning',
      });
      expect(result.allow).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('allows REPORT_PLAN (fallback allowlist)', () => {
      const result = evaluatePlanGate({
        toolName: TOOL_NAMES.REPORT_PLAN,
        toolReadOnly: undefined,
        planMode: 'planning',
      });
      expect(result.allow).toBe(true);
    });

    it('allows WEB_SEARCH (fallback allowlist)', () => {
      const result = evaluatePlanGate({
        toolName: TOOL_NAMES.WEB_SEARCH,
        toolReadOnly: undefined,
        planMode: 'planning',
      });
      expect(result.allow).toBe(true);
    });

    it('allows SHOW_WIDGET and READ_ME (fallback allowlist — in-conversation rendering mutates nothing)', () => {
      for (const toolName of [TOOL_NAMES.SHOW_WIDGET, TOOL_NAMES.READ_ME]) {
        const result = evaluatePlanGate({
          toolName,
          toolReadOnly: undefined,
          planMode: 'planning',
        });
        expect(result.allow).toBe(true);
      }
    });

    it('blocks WRITE_FILE with toolReadOnly undefined', () => {
      const result = evaluatePlanGate({
        toolName: TOOL_NAMES.WRITE_FILE,
        toolReadOnly: undefined,
        planMode: 'planning',
      });
      expect(result.allow).toBe(false);
      expect(result.reason).toBeDefined();
      expect(result.reason).toMatch(/计划模式/);
      expect(result.reason).toMatch(/report_plan/);
    });

    it('blocks RUN_COMMAND with toolReadOnly false', () => {
      const result = evaluatePlanGate({
        toolName: TOOL_NAMES.RUN_COMMAND,
        toolReadOnly: false,
        planMode: 'planning',
      });
      expect(result.allow).toBe(false);
      expect(result.reason).toBeDefined();
    });

    it('blocks an arbitrary unknown write tool', () => {
      const result = evaluatePlanGate({
        toolName: 'delete_database',
        toolReadOnly: undefined,
        planMode: 'planning',
      });
      expect(result.allow).toBe(false);
      expect(result.reason).toBeDefined();
    });

    it('reason is absent (undefined) when the tool is allowed', () => {
      const result = evaluatePlanGate({
        toolName: TOOL_NAMES.READ_FILE,
        toolReadOnly: undefined,
        planMode: 'planning',
      });
      expect(result).not.toHaveProperty('reason');
    });

    it('reason is present and non-empty when blocked', () => {
      const result = evaluatePlanGate({
        toolName: TOOL_NAMES.WRITE_FILE,
        toolReadOnly: false,
        planMode: 'planning',
      });
      expect(typeof result.reason).toBe('string');
      expect((result.reason as string).length).toBeGreaterThan(0);
    });
  });
});

// ── READONLY_FALLBACK_TOOLS ──

describe('READONLY_FALLBACK_TOOLS', () => {
  it('contains all expected tools', () => {
    const expected = [
      TOOL_NAMES.REPORT_PLAN,
      TOOL_NAMES.ASK_USER_QUESTION,
      TOOL_NAMES.READ_FILE,
      TOOL_NAMES.LIST_DIRECTORY,
      TOOL_NAMES.SEARCH_FILES,
      TOOL_NAMES.FIND_FILES,
      TOOL_NAMES.WEB_SEARCH,
      TOOL_NAMES.HTTP_FETCH,
      TOOL_NAMES.READ_MEMORY,
      TOOL_NAMES.RECALL,
      TOOL_NAMES.READ_SKILL_FILE,
      TOOL_NAMES.SKILL_VIEW,
      TOOL_NAMES.TOOL_SEARCH,
      TOOL_NAMES.GET_SYSTEM_INFO,
      TOOL_NAMES.CLIPBOARD_READ,
    ];
    for (const name of expected) {
      expect(READONLY_FALLBACK_TOOLS.has(name)).toBe(true);
    }
  });

  it('does not contain write tools', () => {
    expect(READONLY_FALLBACK_TOOLS.has(TOOL_NAMES.WRITE_FILE)).toBe(false);
    expect(READONLY_FALLBACK_TOOLS.has(TOOL_NAMES.RUN_COMMAND)).toBe(false);
    expect(READONLY_FALLBACK_TOOLS.has(TOOL_NAMES.EDIT_FILE)).toBe(false);
  });
});
