export type VerificationObservation = 'changed' | 'unchanged' | 'unavailable';
export type VerificationExpectation =
  | 'not-requested'
  | 'satisfied'
  | 'not-satisfied'
  | 'unverifiable';

export interface VerificationEvidence {
  observation: VerificationObservation;
  expectation: VerificationExpectation;
}

export function deriveVerificationEvidence(input: {
  observationAvailable: boolean;
  targetMatches: boolean;
  changed: boolean;
  expectationRequested: boolean;
  expectationMatched: boolean | null;
}): VerificationEvidence {
  const observation = !input.observationAvailable || !input.targetMatches
    ? 'unavailable'
    : input.changed
      ? 'changed'
      : 'unchanged';
  const expectation = !input.expectationRequested
    ? 'not-requested'
    : observation === 'unavailable' || input.expectationMatched === null
      ? 'unverifiable'
      : input.expectationMatched
        ? 'satisfied'
        : 'not-satisfied';
  return {
    observation,
    expectation,
  };
}
