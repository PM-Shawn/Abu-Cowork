import { describe, it, expect, beforeEach } from 'vitest';
import {
  admitDispatches,
  clearRunBounds,
  forgiveMember,
  getRunBounds,
  recordDispatchOutcome,
  resetDispatchCount,
  TEAM_MAX_CONSECUTIVE_FAILURES_PER_MEMBER,
  TEAM_MAX_DISPATCHES_PER_RUN,
} from './teamRunBounds';

describe('task-keyed bounds', () => {
  beforeEach(() => ['task-1', 'task-2', 'task-3'].forEach(clearRunBounds));

  it('keeps counting across runs that share a task key, and keeps the last failure', () => {
    recordDispatchOutcome('task-1', 'A', false, 'first');
    recordDispatchOutcome('task-1', 'A', false, 'second');
    recordDispatchOutcome('task-1', 'A', false, 'third');
    expect(admitDispatches('task-1', ['A'])).toEqual({ ok: false, reason: 'member_blocked', member: 'A', failures: 3 });
    expect(getRunBounds('task-1').lastFailure).toEqual({ A: 'third' });
  });

  it('a success clears the member streak and its last failure', () => {
    recordDispatchOutcome('task-1', 'A', false, 'broke');
    recordDispatchOutcome('task-1', 'A', true);
    expect(getRunBounds('task-1').consecutiveFailures).toEqual({});
    expect(getRunBounds('task-1').lastFailure).toEqual({});
  });

  it('forgiving a member lets it take work again without touching the dispatch count', () => {
    admitDispatches('task-2', ['A']);
    for (let i = 0; i < TEAM_MAX_CONSECUTIVE_FAILURES_PER_MEMBER; i += 1) recordDispatchOutcome('task-2', 'A', false);
    forgiveMember('task-2', 'A');
    expect(admitDispatches('task-2', ['A'])).toEqual({ ok: true });
    expect(getRunBounds('task-2').dispatches).toBe(2);
  });

  it('resetting the dispatch count reopens a task that used its allowance', () => {
    admitDispatches('task-3', Array.from({ length: TEAM_MAX_DISPATCHES_PER_RUN }, () => 'A'));
    expect(admitDispatches('task-3', ['A']).ok).toBe(false);
    resetDispatchCount('task-3');
    expect(admitDispatches('task-3', ['A'])).toEqual({ ok: true });
  });
});

describe('teamRunBounds (hard bounds for one team run)', () => {
  beforeEach(() => clearRunBounds('loop-1'));

  it('counts admitted hand-offs and refuses past the per-run cap without counting the refusal', () => {
    const batch = Array.from({ length: TEAM_MAX_DISPATCHES_PER_RUN - 1 }, () => 'zz取数员');
    expect(admitDispatches('loop-1', batch)).toEqual({ ok: true });
    expect(admitDispatches('loop-1', ['zz取数员', 'zz撰写员'])).toEqual({ ok: false, reason: 'run_cap', max: TEAM_MAX_DISPATCHES_PER_RUN, used: TEAM_MAX_DISPATCHES_PER_RUN - 1 });
    expect(getRunBounds('loop-1').dispatches).toBe(TEAM_MAX_DISPATCHES_PER_RUN - 1);
    expect(admitDispatches('loop-1', ['zz撰写员'])).toEqual({ ok: true });
    expect(admitDispatches('loop-1', ['zz撰写员'])).toMatchObject({ ok: false, reason: 'run_cap' });
  });

  it('blocks a member after consecutive failures; one success resets the streak', () => {
    for (let i = 0; i < TEAM_MAX_CONSECUTIVE_FAILURES_PER_MEMBER; i++) recordDispatchOutcome('loop-1', 'zz取数员', false);
    expect(admitDispatches('loop-1', ['zz撰写员', 'zz取数员'])).toEqual({ ok: false, reason: 'member_blocked', member: 'zz取数员', failures: TEAM_MAX_CONSECUTIVE_FAILURES_PER_MEMBER });
    expect(getRunBounds('loop-1').dispatches).toBe(0);
    expect(admitDispatches('loop-1', ['zz撰写员'])).toEqual({ ok: true });

    recordDispatchOutcome('loop-1', 'zz取数员', true);
    expect(admitDispatches('loop-1', ['zz取数员'])).toEqual({ ok: true });
    recordDispatchOutcome('loop-1', 'zz取数员', false);
    recordDispatchOutcome('loop-1', 'zz取数员', false);
    expect(admitDispatches('loop-1', ['zz取数员'])).toEqual({ ok: true });
  });

  it('keeps runs apart', () => {
    for (let i = 0; i < TEAM_MAX_CONSECUTIVE_FAILURES_PER_MEMBER; i++) recordDispatchOutcome('loop-1', 'zz取数员', false);
    expect(admitDispatches('loop-2', ['zz取数员'])).toEqual({ ok: true });
    clearRunBounds('loop-2');
  });
});

it('never evicts an active run when more than 64 other runs arrive (F7)', () => {
  clearRunBounds('long-running');
  admitDispatches('long-running', Array.from({ length: TEAM_MAX_DISPATCHES_PER_RUN }, () => 'member'));
  for (let i = 0; i < 65; i++) admitDispatches(`other-${i}`, ['member']);
  try {
    expect(admitDispatches('long-running', ['member'])).toMatchObject({ ok: false, reason: 'run_cap' });
  } finally {
    clearRunBounds('long-running');
    for (let i = 0; i < 65; i++) clearRunBounds(`other-${i}`);
  }
});
