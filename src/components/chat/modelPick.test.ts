import { describe, expect, it, vi } from 'vitest';
import { applyModelPick } from './modelPick';

function deps() {
  return { selectModel: vi.fn(), touchRecentModel: vi.fn(), setConversationModel: vi.fn() };
}

describe('applyModelPick', () => {
  it('inside a conversation: pins only that conversation and bumps recents, leaves the global default alone', () => {
    const d = deps();
    applyModelPick({ activeConversationId: 'c1', providerId: 'p', modelId: 'm' }, d);
    expect(d.setConversationModel).toHaveBeenCalledWith('c1', { providerId: 'p', modelId: 'm' });
    expect(d.touchRecentModel).toHaveBeenCalledWith('p', 'm');
    expect(d.selectModel).not.toHaveBeenCalled();
  });

  it('on the new-task page (no conversation): updates the global default only', () => {
    const d = deps();
    applyModelPick({ activeConversationId: null, providerId: 'p', modelId: 'm' }, d);
    expect(d.selectModel).toHaveBeenCalledWith('p', 'm');
    expect(d.setConversationModel).not.toHaveBeenCalled();
    expect(d.touchRecentModel).not.toHaveBeenCalled();
  });

  it('treats undefined conversation id like the new-task page', () => {
    const d = deps();
    applyModelPick({ activeConversationId: undefined, providerId: 'p', modelId: 'm' }, d);
    expect(d.selectModel).toHaveBeenCalledOnce();
  });
});
