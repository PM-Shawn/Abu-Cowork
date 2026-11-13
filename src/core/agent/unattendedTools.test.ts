import { describe, expect, it } from 'vitest';
import { TOOL_NAMES } from '../tools/toolNames';
import { UNATTENDED_BLOCKED_TOOLS, withUnattendedBlockedTools } from './unattendedTools';

describe('withUnattendedBlockedTools', () => {
  it('blocks the tools that wait for a person on every background run', () => {
    expect(withUnattendedBlockedTools(undefined, 'background')).toEqual([...UNATTENDED_BLOCKED_TOOLS]);
    expect(UNATTENDED_BLOCKED_TOOLS).toContain(TOOL_NAMES.ASK_USER_QUESTION);
    expect(UNATTENDED_BLOCKED_TOOLS).toContain(TOOL_NAMES.REQUEST_WORKSPACE);
  });

  it('keeps what the entry point already blocked and adds only what is missing', () => {
    const result = withUnattendedBlockedTools([TOOL_NAMES.REQUEST_WORKSPACE, 'navigate'], 'background');
    expect(result).toEqual([TOOL_NAMES.REQUEST_WORKSPACE, 'navigate', TOOL_NAMES.ASK_USER_QUESTION]);
  });

  it('returns the same list when a background run already lists both', () => {
    const list = [...UNATTENDED_BLOCKED_TOOLS];
    expect(withUnattendedBlockedTools(list, 'background')).toBe(list);
  });

  it('leaves a foreground run alone', () => {
    const list = ['navigate'];
    expect(withUnattendedBlockedTools(list, 'foreground')).toBe(list);
    expect(withUnattendedBlockedTools(undefined, undefined)).toBeUndefined();
  });
});
