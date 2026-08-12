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

export interface RunChecksOptions {
  /** Per-category deadline. Categories run in parallel, so this also bounds the full run. */
  categoryTimeoutMs?: number;
}

export const DEFAULT_CATEGORY_TIMEOUT_MS = 12_000;

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
    freshness: 'unknown',
  };
}

function categoryTimeoutRow(category: CheckCategory, timeoutMs: number): CheckResult {
  const t = getI18n();
  return {
    id: `${category}:runner-timeout`,
    category,
    name: t.diagnostic.checkTimedOut,
    status: 'warning',
    errorMessage: `${t.diagnostic.checkTimedOut} (${timeoutMs}ms)`,
    checkedAt: Date.now(),
    durationMs: timeoutMs,
    freshness: 'unknown',
  };
}

async function runWithDeadline(runner: CategoryRunner, timeoutMs: number): Promise<CheckResult[]> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<CheckResult[]>((resolve) => {
    timeoutId = setTimeout(() => resolve([categoryTimeoutRow(runner.category, timeoutMs)]), timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(runner.run), timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function runAllChecks(options: RunChecksOptions = {}): Promise<CheckResult[]> {
  const timeoutMs = Math.max(1, options.categoryTimeoutMs ?? DEFAULT_CATEGORY_TIMEOUT_MS);
  const settled = await Promise.allSettled(RUNNERS.map((r) => runWithDeadline(r, timeoutMs)));
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

export async function runCategoryChecks(
  category: CheckCategory,
  options: RunChecksOptions = {},
): Promise<CheckResult[]> {
  const runner = RUNNERS.find((r) => r.category === category);
  if (!runner) return [];
  try {
    const timeoutMs = Math.max(1, options.categoryTimeoutMs ?? DEFAULT_CATEGORY_TIMEOUT_MS);
    return await runWithDeadline(runner, timeoutMs);
  } catch (e) {
    return [categoryErrorRow(category, e)];
  }
}

export const ALL_CATEGORIES: CheckCategory[] = RUNNERS.map((r) => r.category);
