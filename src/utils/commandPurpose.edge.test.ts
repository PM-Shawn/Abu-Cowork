import { describe, expect, it } from 'vitest';
import { cleanPurpose, MAX_PURPOSE_CHARS } from './commandPurpose';

// Hostile and awkward model output: the purpose is the model's own text, shown to a person who
// cannot read code. These cases pin what is accepted and what counts as missing.
describe('cleanPurpose: awkward text', () => {
  it('keeps a Chinese sentence that mentions a tool by name (a known limit, not filtered)', () => {
    // A name inside prose cannot be told from "合并三个 Python 学习笔记" without false rejections.
    expect(cleanPurpose('运行 python 脚本')).toBe('运行 python 脚本');
  });

  it.each([
    '把 /Users/张三/文档/合同.pdf 转成图片',
    '读取 C:\\Users\\张三\\文档\\合同.docx',
    '读取 C:/Users/张三/文档/合同.docx',
    '整理 ~/桌面/合同.pdf',
  ])('rejects a path with Chinese folder names set off by spaces: %j', (value) => {
    expect(cleanPurpose(value)).toBeUndefined();
  });

  // Regression: Chinese prose has no spaces, so the path is glued to the verb and the
  // "preceded by whitespace" test in PATH_IN_TEXT never fires. The path reaches the step title.
  it.each([
    '保存到/tmp/work/out.pdf',
    '读取C:\\Users\\a\\合同.docx',
    '整理/Users/张三/文档/合同.pdf里的页面',
    '复制到~/Desktop/a.docx',
  ])('rejects a path glued to Chinese text: %j', (value) => {
    expect(cleanPurpose(value)).toBeUndefined();
  });

  // Regression: a path whose first folder is Chinese has no [\w.-]+ run to match.
  it('rejects a path that starts with a Chinese folder', () => {
    expect(cleanPurpose('整理 /桌面/合同.pdf')).toBeUndefined();
  });

  it('keeps a web address (not a path)', () => {
    expect(cleanPurpose('下载 https://example.com/a/b.pdf 里的报价')).toBe('下载 https://example.com/a/b.pdf 里的报价');
  });

  it('keeps markdown and HTML as plain characters (the UI renders text, never markup)', () => {
    expect(cleanPurpose('**合并** <b>三个</b> 表格')).toBe('**合并** <b>三个</b> 表格');
    expect(cleanPurpose('<script>alert(1)</script>')).toBe('<script>alert(1)</script>');
  });

  it('keeps an emoji sentence whole when under the limit', () => {
    expect(cleanPurpose('把报告做成 PPT 🎉')).toBe('把报告做成 PPT 🎉');
  });

  it('cuts 200 characters to the limit, with one ellipsis, on a character boundary', () => {
    const out = cleanPurpose('合并报表'.repeat(50)) ?? '';
    expect(Array.from(out)).toHaveLength(MAX_PURPOSE_CHARS);
    expect(out.endsWith('…')).toBe(true);
    expect(out.slice(0, -1)).toBe('合并报表'.repeat(50).slice(0, MAX_PURPOSE_CHARS - 1));
  });

  it('treats an ideographic space and a non-breaking space as blank', () => {
    expect(cleanPurpose('\u3000\u3000')).toBeUndefined();
    expect(cleanPurpose('\u00a0')).toBeUndefined();
    expect(cleanPurpose('\ufeff')).toBeUndefined();
  });

  // Regression: zero-width characters are not whitespace to String#trim, so a purpose
  // made only of them passes as a "sentence" and the step title is invisible.
  it.each(['\u200b', '\u200b\u200b\u200b', '\u2060'])('treats an invisible-only purpose as missing: %j', (value) => {
    expect(cleanPurpose(value)).toBeUndefined();
  });

  // Regression: right-to-left override / isolate controls are kept, so the model (or a
  // file name it was fed) can make the shown sentence read in a different order from its characters.
  it.each(['\u202e把文件删除\u202c', '\u2067合并表格\u2069'])('does not pass bidirectional control characters through: %j', (value) => {
    expect(cleanPurpose(value)).not.toMatch(/[\u202a-\u202e\u2066-\u2069]/);
  });

  it('keeps genuine right-to-left text', () => {
    expect(cleanPurpose('دمج الجداول')).toBe('دمج الجداول');
  });

  it('a command with other whitespace pasted back is still caught', () => {
    expect(cleanPurpose('ls\t-la', 'ls   -la\n')).toBeUndefined();
  });
});
