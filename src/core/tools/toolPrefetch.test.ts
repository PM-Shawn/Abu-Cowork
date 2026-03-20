import { describe, it, expect } from 'vitest';
import { CORE_TOOL_NAMES, prefetchTools, type PrefetchContext } from './toolPrefetch';

function makeCtx(overrides: Partial<PrefetchContext> = {}): PrefetchContext {
  return {
    userInput: '',
    computerUseEnabled: false,
    activeSkills: [],
    turnCount: 0,
    ...overrides,
  };
}

describe('toolPrefetch', () => {
  describe('CORE_TOOL_NAMES', () => {
    it('should contain 16 core tools', () => {
      expect(CORE_TOOL_NAMES.size).toBe(16);
    });

    it('should include essential tools', () => {
      expect(CORE_TOOL_NAMES.has('read_file')).toBe(true);
      expect(CORE_TOOL_NAMES.has('write_file')).toBe(true);
      expect(CORE_TOOL_NAMES.has('run_command')).toBe(true);
      expect(CORE_TOOL_NAMES.has('web_search')).toBe(true);
    });

    it('should not include conditional tools', () => {
      expect(CORE_TOOL_NAMES.has('generate_image')).toBe(false);
      expect(CORE_TOOL_NAMES.has('computer')).toBe(false);
      expect(CORE_TOOL_NAMES.has('manage_scheduled_task')).toBe(false);
    });
  });

  describe('prefetchTools', () => {
    it('should return empty array for generic input', () => {
      const result = prefetchTools(makeCtx({ userInput: '你好' }));
      expect(result).toEqual([]);
    });

    it('should match schedule keywords', () => {
      const result = prefetchTools(makeCtx({ userInput: '帮我设置一个定时任务' }));
      expect(result).toContain('manage_scheduled_task');
    });

    it('should match trigger keywords', () => {
      const result = prefetchTools(makeCtx({ userInput: '创建一个 webhook 触发器' }));
      expect(result).toContain('manage_trigger');
    });

    it('should match file watch keywords', () => {
      const result = prefetchTools(makeCtx({ userInput: '监听文件变化' }));
      expect(result).toContain('manage_file_watch');
    });

    it('should match image keywords', () => {
      const result = prefetchTools(makeCtx({ userInput: '生成一张图片' }));
      expect(result).toContain('generate_image');
      expect(result).toContain('process_image');
    });

    it('should match clipboard keywords', () => {
      const result = prefetchTools(makeCtx({ userInput: '读取剪贴板内容' }));
      expect(result).toContain('clipboard_read');
      expect(result).toContain('clipboard_write');
    });

    it('should match skill/agent creation keywords', () => {
      const result = prefetchTools(makeCtx({ userInput: '帮我创建一个新技能' }));
      expect(result).toContain('save_skill');
      expect(result).toContain('save_agent');
    });

    it('should match MCP keywords', () => {
      const result = prefetchTools(makeCtx({ userInput: '我需要一个 MCP 工具' }));
      expect(result).toContain('manage_mcp_server');
    });

    it('should match notify keywords', () => {
      const result = prefetchTools(makeCtx({ userInput: '完成后通知我' }));
      expect(result).toContain('system_notify');
    });

    it('should load computer tool when enabled', () => {
      const result = prefetchTools(makeCtx({ computerUseEnabled: true }));
      expect(result).toContain('computer');
    });

    it('should not load computer tool when disabled', () => {
      const result = prefetchTools(makeCtx({ computerUseEnabled: false }));
      expect(result).not.toContain('computer');
    });

    it('should load read_skill_file when active skills exist', () => {
      const result = prefetchTools(makeCtx({
        activeSkills: [{ name: 'test', description: 'test', content: '' } as import('../../types').Skill],
      }));
      expect(result).toContain('read_skill_file');
    });

    it('should load log_task_completion after turn 2', () => {
      expect(prefetchTools(makeCtx({ turnCount: 1 }))).not.toContain('log_task_completion');
      expect(prefetchTools(makeCtx({ turnCount: 2 }))).not.toContain('log_task_completion');
      expect(prefetchTools(makeCtx({ turnCount: 3 }))).toContain('log_task_completion');
    });

    it('should deduplicate results', () => {
      const result = prefetchTools(makeCtx({ userInput: '图片图像照片' }));
      const imageCount = result.filter(t => t === 'generate_image').length;
      expect(imageCount).toBe(1);
    });

    it('should match case-insensitively', () => {
      const result = prefetchTools(makeCtx({ userInput: 'DALL-E image generation' }));
      expect(result).toContain('generate_image');
    });
  });
});
