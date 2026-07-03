import { describe, it, expect } from 'vitest';
import { LABS_EXPERIMENTS, getLabsExperiment } from './registry';

describe('labs registry', () => {
  it('has unique ids (persisted keys must never collide)', () => {
    const ids = LABS_EXPERIMENTS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every experiment has a valid YYYY-MM-DD expiresAfter (lifecycle guard)', () => {
    for (const exp of LABS_EXPERIMENTS) {
      expect(exp.expiresAfter).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(exp.expiresAfter))).toBe(false);
    }
  });

  it('every experiment resolves a non-empty i18n title and description', () => {
    for (const exp of LABS_EXPERIMENTS) {
      expect(exp.title().length).toBeGreaterThan(0);
      expect(exp.description().length).toBeGreaterThan(0);
    }
  });

  it('ships the todos-inbox experiment, default off', () => {
    const exp = getLabsExperiment('todos-inbox');
    expect(exp).toBeDefined();
    expect(exp?.defaultEnabled).toBe(false);
  });

  it('getLabsExperiment returns undefined for unknown ids', () => {
    expect(getLabsExperiment('does-not-exist')).toBeUndefined();
  });
});
