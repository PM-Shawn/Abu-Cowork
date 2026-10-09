import { describe, it, expect } from 'vitest';
import { collectPresentedFiles } from './presentedFiles';
import type { ToolCall } from '@/types';
import {
  TOOL_RESULT_CANCELLED_MARKER,
  TOOL_RESULT_HOOK_BLOCKED_MARKER,
} from '@/core/agent/toolResultMarkers';
import zhCN from '@/i18n/locales/zh-CN';
import enUS from '@/i18n/locales/en-US';

function presentCall(id: string, files: unknown[], result?: string, extra?: Partial<ToolCall>): ToolCall {
  return { id, name: 'present_files', input: { files }, result, ...extra };
}

const NOT_RUN_RESULTS = [
  ['stopped by the user (zh-CN)', zhCN.task.cancelled],
  ['stopped by the user (en-US)', enUS.task.cancelled],
  ['aborted before it started', TOOL_RESULT_CANCELLED_MARKER],
  ['blocked by a hook', TOOL_RESULT_HOOK_BLOCKED_MARKER],
] as const;

describe('collectPresentedFiles', () => {
  describe('present_files calls', () => {
    it('lists the files of a successful call in order, with their descriptions', () => {
      const calls = [presentCall(
        'tc1',
        [{ path: '/out/report.md', description: 'Quarterly report' }, { path: '/out/data.xlsx' }],
        'Presented /out/report.md\nPresented /out/data.xlsx',
      )];
      expect(collectPresentedFiles(calls)).toEqual([
        { path: '/out/report.md', description: 'Quarterly report' },
        { path: '/out/data.xlsx' },
      ]);
    });

    it('ignores a call whose result is an error', () => {
      const calls = [presentCall('tc1', [{ path: '/out/missing.md' }], 'Error: Nothing was presented.\n- /out/missing.md: file not found')];
      expect(collectPresentedFiles(calls)).toEqual([]);
    });

    it('ignores a call flagged as an error', () => {
      const calls = [presentCall('tc1', [{ path: '/out/report.md' }], 'Presented /out/report.md', { isError: true })];
      expect(collectPresentedFiles(calls)).toEqual([]);
    });

    it('ignores a call that has not finished', () => {
      const calls = [presentCall('tc1', [{ path: '/out/report.md' }], undefined, { isExecuting: true })];
      expect(collectPresentedFiles(calls)).toEqual([]);
    });

    it.each(NOT_RUN_RESULTS)('ignores a call that was %s', (_label, result) => {
      const calls = [presentCall('tc1', [{ path: '/out/report.md', description: 'Report' }], result)];
      expect(collectPresentedFiles(calls)).toEqual([]);
    });

    it('ignores a call whose result lists fewer paths than it was given', () => {
      const calls = [presentCall('tc1', [{ path: '/out/a.md' }, { path: '/out/b.md' }], 'Presented /out/a.md')];
      expect(collectPresentedFiles(calls)).toEqual([]);
    });

    it('ignores a call whose result lists more paths than it was given', () => {
      const calls = [presentCall('tc1', [{ path: '/out/a.md' }], 'Presented /out/a.md\nPresented /out/b.md')];
      expect(collectPresentedFiles(calls)).toEqual([]);
    });

    it('ignores a call whose result holds any other line', () => {
      const calls = [presentCall('tc1', [{ path: '/out/a.md' }, { path: '/out/b.md' }], 'Presented /out/a.md\nok')];
      expect(collectPresentedFiles(calls)).toEqual([]);
    });

    it('takes the path from the result and the description from the input at the same position', () => {
      const calls = [presentCall(
        'tc1',
        [{ path: 'docs/report.md', description: 'Report' }, { path: './data.xlsx' }, { path: 'notes.md', description: 'Notes' }],
        'Presented /first/docs/report.md\nPresented /first/data.xlsx\nPresented /first/notes.md',
      )];
      expect(collectPresentedFiles(calls)).toEqual([
        { path: '/first/docs/report.md', description: 'Report' },
        { path: '/first/data.xlsx' },
        { path: '/first/notes.md', description: 'Notes' },
      ]);
    });

    it('lists one entry for a file presented by a relative and by an absolute path', () => {
      const calls = [
        presentCall('tc1', [{ path: './a.md', description: 'First wording' }], 'Presented /ws/a.md'),
        presentCall('tc2', [{ path: '/ws/a.md', description: 'Second wording' }], 'Presented /ws/a.md'),
      ];
      expect(collectPresentedFiles(calls)).toEqual([{ path: '/ws/a.md', description: 'Second wording' }]);
    });

    it('keeps the first position and the later description when a path is presented twice', () => {
      const calls = [
        presentCall('tc1', [{ path: '/out/a.md', description: 'First wording' }, { path: '/out/b.md', description: 'B' }], 'Presented /out/a.md\nPresented /out/b.md'),
        presentCall('tc2', [{ path: '/out/c.md' }, { path: '/out/a.md', description: 'Second wording' }, { path: '/out/b.md' }], 'Presented /out/c.md\nPresented /out/a.md\nPresented /out/b.md'),
      ];
      expect(collectPresentedFiles(calls)).toEqual([
        { path: '/out/a.md', description: 'Second wording' },
        { path: '/out/b.md', description: 'B' },
        { path: '/out/c.md' },
      ]);
    });

    it('unifies Windows separators', () => {
      const calls = [presentCall('tc1', [{ path: 'C:\\out\\a.docx' }], 'Presented C:\\out\\a.docx')];
      expect(collectPresentedFiles(calls)).toEqual([{ path: 'C:/out/a.docx' }]);
    });
  });

  describe('image tools', () => {
    it('lists the output of a successful generate_image without a description', () => {
      const calls: ToolCall[] = [{
        id: 'tc1', name: 'generate_image', input: { prompt: 'a cat' },
        result: '图片已保存到: /p/a.png\n修订后的提示词: a cat',
      }];
      expect(collectPresentedFiles(calls)).toEqual([{ path: '/p/a.png' }]);
    });

    it('lists the output of a successful process_image', () => {
      const calls: ToolCall[] = [{
        id: 'tc1', name: 'process_image', input: { action: 'resize', output_path: '/p/ignored.png' },
        result: 'Image processed successfully: /p/small.png',
      }];
      expect(collectPresentedFiles(calls)).toEqual([{ path: '/p/small.png' }]);
    });

    it('ignores a failed generate_image', () => {
      const calls: ToolCall[] = [{
        id: 'tc1', name: 'generate_image', input: { prompt: 'a cat' },
        result: 'Error: no image backend configured',
      }];
      expect(collectPresentedFiles(calls)).toEqual([]);
    });

    it.each(NOT_RUN_RESULTS)('ignores a process_image that was %s', (_label, result) => {
      const calls: ToolCall[] = [{
        id: 'tc1', name: 'process_image', input: { action: 'resize', output_path: '/p/small.png' }, result,
      }];
      expect(collectPresentedFiles(calls)).toEqual([]);
    });

    it('keeps images and presented files in call order', () => {
      const calls: ToolCall[] = [
        { id: 'tc1', name: 'generate_image', input: {}, result: 'Image saved to: /p/a.png' },
        presentCall('tc2', [{ path: '/out/report.md' }, { path: '/p/a.png', description: 'Cover' }], 'Presented /out/report.md\nPresented /p/a.png'),
      ];
      expect(collectPresentedFiles(calls)).toEqual([
        { path: '/p/a.png', description: 'Cover' },
        { path: '/out/report.md' },
      ]);
    });
  });

  describe('other tools', () => {
    it('produces nothing for write_file, run_command and delegate_to_agent', () => {
      const calls: ToolCall[] = [
        { id: 'tc1', name: 'write_file', input: { path: '/ws/draft.md', content: 'x' }, result: 'ok' },
        { id: 'tc2', name: 'run_command', input: { command: 'python build.py' }, result: 'Saved to /ws/out.pdf' },
        { id: 'tc3', name: 'delegate_to_agent', input: { agent_name: 'writer', task: 'write' }, result: 'Wrote /ws/essay.md' },
      ];
      expect(collectPresentedFiles(calls)).toEqual([]);
    });
  });
});
