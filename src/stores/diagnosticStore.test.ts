import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CheckCategory, CheckResult } from '@/core/diagnostic/types';

// Control what each category run returns without touching the real checks.
const mockRunCategoryChecks = vi.fn();
vi.mock('@/core/diagnostic/runner', async (importActual) => {
  const actual = await importActual<typeof import('@/core/diagnostic/runner')>();
  return {
    ...actual,
    runCategoryChecks: (cat: CheckCategory) => mockRunCategoryChecks(cat),
  };
});

import { useDiagnosticStore } from './diagnosticStore';

function appRow(metric: string): CheckResult {
  return {
    id: 'app:version',
    category: 'app',
    name: 'App version',
    status: 'passed',
    metric,
    checkedAt: 123,
    durationMs: 0,
  };
}

function aiRow(): CheckResult {
  return {
    id: 'ai-services:anthropic-1',
    category: 'ai-services',
    name: 'Anthropic',
    status: 'failed',
    checkedAt: 123,
    durationMs: 0,
  };
}

describe('diagnosticStore.refreshApp', () => {
  beforeEach(() => {
    mockRunCategoryChecks.mockReset();
    useDiagnosticStore.setState({ results: {}, lastCheckedAt: null, isChecking: false });
  });

  it('replaces the stale app row with a fresh one', async () => {
    useDiagnosticStore.setState({
      results: { 'app:version': appRow('v0.29.0 · 已是最新') },
      lastCheckedAt: 1_000,
    });
    mockRunCategoryChecks.mockResolvedValue([appRow('v0.36.0 · 已是最新')]);

    await useDiagnosticStore.getState().refreshApp();

    expect(mockRunCategoryChecks).toHaveBeenCalledWith('app');
    expect(useDiagnosticStore.getState().results['app:version'].metric).toBe('v0.36.0 · 已是最新');
  });

  it('does NOT bump lastCheckedAt (the app-only refresh must not fake a full check)', async () => {
    useDiagnosticStore.setState({ results: {}, lastCheckedAt: 1_000 });
    mockRunCategoryChecks.mockResolvedValue([appRow('v0.36.0 · 已是最新')]);

    await useDiagnosticStore.getState().refreshApp();

    expect(useDiagnosticStore.getState().lastCheckedAt).toBe(1_000);
  });

  it('leaves other categories\' cached results untouched', async () => {
    useDiagnosticStore.setState({
      results: { 'ai-services:anthropic-1': aiRow(), 'app:version': appRow('v0.29.0 · 已是最新') },
      lastCheckedAt: 1_000,
    });
    mockRunCategoryChecks.mockResolvedValue([appRow('v0.36.0 · 已是最新')]);

    await useDiagnosticStore.getState().refreshApp();

    const results = useDiagnosticStore.getState().results;
    expect(results['ai-services:anthropic-1']).toBeDefined();
    expect(results['ai-services:anthropic-1'].status).toBe('failed');
  });
});
