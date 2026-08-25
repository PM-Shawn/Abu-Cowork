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
});
