import { getI18n } from '@/i18n';

/**
 * A single Labs (experimental features) entry.
 *
 * Everything registered here is "实验中" — there is deliberately NO maturity
 * state machine (Alpha/Beta/Stable). "Graduation" is a code action, not a
 * stored tier: delete the entry here, drop its `if (labsFlag)` gate, and the
 * feature becomes default behavior. Removing the entry also auto-drops any
 * orphaned `settings.labs[id]` value, since the UI only renders registered ids.
 *
 * See docs/superpowers/specs/2026-07-04-labs-experimental-features-design.md.
 */
export interface LabsExperiment {
  /** Stable key persisted in `settings.labs` — never rename or reuse. */
  id: string;
  /** i18n title, resolved lazily at render (not at module load). */
  title: () => string;
  /** i18n description, resolved lazily at render. */
  description: () => string;
  /** Effective value when the user has never toggled it. Almost always false. */
  defaultEnabled: boolean;
  /**
   * `YYYY-MM-DD` review-by date. Forces a periodic lifecycle review so flags
   * don't rot into Chrome-flags-style zombies — by this date the experiment
   * should have graduated (removed) or been renewed.
   */
  expiresAfter: string;
}

export const LABS_EXPERIMENTS: readonly LabsExperiment[] = [
  {
    // Todos + Inbox are a linked cluster, surfaced as one experiment.
    id: 'todos-inbox',
    title: () => getI18n().settings.labsExpTodosInboxTitle,
    description: () => getI18n().settings.labsExpTodosInboxDesc,
    defaultEnabled: false,
    expiresAfter: '2026-10-01',
  },
];

export function getLabsExperiment(id: string): LabsExperiment | undefined {
  return LABS_EXPERIMENTS.find((e) => e.id === id);
}
