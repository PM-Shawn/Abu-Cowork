import { describe, expect, it } from 'vitest';
import { shouldShowWorkspaceContextBar } from './ChatInput';

describe('shouldShowWorkspaceContextBar', () => {
  it('hides redundant workspace context for an already-bound welcome task', () => {
    expect(shouldShowWorkspaceContextBar('welcome', '/projects/order-dataflow-web')).toBe(false);
  });

  it('shows workspace selection below the composer for a new unbound task', () => {
    expect(shouldShowWorkspaceContextBar('welcome', null)).toBe(true);
  });

  it('never shows the pre-task selector in an active chat composer', () => {
    expect(shouldShowWorkspaceContextBar('chat', null)).toBe(false);
  });
});
