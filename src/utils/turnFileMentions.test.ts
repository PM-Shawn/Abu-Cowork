import { describe, it, expect } from 'vitest';
import { collectTurnFilePaths, resolveFileMention } from './turnFileMentions';
import type { ToolCall } from '@/types';
import {
  TOOL_RESULT_CANCELLED_MARKER,
  TOOL_RESULT_HOOK_BLOCKED_MARKER,
} from '@/core/agent/toolResultMarkers';
import zhCN from '@/i18n/locales/zh-CN';
import enUS from '@/i18n/locales/en-US';

function call(id: string, name: string, input: Record<string, unknown>, result?: string, extra?: Partial<ToolCall>): ToolCall {
  return { id, name, input, result, ...extra };
}

describe('collectTurnFilePaths', () => {
  it('lists the files written, edited and presented this turn, each once', () => {
    const calls = [
      call('w', 'write_file', { path: '/ws/report.md', content: 'x' }, 'ok'),
      call('e', 'edit_file', { path: '/ws/app.ts', old_string: 'a', new_string: 'b' }, 'ok'),
      call('w2', 'write_file', { path: '/ws/report.md', content: 'y' }, 'ok'),
      call('p', 'present_files', { files: [{ path: '/ws/report.md' }, { path: '/ws/slides.pptx' }] }, 'Presented /ws/report.md\nPresented /ws/slides.pptx'),
    ];
    expect(collectTurnFilePaths(calls, '/ws')).toEqual(['/ws/report.md', '/ws/app.ts', '/ws/slides.pptx']);
  });

  it('includes files made by the create tools', () => {
    const calls = [call('c', 'create_file', { file_path: '/ws/new.md' }, 'ok')];
    expect(collectTurnFilePaths(calls, '/ws')).toEqual(['/ws/new.md']);
  });

  it('leaves out failed and unfinished calls', () => {
    const calls = [
      call('w1', 'write_file', { path: '/ws/denied.md', content: 'x' }, 'Error: permission denied'),
      call('w2', 'write_file', { path: '/ws/crashed.md', content: 'x' }, 'boom', { isError: true }),
      call('w3', 'write_file', { path: '/ws/pending.md', content: 'x' }, undefined, { isExecuting: true }),
      call('p', 'present_files', { files: [{ path: '/ws/missing.md' }] }, 'Error: Nothing was presented.'),
    ];
    expect(collectTurnFilePaths(calls, '/ws')).toEqual([]);
  });

  it.each([
    ['stopped by the user (zh-CN)', zhCN.task.cancelled],
    ['stopped by the user (en-US)', enUS.task.cancelled],
    ['aborted before it started', TOOL_RESULT_CANCELLED_MARKER],
    ['blocked by a hook', TOOL_RESULT_HOOK_BLOCKED_MARKER],
  ])('leaves out write, create and present calls that were %s', (_label, result) => {
    const calls = [
      call('w', 'write_file', { path: '/ws/report.md', content: 'x' }, result),
      call('c', 'create_file', { file_path: '/ws/new.md' }, result),
      call('p', 'present_files', { files: [{ path: '/ws/slides.pptx' }] }, result),
    ];
    expect(collectTurnFilePaths(calls, '/ws')).toEqual([]);
  });

  it('lists a file once when it was written by a relative path and presented by an absolute one', () => {
    const calls = [
      call('w', 'write_file', { path: './out/../a.md', content: 'x' }, 'ok'),
      call('p', 'present_files', { files: [{ path: './a.md' }] }, 'Presented /ws/a.md'),
    ];
    const paths = collectTurnFilePaths(calls, '/ws');
    expect(paths).toEqual(['/ws/a.md']);
    expect(resolveFileMention('a.md', paths)).toEqual({ path: '/ws/a.md' });
  });

  it('takes a presented path from the result of the call, whatever the workspace is now', () => {
    const calls = [call('p', 'present_files', { files: [{ path: 'report.md' }] }, 'Presented /first/report.md')];
    expect(collectTurnFilePaths(calls, '/second')).toEqual(['/first/report.md']);
  });

  it('leaves out files that were only read, and tools that take no file', () => {
    const calls = [
      call('r', 'read_file', { path: '/ws/input.md' }, 'content'),
      call('c', 'run_command', { command: 'ls' }, 'ok'),
    ];
    expect(collectTurnFilePaths(calls, '/ws')).toEqual([]);
  });

  it('resolves relative paths against the workspace and unifies separators', () => {
    const calls = [
      call('w', 'write_file', { path: 'out/report.md', content: 'x' }, 'ok'),
      call('w2', 'write_file', { path: 'C:\\ws\\a.docx', content: 'x' }, 'ok'),
    ];
    expect(collectTurnFilePaths(calls, '/ws')).toEqual(['/ws/out/report.md', 'C:/ws/a.docx']);
  });

  it('includes the output of generate_image', () => {
    const calls = [call('g', 'generate_image', { prompt: 'chart' }, '图片已保存到: /ws/chart.png')];
    expect(collectTurnFilePaths(calls, '/ws')).toEqual(['/ws/chart.png']);
  });
});

describe('resolveFileMention', () => {
  const paths = ['/ws/a.ts', '/ws/docs/report.md', '/ws/v1/index.html', '/ws/v2/index.html', 'C:/ws/a.docx', '/ws/季度 报告.docx'];

  it('matches a path that is in the turn', () => {
    expect(resolveFileMention('/ws/docs/report.md', paths)).toEqual({ path: '/ws/docs/report.md' });
  });

  it('ignores surrounding whitespace', () => {
    expect(resolveFileMention('  /ws/a.ts ', paths)).toEqual({ path: '/ws/a.ts' });
  });

  it('matches a file name that belongs to exactly one file of the turn', () => {
    expect(resolveFileMention('report.md', paths)).toEqual({ path: '/ws/docs/report.md' });
  });

  it('does not match a file name shared by two files of the turn', () => {
    expect(resolveFileMention('index.html', paths)).toBeNull();
  });

  it('reads a #L line suffix', () => {
    expect(resolveFileMention('/ws/a.ts#L24', paths)).toEqual({ path: '/ws/a.ts', line: 24 });
  });

  it('reads a :line suffix, also after a bare file name', () => {
    expect(resolveFileMention('/ws/a.ts:7', paths)).toEqual({ path: '/ws/a.ts', line: 7 });
    expect(resolveFileMention('a.ts:7', paths)).toEqual({ path: '/ws/a.ts', line: 7 });
  });

  it('matches a Windows path written with either separator', () => {
    expect(resolveFileMention('C:\\ws\\a.docx', paths)).toEqual({ path: 'C:/ws/a.docx' });
    expect(resolveFileMention('C:/ws/a.docx', paths)).toEqual({ path: 'C:/ws/a.docx' });
  });

  it('matches the percent-encoded form a markdown link carries', () => {
    expect(resolveFileMention(encodeURI('/ws/季度 报告.docx'), paths)).toEqual({ path: '/ws/季度 报告.docx' });
    expect(resolveFileMention(encodeURI('季度 报告.docx'), paths)).toEqual({ path: '/ws/季度 报告.docx' });
  });

  it('does not match a file outside the turn', () => {
    expect(resolveFileMention('other.md', paths)).toBeNull();
    expect(resolveFileMention('/elsewhere/a.ts', paths)).toBeNull();
    expect(resolveFileMention('docs/report.md', paths)).toBeNull();
  });

  it('does not match empty text or an empty turn', () => {
    expect(resolveFileMention('   ', paths)).toBeNull();
    expect(resolveFileMention('a.ts', [])).toBeNull();
  });
});
