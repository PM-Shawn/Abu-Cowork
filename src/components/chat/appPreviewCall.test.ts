import { describe, expect, it } from 'vitest';
import type { Message, ToolCall } from '@/types';
import { TOOL_NAMES } from '@/core/tools/toolNames';
import { latestAppPreviewCallId } from './appPreviewCall';

const call = (id: string, extra: Partial<ToolCall> = {}): ToolCall => ({ id, name: TOOL_NAMES.APP_PREPARE, input: {}, result: JSON.stringify({ status: 'ready' }), ...extra });
const message = (id: string, toolCalls: ToolCall[]): Message => ({ id, role: 'assistant', content: '', timestamp: 0, toolCalls } as Message);

describe('latestAppPreviewCallId', () => {
  it('follows the latest app_prepare of the conversation', () => {
    expect(latestAppPreviewCallId([
      message('m1', [call('a')]),
      message('m2', [call('b'), { id: 'w', name: TOOL_NAMES.WRITE_FILE, input: {}, result: 'ok' }]),
    ])).toBe('b');
  });

  it('shows nothing while the latest call is running, failed or found an empty draft', () => {
    expect(latestAppPreviewCallId([message('m1', [call('a'), call('b', { result: undefined, isExecuting: true })])])).toBeUndefined();
    expect(latestAppPreviewCallId([message('m1', [call('a')]), message('m2', [call('b', { result: 'bad', isError: true })])])).toBeUndefined();
    expect(latestAppPreviewCallId([message('m1', [call('a', { result: JSON.stringify({ status: 'empty' }) })])])).toBeUndefined();
  });

  it('shows nothing in a conversation without app_prepare', () => {
    expect(latestAppPreviewCallId(undefined)).toBeUndefined();
    expect(latestAppPreviewCallId([message('m1', [])])).toBeUndefined();
  });
});
