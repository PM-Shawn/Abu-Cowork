import { describe, it, expect } from 'vitest';
import { createMalformedToolCallGuard, MALFORMED_TOOL_CALL_NUDGE } from './malformedToolCallGuard';

describe('createMalformedToolCallGuard', () => {
  it('lets the model rewrite once, then gives up', () => {
    const guard = createMalformedToolCallGuard();
    expect(guard.decide()).toBe('retry');
    expect(guard.decide()).toBe('give-up');
    expect(guard.decide()).toBe('give-up');
  });

  it('starts over after a turn that produced a proper operation', () => {
    const guard = createMalformedToolCallGuard();
    expect(guard.decide()).toBe('retry');
    guard.reset();
    expect(guard.decide()).toBe('retry');
  });

  it('tells the model what went wrong in English', () => {
    expect(MALFORMED_TOOL_CALL_NUDGE).toMatch(/could not be parsed/);
  });
});
