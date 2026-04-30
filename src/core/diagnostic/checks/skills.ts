/**
 * Skills check — discoverSkills returns all known SkillMetadata. We surface
 * total count, source breakdown, and any explicitly disabled-by-user.
 *
 * The discovery API already absorbs per-skill parse errors (see loader.ts),
 * so a partial failure won't crash this check; we just see fewer entries.
 */

import { skillLoader } from '@/core/skill/loader';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { getI18n } from '@/i18n';
import type { CheckResult } from '../types';

export async function runSkillsChecks(): Promise<CheckResult[]> {
  const t = getI18n();
  const start = Date.now();
  const ws = useWorkspaceStore.getState().currentPath;

  try {
    const skills = await skillLoader.discoverSkills(ws);
    const total = skills.length;
    const builtin = skills.filter((s) => s.source === 'builtin').length;
    const user = total - builtin;

    return [{
      id: 'skills:loader',
      category: 'skills',
      name: t.diagnostic.skillsLoader,
      status: total > 0 ? 'passed' : 'warning',
      metric: total > 0
        ? t.diagnostic.skillsCount.replace('{total}', String(total)).replace('{builtin}', String(builtin)).replace('{user}', String(user))
        : t.diagnostic.skillsZero,
      checkedAt: Date.now(),
      durationMs: Date.now() - start,
    }];
  } catch (e) {
    return [{
      id: 'skills:loader',
      category: 'skills',
      name: t.diagnostic.skillsLoader,
      status: 'failed',
      errorMessage: t.diagnostic.skillsLoadFailed,
      errorDetail: e instanceof Error ? e.message : String(e),
      checkedAt: Date.now(),
      durationMs: Date.now() - start,
    }];
  }
}
