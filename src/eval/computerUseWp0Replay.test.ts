import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeclaredCapabilities, ProviderSource } from '@/types/provider';
import {
  resolveAgentModelCapabilities,
} from '@/core/llm/modelCapabilities';
import {
  normalizeComputerUsePermissions,
  requiredComputerUsePermissions,
  type ComputerUseExecutionPath,
} from '@/core/agent/computerUsePermission';
import {
  createComputerUseController,
  verifyComputerEffect,
  type ComputerState,
  type ComputerVerificationStatus,
} from '@/core/agent/computerUseController';

const recordElectronRuntimeEventMock = vi.hoisted(() => vi.fn());
vi.mock('@/utils/electronHost', () => ({
  recordElectronRuntimeEvent: (...args: unknown[]) => recordElectronRuntimeEventMock(...args),
}));

import {
  __resetRuntimeTraceForTests,
  getRendererRuntimeTraceSnapshot,
  traceRuntimeEvent,
} from '@/core/observability/runtimeTrace';
import manifest from './datasets/computer-use-wp0.json';

type ReplayCase = (typeof manifest.cases)[number];

function state(value: string, bundleId = 'com.apple.Notes'): ComputerState {
  return {
    stateId: `state-${value}`,
    target: { appName: 'Notes', bundleId, processId: 42 },
    capturedAt: 1_000,
    axSessionId: `ax-${value}`,
    axTreeHash: `hash-${value}`,
    axDiff: null,
    capabilityTier: 'structured',
    elements: [{
      id: 1,
      role: 'AXTextField',
      label: 'Body',
      value,
      bounds: [0, 0, 100, 20],
      actions: ['AXSetValue'],
      depth: 1,
    }],
  };
}

function replay(entry: ReplayCase): unknown {
  const input = entry.input as Record<string, unknown>;
  switch (entry.domain) {
    case 'model-capability':
      return resolveAgentModelCapabilities({
        modelId: String(input.modelId),
        providerSource: input.providerSource as ProviderSource | undefined,
        declared: input.declared as DeclaredCapabilities | undefined,
      });
    case 'permission-requirements':
      return requiredComputerUsePermissions(input.path as ComputerUseExecutionPath);
    case 'permission-normalization':
      return normalizeComputerUsePermissions(input as Parameters<typeof normalizeComputerUsePermissions>[0]);
    case 'progress-policy': {
      const controller = createComputerUseController();
      const key = { conversationId: 'wp0-conversation', loopId: entry.id };
      return {
        decisions: (input.statuses as ComputerVerificationStatus[]).map((status) => (
          controller.assessProgress(key, {
            status,
            beforeStateId: 'before',
            afterStateId: status === 'ambiguous' ? null : 'after',
            reason: status === 'verified-change'
              ? 'state-changed'
              : status === 'no-change'
                ? 'state-unchanged'
                : 'observation-failed',
          }, String(input.consequence)).decision
        )),
      };
    }
    case 'effect-verification': {
      const before = state(String(input.beforeValue));
      const after = input.after === null
        ? null
        : state(String(input.afterValue), String(input.afterBundleId ?? 'com.apple.Notes'));
      return verifyComputerEffect(
        before,
        after,
        input.expectedValue === undefined
          ? undefined
          : { type: 'element-value', elementId: 1, equals: String(input.expectedValue) },
      );
    }
    case 'diagnostic-scrub': {
      __resetRuntimeTraceForTests();
      traceRuntimeEvent(
        String(input.event),
        input.attributes as Parameters<typeof traceRuntimeEvent>[1],
      );
      return getRendererRuntimeTraceSnapshot().recentEvents[0];
    }
  }
}

describe('Computer Use WP0 versioned replay manifest', () => {
  beforeEach(() => {
    __resetRuntimeTraceForTests();
    recordElectronRuntimeEventMock.mockReset();
  });

  it('keeps a versioned, unique, cross-domain corpus of at least 20 cases', () => {
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.suiteId).toBe('computer-use-wp0');
    expect(manifest.cases.length).toBeGreaterThanOrEqual(20);
    expect(new Set(manifest.cases.map((entry) => entry.id)).size).toBe(manifest.cases.length);
    expect(new Set(manifest.cases.map((entry) => entry.domain))).toEqual(new Set([
      'model-capability',
      'permission-requirements',
      'permission-normalization',
      'progress-policy',
      'effect-verification',
      'diagnostic-scrub',
    ]));
  });

  it.each(manifest.cases)('$id', (entry) => {
    const actual = replay(entry);
    const expected = entry.expected as Record<string, unknown>;
    if (entry.domain !== 'diagnostic-scrub') {
      expect(actual).toMatchObject(expected);
      return;
    }
    const event = actual as Record<string, unknown>;
    if (expected.stageContains) expect(event.stage).toContain(expected.stageContains);
    if (expected.activeToolCount !== undefined) {
      expect(event.activeToolCount).toBe(expected.activeToolCount);
    }
    if (expected.computerUseExposed !== undefined) {
      expect(event.computerUseExposed).toBe(expected.computerUseExposed);
    }
    for (const key of expected.absentKeys as string[]) expect(event).not.toHaveProperty(key);
  });
});
