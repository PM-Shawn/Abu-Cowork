import { describe, it, expect } from 'vitest';
import {
  extractWorkflowSteps,
  generateCompletionMessage,
  extractFileOutputs,
  extractStdout,
  extractFilePathsFromText,
  parsePlanSteps,
} from './workflowExtractor';
import type { ToolCall } from '@/types';

describe('workflowExtractor', () => {
  // ── extractWorkflowSteps ──
  describe('extractWorkflowSteps', () => {
    it('returns empty array for no tool calls', () => {
      const steps = extractWorkflowSteps([]);
      expect(steps).toHaveLength(0);
    });

    it('thinking content without duration → running (still in flight)', () => {
      const steps = extractWorkflowSteps([], '正在推理...');
      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe('thinking');
      expect(steps[0].status).toBe('running');
      expect(steps[0].detail).toBe('正在推理...');
    });

    it('thinking content with duration → completed', () => {
      const steps = extractWorkflowSteps([], '推理完成的内容', undefined, undefined, 5);
      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe('thinking');
      expect(steps[0].status).toBe('completed');
      expect(steps[0].duration).toBe(5);
      expect(steps[0].detail).toBe('推理完成的内容');
    });

    it('adds running thinking step when agentStatus is thinking', () => {
      const steps = extractWorkflowSteps([], undefined, 'thinking');
      expect(steps).toHaveLength(1);
      expect(steps[0].type).toBe('thinking');
      expect(steps[0].status).toBe('running');
    });

    it('maps file read tools correctly', () => {
      const toolCalls: ToolCall[] = [{
        id: 'tc1', name: 'read_file',
        input: { path: '/tmp/test.txt' },
        result: 'content',
      }];
      const steps = extractWorkflowSteps(toolCalls);
      expect(steps[0].type).toBe('file-read');
      expect(steps[0].label).toContain('读取');
      expect(steps[0].label).toContain('test.txt');
      expect(steps[0].status).toBe('completed');
    });

    it('maps file write tools correctly', () => {
      const toolCalls: ToolCall[] = [{
        id: 'tc1', name: 'write_file',
        input: { path: '/tmp/out.txt' },
        result: 'ok',
      }];
      const steps = extractWorkflowSteps(toolCalls);
      expect(steps[0].type).toBe('file-write');
      expect(steps[0].label).toContain('写入');
    });

    it('maps command tools correctly', () => {
      const toolCalls: ToolCall[] = [{
        id: 'tc1', name: 'bash',
        input: { command: 'npm install' },
        result: 'ok',
      }];
      const steps = extractWorkflowSteps(toolCalls);
      expect(steps[0].type).toBe('command');
      expect(steps[0].label).toContain('执行');
    });

    it('truncates long command labels to 20 chars', () => {
      const toolCalls: ToolCall[] = [{
        id: 'tc1', name: 'run_command',
        input: { command: 'npm install --save-dev @types/node typescript vitest' },
        result: 'ok',
      }];
      const steps = extractWorkflowSteps(toolCalls);
      expect(steps[0].label).toContain('...');
    });

    it('maps executing tool as running', () => {
      const toolCalls: ToolCall[] = [{
        id: 'tc1', name: 'read_file',
        input: { path: '/tmp/a.txt' },
        isExecuting: true,
      }];
      const steps = extractWorkflowSteps(toolCalls);
      expect(steps[0].status).toBe('running');
    });

    it('maps error result as error status', () => {
      const toolCalls: ToolCall[] = [{
        id: 'tc1', name: 'read_file',
        input: { path: '/tmp/a.txt' },
        result: 'Error: file not found',
      }];
      const steps = extractWorkflowSteps(toolCalls);
      expect(steps[0].status).toBe('error');
    });

    it('maps pending tool (no result, not executing)', () => {
      const toolCalls: ToolCall[] = [{
        id: 'tc1', name: 'read_file',
        input: { path: '/tmp/a.txt' },
      }];
      const steps = extractWorkflowSteps(toolCalls);
      expect(steps[0].status).toBe('pending');
    });

    it('adds skill step when skillInfo provided', () => {
      const steps = extractWorkflowSteps(
        [{ id: 'tc1', name: 'read_file', input: {}, result: 'ok' }],
        undefined, undefined,
        { name: 'translate', description: '翻译技能' }
      );
      expect(steps[0].type).toBe('skill');
      expect(steps[0].label).toContain('translate');
    });

    it('handles use_skill tool calls', () => {
      const toolCalls: ToolCall[] = [{
        id: 'tc1', name: 'use_skill',
        input: { skill_name: 'summarize' },
        result: 'Summary done',
      }];
      const steps = extractWorkflowSteps(toolCalls);
      expect(steps[0].type).toBe('skill');
      expect(steps[0].label).toContain('summarize');
    });

    it('includes thinkingDuration on thinking step', () => {
      const steps = extractWorkflowSteps([], 'thinking...', undefined, undefined, 5.2);
      expect(steps[0].duration).toBe(5.2);
    });

    it('maps unknown tool to generic type', () => {
      const toolCalls: ToolCall[] = [{
        id: 'tc1', name: 'custom_tool',
        input: {},
        result: 'ok',
      }];
      const steps = extractWorkflowSteps(toolCalls);
      expect(steps[0].type).toBe('tool');
      expect(steps[0].label).toContain('custom_tool');
    });

    it('maps search tools correctly', () => {
      const toolCalls: ToolCall[] = [{
        id: 'tc1', name: 'grep',
        input: { pattern: 'TODO' },
        result: 'line1\nline2',
      }];
      const steps = extractWorkflowSteps(toolCalls);
      expect(steps[0].label).toContain('搜索');
      expect(steps[0].label).toContain('TODO');
    });
  });

  // ── generateCompletionMessage ──
  describe('generateCompletionMessage', () => {
    it('generates Chinese message for list_directory', () => {
      const msg = generateCompletionMessage('list_directory', {}, 'file1\nfile2\nfile3', 'zh');
      expect(msg).toContain('3');
      expect(msg).toContain('成功');
    });

    it('generates English message for list_directory', () => {
      const msg = generateCompletionMessage('list_directory', {}, 'file1\nfile2', 'en');
      expect(msg).toContain('2');
      expect(msg).toContain('Listed');
    });

    it('generates message for read_file success', () => {
      const msg = generateCompletionMessage('read_file', { path: '/tmp/app.tsx' }, 'content', 'zh');
      expect(msg).toContain('app.tsx');
      expect(msg).toContain('成功');
    });

    it('generates failure message for read errors', () => {
      const msg = generateCompletionMessage('read_file', {}, 'Error: not found', 'zh');
      expect(msg).toContain('失败');
    });

    it('generates message for run_command', () => {
      const msg = generateCompletionMessage('run_command', { command: 'npm install' }, 'ok', 'zh');
      expect(msg).toContain('npm install');
    });

    it('truncates long command in completion message', () => {
      const msg = generateCompletionMessage('run_command', { command: 'npm install --save-dev typescript' }, 'ok', 'zh');
      expect(msg).toContain('...');
    });

    it('generates search completion with match count', () => {
      const msg = generateCompletionMessage('grep', {}, 'match1\nmatch2\nmatch3', 'zh');
      expect(msg).toContain('3');
    });

    it('generates default success for unknown tool', () => {
      const msg = generateCompletionMessage('custom_tool', {}, 'ok', 'zh');
      expect(msg).toContain('成功');
    });

    it('generates default failure for unknown tool', () => {
      const msg = generateCompletionMessage('custom_tool', {}, 'Error: failed', 'zh');
      expect(msg).toContain('失败');
    });
  });

  // ── extractFileOutputs ──
  describe('extractFileOutputs', () => {
    it('returns empty for no tool calls', () => {
      expect(extractFileOutputs([])).toHaveLength(0);
    });

    it('extracts write operations', () => {
      const toolCalls: ToolCall[] = [{
        id: 'tc1', name: 'write_file',
        input: { path: '/tmp/out.txt' },
        result: 'ok',
      }];
      const files = extractFileOutputs(toolCalls);
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe('/tmp/out.txt');
      expect(files[0].operation).toBe('write');
    });

    it('extracts create operations', () => {
      const toolCalls: ToolCall[] = [{
        id: 'tc1', name: 'create_file',
        input: { path: '/tmp/new.txt' },
        result: 'ok',
      }];
      const files = extractFileOutputs(toolCalls);
      expect(files[0].operation).toBe('create');
    });

    it('extracts edit operations as write', () => {
      const toolCalls: ToolCall[] = [{
        id: 'tc1', name: 'edit_file',
        input: { path: '/tmp/edit.txt' },
        result: 'ok',
      }];
      const files = extractFileOutputs(toolCalls);
      expect(files[0].operation).toBe('write');
    });

    it('deduplicates same path', () => {
      const toolCalls: ToolCall[] = [
        { id: 'tc1', name: 'write_file', input: { path: '/tmp/a.txt' }, result: 'ok' },
        { id: 'tc2', name: 'edit_file', input: { path: '/tmp/a.txt' }, result: 'ok' },
      ];
      const files = extractFileOutputs(toolCalls);
      expect(files).toHaveLength(1);
    });

    it('skips tool calls without result (not completed)', () => {
      const toolCalls: ToolCall[] = [{
        id: 'tc1', name: 'write_file',
        input: { path: '/tmp/pending.txt' },
      }];
      const files = extractFileOutputs(toolCalls);
      expect(files).toHaveLength(0);
    });

    it('ignores read tools by default', () => {
      const toolCalls: ToolCall[] = [{
        id: 'tc1', name: 'read_file',
        input: { path: '/tmp/a.txt' },
        result: 'content',
      }];
      const files = extractFileOutputs(toolCalls);
      expect(files).toHaveLength(0);
    });

    it('includes read tools when includeReads is true', () => {
      const toolCalls: ToolCall[] = [{
        id: 'tc1', name: 'read_file',
        input: { path: '/tmp/a.txt' },
        result: 'content',
      }];
      const files = extractFileOutputs(toolCalls, { includeReads: true });
      expect(files).toHaveLength(1);
      expect(files[0].operation).toBe('read');
    });

    it('skips error results', () => {
      const toolCalls: ToolCall[] = [{
        id: 'tc1', name: 'write_file',
        input: { path: '/tmp/fail.txt' },
        result: 'Error: permission denied',
      }];
      const files = extractFileOutputs(toolCalls);
      expect(files).toHaveLength(0);
    });

    it('skips "Error <verb>ing" style errors', () => {
      const toolCalls: ToolCall[] = [{
        id: 'tc1', name: 'write_file',
        input: { path: '/tmp/fail.txt' },
        result: 'Error writing file: permission denied',
      }];
      const files = extractFileOutputs(toolCalls);
      expect(files).toHaveLength(0);
    });

    it('skips failed commands (non-zero exit code)', () => {
      const toolCalls: ToolCall[] = [{
        id: 'tc1', name: 'run_command',
        input: { command: 'cp "/tmp/Hello world.docx" "/Users/didi/Desktop/Hello world.docx"' },
        result: 'stderr:\n[sandbox-blocked] file write or network access blocked by sandbox policy\n\nexit code: 1',
      }];
      const files = extractFileOutputs(toolCalls);
      expect(files).toHaveLength(0);
    });

    it('skips sandbox-blocked commands', () => {
      const toolCalls: ToolCall[] = [{
        id: 'tc1', name: 'run_command',
        input: { command: 'mv /tmp/doc.pdf /Users/didi/Desktop/doc.pdf' },
        result: 'stderr:\n[sandbox-blocked] file write or network access blocked by sandbox policy\n\nexit code: 1',
      }];
      const files = extractFileOutputs(toolCalls);
      expect(files).toHaveLength(0);
    });

    it('write overrides read for same path', () => {
      const toolCalls: ToolCall[] = [
        { id: 'tc1', name: 'read_file', input: { path: '/tmp/a.txt' }, result: 'content' },
        { id: 'tc2', name: 'write_file', input: { path: '/tmp/a.txt' }, result: 'ok' },
      ];
      const files = extractFileOutputs(toolCalls, { includeReads: true });
      expect(files).toHaveLength(1);
      expect(files[0].operation).toBe('write');
    });

    it('extracts file paths from run_command stdout', () => {
      const toolCalls: ToolCall[] = [{
        id: 'tc1', name: 'run_command',
        input: { command: 'python convert.py' },
        result: 'stdout:\n转换完成，已保存到 /Users/test/output.docx\n\nexit code: 0',
      }];
      const files = extractFileOutputs(toolCalls);
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe('/Users/test/output.docx');
      expect(files[0].operation).toBe('create');
    });

    it('extracts file paths from bash tool stdout', () => {
      const toolCalls: ToolCall[] = [{
        id: 'tc1', name: 'bash',
        input: { command: 'python script.py' },
        result: 'stdout:\nFile saved to /tmp/result.pdf\n\nexit code: 0',
      }];
      const files = extractFileOutputs(toolCalls);
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe('/tmp/result.pdf');
    });

    it('extracts file paths from delegate_to_agent result', () => {
      const toolCalls: ToolCall[] = [{
        id: 'tc1', name: 'delegate_to_agent',
        input: { task: 'convert pdf' },
        result: '转换完成，输出文件: /Users/test/report.docx',
      }];
      const files = extractFileOutputs(toolCalls);
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe('/Users/test/report.docx');
    });

    it('extracts file paths from MCP tool input path fields', () => {
      const toolCalls: ToolCall[] = [{
        id: 'tc1', name: 'mcp_server__convert',
        input: { output_path: '/tmp/converted.xlsx' },
        result: 'done',
      }];
      const files = extractFileOutputs(toolCalls);
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe('/tmp/converted.xlsx');
    });

    it('extracts file paths from MCP tool result text', () => {
      const toolCalls: ToolCall[] = [{
        id: 'tc1', name: 'mcp_server__export',
        input: {},
        result: '导出完成，已保存到 /tmp/export.csv',
      }];
      const files = extractFileOutputs(toolCalls);
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe('/tmp/export.csv');
    });

    it('process_image falls back to input.output_path', () => {
      const toolCalls: ToolCall[] = [{
        id: 'tc1', name: 'process_image',
        input: { output_path: '/tmp/processed.png' },
        result: 'Processing complete',
      }];
      const files = extractFileOutputs(toolCalls);
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe('/tmp/processed.png');
      expect(files[0].operation).toBe('create');
    });

    it('skips error results for command tools', () => {
      const toolCalls: ToolCall[] = [{
        id: 'tc1', name: 'run_command',
        input: { command: 'python fail.py' },
        result: 'Error: command failed',
      }];
      const files = extractFileOutputs(toolCalls);
      expect(files).toHaveLength(0);
    });

    it('skips error results for delegate_to_agent', () => {
      const toolCalls: ToolCall[] = [{
        id: 'tc1', name: 'delegate_to_agent',
        input: { task: 'convert' },
        result: 'Error: agent failed',
      }];
      const files = extractFileOutputs(toolCalls);
      expect(files).toHaveLength(0);
    });

    // ── /tmp/ command-string intermediate buffer filter ──
    // Regression: cooper skill (and similar tools) pipe output to /tmp/ as an
    // intermediate processing buffer, then run wc/grep/python3 on it. None of
    // these run_command calls should produce a file card or trigger a snapshot.
    //
    // The filter is applied ONLY inside extractPathsFromCommand (command-string
    // scanning). Legitimate /tmp/ deliverables announced via stdout keywords or
    // written explicitly via write_file / MCP output_path are unaffected.
    describe('/tmp/ intermediate buffer suppression', () => {
      it('does not emit file card for /tmp/ path in compound create command', () => {
        const toolCalls: ToolCall[] = [{
          id: 'tc1', name: 'run_command',
          input: { command: 'mcporter call Cooper.readContent > /tmp/cooper_doc.txt && wc -l /tmp/cooper_doc.txt' },
          result: 'stdout:\n1 /tmp/cooper_doc.txt\n\nexit code: 0',
        }];
        expect(extractFileOutputs(toolCalls)).toHaveLength(0);
      });

      it('does not emit file card for /tmp/ path in standalone grep command', () => {
        const toolCalls: ToolCall[] = [{
          id: 'tc1', name: 'run_command',
          input: { command: "grep -o '客观成交率' /tmp/cooper_doc.txt | sort | uniq -c" },
          result: 'stdout:\n20 客观成交率\n\nexit code: 0',
        }];
        expect(extractFileOutputs(toolCalls)).toHaveLength(0);
      });

      it('does not emit file card for /tmp/ path inside python3 -c inline script', () => {
        const toolCalls: ToolCall[] = [{
          id: 'tc1', name: 'run_command',
          input: { command: "python3 -c \"with open('/tmp/cooper_doc.txt') as f: print(f.read()[:100])\"" },
          result: 'stdout:\nsome content\n\nexit code: 0',
        }];
        expect(extractFileOutputs(toolCalls)).toHaveLength(0);
      });

      it('does not emit file card for all three cooper-pattern commands combined', () => {
        // Full reproduction of the conversation that triggered the bug.
        const toolCalls: ToolCall[] = [
          {
            id: 'tc1', name: 'run_command',
            input: { command: 'mcporter call Cooper.readContent > /tmp/cooper_doc.txt && wc -l /tmp/cooper_doc.txt' },
            result: 'stdout:\n1 /tmp/cooper_doc.txt\n\nexit code: 0',
          },
          {
            id: 'tc2', name: 'run_command',
            input: { command: "grep -o '客观成交率' /tmp/cooper_doc.txt | wc -l" },
            result: 'stdout:\n26\n\nexit code: 0',
          },
          {
            id: 'tc3', name: 'run_command',
            input: { command: "python3 -c \"with open('/tmp/cooper_doc.txt') as f: print(f.read()[:100])\"" },
            result: 'stdout:\nsome content\n\nexit code: 0',
          },
        ];
        expect(extractFileOutputs(toolCalls)).toHaveLength(0);
      });

      it('still emits /tmp/ path announced via stdout keyword (not from command string)', () => {
        // /tmp/ filter is in extractPathsFromCommand only. A process that
        // explicitly announces "File saved to /tmp/result.pdf" in stdout is a
        // legitimate deliverable and must not be suppressed.
        const toolCalls: ToolCall[] = [{
          id: 'tc1', name: 'run_command',
          input: { command: 'python script.py' },
          result: 'stdout:\nFile saved to /tmp/result.pdf\n\nexit code: 0',
        }];
        const files = extractFileOutputs(toolCalls);
        expect(files).toHaveLength(1);
        expect(files[0].path).toBe('/tmp/result.pdf');
      });

      it('still emits non-/tmp/ path from command string', () => {
        // Sanity check: the filter must not suppress legitimate workspace paths.
        const toolCalls: ToolCall[] = [{
          id: 'tc1', name: 'run_command',
          input: { command: 'echo "# Notes" >> /Users/me/workspace/notes.md' },
          result: 'stdout:\n\nexit code: 0',
        }];
        const files = extractFileOutputs(toolCalls);
        expect(files).toHaveLength(1);
        expect(files[0].path).toBe('/Users/me/workspace/notes.md');
      });
    });

    // ── mv/cp destination-wins fast-path ──
    // Regression tests for the case where `mv source dest` both paths share a
    // basename. The generic extractor took the first match (source) and let
    // basename dedup drop the destination, binding file cards to a path that
    // had just been deleted. parseCopyMoveCommand now surfaces the destination.
    describe('mv/cp destination extraction', () => {
      it('mv file to file: returns destination only', () => {
        const toolCalls: ToolCall[] = [{
          id: 'tc1', name: 'run_command',
          input: { command: 'mv /Users/me/Downloads/report.xlsx /Users/me/Desktop/Test/report.xlsx' },
          result: 'stdout:\n\nexit code: 0',
        }];
        const files = extractFileOutputs(toolCalls);
        expect(files).toHaveLength(1);
        expect(files[0].path).toBe('/Users/me/Desktop/Test/report.xlsx');
        expect(files[0].operation).toBe('create');
      });

      it('mv file to directory (trailing slash): joins basename', () => {
        const toolCalls: ToolCall[] = [{
          id: 'tc1', name: 'run_command',
          input: { command: 'mv ~/Downloads/a.xlsx /Users/me/Desktop/Test/' },
          result: 'stdout:\n\nexit code: 0',
        }];
        const files = extractFileOutputs(toolCalls);
        expect(files).toHaveLength(1);
        expect(files[0].path).toBe('/Users/me/Desktop/Test/a.xlsx');
      });

      it('prior tool recorded source path → mv wipes it and replaces with dest', () => {
        const toolCalls: ToolCall[] = [
          {
            id: 'tc1', name: 'run_command',
            input: { command: 'curl -o /tmp/report.pdf https://example.com/r.pdf' },
            result: 'stdout:\n已保存到 /tmp/report.pdf\n\nexit code: 0',
          },
          {
            id: 'tc2', name: 'run_command',
            input: { command: 'mv /tmp/report.pdf /Users/me/Desktop/Test/report.pdf' },
            result: 'stdout:\n\nexit code: 0',
          },
        ];
        const files = extractFileOutputs(toolCalls);
        expect(files).toHaveLength(1);
        expect(files[0].path).toBe('/Users/me/Desktop/Test/report.pdf');
        expect(files[0].operation).toBe('create');
      });

      it('cp file to file: returns destination only', () => {
        const toolCalls: ToolCall[] = [{
          id: 'tc1', name: 'run_command',
          input: { command: 'cp /tmp/old.docx /Users/me/Desktop/new.docx' },
          result: 'stdout:\n\nexit code: 0',
        }];
        const files = extractFileOutputs(toolCalls);
        expect(files).toHaveLength(1);
        expect(files[0].path).toBe('/Users/me/Desktop/new.docx');
      });

      it('mv with -f flag: flag stripped, destination returned', () => {
        const toolCalls: ToolCall[] = [{
          id: 'tc1', name: 'run_command',
          input: { command: 'mv -f /tmp/a.xlsx /Users/me/Desktop/a.xlsx' },
          result: 'stdout:\n\nexit code: 0',
        }];
        const files = extractFileOutputs(toolCalls);
        expect(files).toHaveLength(1);
        expect(files[0].path).toBe('/Users/me/Desktop/a.xlsx');
      });

      it('mv with quoted paths containing spaces', () => {
        const toolCalls: ToolCall[] = [{
          id: 'tc1', name: 'run_command',
          input: { command: 'mv "/tmp/my report.xlsx" "/Users/me/Desktop/Test/my report.xlsx"' },
          result: 'stdout:\n\nexit code: 0',
        }];
        const files = extractFileOutputs(toolCalls);
        expect(files).toHaveLength(1);
        expect(files[0].path).toBe('/Users/me/Desktop/Test/my report.xlsx');
      });

      it('complex command with pipe: both paths in /tmp → no deliverable', () => {
        // With a pipe the mv parser bails (contains |). The generic extractor
        // then runs on the whole command string. Both /tmp/a.xlsx and
        // /tmp/b.xlsx are temp paths, so isTempPath filters them out in
        // deliverables mode. Result: no file card — which is correct, since
        // mv-ing between /tmp locations doesn't produce a user-facing output.
        const toolCalls: ToolCall[] = [{
          id: 'tc1', name: 'run_command',
          input: { command: 'mv /tmp/a.xlsx /tmp/b.xlsx | tee log.txt' },
          result: 'stdout:\n\nexit code: 0',
        }];
        const files = extractFileOutputs(toolCalls);
        expect(files).toHaveLength(0);
      });

      // Regression: Cooper skill redirects MCP output to /tmp/cooper_doc.txt as
      // an intermediate buffer. parseCopyMoveCommand bails on `>` and `&&`, so
      // the generic regex fallback ran and produced a spurious file card for
      // /tmp/cooper_doc.txt. The compound-command split + isTempPath guard fix
      // this: the wc segment is read-only (skipped), and the redirect target
      // /tmp/cooper_doc.txt is a temp path (filtered in deliverables mode).
      it('Cooper skill: mcporter + wc compound command emits no file card', () => {
        const toolCalls: ToolCall[] = [{
          id: 'tc1', name: 'run_command',
          input: { command: 'mcporter call "Cooper.readContent(doc_id=\'abc\')" --output text 2>&1 > /tmp/cooper_doc.txt && wc -l /tmp/cooper_doc.txt' },
          result: 'stdout:\n1 /tmp/cooper_doc.txt\n\nexit code: 0',
        }];
        const files = extractFileOutputs(toolCalls);
        // /tmp/cooper_doc.txt is an intermediate buffer, not a deliverable
        expect(files).toHaveLength(0);
      });

      // Regression: if user explicitly asks to write to /tmp AND announces via
      // stdout keyword, it should still show up (6a path is unaffected by
      // isTempPath which only guards 6b-ii).
      it('explicit /tmp output announced in stdout still shows (6a path unaffected)', () => {
        const toolCalls: ToolCall[] = [{
          id: 'tc1', name: 'run_command',
          input: { command: 'python generate.py' },
          result: 'stdout:\n已保存到 /tmp/result.pdf\n\nexit code: 0',
        }];
        const files = extractFileOutputs(toolCalls);
        expect(files).toHaveLength(1);
        expect(files[0].path).toBe('/tmp/result.pdf');
      });

      it('chained cd && mv: falls back to generic extractor', () => {
        // && is a shell operator, parser bails.
        const toolCalls: ToolCall[] = [{
          id: 'tc1', name: 'run_command',
          input: { command: 'cd /tmp && mv a.xlsx /Users/me/Desktop/a.xlsx' },
          result: 'stdout:\n\nexit code: 0',
        }];
        const files = extractFileOutputs(toolCalls);
        // Generic extractor will find /Users/me/Desktop/a.xlsx (the only
        // absolute path in the command). Not the case we're optimizing for,
        // but shouldn't regress.
        expect(files.length).toBeGreaterThanOrEqual(1);
      });

      it('sandbox-blocked mv: still short-circuits (existing behavior)', () => {
        // Regression guard for the pre-existing sandbox-blocked path — the
        // isCommandFailed check runs before our fast-path, so this must
        // still return zero files.
        const toolCalls: ToolCall[] = [{
          id: 'tc1', name: 'run_command',
          input: { command: 'mv /tmp/a.xlsx /Users/me/Desktop/a.xlsx' },
          result: 'stderr:\n[sandbox-blocked]\n\nexit code: 1',
        }];
        const files = extractFileOutputs(toolCalls);
        expect(files).toHaveLength(0);
      });

      it('mv with non-document extension destination: not emitted', () => {
        // Our destination filter only emits DOCUMENT_EXTENSIONS. .log isn't
        // one, so nothing is returned — same as generic extractor behavior.
        const toolCalls: ToolCall[] = [{
          id: 'tc1', name: 'run_command',
          input: { command: 'mv /tmp/a.log /tmp/b.log' },
          result: 'stdout:\n\nexit code: 0',
        }];
        const files = extractFileOutputs(toolCalls);
        expect(files).toHaveLength(0);
      });

      // Regression: addFile's leading-markdown strip used to eat the `~` of a
      // home-relative destination, turning ~/Desktop/leak.txt into
      // /Desktop/leak.txt — a path that doesn't exist, so the file card resolved
      // to "文件已不可访问" even though the copy succeeded. The `~` must survive.
      describe('home-relative (~) destination preserved', () => {
        it('cp to ~/Desktop/<file>: keeps leading ~', () => {
          const toolCalls: ToolCall[] = [{
            id: 'tc1', name: 'run_command',
            input: { command: 'cp hello.txt ~/Desktop/leak.txt' },
            result: 'stdout:\n\nexit code: 0',
          }];
          const files = extractFileOutputs(toolCalls);
          expect(files).toHaveLength(1);
          expect(files[0].path).toBe('~/Desktop/leak.txt');
        });

        it('cp to ~/<dir>/ (trailing slash): joins basename, keeps ~', () => {
          const toolCalls: ToolCall[] = [{
            id: 'tc1', name: 'run_command',
            input: { command: 'cp hello.txt ~/Documents/abu-out222/' },
            result: 'stdout:\n\nexit code: 0',
          }];
          const files = extractFileOutputs(toolCalls);
          expect(files).toHaveLength(1);
          expect(files[0].path).toBe('~/Documents/abu-out222/hello.txt');
        });
      });

      // Change: cp/mv destinations outside the workspace boundary are dropped
      // from chat cards (a copy elsewhere is a duplicate, not a fresh artifact).
      // Only active when dropCopiesOutside is passed (chat-card renderer only).
      describe('dropCopiesOutside boundary filter', () => {
        const home = '/Users/me';
        const dirs = ['/Users/me/workspace', '/tmp'];

        it('outside workspace: card suppressed', () => {
          const toolCalls: ToolCall[] = [{
            id: 'tc1', name: 'run_command',
            input: { command: 'cp report.docx ~/Desktop/report.docx' },
            result: 'stdout:\n\nexit code: 0',
          }];
          const files = extractFileOutputs(toolCalls, { mode: 'deliverables', dropCopiesOutside: { dirs, home } });
          expect(files).toHaveLength(0);
        });

        it('inside workspace: card kept', () => {
          const toolCalls: ToolCall[] = [{
            id: 'tc1', name: 'run_command',
            input: { command: 'cp report.docx /Users/me/workspace/out/report.docx' },
            result: 'stdout:\n\nexit code: 0',
          }];
          const files = extractFileOutputs(toolCalls, { mode: 'deliverables', dropCopiesOutside: { dirs, home } });
          expect(files).toHaveLength(1);
          expect(files[0].path).toBe('/Users/me/workspace/out/report.docx');
        });

        it('relative destination treated as inside (conservative): card kept', () => {
          const toolCalls: ToolCall[] = [{
            id: 'tc1', name: 'run_command',
            input: { command: 'cp report.docx out/report.docx' },
            result: 'stdout:\n\nexit code: 0',
          }];
          const files = extractFileOutputs(toolCalls, { mode: 'deliverables', dropCopiesOutside: { dirs, home } });
          expect(files).toHaveLength(1);
          expect(files[0].path).toBe('out/report.docx');
        });

        it('without the option: outside copies still produce a card (audit/snapshot path)', () => {
          const toolCalls: ToolCall[] = [{
            id: 'tc1', name: 'run_command',
            input: { command: 'cp report.docx ~/Desktop/report.docx' },
            result: 'stdout:\n\nexit code: 0',
          }];
          const files = extractFileOutputs(toolCalls, { mode: 'deliverables' });
          expect(files).toHaveLength(1);
          expect(files[0].path).toBe('~/Desktop/report.docx');
        });
      });
    });

    // ──────────────────────────────────────────────────────────────────
    // Mode-aware extraction (deliverables vs file-ops)
    // ──────────────────────────────────────────────────────────────────
    //
    // Two distinct semantics, previously conflated:
    //
    //   deliverables — "what did the AI deliver this turn?"
    //     Used by: MessageGroup chat cards, outputSnapshots backup.
    //     Strict whitelist (DOCUMENT_EXTENSIONS), filters out scripts that
    //     were later executed (intermediate artifacts).
    //
    //   file-ops    — "what files did this conversation touch?"
    //     Used by: RightPanel/FilesSection audit view.
    //     No extension whitelist, only filters obvious noise (.log/.tmp/.bak/
    //     .cache/.lock/.pid). Includes reads. Doesn't filter executed scripts
    //     (the user wants to see what scripts the AI ran).
    //
    // Default mode is 'deliverables' for backwards compatibility — all existing
    // callers continue to work without changes.
    describe('mode-aware extraction', () => {
      describe("default mode = 'deliverables'", () => {
        it('includes .md/.txt/.json/.yaml in DOCUMENT_EXTENSIONS (regression: todo skill .md)', () => {
          // Reproduces the user-reported bug: todo skill writes
          // /workspace/todo/2026-04/2026-04-29.md via run_command, but the file
          // card never showed up because .md wasn't in DOCUMENT_EXTENSIONS.
          const toolCalls: ToolCall[] = [{
            id: 'tc1', name: 'run_command',
            input: { command: 'echo "## 09:23\n- 完成评审" >> /Users/me/todo/2026-04/2026-04-29.md' },
            result: 'stdout:\n\nstderr:\n\nexit code: 0',
          }];
          const files = extractFileOutputs(toolCalls);
          expect(files).toHaveLength(1);
          expect(files[0].path).toBe('/Users/me/todo/2026-04/2026-04-29.md');
        });

        it('extracts cross-turn same-basename writes (regression: basename dedup)', () => {
          // Same basename (todo.md) but different paths — treated as separate
          // files. Old behavior aggressively deduped on basename, hiding all
          // but the first.
          const toolCalls: ToolCall[] = [
            { id: '1', name: 'write_file', input: { path: '/a/todo.md' }, result: 'ok' },
            { id: '2', name: 'write_file', input: { path: '/b/todo.md' }, result: 'ok' },
            { id: '3', name: 'write_file', input: { path: '/c/todo.md' }, result: 'ok' },
          ];
          const files = extractFileOutputs(toolCalls);
          expect(files).toHaveLength(3);
          expect(files.map(f => f.path).sort()).toEqual(['/a/todo.md', '/b/todo.md', '/c/todo.md']);
        });

        it('still filters intermediate scripts that were later executed', () => {
          // deliverables mode preserves SCRIPT_EXTENSIONS filtering.
          const toolCalls: ToolCall[] = [
            { id: '1', name: 'write_file', input: { path: '/tmp/build.py' }, result: 'ok' },
            { id: '2', name: 'run_command', input: { command: 'python3 /tmp/build.py' }, result: 'stdout:\n\nstderr:\n\nexit code: 0' },
          ];
          const files = extractFileOutputs(toolCalls);
          // build.py was executed → filtered out (intermediate artifact)
          expect(files.find(f => f.path.endsWith('build.py'))).toBeUndefined();
        });
      });

      describe("mode = 'file-ops'", () => {
        it('includes read operations by default', () => {
          const toolCalls: ToolCall[] = [{
            id: '1', name: 'read_file', input: { path: '/data/config.yaml' }, result: '...',
          }];
          const files = extractFileOutputs(toolCalls, { mode: 'file-ops' });
          expect(files).toHaveLength(1);
          expect(files[0].operation).toBe('read');
        });

        it('does NOT filter executed scripts (audit transparency)', () => {
          // file-ops mode wants to show the user "the AI ran build.py" —
          // unlike deliverables mode which treats build.py as intermediate.
          const toolCalls: ToolCall[] = [
            { id: '1', name: 'write_file', input: { path: '/tmp/build.py' }, result: 'ok' },
            { id: '2', name: 'run_command', input: { command: 'python3 /tmp/build.py' }, result: 'stdout:\n\nstderr:\n\nexit code: 0' },
          ];
          const files = extractFileOutputs(toolCalls, { mode: 'file-ops' });
          expect(files.find(f => f.path === '/tmp/build.py')).toBeDefined();
        });

        it('does NOT enforce DOCUMENT_EXTENSIONS whitelist (any extension OK)', () => {
          // run_command writing .py / .sh / .conf → all included in file-ops
          // because the user wants to see what files the AI touched.
          const toolCalls: ToolCall[] = [
            { id: '1', name: 'write_file', input: { path: '/etc/abu/app.conf' }, result: 'ok' },
            { id: '2', name: 'write_file', input: { path: '/scripts/deploy.sh' }, result: 'ok' },
          ];
          const files = extractFileOutputs(toolCalls, { mode: 'file-ops' });
          expect(files).toHaveLength(2);
        });

        it('filters obvious noise extensions (.log/.tmp/.bak/.cache/.lock/.pid)', () => {
          const toolCalls: ToolCall[] = [
            { id: '1', name: 'write_file', input: { path: '/tmp/debug.log' }, result: 'ok' },
            { id: '2', name: 'write_file', input: { path: '/tmp/cache.tmp' }, result: 'ok' },
            { id: '3', name: 'write_file', input: { path: '/tmp/backup.bak' }, result: 'ok' },
            { id: '4', name: 'write_file', input: { path: '/run/abu.pid' }, result: 'ok' },
            { id: '5', name: 'write_file', input: { path: '/var/abu/state.cache' }, result: 'ok' },
            { id: '6', name: 'write_file', input: { path: '/data/report.csv' }, result: 'ok' },
          ];
          const files = extractFileOutputs(toolCalls, { mode: 'file-ops' });
          // Only the .csv survives; all noise extensions are filtered
          expect(files).toHaveLength(1);
          expect(files[0].path).toBe('/data/report.csv');
        });
      });
    });
  });

  // ── extractStdout ──
  describe('extractStdout', () => {
    it('extracts stdout from full result', () => {
      const result = 'stdout:\nHello World\n\nstderr:\nwarning\n\nexit code: 0';
      expect(extractStdout(result)).toBe('Hello World');
    });

    it('extracts stdout when no stderr', () => {
      const result = 'stdout:\nOutput here\n\nexit code: 0';
      expect(extractStdout(result)).toBe('Output here');
    });

    it('returns empty for no stdout section', () => {
      const result = 'stderr:\nerror msg\n\nexit code: 1';
      expect(extractStdout(result)).toBe('');
    });

    it('returns empty for exit-code-only result', () => {
      const result = 'exit code: 0';
      expect(extractStdout(result)).toBe('');
    });

    it('handles multiline stdout', () => {
      const result = 'stdout:\nLine 1\nLine 2\nLine 3\n\nexit code: 0';
      expect(extractStdout(result)).toBe('Line 1\nLine 2\nLine 3');
    });

    it('returns empty stdout when stdout section is empty', () => {
      const result = 'stdout:\n\n\nstderr:\nerror\n\nexit code: 1';
      expect(extractStdout(result)).toBe('');
    });
  });

  // ── extractFilePathsFromText ──
  describe('extractFilePathsFromText', () => {
    it('extracts Chinese pattern: 已保存到', () => {
      const text = '转换完成，已保存到 /Users/test/output.docx';
      expect(extractFilePathsFromText(text)).toEqual(['/Users/test/output.docx']);
    });

    it('extracts Chinese pattern: 输出到', () => {
      const text = '文件输出到 /tmp/result.pdf';
      expect(extractFilePathsFromText(text)).toEqual(['/tmp/result.pdf']);
    });

    it('extracts English pattern: saved to', () => {
      const text = 'File saved to /tmp/output.csv';
      expect(extractFilePathsFromText(text)).toEqual(['/tmp/output.csv']);
    });

    it('extracts English pattern: written to', () => {
      const text = 'Data written to /home/user/data.json';
      expect(extractFilePathsFromText(text)).toEqual(['/home/user/data.json']);
    });

    it('extracts label pattern: Output file:', () => {
      const text = 'Output file: /tmp/report.xlsx';
      expect(extractFilePathsFromText(text)).toEqual(['/tmp/report.xlsx']);
    });

    it('extracts label pattern: 输出文件:', () => {
      const text = '输出文件: /tmp/report.xlsx';
      expect(extractFilePathsFromText(text)).toEqual(['/tmp/report.xlsx']);
    });

    it('extracts arrow pattern: ->', () => {
      const text = '-> /tmp/converted.docx';
      expect(extractFilePathsFromText(text)).toEqual(['/tmp/converted.docx']);
    });

    it('extracts arrow pattern: →', () => {
      const text = '→ /tmp/converted.docx';
      expect(extractFilePathsFromText(text)).toEqual(['/tmp/converted.docx']);
    });

    it('deduplicates same path', () => {
      const text = '已保存到 /tmp/out.docx\nsaved to /tmp/out.docx';
      expect(extractFilePathsFromText(text)).toEqual(['/tmp/out.docx']);
    });

    it('returns empty for no file paths', () => {
      expect(extractFilePathsFromText('Hello world')).toEqual([]);
    });

    it('extracts Chinese pattern: 已生成 (backtick wrapped)', () => {
      const text = '搞定了，已生成 `sample_data.csv`，包含10行假数据';
      expect(extractFilePathsFromText(text)).toEqual(['sample_data.csv']);
    });

    it('extracts Chinese pattern: 生成了 (with absolute path)', () => {
      const text = '生成了 /Users/me/Desktop/report.xlsx';
      expect(extractFilePathsFromText(text)).toEqual(['/Users/me/Desktop/report.xlsx']);
    });

    it('extracts Chinese pattern: 已保存 (with backtick path that has spaces)', () => {
      const text = '已保存 `~/Library/Application Support/com.abu.app/conversations/foo/outputs/file.pptx`';
      expect(extractFilePathsFromText(text)).toEqual([
        '~/Library/Application Support/com.abu.app/conversations/foo/outputs/file.pptx',
      ]);
    });

    it('rejects paths without file extension', () => {
      const text = '已保存到 /tmp/mydir';
      expect(extractFilePathsFromText(text)).toEqual([]);
    });

    it('strips trailing punctuation', () => {
      const text = '已保存到 /tmp/out.docx。';
      expect(extractFilePathsFromText(text)).toEqual(['/tmp/out.docx']);
    });

    it('strips trailing quotes', () => {
      const text = "saved to '/tmp/out.docx'";
      expect(extractFilePathsFromText(text)).toEqual(['/tmp/out.docx']);
    });

    it('extracts Windows paths', () => {
      const text = 'saved to C:\\Users\\test\\output.docx';
      expect(extractFilePathsFromText(text)).toEqual(['C:\\Users\\test\\output.docx']);
    });

    it('extracts multiple paths from text', () => {
      const text = '已保存到 /tmp/a.docx\n输出到 /tmp/b.pdf';
      const paths = extractFilePathsFromText(text);
      expect(paths).toHaveLength(2);
      expect(paths).toContain('/tmp/a.docx');
      expect(paths).toContain('/tmp/b.pdf');
    });
  });

  // ── parsePlanSteps ──
  describe('parsePlanSteps', () => {
    it('extracts content from declarative step objects', () => {
      const call: ToolCall = {
        id: 'tc1',
        name: 'report_plan',
        input: {
          steps: [
            { content: 'Scan', status: 'pending' },
            { content: 'Build' },
          ],
        },
      };
      expect(parsePlanSteps(call)).toEqual(['Scan', 'Build']);
    });

    it('stays backward compatible with legacy plain string steps', () => {
      const call: ToolCall = {
        id: 'tc1',
        name: 'report_plan',
        input: { steps: ['a', 'b'] },
      };
      expect(parsePlanSteps(call)).toEqual(['a', 'b']);
    });
  });
});
