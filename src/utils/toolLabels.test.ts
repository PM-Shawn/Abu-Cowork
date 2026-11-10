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
      expect(getToolLabel('run_command', { command: 'ls', purpose: 'List the folder' }, 'en-US').label).toBe('List the folder');
      expect(getToolLabel('run_command', { command: 'ls', purpose: '看看文件夹里有什么' }, 'zh-CN').label).toBe('看看文件夹里有什么');
      // No purpose: a generic sentence, never the command.
      expect(getToolLabel('run_command', { command: 'ls' }, 'en-US').label).toBe('Work on files');
      expect(getToolLabel('run_command', { command: 'ls' }, 'zh-CN').label).toBe('处理文件');
    });

    it('run_command in background mode says so', () => {
      expect(getToolLabel('run_command', { command: 'npm run dev', purpose: '启动预览', background: true }, 'zh-CN').label).toBe('启动预览（在后台）');
      expect(getToolLabel('run_command', { command: 'npm run dev', purpose: 'Start the preview', background: true }, 'en-US').label).toBe('Start the preview (in the background)');
      expect(getToolLabel('run_command', { command: 'npm run dev', background: true }, 'en-US').label).toBe('Work on files in the background');
      expect(getToolLabel('run_command', { command: 'npm run dev', purpose: '启动预览', background: false }, 'zh-CN').label).toBe('启动预览');
    });

    it('background_command_output names the command from the step record, else its id', () => {
      const record = { backgroundCommand: { command: 'npm run dev' } };
      expect(getToolLabel('background_command_output', { id: 'bg-0a1b2c3d' }, 'zh-CN', record).label).toBe('查看后台命令的输出 npm run dev');
      expect(getToolLabel('background_command_output', { id: 'bg-0a1b2c3d' }, 'en-US', record).label).toBe('Read background command output npm run dev');
      expect(getToolLabel('background_command_output', { id: 'bg-0a1b2c3d' }, 'zh-CN').label).toBe('查看后台命令的输出 bg-0a1b2c3d');
      expect(getToolLabel('background_command_output', {}, 'en-US').label).toBe('Read background command output');
    });

    it('stop_background_command names the command from the step record, else its id', () => {
      const record = { backgroundCommand: { command: 'npm run dev' } };
      expect(getToolLabel('stop_background_command', { id: 'bg-0a1b2c3d' }, 'zh-CN', record).label).toBe('停止后台命令 npm run dev');
      expect(getToolLabel('stop_background_command', { id: 'bg-0a1b2c3d' }, 'en-US', record).label).toBe('Stop background command npm run dev');
      expect(getToolLabel('stop_background_command', { id: 'bg-0a1b2c3d' }, 'en-US').label).toBe('Stop background command bg-0a1b2c3d');
    });

    it('use_skill follows locale', () => {
      expect(getToolLabel('use_skill', { skill_name: '/pdf' }, 'en-US').label).toBe('Use /pdf skill');
      expect(getToolLabel('use_skill', { skill_name: '/pdf' }, 'zh-CN').label).toBe('使用 /pdf 技能');
    });

    it('present_files → count of files, with the file names as detail', () => {
      const input = { files: [{ path: '/out/report.md', description: 'Report' }, { path: 'C:\\out\\chart.png' }, { path: 7 }] };
      expect(getToolLabel('present_files', input, 'zh-CN')).toEqual({
        label: '交付了 2 个文件',
        detail: 'report.md、chart.png',
      });
      expect(getToolLabel('present_files', input, 'en-US')).toEqual({
        label: 'Presented 2 files',
        detail: 'report.md, chart.png',
      });
      expect(getToolLabel('present_files', { files: [{ path: '/out/report.md' }] }, 'en-US').label).toBe('Presented 1 file');
      expect(getToolLabel('present_files', {}, 'zh-CN')).toEqual({ label: '交付了 0 个文件', detail: undefined });
    });

    it('http_fetch names the page without the scheme, in both locales', () => {
      const url = 'https://example.com/docs/api';
      expect(getToolLabel('http_fetch', { url }, 'zh-CN')).toEqual({ label: '读取网页 example.com/docs/api', detail: url });
      expect(getToolLabel('http_fetch', { url }, 'en-US')).toEqual({ label: 'Read page example.com/docs/api', detail: url });
    });

    it('http_fetch cuts a long address at 40 characters', () => {
      const url = `https://example.com/${'a'.repeat(60)}`;
      const { label } = getToolLabel('http_fetch', { url }, 'en-US');
      expect(label.endsWith('…')).toBe(true);
      expect(Array.from(label.slice('Read page '.length))).toHaveLength(41);
    });

    it('http_fetch without a url keeps the bare title', () => {
      expect(getToolLabel('http_fetch', {}, 'zh-CN').label).toBe('读取网页');
    });

    it('an unknown tool reads as a generic sentence in the right locale, never by its id', () => {
      expect(getToolLabel('some_tool', {}, 'en-US').label).toBe('Use a tool');
      expect(getToolLabel('some_tool', {}, 'zh-CN').label).toBe('使用工具');
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

    it('MCP label names the connector in the locale; the tool and its input stay in the detail', () => {
      expect(getToolLabel('gh__list', { a: 1 }, 'en-US')).toEqual({ label: 'Use gh', detail: 'list {"a":1}' });
      expect(getToolLabel('gh__list', { a: 1 }, 'zh-CN').label).toBe('使用 gh');
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
