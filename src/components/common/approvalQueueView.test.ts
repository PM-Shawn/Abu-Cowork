import { describe, expect, it } from 'vitest';
import { pickVisibleApproval } from './approvalQueueView';

const mine = { conversationId: 'conversation-a' };
const other = { conversationId: 'conversation-b' };

describe('pickVisibleApproval', () => {
  it('shows nothing when nothing is pending', () => {
    expect(pickVisibleApproval({ command: null, file: null, workspace: null }, 'conversation-a')).toBeNull();
  });

  it('shows nothing for approvals of another conversation', () => {
    expect(pickVisibleApproval({ command: other, file: other, workspace: other }, 'conversation-a')).toBeNull();
  });

  it('shows nothing when no conversation is in view', () => {
    expect(pickVisibleApproval({ command: mine, file: mine, workspace: mine }, null)).toBeNull();
  });

  it.each([
    ['command', { command: mine, file: null, workspace: null }],
    ['file', { command: null, file: mine, workspace: null }],
    ['workspace', { command: null, file: null, workspace: mine }],
  ] as const)('shows the only pending approval: %s', (kind, pending) => {
    expect(pickVisibleApproval(pending, 'conversation-a')).toEqual({ kind });
  });

  it('shows the command approval before the file grant', () => {
    expect(pickVisibleApproval({ command: mine, file: mine, workspace: null }, 'conversation-a')).toEqual({ kind: 'command' });
  });

  it('shows the workspace request before the file grant', () => {
    expect(pickVisibleApproval({ command: null, file: mine, workspace: mine }, 'conversation-a')).toEqual({ kind: 'workspace' });
  });

  it('shows the workspace request before the command approval', () => {
    expect(pickVisibleApproval({ command: mine, file: null, workspace: mine }, 'conversation-a')).toEqual({ kind: 'workspace' });
  });

  it('shows the workspace request first when all three are pending', () => {
    expect(pickVisibleApproval({ command: mine, file: mine, workspace: mine }, 'conversation-a')).toEqual({ kind: 'workspace' });
  });

  it('passes over an earlier kind that belongs to another conversation', () => {
    expect(pickVisibleApproval({ command: mine, file: mine, workspace: other }, 'conversation-a')).toEqual({ kind: 'command' });
    expect(pickVisibleApproval({ command: other, file: mine, workspace: other }, 'conversation-a')).toEqual({ kind: 'file' });
  });
});
