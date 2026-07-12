import { describe, it, expect } from 'vitest';
import { computeProposalSignal, renderProposalSignalSection } from './proposalSignal';
import type { Message, ToolCall } from '../../types';

function tc(name: string, overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: `tc_${Math.random().toString(36).slice(2, 8)}`,
    name,
    input: {},
    result: 'ok',
    ...overrides,
  };
}

function msg(overrides: Partial<Message> = {}): Message {
  return {
    id: `m_${Math.random().toString(36).slice(2, 8)}`,
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('computeProposalSignal · proactivity thresholds', () => {
  it('shy proactivity never fires, even for 20+ tool calls', () => {
    const tools = Array.from({ length: 20 }, () => tc('run_command'));
    const m = msg({ toolCalls: tools });
    expect(computeProposalSignal([m], 'shy')).toBeNull();
  });

  it('companion needs ≥5 non-hidden tool calls', () => {
    expect(
      computeProposalSignal([msg({ toolCalls: Array.from({ length: 4 }, () => tc('run_command')) })], 'companion'),
    ).toBeNull();
    expect(
      computeProposalSignal([msg({ toolCalls: Array.from({ length: 5 }, () => tc('run_command')) })], 'companion'),
    ).not.toBeNull();
  });

  it('butler fires at 3 tool calls — more aggressive than companion', () => {
    const three = [msg({ toolCalls: Array.from({ length: 3 }, () => tc('run_command')) })];
    expect(computeProposalSignal(three, 'butler')).not.toBeNull();
    expect(computeProposalSignal(three, 'companion')).toBeNull();
  });
});

describe('computeProposalSignal · guards', () => {
  it('skips when any tool call errored', () => {
    const tools = [
      ...Array.from({ length: 4 }, () => tc('run_command')),
      tc('run_command', { isError: true }),
    ];
    expect(computeProposalSignal([msg({ toolCalls: tools })], 'companion')).toBeNull();
  });

  it('skips when the agent already proposed in this loop', () => {
    const tools = [
      ...Array.from({ length: 4 }, () => tc('run_command')),
      tc('skill_manage', {
        input: { action: 'create', agent_proposed: true, name: 'auto-x' },
      }),
    ];
    expect(computeProposalSignal([msg({ toolCalls: tools })], 'companion')).toBeNull();
  });

  it("doesn't skip when skill_manage was a direct write (agent_proposed absent)", () => {
    // User explicitly asked → direct skill_manage(create) → still sink-worthy
    // if enough other tools ran alongside. This is a subtle case — we want
    // the nudge next turn so the agent considers *another* skill for the
    // remaining sub-workflow, not to suppress based on one explicit create.
    const tools = [
      ...Array.from({ length: 4 }, () => tc('run_command')),
      tc('skill_manage', { input: { action: 'create', name: 'user-asked' } }),
    ];
    expect(computeProposalSignal([msg({ toolCalls: tools })], 'companion')).not.toBeNull();
  });

  it('ignores hidden tool calls (e.g. report_plan)', () => {
    const tools = [
      ...Array.from({ length: 4 }, () => tc('run_command')),
      tc('report_plan', { hidden: true }),
    ];
    // Only 4 visible tools → below companion's 5 threshold
    expect(computeProposalSignal([msg({ toolCalls: tools })], 'companion')).toBeNull();
  });

  it('counts display-hidden step-backed calls (show_widget) as real work', () => {
    // show_widget is hidden for display only — a visualization-heavy loop
    // must still cross the threshold and surface widget errors.
    const tools = [
      ...Array.from({ length: 4 }, () => tc('run_command')),
      tc('show_widget', { hidden: true }),
    ];
    const signal = computeProposalSignal([msg({ toolCalls: tools })], 'companion');
    expect(signal).not.toBeNull();
    expect(signal!.toolCallCount).toBe(5);
  });

  it('a failed show_widget call suppresses the signal like any other error', () => {
    const tools = [
      ...Array.from({ length: 4 }, () => tc('run_command')),
      tc('show_widget', { hidden: true, isError: true }),
    ];
    expect(computeProposalSignal([msg({ toolCalls: tools })], 'companion')).toBeNull();
  });

  it('usedSkill is true when use_skill was called', () => {
    const tools = [
      tc('use_skill'),
      ...Array.from({ length: 4 }, () => tc('run_command')),
    ];
    const signal = computeProposalSignal([msg({ toolCalls: tools })], 'companion');
    expect(signal).not.toBeNull();
    expect(signal!.usedSkill).toBe(true);
  });

  it('usedSkill is true when message carries skill metadata', () => {
    const tools = Array.from({ length: 5 }, () => tc('run_command'));
    const m = msg({ toolCalls: tools, skill: { name: 'daily-report' } });
    const signal = computeProposalSignal([m], 'companion');
    expect(signal!.usedSkill).toBe(true);
  });
});

describe('computeProposalSignal · output shape', () => {
  it('returns counts and proactivity level in the signal', () => {
    const tools = Array.from({ length: 7 }, () => tc('run_command'));
    const signal = computeProposalSignal([msg({ toolCalls: tools })], 'companion');
    expect(signal).toEqual({
      computedAt: expect.any(Number),
      toolCallCount: 7,
      hadErrors: false,
      usedSkill: false,
      triggerLevel: 'companion',
    });
  });
});

describe('renderProposalSignalSection', () => {
  it('prompts the agent to call skill_manage with agent_proposed=true', () => {
    const rendered = renderProposalSignalSection({
      computedAt: Date.now(),
      toolCallCount: 7,
      hadErrors: false,
      usedSkill: false,
      triggerLevel: 'companion',
    });
    expect(rendered).toMatch(/skill_manage/);
    expect(rendered).toMatch(/agent_proposed/);
    expect(rendered).toMatch(/7 步/);
    // Counter-examples in the prompt so agent knows when NOT to propose.
    expect(rendered).toMatch(/不要调|别调/);
  });

  it('annotates when a skill was used in the loop (signals new-pattern vs. reuse)', () => {
    const rendered = renderProposalSignalSection({
      computedAt: Date.now(),
      toolCallCount: 5,
      hadErrors: false,
      usedSkill: true,
      triggerLevel: 'butler',
    });
    expect(rendered).toMatch(/用过已有 skill/);
  });
});
