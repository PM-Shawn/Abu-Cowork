import { describe, expect, it } from 'vitest';
import { replyEntryForTurnOwnerToolCall } from './turnOwnerToolCalls';

describe('replyEntryForTurnOwnerToolCall', () => {
  it('keeps a present_files call with its whole input', () => {
    const input = { files: [{ path: 'report.md', description: 'The report' }] };
    expect(replyEntryForTurnOwnerToolCall({
      id: 'call-1', toolName: 'present_files', input, result: 'Presented /ws/report.md', error: false,
    })).toEqual({
      id: 'call-1', name: 'present_files', input, result: 'Presented /ws/report.md', hidden: true, fromSubagent: true,
    });
  });

  it.each(['generate_image', 'process_image'])('keeps a %s call with its whole input', (toolName) => {
    const input = { prompt: 'a chart', output_path: '/ws/chart.png' };
    expect(replyEntryForTurnOwnerToolCall({
      id: 'call-1', toolName, input, result: 'Image saved to: /ws/chart.png', error: false,
    })).toEqual({
      id: 'call-1', name: toolName, input, result: 'Image saved to: /ws/chart.png', hidden: true, fromSubagent: true,
    });
  });

  it.each([
    ['write_file', { path: '/ws/a.md', content: 'long text' }, { path: '/ws/a.md' }],
    ['edit_file', { path: '/ws/a.md', old_string: 'a', new_string: 'b' }, { path: '/ws/a.md' }],
    ['create_file', { file_path: '/ws/b.md', content: 'long text' }, { file_path: '/ws/b.md' }],
    ['write', { filePath: '/ws/c.md', content: 'long text' }, { filePath: '/ws/c.md' }],
  ])('keeps a %s call with its path alone', (toolName, input, keptInput) => {
    expect(replyEntryForTurnOwnerToolCall({ id: 'call-1', toolName, input, result: 'ok', error: false })).toEqual({
      id: 'call-1', name: toolName, input: keptInput, result: 'ok', hidden: true, fromSubagent: true,
    });
  });

  it('marks a failed call as an error', () => {
    expect(replyEntryForTurnOwnerToolCall({
      id: 'call-1', toolName: 'write_file', input: { path: '/ws/a.md' }, result: 'Error: permission denied', error: true,
    })).toEqual({
      id: 'call-1', name: 'write_file', input: { path: '/ws/a.md' }, result: 'Error: permission denied',
      isError: true, hidden: true, fromSubagent: true,
    });
  });

  it.each(['read_file', 'run_command', 'web_search', 'delegate_to_agent'])('keeps nothing for %s', (toolName) => {
    expect(replyEntryForTurnOwnerToolCall({
      id: 'call-1', toolName, input: { path: '/ws/a.md' }, result: 'ok', error: false,
    })).toBeNull();
  });
});
