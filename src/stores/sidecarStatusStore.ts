import { create } from 'zustand';
import {
  getSidecarStatus,
  onSidecarStatusChange,
  startSidecar,
  type SidecarStatus,
} from '@/core/sidecar/sidecarManager';

/**
 * UI projection of the agent sidecar supervisor (#549). Not persisted:
 * `status` mirrors sidecarManager; `waiting` counts sends currently blocked
 * on a cold start, per conversation.
 */
export interface SidecarStatusState {
  status: SidecarStatus;
  waiting: Record<string, number>;
  setWaiting: (conversationId: string, waiting: boolean) => void;
  reconnect: () => void;
}

export const useSidecarStatusStore = create<SidecarStatusState>()((set) => ({
  // Seeded lazily by ensureSidecarStatusProjection() — see below.
  status: 'stopped',
  waiting: {},
  setWaiting: (conversationId, waiting) => set((state) => {
    const next = { ...state.waiting };
    const count = (next[conversationId] ?? 0) + (waiting ? 1 : -1);
    if (count > 0) next[conversationId] = count;
    else delete next[conversationId];
    return { waiting: next };
  }),
  reconnect: () => {
    // Attach the projection first: a reconnect pressed from a surface that
    // never called ensure…() must still see the resulting transitions.
    ensureSidecarStatusProjection();
    // startSidecar() never throws and is idempotent while already active.
    void startSidecar();
  },
}));

let projectionAttached = false;

/**
 * Attach the supervisor → store projection. Idempotent, and deliberately NOT
 * run at import time: this module is pulled in by the agent dispatch path, and
 * suites that mock `@/core/sidecar/sidecarManager` with only the members they
 * use would crash on import if merely importing the store called into it.
 * Callers that actually need live status (waitForSidecarVenue, the status
 * strip, App bootstrap) call this first.
 */
export function ensureSidecarStatusProjection(): void {
  if (projectionAttached) return;
  projectionAttached = true;
  useSidecarStatusStore.setState({ status: getSidecarStatus() });
  onSidecarStatusChange((status) => useSidecarStatusStore.setState({ status }));
}

export function isConversationWaitingForSidecar(state: SidecarStatusState, conversationId: string): boolean {
  return (state.waiting[conversationId] ?? 0) > 0;
}
