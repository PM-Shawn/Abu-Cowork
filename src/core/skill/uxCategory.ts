/**
 * Source-to-UX-category mapping.
 *
 * The Toolbox shows 3 top-level skill buckets (`SkillUXCategory`):
 *
 *   - **mine** — user/standard/project/project-standard/workspace-auto.
 *     Everything the human or Abu created on behalf of the user. Abu-created
 *     skills get the per-row "自进化" badge via sourceBadge() so the origin
 *     is still visible without a separate category.
 *   - **agent-evolved** — draft only. Pending agent proposals awaiting
 *     user review. Shown via SkillDraftsPanel when draftsCount > 0.
 *   - **builtin** — bundled with the app binary.
 *
 * All Toolbox grouping goes through this function, so the enum-to-
 * bucket mapping stays in one place and it's hard to forget a new
 * source (unknown values log a warning instead of silently landing
 * in `mine`).
 */

import type { SkillSource, SkillUXCategory } from '../../types';

export function sourceToUXCategory(source: SkillSource | undefined): SkillUXCategory | null {
  switch (source) {
    case 'user':
    case 'standard':
    case 'project':
    case 'project-standard':
      return 'mine';
    case 'workspace-auto':
      return 'mine';
    case 'enterprise':
      // Enterprise-installed skills appear in the "mine" bucket for now.
      // A dedicated visual badge will distinguish them (spec 11.d, V1.5+).
      return 'mine';
    case 'draft':
      return 'agent-evolved';
    case 'builtin':
      return 'builtin';
    case undefined:
      // Legacy skills loaded before `source` was populated. Treat as
      // "mine" — matches historical behavior for un-tagged files.
      return 'mine';
    default: {
      // Exhaustiveness guard — if SkillSource grows a new member
      // and this switch isn't updated, TS narrows to `never` and
      // the assignment fails at build time. We also log at runtime
      // so mislabeled on-disk skills don't silently disappear.
      const _exhaustive: never = source;
      void _exhaustive;
      console.warn(
        `[sourceToUXCategory] unknown skill source "${String(source)}" — skill will be hidden`,
      );
      return null;
    }
  }
}
