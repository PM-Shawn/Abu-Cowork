/**
 * Source-to-UX-category mapping.
 *
 * The Toolbox shows 3 top-level skill buckets (`SkillUXCategory`), split by
 * what the user OWNS versus what they can still get:
 *
 *   - **mine** — what the user has: skills they or Abu wrote
 *     (user/standard/project/project-standard/workspace-auto), skills a plugin
 *     they installed brought in, and skills the organization pushed. Origin
 *     stays visible per row (sourceBadge / the plugin badge); a plugin's skill
 *     is read-only there and leaves with its plugin.
 *   - **agent-evolved** — draft only. Pending agent proposals awaiting
 *     user review. Shown via SkillDraftsPanel when draftsCount > 0.
 *   - **builtin** — the 市场 bucket: what ships with the app and can be
 *     used without installing anything.
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
      // Pushed to this user by their organization: theirs to use, badged.
      return 'mine';
    case 'plugin':
      // Installed by this user through a plugin: theirs, badged with the
      // plugin, read-only, and removed by uninstalling the plugin.
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
