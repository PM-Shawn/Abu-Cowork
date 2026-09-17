/**
 * Where an agent run executes (#549 B). Electron: always the sidecar — if it
 * is starting we wait (visibly, ≤60s); if it failed we try one restart; then
 * we fail visibly. There is no silent in-process fallback. Only a renderer
 * with no desktop process bridge (web preview, unit tests) runs the loop
 * in-process, and that is an environment choice, not a recovery path.
 */
import { isTauriEnv } from '@/utils/tauriEnv';
import { ensureSidecarStatusProjection, useSidecarStatusStore } from '@/stores/sidecarStatusStore';
import {
  getSidecarStatus,
  startSidecar,
  waitForSidecarStatus,
  type SidecarStatus,
} from './sidecarManager';

export const SIDECAR_READY_TIMEOUT_MS = 60_000;

export class SidecarUnavailableError extends Error {
  readonly code = 'sidecar_unavailable' as const;
  readonly stopReason = 'sidecar_unavailable' as const;
  readonly lastStatus: SidecarStatus;
  readonly reason: 'timeout' | 'failed';

  constructor(lastStatus: SidecarStatus, reason: 'timeout' | 'failed') {
    super(`Agent sidecar unavailable (${reason}; last status ${lastStatus})`);
    this.name = 'SidecarUnavailableError';
    this.lastStatus = lastStatus;
    this.reason = reason;
  }
}

/** Environment choice, not a failure fallback: no desktop process bridge. */
export function isInProcessAgentEnvironment(): boolean {
  return !isTauriEnv();
}

function abortReason(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === 'string' ? reason : 'Waiting for the agent sidecar was aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * Resolve once the sidecar can accept a run, or throw visibly.
 *
 * - In-process environment (no desktop bridge): resolves immediately; the
 *   caller keeps the in-process loop.
 * - `running`: resolves immediately.
 * - `starting` / `restarting`: waits up to 60s, marking the conversation as
 *   waiting so the UI can say so.
 * - `failed` / `stopped`: attempts exactly ONE `startSidecar()` (the "restart
 *   on the next user send" rule, spec §5) and then waits the normal 60s.
 *   The crash-loop policy in sidecarManager owns any further backoff.
 *
 * Never auto-resends anything: it only reports whether the venue is ready.
 */
export async function waitForSidecarVenue(options: {
  signal?: AbortSignal;
  conversationId?: string;
  timeoutMs?: number;
} = {}): Promise<void> {
  if (isInProcessAgentEnvironment()) return;
  ensureSidecarStatusProjection();
  const initial = getSidecarStatus();
  if (initial === 'running') return;
  if (initial === 'failed' || initial === 'stopped') {
    // One restart attempt per user send (spec §5). startSidecar never throws
    // and flips status to 'starting' synchronously.
    void startSidecar();
  }
  const { conversationId } = options;
  if (conversationId) useSidecarStatusStore.getState().setWaiting(conversationId, true);
  try {
    const outcome = await waitForSidecarStatus(options.timeoutMs ?? SIDECAR_READY_TIMEOUT_MS, options.signal);
    if (outcome === 'running') return;
    if (outcome === 'aborted') throw abortReason(options.signal);
    throw new SidecarUnavailableError(getSidecarStatus(), outcome);
  } finally {
    if (conversationId) useSidecarStatusStore.getState().setWaiting(conversationId, false);
  }
}
