/**
 * L1 — Routing stability tests
 *
 * Verifies that routeInput correctly dispatches to the right handler type.
 * Uses a fixture JSON so non-developers can add cases easily.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ──
const mockGetAgent = vi.fn();
const mockGetSkill = vi.fn();
const mockFindMatchingSkills = vi.fn().mockReturnValue([]);
const mockSettingsGetState = vi.fn();

vi.mock('@/core/agent/registry', () => ({
  agentRegistry: {
    getAgent: (...args: unknown[]) => mockGetAgent(...args),
    getAvailableAgents: vi.fn().mockReturnValue([]),
  },
}));

vi.mock('@/core/skill/loader', () => ({
  skillLoader: {
    getSkill: (...args: unknown[]) => mockGetSkill(...args),
    getAvailableSkills: vi.fn().mockReturnValue([]),
    findMatchingSkills: (...args: unknown[]) => mockFindMatchingSkills(...args),
  },
}));

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: {
    getState: (...args: unknown[]) => mockSettingsGetState(...args),
  },
}));

import { routeInput } from '@/core/agent/orchestrator';
import routingCases from './datasets/routing-cases.json';

// ── Default mock values ──
const DEFAULT_ABU = { name: 'abu', systemPrompt: '', description: '' };
const DEFAULT_SETTINGS = { disabledSkills: [], disabledAgents: [] };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAgent.mockReturnValue(DEFAULT_ABU);
  mockGetSkill.mockReturnValue(undefined);
  mockFindMatchingSkills.mockReturnValue([]);
  mockSettingsGetState.mockReturnValue(DEFAULT_SETTINGS);
});

// ── General routing (from fixture JSON) ──

describe('routeInput — general routing', () => {
  it.each(routingCases)(
    '$description: "$input" → $expectedType',
    ({ input, expectedType }) => {
      const result = routeInput(input);
      expect(result.type).toBe(expectedType);
    }
  );

  it('always returns cleanInput as string', () => {
    for (const { input } of routingCases) {
      const result = routeInput(input);
      expect(typeof result.cleanInput).toBe('string');
    }
  });

  it('general route always names abu', () => {
    for (const { input, expectedType } of routingCases) {
      if (expectedType !== 'general') continue;
      const result = routeInput(input);
      expect(result.name).toBe('abu');
    }
  });
});

// ── Skill routing ──

describe('routeInput — skill routing', () => {
  const fakeSkill = {
    name: 'test-skill',
    description: 'test',
    content: 'test content',
    filePath: '/test',
    skillDir: '/test',
  };

  it('slash command with registered skill returns skill type', () => {
    mockGetSkill.mockReturnValueOnce(fakeSkill);

    const result = routeInput('/test-skill some args');
    expect(result.type).toBe('skill');
    expect(result.name).toBe('test-skill');
    expect(result.args).toBe('some args');
    expect(result.skillContent).toBe('test content');
  });

  it('slash command with unregistered skill returns general', () => {
    const result = routeInput('/nonexistent');
    expect(result.type).toBe('general');
  });

  it('preserves all args after skill name', () => {
    mockGetSkill.mockReturnValueOnce({ ...fakeSkill, name: 'commit' });

    const result = routeInput('/commit fix: resolve bug #123');
    expect(result.args).toBe('fix: resolve bug #123');
  });

  it('skill with no args sets cleanInput to execution hint', () => {
    mockGetSkill.mockReturnValueOnce(fakeSkill);

    const result = routeInput('/test-skill');
    expect(result.cleanInput).toContain('test-skill');
  });
});

// ── Agent delegation ──

describe('routeInput — agent delegation', () => {
  const fakeAgent = { name: 'coder', systemPrompt: 'coding', description: 'writes code' };

  it('@agent with registered non-abu agent returns delegate', () => {
    mockGetAgent.mockReturnValueOnce(fakeAgent);

    const result = routeInput('@coder 写个排序函数');
    expect(result.type).toBe('delegate');
    expect(result.cleanInput).toBe('写个排序函数');
    expect(result.delegateAgent).toBeDefined();
  });

  it('@abu does not delegate (abu is the main agent)', () => {
    const result = routeInput('@abu 做点什么');
    expect(result.type).toBe('general');
  });

  it('@agent still delegates when the agent is off the auto-dispatch pool', () => {
    mockSettingsGetState.mockReturnValueOnce({
      disabledSkills: [],
      disabledAgents: ['coder'],
    });
    mockGetAgent.mockReturnValueOnce(fakeAgent);

    const result = routeInput('@coder 写个函数');
    expect(result.type).toBe('delegate');
    expect(result.name).toBe('coder');
  });

  it('@agent with no task text uses fallback cleanInput', () => {
    mockGetAgent.mockReturnValueOnce(fakeAgent);

    const result = routeInput('@coder');
    expect(result.type).toBe('delegate');
    expect(result.cleanInput).toContain('coder');
  });
});
