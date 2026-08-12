import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckCategory, CheckResult } from './types';

const mocks = vi.hoisted(() => ({
  ai: vi.fn(),
  permissions: vi.fn(),
  mcp: vi.fn(),
  skills: vi.fn(),
  network: vi.fn(),
  app: vi.fn(),
}));

vi.mock('./checks/aiServices', () => ({ runAIServicesChecks: mocks.ai }));
vi.mock('./checks/permissions', () => ({ runPermissionsChecks: mocks.permissions }));
vi.mock('./checks/mcp', () => ({ runMcpChecks: mocks.mcp }));
vi.mock('./checks/skills', () => ({ runSkillsChecks: mocks.skills }));
vi.mock('./checks/network', () => ({ runNetworkChecks: mocks.network }));
vi.mock('./checks/app', () => ({ runAppChecks: mocks.app }));

import { runAllChecks, runCategoryChecks } from './runner';

function passed(category: CheckCategory): CheckResult[] {
  return [{
    id: `${category}:ok`,
    category,
    name: 'ok',
    status: 'passed',
    checkedAt: 1,
    durationMs: 1,
  }];
}

describe('diagnostic runner deadlines', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.ai.mockReset().mockResolvedValue(passed('ai-services'));
    mocks.permissions.mockReset().mockResolvedValue(passed('permissions'));
    mocks.mcp.mockReset().mockResolvedValue(passed('mcp'));
    mocks.skills.mockReset().mockResolvedValue(passed('skills'));
    mocks.network.mockReset().mockResolvedValue(passed('network'));
    mocks.app.mockReset().mockResolvedValue(passed('app'));
  });

  afterEach(() => vi.useRealTimers());

  it('bounds a hung category without blocking healthy categories', async () => {
    mocks.network.mockReturnValue(new Promise(() => {}));

    const pending = runAllChecks({ categoryTimeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(50);
    const results = await pending;

    expect(results).toHaveLength(6);
    expect(results.find((row) => row.category === 'network')).toMatchObject({
      id: 'network:runner-timeout',
      status: 'warning',
      freshness: 'unknown',
      durationMs: 50,
    });
    expect(results.filter((row) => row.status === 'passed')).toHaveLength(5);
  });

  it('applies the same deadline to a single-category rerun', async () => {
    mocks.ai.mockReturnValue(new Promise(() => {}));

    const pending = runCategoryChecks('ai-services', { categoryTimeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(25);

    await expect(pending).resolves.toEqual([
      expect.objectContaining({
        id: 'ai-services:runner-timeout',
        status: 'warning',
        freshness: 'unknown',
      }),
    ]);
  });
});
