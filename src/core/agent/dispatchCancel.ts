import { cancelDispatch } from './subagentAbort';
import { notifySidecar } from '@/core/sidecar/sidecarManager';

/**
 * Stop one team member's hand-off from the UI. The member may run in this
 * process (in-process fallback) or in the sidecar, so both are told; each
 * side ignores a key it does not own.
 */
export function requestDispatchCancel(dispatchKey: string): void {
  cancelDispatch(dispatchKey);
  try {
    notifySidecar('state.cancelDispatch', { key: dispatchKey });
  } catch {
    // The sidecar may not be up (in-process run) — the local cancel above covered it.
  }
}
