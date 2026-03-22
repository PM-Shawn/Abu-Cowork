import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { saveSkillTool, saveAgentTool } from './agentTools';

// Mock dependencies not covered by global setup
vi.mock('../../skill/loader', () => ({
  skillLoader: { getSkill: vi.fn(), loadSkill: vi.fn(), refreshSkill: vi.fn() },
}));
vi.mock('../../agent/registry', () => ({
  agentRegistry: { getAgent: vi.fn(), listAgents: vi.fn().mockReturnValue([]) },
}));
vi.mock('../../agent/permissionBridge', () => ({
  getCurrentLoopContext: vi.fn(),
  requestWorkspace: vi.fn(),
}));
vi.mock('../../agent/subagentLoop', () => ({
  runSubagentLoop: vi.fn(),
  extractParentConversationSummary: vi.fn().mockReturnValue(''),
}));
vi.mock('../../agent/subagentAbort', () => ({
  createSubagentController: vi.fn(),
}));
vi.mock('../../../stores/chatStore', () => ({
  useChatStore: { getState: vi.fn().mockReturnValue({ activeConversationId: 'test', getActiveConversation: vi.fn() }) },
}));
vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: { getState: vi.fn().mockReturnValue({ disabledSkills: [] }) },
}));
vi.mock('../../../stores/discoveryStore', () => ({
  useDiscoveryStore: { getState: vi.fn().mockReturnValue({ refresh: vi.fn() }) },
}));
vi.mock('../../../utils/pathUtils', () => ({
  joinPath: (...parts: string[]) => parts.join('/'),
  ensureParentDir: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../utils/validation', () => ({
  ITEM_NAME_RE: /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
}));
vi.mock('../helpers/toolHelpers', () => ({
  getSystemInfoData: vi.fn().mockResolvedValue({ home: '/Users/testuser' }),
}));

describe('save_skill / save_agent multi-file support', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('save_skill', () => {
    it('should save SKILL.md only when no files provided', async () => {
      const result = await saveSkillTool.execute({
        name: 'my-skill',
        content: '---\nname: my-skill\n---\n# My Skill',
      });

      expect(writeTextFile).toHaveBeenCalledTimes(1);
      expect(writeTextFile).toHaveBeenCalledWith(
        '/Users/testuser/.abu/skills/my-skill/SKILL.md',
        '---\nname: my-skill\n---\n# My Skill',
      );
      expect(result).toContain('my-skill');
      expect(result).not.toContain('附属文件');
    });

    it('should save SKILL.md + supporting files when files provided', async () => {
      const result = await saveSkillTool.execute({
        name: 'infographic-gen',
        content: '---\nname: infographic-gen\n---\n# Infographic',
        files: [
          { path: 'scripts/render.mjs', content: 'export default function render() {}' },
          { path: 'references/templates.md', content: '# Templates\n- list\n- chart' },
        ],
      });

      // SKILL.md + 2 supporting files = 3 writes
      expect(writeTextFile).toHaveBeenCalledTimes(3);
      expect(writeTextFile).toHaveBeenCalledWith(
        '/Users/testuser/.abu/skills/infographic-gen/SKILL.md',
        expect.any(String),
      );
      expect(writeTextFile).toHaveBeenCalledWith(
        '/Users/testuser/.abu/skills/infographic-gen/scripts/render.mjs',
        'export default function render() {}',
      );
      expect(writeTextFile).toHaveBeenCalledWith(
        '/Users/testuser/.abu/skills/infographic-gen/references/templates.md',
        '# Templates\n- list\n- chart',
      );
      expect(result).toContain('附属文件');
      expect(result).toContain('scripts/render.mjs');
      expect(result).toContain('references/templates.md');
    });

    it('should reject path traversal in files', async () => {
      const result = await saveSkillTool.execute({
        name: 'bad-skill',
        content: '---\nname: bad-skill\n---\n# Bad',
        files: [
          { path: '../../../etc/passwd', content: 'malicious' },
        ],
      });

      expect(result).toContain('Error');
      expect(result).toContain('不安全');
      // SKILL.md was written before files check, but the malicious file was not
      expect(writeTextFile).toHaveBeenCalledTimes(1);
    });

    it('should reject absolute paths in files', async () => {
      const result = await saveSkillTool.execute({
        name: 'bad-skill',
        content: '---\nname: bad-skill\n---\n# Bad',
        files: [
          { path: '/etc/passwd', content: 'malicious' },
        ],
      });

      expect(result).toContain('Error');
      expect(result).toContain('不安全');
    });

    it('should reject backslash absolute paths', async () => {
      const result = await saveSkillTool.execute({
        name: 'bad-skill',
        content: '---\nname: bad-skill\n---\n# Bad',
        files: [
          { path: '\\Windows\\System32\\evil.bat', content: 'malicious' },
        ],
      });

      expect(result).toContain('Error');
      expect(result).toContain('不安全');
    });

    it('should handle empty files array gracefully', async () => {
      const result = await saveSkillTool.execute({
        name: 'simple-skill',
        content: '---\nname: simple-skill\n---\n# Simple',
        files: [],
      });

      expect(writeTextFile).toHaveBeenCalledTimes(1);
      expect(result).not.toContain('附属文件');
    });

    it('should still validate name even with files', async () => {
      const result = await saveSkillTool.execute({
        name: 'INVALID_NAME',
        content: '---\n---',
        files: [{ path: 'scripts/a.js', content: 'x' }],
      });

      expect(result).toContain('Error');
      expect(result).toContain('名称不合法');
      expect(writeTextFile).not.toHaveBeenCalled();
    });
  });

  describe('save_agent', () => {
    it('should save AGENT.md + supporting files', async () => {
      const result = await saveAgentTool.execute({
        name: 'my-agent',
        content: '---\nname: my-agent\n---\n# My Agent',
        files: [
          { path: 'scripts/helper.py', content: 'print("hello")' },
        ],
      });

      expect(writeTextFile).toHaveBeenCalledTimes(2);
      expect(writeTextFile).toHaveBeenCalledWith(
        '/Users/testuser/.abu/agents/my-agent/AGENT.md',
        expect.any(String),
      );
      expect(writeTextFile).toHaveBeenCalledWith(
        '/Users/testuser/.abu/agents/my-agent/scripts/helper.py',
        'print("hello")',
      );
      expect(result).toContain('附属文件');
      expect(result).toContain('scripts/helper.py');
    });
  });
});
