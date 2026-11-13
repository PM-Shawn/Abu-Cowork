import { describe, expect, it } from 'vitest';
import { cleanPurpose, commandPurpose, MAX_PURPOSE_CHARS } from './commandPurpose';

describe('cleanPurpose', () => {
  it('keeps a plain sentence as written', () => {
    expect(cleanPurpose('把合同第 18 页转成图片')).toBe('把合同第 18 页转成图片');
    expect(cleanPurpose('  Merge the three spreadsheets  ')).toBe('Merge the three spreadsheets');
  });

  it.each([undefined, null, 3, {}, [], '', '   ', '\n\t'])('has nothing to show for %j', (value) => {
    expect(cleanPurpose(value)).toBeUndefined();
  });

  it('rejects the command pasted back, whatever its spacing', () => {
    expect(cleanPurpose('ls   -la', 'ls -la')).toBeUndefined();
    expect(cleanPurpose("python3 - <<'EOF'\nprint(1)\nEOF", "python3 - <<'EOF'\nprint(1)\nEOF")).toBeUndefined();
  });

  it.each([
    '转换 /tmp/work/a.pdf',
    '处理 /Users/x/Desktop/a.docx',
    '读取 ~/Desktop/a.docx',
    'Open C:\\Users\\a\\b.docx',
    'Open C:/Users/a/b.docx',
    '复制到 \\\\server\\share\\x',
    '运行 `ls`',
    'cd a && ls',
    'python3 convert.py',
    'npm install',
    'a | b',
    'echo $(date)',
  ])('rejects %j, which is code or a path', (value) => {
    expect(cleanPurpose(value)).toBeUndefined();
  });

  it('accepts ordinary text that only resembles code words, and a slash in prose', () => {
    expect(cleanPurpose('统计 5/6 月的销售额')).toBe('统计 5/6 月的销售额');
    expect(cleanPurpose('Compare Q1/Q2 totals')).toBe('Compare Q1/Q2 totals');
    expect(cleanPurpose('合并三个 Python 学习笔记')).toBe('合并三个 Python 学习笔记');
  });

  it('cuts at the limit by characters, ending in an ellipsis', () => {
    const out = cleanPurpose('字'.repeat(MAX_PURPOSE_CHARS + 20));
    expect(Array.from(out ?? '')).toHaveLength(MAX_PURPOSE_CHARS);
    expect(out?.endsWith('…')).toBe(true);
    expect(cleanPurpose('字'.repeat(MAX_PURPOSE_CHARS))).toBe('字'.repeat(MAX_PURPOSE_CHARS));
    expect(Array.from(cleanPurpose('😀'.repeat(100)) ?? '')).toHaveLength(MAX_PURPOSE_CHARS);
  });

  it('turns line breaks into spaces', () => {
    expect(cleanPurpose('第一行\n\n第二行')).toBe('第一行 第二行');
  });
});

describe('commandPurpose', () => {
  it('reads the purpose of a run_command input against its own command', () => {
    expect(commandPurpose({ command: 'ls', purpose: '看看文件夹里有什么' })).toBe('看看文件夹里有什么');
    expect(commandPurpose({ command: 'ls', purpose: 'ls' })).toBeUndefined();
    expect(commandPurpose({ cmd: 'ls', purpose: 'ls' })).toBeUndefined();
    expect(commandPurpose({ command: 'ls' })).toBeUndefined();
    expect(commandPurpose(undefined)).toBeUndefined();
  });
});
