import { beforeEach, describe, expect, it, vi } from 'vitest';

const statusListeners: Array<(s: string) => void> = [];
const startSidecar = vi.fn().mockResolvedValue(undefined);
const getSidecarStatus = vi.fn(() => 'stopped');
vi.mock('@/core/sidecar/sidecarManager', () => ({
  getSidecarStatus: () => getSidecarStatus(),
  onSidecarStatusChange: (h: (s: string) => void) => {
    statusListeners.push(h);
    return () => {
      const at = statusListeners.indexOf(h);
      if (at >= 0) statusListeners.splice(at, 1);
    };
  },
  startSidecar: () => startSidecar(),
}));

import {
  ensureSidecarStatusProjection,
  isConversationWaitingForSidecar,
  useSidecarStatusStore,
} from './sidecarStatusStore';

// Captured at module scope, BEFORE any beforeEach can clear the spy — an
// import-time read of the supervisor has to be visible here or nowhere.
const managerReadsAtImport = getSidecarStatus.mock.calls.length;
const listenersAtImport = statusListeners.length;

describe('sidecarStatusStore', () => {
  beforeEach(() => {
    useSidecarStatusStore.setState({ status: 'stopped', waiting: {} });
    startSidecar.mockClear();
    getSidecarStatus.mockClear();
  });

  it('does not subscribe to the supervisor at import time (ruling R1)', () => {
    // Importing the module must not touch sidecarManager — suites that mock it
    // with only the members they use would otherwise crash on import.
    expect(listenersAtImport).toBe(0);
    expect(managerReadsAtImport).toBe(0);
    expect(statusListeners).toHaveLength(0);
  });

  it('ensureSidecarStatusProjection seeds the current status and is idempotent', () => {
    getSidecarStatus.mockReturnValue('running');
    ensureSidecarStatusProjection();
    ensureSidecarStatusProjection();
    expect(statusListeners).toHaveLength(1);
    expect(useSidecarStatusStore.getState().status).toBe('running');
    getSidecarStatus.mockReturnValue('stopped');
  });

  it('mirrors manager status transitions once the projection is ensured', () => {
    ensureSidecarStatusProjection();
    expect(statusListeners).toHaveLength(1);
    statusListeners.forEach((h) => h('failed'));
    expect(useSidecarStatusStore.getState().status).toBe('failed');
  });

  it('reference-counts waiting conversations', () => {
    const { setWaiting } = useSidecarStatusStore.getState();
    setWaiting('c1', true);
    setWaiting('c1', true);
    setWaiting('c1', false);
    expect(isConversationWaitingForSidecar(useSidecarStatusStore.getState(), 'c1')).toBe(true);
    setWaiting('c1', false);
    setWaiting('c1', false);
    expect(isConversationWaitingForSidecar(useSidecarStatusStore.getState(), 'c1')).toBe(false);
    expect(useSidecarStatusStore.getState().waiting).toEqual({});
  });

  it('reconnect asks the supervisor to start', () => {
    useSidecarStatusStore.getState().reconnect();
    expect(startSidecar).toHaveBeenCalledTimes(1);
  });
});
