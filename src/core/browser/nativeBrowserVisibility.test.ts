import { describe, expect, it } from 'vitest';
import { hasVisibleBlockingApproval } from './nativeBrowserVisibility';

describe('hasVisibleBlockingApproval', () => {
  it('detects approvals rendered for the active conversation', () => {
    expect(hasVisibleBlockingApproval('active', [
      null,
      { conversationId: 'active' },
      { conversationId: 'background' },
    ])).toBe(true);
  });

  it('does not hide the browser for background approvals', () => {
    expect(hasVisibleBlockingApproval('active', [
      { conversationId: 'background' },
    ])).toBe(false);
  });

  it('requires an active conversation', () => {
    expect(hasVisibleBlockingApproval(null, [
      { conversationId: 'active' },
    ])).toBe(false);
  });

  it('always hides for a global task setup dialog', () => {
    expect(hasVisibleBlockingApproval(null, [], true)).toBe(true);
    expect(hasVisibleBlockingApproval('active', [
      { conversationId: 'background' },
    ], true)).toBe(true);
  });
});
