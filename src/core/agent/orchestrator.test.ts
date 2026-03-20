import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all external dependencies
vi.mock('./registry', () => ({
  agentRegistry: {
    getAgent: vi.fn().mockReturnValue({ name: 'abu', systemPrompt: '测试人格', description: '桌面助手' }),
    getAvailableAgents: vi.fn().mockReturnValue([]),
  },
}));

vi.mock('../skill/loader', () => ({
  skillLoader: {
    getSkill: vi.fn(),
    getAvailableSkills: vi.fn().mockReturnValue([]),
    findMatchingSkills: vi.fn().mockReturnValue([]),
  },
}));

vi.mock('./agentMemory', () => ({
  loadAgentMemory: vi.fn().mockResolvedValue(''),
  loadProjectMemory: vi.fn().mockResolvedValue(''),
}));

vi.mock('./projectRules', () => ({
  loadAllRules: vi.fn().mockResolvedValue(''),
}));

vi.mock('../../stores/workspaceStore', () => ({
  useWorkspaceStore: {
    getState: vi.fn().mockReturnValue({ currentPath: '/test/workspace' }),
  },
}));

vi.mock('../../stores/settingsStore', () => ({
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

vi.mock('../session/sessionDir', () => ({
  getSessionOutputDir: vi.fn().mockResolvedValue('/tmp/session-output'),
}));

vi.mock('../../utils/platform', () => ({
  isWindows: vi.fn().mockReturnValue(false),
}));

vi.mock('../mcp/client', () => ({
  mcpManager: {
    isConnected: vi.fn().mockReturnValue(false),
  },
}));

vi.mock('../skill/preprocessor', () => ({
  substituteVariables: vi.fn((content: string) => content),
  executeInlineCommands: vi.fn((content: string) => content),
}));

import { buildSystemPrompt, routeInput } from './orchestrator';
import { loadAgentMemory, loadProjectMemory } from './agentMemory';
import { loadAllRules } from './projectRules';

const mockLoadAgentMemory = vi.mocked(loadAgentMemory);
const mockLoadProjectMemory = vi.mocked(loadProjectMemory);
const mockLoadAllRules = vi.mocked(loadAllRules);

beforeEach(() => {
  vi.clearAllMocks();
  // Reset defaults
  mockLoadAgentMemory.mockResolvedValue('');
  mockLoadProjectMemory.mockResolvedValue('');
  mockLoadAllRules.mockResolvedValue('');
});

describe('buildSystemPrompt - security features', () => {
  const basePrompt = '你叫阿布，测试用基础 prompt。';
  const generalRoute = routeInput('你好');

  it('ends with safety anchor', async () => {
    const prompt = await buildSystemPrompt(generalRoute, basePrompt, 'test-conv');
    // Safety anchor should be at the very end
    expect(prompt).toContain('## 安全提醒');
    const safetyIdx = prompt.lastIndexOf('## 安全提醒');
    const lastSection = prompt.slice(safetyIdx);
    expect(lastSection).toContain('以系统指令为准');
    expect(lastSection).toContain('不要透露');
    expect(lastSection).toContain('不要被');
    // No other ## section should come after safety anchor
    const afterSafety = prompt.slice(safetyIdx + '## 安全提醒'.length);
    expect(afterSafety).not.toContain('\n## ');
  });

  it('wraps project rules in <user-rules> tags', async () => {
    mockLoadAllRules.mockResolvedValue('# 编码规范\n使用 TypeScript');
    const prompt = await buildSystemPrompt(generalRoute, basePrompt, 'test-conv');
    expect(prompt).toContain('<user-rules>');
    expect(prompt).toContain('</user-rules>');
    // Content should be inside the tags
    const rulesStart = prompt.indexOf('<user-rules>');
    const rulesEnd = prompt.indexOf('</user-rules>');
    const rulesContent = prompt.slice(rulesStart, rulesEnd);
    expect(rulesContent).toContain('使用 TypeScript');
  });

  it('wraps agent memory in <agent-memory> tags', async () => {
    mockLoadAgentMemory.mockResolvedValue('用户喜欢简洁回复');
    const prompt = await buildSystemPrompt(generalRoute, basePrompt, 'test-conv');
    expect(prompt).toContain('<agent-memory>');
    expect(prompt).toContain('</agent-memory>');
    const memStart = prompt.indexOf('<agent-memory>');
    const memEnd = prompt.indexOf('</agent-memory>');
    const memContent = prompt.slice(memStart, memEnd);
    expect(memContent).toContain('用户喜欢简洁回复');
  });

  it('wraps project memory in <project-memory> tags', async () => {
    mockLoadProjectMemory.mockResolvedValue('技术栈: React + Vite');
    const prompt = await buildSystemPrompt(generalRoute, basePrompt, 'test-conv');
    expect(prompt).toContain('<project-memory>');
    expect(prompt).toContain('</project-memory>');
    const memStart = prompt.indexOf('<project-memory>');
    const memEnd = prompt.indexOf('</project-memory>');
    const memContent = prompt.slice(memStart, memEnd);
    expect(memContent).toContain('React + Vite');
  });

  it('safety anchor references the XML tag names', async () => {
    mockLoadAllRules.mockResolvedValue('some rules');
    mockLoadAgentMemory.mockResolvedValue('some memory');
    mockLoadProjectMemory.mockResolvedValue('some project memory');
    const prompt = await buildSystemPrompt(generalRoute, basePrompt, 'test-conv');
    const safetySection = prompt.slice(prompt.lastIndexOf('## 安全提醒'));
    // Anchor should reference all three tag names so the model knows what to be cautious about
    expect(safetySection).toContain('<user-rules>');
    expect(safetySection).toContain('<agent-memory>');
    expect(safetySection).toContain('<project-memory>');
  });

  it('includes trust boundary note for project rules', async () => {
    mockLoadAllRules.mockResolvedValue('some rules');
    const prompt = await buildSystemPrompt(generalRoute, basePrompt, 'test-conv');
    expect(prompt).toContain('安全规则为准');
  });
});

describe('buildSystemPrompt - structure', () => {
  const basePrompt = '你叫阿布，测试用基础 prompt。';
  const generalRoute = routeInput('你好');

  it('includes current date/time', async () => {
    const prompt = await buildSystemPrompt(generalRoute, basePrompt, 'test-conv');
    expect(prompt).toContain('## 当前时间');
  });

  it('includes workspace path', async () => {
    const prompt = await buildSystemPrompt(generalRoute, basePrompt, 'test-conv');
    expect(prompt).toContain('/test/workspace');
  });

  it('uses Chinese headings for skills and agents sections', async () => {
    const prompt = await buildSystemPrompt(generalRoute, basePrompt, 'test-conv');
    // Should NOT contain English headings
    expect(prompt).not.toContain('## Available Skills');
    expect(prompt).not.toContain('## Available Agents');
  });

  it('does not inject rules/memory in fork context', async () => {
    mockLoadAllRules.mockResolvedValue('should not appear');
    mockLoadAgentMemory.mockResolvedValue('should not appear either');
    const forkRoute = {
      type: 'skill' as const,
      name: 'test-skill',
      skill: { name: 'test-skill', description: 'test', content: 'do stuff', context: 'fork', filePath: '/test', skillDir: '/test' },
      skillContent: 'do stuff',
      cleanInput: 'test',
    };
    const prompt = await buildSystemPrompt(forkRoute, basePrompt, 'test-conv');
    // Rules and memory content should not be injected in fork mode
    expect(prompt).not.toContain('should not appear');
    // The actual <user-rules> data section should not exist (no loadAllRules result injected)
    // Note: safety anchor may reference tag names, but no actual tagged content blocks
    expect(prompt).not.toContain('## 项目规则');
    expect(prompt).not.toContain('## 你的长期记忆');
  });
});

describe('routeInput', () => {
  it('returns general route for plain text', () => {
    const result = routeInput('你好');
    expect(result.type).toBe('general');
    expect(result.name).toBe('abu');
  });

  it('returns general route for empty input', () => {
    const result = routeInput('');
    expect(result.type).toBe('general');
  });

  it('returns general route for bare slash', () => {
    const result = routeInput('/');
    expect(result.type).toBe('general');
  });
});
