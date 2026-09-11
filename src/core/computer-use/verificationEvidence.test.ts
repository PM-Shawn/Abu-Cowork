import { describe, expect, it } from 'vitest';
import { deriveVerificationEvidence } from './verificationEvidence';

describe('deriveVerificationEvidence', () => {
  it('separates an observed change from an unrequested expectation', () => {
    expect(deriveVerificationEvidence({
      observationAvailable: true,
      targetMatches: true,
      changed: true,
      expectationRequested: false,
      expectationMatched: null,
    })).toEqual({
      observation: 'changed',
      expectation: 'not-requested',
    });
  });

  it('reports an explicit mismatch independently from an observed change', () => {
    expect(deriveVerificationEvidence({
      observationAvailable: true,
      targetMatches: true,
      changed: true,
      expectationRequested: true,
      expectationMatched: false,
    })).toEqual({
      observation: 'changed',
      expectation: 'not-satisfied',
    });
  });

  it('reports a reliably matched explicit expectation as satisfied', () => {
    expect(deriveVerificationEvidence({
      observationAvailable: true,
      targetMatches: true,
      changed: false,
      expectationRequested: true,
      expectationMatched: true,
    })).toEqual({
      observation: 'unchanged',
      expectation: 'satisfied',
    });
  });

  it.each([
    {
      name: 'failed observation',
      input: {
        observationAvailable: false,
        targetMatches: true,
        changed: true,
        expectationRequested: true,
        expectationMatched: true,
      },
      wantObservation: 'unavailable' as const,
    },
    {
      name: 'changed target',
      input: {
        observationAvailable: true,
        targetMatches: false,
        changed: true,
        expectationRequested: true,
        expectationMatched: true,
      },
      wantObservation: 'unavailable' as const,
    },
    {
      name: 'missing reliable assertion evidence',
      input: {
        observationAvailable: true,
        targetMatches: true,
        changed: false,
        expectationRequested: true,
        expectationMatched: null,
      },
      wantObservation: 'unchanged' as const,
    },
  ])('marks an explicit expectation unverifiable for $name', ({ input, wantObservation }) => {
    expect(deriveVerificationEvidence(input)).toEqual({
      observation: wantObservation,
      expectation: 'unverifiable',
    });
  });

  it('keeps an unrequested expectation distinct even when observation is unavailable', () => {
    expect(deriveVerificationEvidence({
      observationAvailable: false,
      targetMatches: false,
      changed: false,
      expectationRequested: false,
      expectationMatched: null,
    })).toEqual({
      observation: 'unavailable',
      expectation: 'not-requested',
    });
  });
});
