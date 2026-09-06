import { describe, it, expect, beforeEach } from 'vitest';
import {
  admitDispatches,
  clearRunBounds,
  getRunBounds,
  recordDispatchOutcome,
  TEAM_MAX_CONSECUTIVE_FAILURES_PER_MEMBER,
  TEAM_MAX_DISPATCHES_PER_RUN,
} from './teamRunBounds';

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
