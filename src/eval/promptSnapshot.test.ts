/**
 * L1 — Prompt section snapshot tests
 *
 * Ensures the system prompt structure doesn't change accidentally.
 * Uses snapshot testing for section names + content existence checks for key instructions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (same as orchestrator.test.ts) ──
vi.mock('@/core/agent/registry', () => ({
  agentRegistry: {
    getAgent: vi.fn().mockReturnValue({ name: 'abu', systemPrompt: '你是阿布', description: '桌面助手' }),
    getAvailableAgents: vi.fn().mockReturnValue([]),
  },
}));

vi.mock('@/core/skill/loader', () => ({
  skillLoader: {
    getSkill: vi.fn(),
    getAvailableSkills: vi.fn().mockReturnValue([]),
    findMatchingSkills: vi.fn().mockReturnValue([]),
  },
}));

vi.mock('@/core/memdir/scan', () => ({
  loadMemoryIndex: vi.fn().mockResolvedValue(''),
  scanMemoryFiles: vi.fn().mockResolvedValue([]),
  readMemoryFile: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/core/memdir/write', () => ({
  touchMemory: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/core/agent/projectRules', () => ({
  loadAllRules: vi.fn().mockResolvedValue(''),
}));

vi.mock('@/stores/workspaceStore', () => ({
  useWorkspaceStore: {
    getState: vi.fn().mockReturnValue({ currentPath: '/test/workspace' }),
  },
}));

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: {
    getState: vi.fn().mockReturnValue({
      computerUseEnabled: false,
      disabledSkills: [],
      disabledAgents: [],
      contextWindowSize: 200000,
      allowSkillCommands: false,
    }),
  },
}));

vi.mock('@/core/session/sessionDir', () => ({
  getSessionOutputDir: vi.fn().mockResolvedValue('/tmp/session-output'),
}));

vi.mock('@/utils/platform', () => ({
  isWindows: vi.fn().mockReturnValue(false),
}));

vi.mock('@/core/mcp/client', () => ({
  mcpManager: {
    isConnected: vi.fn().mockReturnValue(false),
  },
}));

vi.mock('@/core/skill/preprocessor', () => ({
  substituteVariables: vi.fn((content: string) => content),
  executeInlineCommands: vi.fn((content: string) => content),
}));

vi.mock('@/utils/pythonRuntime', () => ({
  hasEmbeddedPython: vi.fn().mockResolvedValue(false),
}));

import { buildSystemPromptSections, buildSystemPrompt, routeInput } from '@/core/agent/orchestrator';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('System prompt section structure', () => {
  it('general mode section names match snapshot', async () => {
    const route = routeInput('你好');
    const sections = await buildSystemPromptSections(route, '你是阿布', 'eval-conv-001');

    const names = sections.map(s => s.name);
    expect(names).toMatchSnapshot();
  });

  it('general mode has persona and planning sections', async () => {
    const route = routeInput('你好');
    const sections = await buildSystemPromptSections(route, '你是阿布', 'eval-conv-001');

    const names = sections.map(s => s.name);
    expect(names).toContain('persona');
    expect(names).toContain('planning');
  });

  it('includes current-time as volatile section', async () => {
    const route = routeInput('你好');
    const sections = await buildSystemPromptSections(route, '你是阿布', 'eval-conv-001');

    const timeSection = sections.find(s => s.name === 'current-time');
    expect(timeSection).toBeDefined();
    expect(timeSection!.cacheable).toBe(false);
  });

  it('persona and planning are cacheable', async () => {
    const route = routeInput('你好');
    const sections = await buildSystemPromptSections(route, '你是阿布', 'eval-conv-001');

    const persona = sections.find(s => s.name === 'persona');
    const planning = sections.find(s => s.name === 'planning');
    expect(persona?.cacheable).toBe(true);
    expect(planning?.cacheable).toBe(true);
  });
});

describe('System prompt key content', () => {
  const basePrompt = '你是阿布，专业桌面助手。';

  it('contains tool selection principles', async () => {
    const route = routeInput('你好');
    const prompt = await buildSystemPrompt(route, basePrompt, 'test-conv');

    expect(prompt).toContain('read_file');
    expect(prompt).toContain('run_command');
    expect(prompt).toContain('report_plan');
  });

  it('contains planning instruction', async () => {
    const route = routeInput('你好');
    const prompt = await buildSystemPrompt(route, basePrompt, 'test-conv');

    expect(prompt).toContain('执行规范');
    expect(prompt).toContain('情况 A');
    expect(prompt).toContain('use_skill');
  });

  it('contains safety anchor', async () => {
    const route = routeInput('你好');
    const prompt = await buildSystemPrompt(route, basePrompt, 'test-conv');

    expect(prompt).toContain('安全提醒');
  });

  it('contains workspace path', async () => {
    const route = routeInput('你好');
    const prompt = await buildSystemPrompt(route, basePrompt, 'test-conv');

    expect(prompt).toContain('/test/workspace');
  });
});

describe('Skill mode prompt structure', () => {
  it('skill mode injects skill content', async () => {
    const route = {
      type: 'skill' as const,
      name: 'test-skill',
      skill: {
        name: 'test-skill',
        description: 'test',
        content: '这是技能指令内容',
        filePath: '/test',
        skillDir: '/test',
      },
      skillContent: '这是技能指令内容',
      cleanInput: 'test input',
    };

    const sections = await buildSystemPromptSections(route, '你是阿布', 'test-conv');
    const fullText = sections.map(s => s.text).join('\n');
    expect(fullText).toContain('技能指令内容');
  });

  it('skill mode does not include planning instruction', async () => {
    const route = {
      type: 'skill' as const,
      name: 'test-skill',
      skill: {
        name: 'test-skill',
        description: 'test',
        content: 'skill content',
        filePath: '/test',
        skillDir: '/test',
      },
      skillContent: 'skill content',
      cleanInput: 'test input',
    };

    const sections = await buildSystemPromptSections(route, '你是阿布', 'test-conv');
    const names = sections.map(s => s.name);
    expect(names).not.toContain('planning');
  });
});
