/**
 * Runner — orchestrates the 6 categories of health checks.
 *
 * Each category function returns `CheckResult[]` (a category may have 0..N
 * items). The runner executes all categories in parallel via `allSettled`
 * so a hang in one (e.g. AI services with a slow provider) doesn't block
 * the others. A category that throws is surfaced as a single failed
 * `category-error` row instead of a silent absence — that way the UI never
 * looks like "everything's fine" when the runner itself broke.
 */

import { runAIServicesChecks } from './checks/aiServices';
import { runPermissionsChecks } from './checks/permissions';
import { runMcpChecks } from './checks/mcp';
import { runSkillsChecks } from './checks/skills';
import { runNetworkChecks } from './checks/network';
import { runAppChecks } from './checks/app';
import { getI18n } from '@/i18n';
import type { CheckCategory, CheckResult } from './types';

interface CategoryRunner {
  category: CheckCategory;
  run: () => CheckResult[] | Promise<CheckResult[]>;
}

const RUNNERS: CategoryRunner[] = [
  { category: 'ai-services', run: runAIServicesChecks },
  { category: 'permissions', run: runPermissionsChecks },
  { category: 'mcp', run: runMcpChecks },
  { category: 'skills', run: runSkillsChecks },
  { category: 'network', run: runNetworkChecks },
  { category: 'app', run: runAppChecks },
];

function categoryErrorRow(category: CheckCategory, err: unknown): CheckResult {
  const t = getI18n();
  return {
    id: `${category}:runner-error`,
    category,
    name: t.diagnostic.checkInternalError,
    status: 'failed',
    errorMessage: err instanceof Error ? err.message : String(err),
    errorDetail: err instanceof Error ? err.stack ?? err.message : String(err),
    checkedAt: Date.now(),
    durationMs: 0,
  };
}

export async function runAllChecks(): Promise<CheckResult[]> {
  const settled = await Promise.allSettled(RUNNERS.map((r) => Promise.resolve(r.run())));
  const out: CheckResult[] = [];
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    if (s.status === 'fulfilled') {
      out.push(...s.value);
    } else {
      out.push(categoryErrorRow(RUNNERS[i].category, s.reason));
    }
  }
  return out;
}

export async function runCategoryChecks(category: CheckCategory): Promise<CheckResult[]> {
  const runner = RUNNERS.find((r) => r.category === category);
  if (!runner) return [];
  try {
    return await Promise.resolve(runner.run());
  } catch (e) {
    return [categoryErrorRow(category, e)];
  }
}

export const ALL_CATEGORIES: CheckCategory[] = RUNNERS.map((r) => r.category);
