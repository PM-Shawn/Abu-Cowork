import { describe, it, expect } from 'vitest';
import { getToolLabel, getDetailBlockLabel, parseMCPToolName, isMCPTool } from './toolLabels';

describe('getToolLabel', () => {
  describe('locale following', () => {
    it('list_directory renders in English for en-US', () => {
      expect(getToolLabel('list_directory', { path: '/Users/x/Desktop' }, 'en-US').label).toBe('List Desktop');
    });

    it('list_directory renders in Chinese for zh-CN', () => {
      expect(getToolLabel('list_directory', { path: '/Users/x/Desktop' }, 'zh-CN').label).toBe('列出 Desktop');
    });

    it('read_file follows locale', () => {
      expect(getToolLabel('read_file', { path: '/a/App.tsx' }, 'en-US').label).toBe('Read App.tsx');
      expect(getToolLabel('read_file', { path: '/a/App.tsx' }, 'zh-CN').label).toBe('读取 App.tsx');
    });

    it('run_command follows locale', () => {
      expect(getToolLabel('run_command', { command: 'ls' }, 'en-US').label).toBe('Run ls');
      expect(getToolLabel('run_command', { command: 'ls' }, 'zh-CN').label).toBe('执行 ls');
    });

    it('use_skill follows locale', () => {
      expect(getToolLabel('use_skill', { skill_name: '/pdf' }, 'en-US').label).toBe('Use /pdf skill');
      expect(getToolLabel('use_skill', { skill_name: '/pdf' }, 'zh-CN').label).toBe('使用 /pdf 技能');
    });

    it('unknown tool falls back to Call/调用 in the right locale', () => {
      expect(getToolLabel('some_tool', {}, 'en-US').label).toBe('Call some_tool');
      expect(getToolLabel('some_tool', {}, 'zh-CN').label).toBe('调用 some_tool');
    });
  });

  describe('defensive default locale', () => {
    it('defaults to Chinese when no locale passed', () => {
      expect(getToolLabel('list_directory', { path: '/x/Desktop' }).label).toBe('列出 Desktop');
    });
  });

  describe('MCP tools', () => {
    it('detects and parses MCP tool names', () => {
      expect(isMCPTool('server__do')).toBe(true);
      expect(isMCPTool('read_file')).toBe(false);
      expect(parseMCPToolName('server__do')).toEqual({ serverName: 'server', actualToolName: 'do' });
    });

    it('MCP label is locale-independent (server + tool name)', () => {
      expect(getToolLabel('gh__list', { a: 1 }, 'en-US').label).toBe('[gh] list');
      expect(getToolLabel('gh__list', { a: 1 }, 'zh-CN').label).toBe('[gh] list');
    });
  });
});

describe('getDetailBlockLabel', () => {
  it('localizes result/error/script/content headers', () => {
    expect(getDetailBlockLabel('result', 'en-US')).toBe('Result');
    expect(getDetailBlockLabel('result', 'zh-CN')).toBe('结果');
    expect(getDetailBlockLabel('error', 'en-US')).toBe('Error');
    expect(getDetailBlockLabel('error', 'zh-CN')).toBe('错误');
    expect(getDetailBlockLabel('script', 'en-US')).toBe('Script');
    expect(getDetailBlockLabel('content', 'zh-CN')).toBe('内容');
  });
});
