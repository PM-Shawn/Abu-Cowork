import { describe, expect, it } from 'vitest';
import manifest from './datasets/computer-use-golden-journeys.json';

describe('Computer Use Golden Journey manifest', () => {
  it('defines five candidate journeys without presenting them as frozen support', () => {
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.suiteId).toBe('computer-use-golden-journeys');
    expect(manifest.productStatus).toBe('candidate-apps-awaiting-freeze');
    expect(manifest.requiredRepeatRuns).toBeGreaterThanOrEqual(3);
    expect(manifest.journeys).toHaveLength(5);
    expect(new Set(manifest.journeys.map((journey) => journey.id)).size).toBe(5);
  });

  it.each(manifest.journeys)('$id has a bounded target and measurable success criteria', (journey) => {
    expect(journey.platform).toBe('macos');
    expect(journey.candidateApp.name).not.toBe('');
    expect(journey.candidateApp.bundleId).toMatch(/^[a-z0-9.-]+$/i);
    expect(['full', 'structured']).toContain(journey.modelTier);
    expect(journey.steps.length).toBeGreaterThanOrEqual(3);
    expect(journey.success.length).toBeGreaterThanOrEqual(3);
  });

  it.each(manifest.journeys)('$id requires Observe before every declared write', (journey) => {
    let hasFreshObservation = false;
    for (const step of journey.steps) {
      if (step.kind === 'observe') hasFreshObservation = true;
      if (step.kind !== 'write') continue;
      expect(hasFreshObservation).toBe(true);
      expect(step.requiresStateId).toBe(true);
      expect(step.consequence).toBeDefined();
      expect(step.expectedEffect).toBeDefined();
      hasFreshObservation = false;
    }
  });

  it('keeps repeat evidence empty until real Electron runs are performed', () => {
    expect(manifest.runRecords).toEqual([]);
  });
});
