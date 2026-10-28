import { describe, it, expect, vi, beforeEach } from 'vitest';
import { compactionTriggerRatio, retainedTailRatio, anchorPreservationEnabled } from './compressionTuning';
import { COMPACTION_TRIGGER_RATIO, RETAINED_TAIL_RATIO } from './compaction';
import { LABS_STATE_PRESERVING_COMPRESSION, getLabsExperiment } from '../labs/registry';
import { isLabsFlagOn } from '../labs/resolve';

vi.mock('../labs/resolve', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../labs/resolve')>();
  return {
    ...actual,
    isLabsFlagOn: vi.fn(() => false),
  };
});

function setLabsFlag(on: boolean) {
  vi.mocked(isLabsFlagOn).mockReturnValue(on);
}

describe('compression tuning thresholds', () => {
  beforeEach(() => setLabsFlag(false));

  it('defaults to the shipped conservative values when the labs flag is off', () => {
    expect(compactionTriggerRatio()).toBe(COMPACTION_TRIGGER_RATIO);
    expect(retainedTailRatio()).toBe(RETAINED_TAIL_RATIO);
  });

  it('triggers earlier and keeps a larger tail when the labs flag is on', () => {
    setLabsFlag(true);
    expect(compactionTriggerRatio()).toBe(0.75);
    expect(retainedTailRatio()).toBe(0.25);
  });

  it('gates anchor preservation on the labs flag', () => {
    expect(anchorPreservationEnabled()).toBe(false);
    setLabsFlag(true);
    expect(anchorPreservationEnabled()).toBe(true);
  });
});

describe('LABS_STATE_PRESERVING_COMPRESSION registration', () => {
  it('is a registered experiment defaulting to off', () => {
    const exp = getLabsExperiment(LABS_STATE_PRESERVING_COMPRESSION);
    expect(exp).toBeDefined();
    expect(exp?.defaultEnabled).toBe(false);
  });
});
