import { describe, expect, it } from 'vitest';
import { getToolLabel, hasNameOnlyLabel, isCommandToolName } from './toolLabels';

// Step titles as a person reads them. Each case checks the title for the words of code a person
// should not meet: a command, a path, a tool id.
describe('getToolLabel: plain titles', () => {
  const command = "cd /var/tmp/case && python3 convert.py '合同.pdf'";

  it.each([
    ['a command-like phrase in Chinese', '运行 python 脚本'],
    ['a Chinese-folder sentence', '整理“项目资料”文件夹里的合同'],
    ['a web address', '下载 https://example.com/a.pdf'],
    ['markdown', '**合并** 表格'],
    ['an emoji', '做成 PPT 🎉'],
  ])('shows %s as the purpose, whole', (_name, purpose) => {
    expect(getToolLabel('run_command', { command, purpose }, 'zh-CN').label).toBe(purpose);
  });

  it('shows a purpose that is a path, a command or a flag as the generic sentence', () => {
    for (const purpose of ['转换 /tmp/work/a.pdf', 'python3 convert.py', 'ls -la']) {
      expect(getToolLabel('run_command', { command, purpose }, 'en-US').label).toBe('Work on files');
    }
  });

  it('cuts a 200-character purpose to 60 characters', () => {
    expect(Array.from(getToolLabel('run_command', { command, purpose: '整理合同'.repeat(50) }, 'zh-CN').label)).toHaveLength(60);
  });

  it('serves the `cmd` field and the `shell` / `execute` / `bash` aliases', () => {
    for (const name of ['shell', 'execute', 'bash']) {
      expect(getToolLabel(name, { cmd: 'ls', purpose: '看看文件夹' }, 'zh-CN').label).toBe('看看文件夹');
      expect(getToolLabel(name, { cmd: 'ls', purpose: 'ls' }, 'zh-CN').label).toBe('处理文件');
      expect(getToolLabel(name, { cmd: 'ls' }, 'en-US').label).toBe('Work on files');
      expect(isCommandToolName(name)).toBe(true);
    }
  });

  it('keeps the exact command in the detail even when the purpose is missing', () => {
    expect(getToolLabel('run_command', { command }, 'zh-CN').detail).toBe(command);
  });

  it('a background command is titled by its purpose, or generically', () => {
    expect(getToolLabel('run_command', { command: 'npm run dev', purpose: '启动预览', background: true }, 'zh-CN').label).toBe('启动预览（在后台）');
    expect(getToolLabel('run_command', { command: 'npm run dev', background: true }, 'en-US').label).toBe('Work on files in the background');
  });

  it('connector steps read as the connector, in both locales, and keep the tool id in the detail', () => {
    const zh = getToolLabel('github__create_issue', { title: 't' }, 'zh-CN');
    const en = getToolLabel('github__create_issue', { title: 't' }, 'en-US');
    expect(zh.label).toBe('使用 github');
    expect(en.label).toBe('Use github');
    expect(zh.label + en.label).not.toContain('create_issue');
    expect(zh.detail).toContain('create_issue');
  });

  it('the built-in browser has a plain name, not a server id', () => {
    expect(getToolLabel('abu-browser__click', {}, 'en-US').label).toBe('Use the browser');
    expect(getToolLabel('abu-browser-bridge__click', {}, 'zh-CN').label).toBe('使用浏览器');
  });

  it('a tool with a plain name is titled by it, an unknown tool generically, never by its id', () => {
    expect(getToolLabel('apply_patch', {}, 'zh-CN').label).toBe('修改文件');
    expect(hasNameOnlyLabel('apply_patch')).toBe(true);
    expect(getToolLabel('some_new_tool', {}, 'en-US').label).toBe('Use a tool');
    expect(getToolLabel('some_new_tool', {}, 'zh-CN').label).toBe('使用工具');
    expect(hasNameOnlyLabel('some_new_tool')).toBe(false);
  });

  it('delete_file names the file', () => {
    expect(getToolLabel('delete_file', { path: '/a/b/old.txt' }, 'en-US').label).toBe('Delete old.txt');
  });
});
