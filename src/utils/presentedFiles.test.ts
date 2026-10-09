import { describe, it, expect } from 'vitest';
import { collectPresentedFiles } from './presentedFiles';
import type { ToolCall } from '@/types';

function presentCall(id: string, files: unknown[], result?: string, extra?: Partial<ToolCall>): ToolCall {
  return { id, name: 'present_files', input: { files }, result, ...extra };
}

describe('collectPresentedFiles', () => {
  describe('present_files calls', () => {
    it('lists the files of a successful call in order, with their descriptions', () => {
      const calls = [presentCall(
        'tc1',
        [{ path: '/out/report.md', description: 'Quarterly report' }, { path: '/out/data.xlsx' }],
        'Presented /out/report.md\nPresented /out/data.xlsx',
      )];
      expect(collectPresentedFiles(calls, '/ws')).toEqual([
        { path: '/out/report.md', description: 'Quarterly report' },
        { path: '/out/data.xlsx' },
      ]);
    });

    it('ignores a call whose result is an error', () => {
      const calls = [presentCall('tc1', [{ path: '/out/missing.md' }], 'Error: Nothing was presented.\n- /out/missing.md: file not found')];
      expect(collectPresentedFiles(calls, '/ws')).toEqual([]);
    });

    it('ignores a call flagged as an error', () => {
      const calls = [presentCall('tc1', [{ path: '/out/report.md' }], 'tool crashed', { isError: true })];
      expect(collectPresentedFiles(calls, '/ws')).toEqual([]);
    });

    it('ignores a call that has not finished', () => {
      const calls = [presentCall('tc1', [{ path: '/out/report.md' }], undefined, { isExecuting: true })];
      expect(collectPresentedFiles(calls, '/ws')).toEqual([]);
    });

    it('keeps the first position and the later description when a path is presented twice', () => {
      const calls = [
        presentCall('tc1', [{ path: '/out/a.md', description: 'First wording' }, { path: '/out/b.md', description: 'B' }], 'Presented /out/a.md\nPresented /out/b.md'),
        presentCall('tc2', [{ path: '/out/c.md' }, { path: '/out/a.md', description: 'Second wording' }, { path: '/out/b.md' }], 'Presented /out/c.md\nPresented /out/a.md\nPresented /out/b.md'),
      ];
      expect(collectPresentedFiles(calls, null)).toEqual([
        { path: '/out/a.md', description: 'Second wording' },
        { path: '/out/b.md', description: 'B' },
        { path: '/out/c.md' },
      ]);
    });

    it('resolves a relative path against the workspace', () => {
      const calls = [presentCall('tc1', [{ path: 'docs/report.md' }], 'Presented /ws/docs/report.md')];
      expect(collectPresentedFiles(calls, '/ws')).toEqual([{ path: '/ws/docs/report.md' }]);
    });

    it('unifies Windows separators', () => {
      const calls = [presentCall('tc1', [{ path: 'C:\\out\\a.docx' }], 'Presented C:\\out\\a.docx')];
      expect(collectPresentedFiles(calls, 'C:\\ws')).toEqual([{ path: 'C:/out/a.docx' }]);
    });
  });

  describe('image tools', () => {
    it('lists the output of a successful generate_image without a description', () => {
      const calls: ToolCall[] = [{
        id: 'tc1', name: 'generate_image', input: { prompt: 'a cat' },
        result: '图片已保存到: /p/a.png\n修订后的提示词: a cat',
      }];
      expect(collectPresentedFiles(calls, '/ws')).toEqual([{ path: '/p/a.png' }]);
    });

    it('lists the output of a successful process_image', () => {
      const calls: ToolCall[] = [{
        id: 'tc1', name: 'process_image', input: { action: 'resize', output_path: '/p/ignored.png' },
        result: 'Image processed successfully: /p/small.png',
      }];
      expect(collectPresentedFiles(calls, '/ws')).toEqual([{ path: '/p/small.png' }]);
    });

    it('ignores a failed generate_image', () => {
      const calls: ToolCall[] = [{
        id: 'tc1', name: 'generate_image', input: { prompt: 'a cat' },
        result: 'Error: no image backend configured',
      }];
      expect(collectPresentedFiles(calls, '/ws')).toEqual([]);
    });

    it('keeps images and presented files in call order', () => {
      const calls: ToolCall[] = [
        { id: 'tc1', name: 'generate_image', input: {}, result: 'Image saved to: /p/a.png' },
        presentCall('tc2', [{ path: '/out/report.md' }, { path: '/p/a.png', description: 'Cover' }], 'Presented /out/report.md\nPresented /p/a.png'),
      ];
      expect(collectPresentedFiles(calls, '/ws')).toEqual([
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
      expect(collectPresentedFiles(calls, '/ws')).toEqual([]);
    });
  });
});
