// @vitest-environment happy-dom
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

describe('diagnosticStore persisted rows', () => {
  it('redacts failure text that an earlier version persisted unredacted', () => {
    const secret = `sk-test-not-a-secret-${'0'.repeat(12)}`;
    const migrate = useDiagnosticStore.persist.getOptions().migrate!;

    const migrated = migrate({
      results: {
        'mcp:tracker': {
          ...aiRow(),
          id: 'mcp:tracker',
          category: 'mcp',
          errorMessage: `connect failed: api_key=${secret}`,
          errorDetail: 'https://gateway.example.test/sse?key=not-a-secret-value → 401',
        },
        'app:version': appRow('v0.36.0'),
      },
      lastCheckedAt: 1_000,
      includeRawText: false,
    }, 2) as { results: Record<string, CheckResult>; includeRawText: boolean };

    expect(JSON.stringify(migrated)).not.toContain(secret);
    expect(JSON.stringify(migrated)).not.toContain('not-a-secret-value');
    expect(migrated.results['mcp:tracker']).toMatchObject({ id: 'mcp:tracker', status: 'failed' });
    expect(migrated.results['app:version']).toEqual(appRow('v0.36.0'));
    expect(migrated.includeRawText).toBe(false);
  });
});

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
