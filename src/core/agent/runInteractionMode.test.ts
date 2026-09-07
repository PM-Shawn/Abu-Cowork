import { describe, expect, it } from 'vitest';
import { deriveRunInteractionMode } from './runInteractionMode';

describe('deriveRunInteractionMode', () => {
  it('keeps a marker-free desktop run foreground', () => {
    expect(deriveRunInteractionMode({})).toBe('foreground');
  });

  it.each([
    [{ authorizationScopeId: 'scope-1' }, 'authorization scope'],
    [{ runPermissionCeiling: {} as never }, 'permission ceiling'],
    [{ imContext: {} as never }, 'IM context'],
    [{ triggerId: 'trigger-1' }, 'trigger provenance'],
    [{ scheduledTaskId: 'task-1' }, 'scheduled-task provenance'],
    [{ authorizationScopeId: '' }, 'present but empty scope marker'],
    [{ triggerId: '' }, 'present but empty trigger marker'],
  ])('treats %s (%s) as background provenance', (input) => {
    expect(deriveRunInteractionMode(input)).toBe('background');
  });

  describe('run initiator', () => {
    it('a human-typed send in a scheduled-task conversation is foreground', () => {
      expect(deriveRunInteractionMode({ scheduledTaskId: 'task-1', initiatedBy: 'user' }))
        .toBe('foreground');
    });

    it('a human-typed send in a trigger conversation is foreground', () => {
      expect(deriveRunInteractionMode({ triggerId: 'trigger-1', initiatedBy: 'user' }))
        .toBe('foreground');
    });

    it('the scheduler tick in that same conversation is background', () => {
      expect(deriveRunInteractionMode({ scheduledTaskId: 'task-1', initiatedBy: 'automation' }))
        .toBe('background');
    });

    it('automation is background even with no other marker at all', () => {
      expect(deriveRunInteractionMode({ initiatedBy: 'automation' })).toBe('background');
    });

    it.each([
      [{ authorizationScopeId: 'scope-1', initiatedBy: 'user' as const }, 'authorization scope'],
      [{ runPermissionCeiling: {} as never, initiatedBy: 'user' as const }, 'permission ceiling'],
      [{ imContext: {} as never, initiatedBy: 'user' as const }, 'IM context'],
    ])('a "user" label cannot strip a fenced run of its %s', (input) => {
      // These markers are attached on purpose by the dispatch entry that
      // fenced the run; no initiator label may widen it back to foreground.
      expect(deriveRunInteractionMode(input)).toBe('background');
    });

    it('without an initiator the conversation record still decides (legacy path)', () => {
      expect(deriveRunInteractionMode({ scheduledTaskId: 'task-1' })).toBe('background');
      expect(deriveRunInteractionMode({})).toBe('foreground');
    });
  });
});
