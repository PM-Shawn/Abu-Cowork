import { cancelDispatch, isDispatchActive } from './subagentAbort';
import { enqueueDispatchInput } from './dispatchInput';
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

/**
 * Hand a user instruction to ONE running member. Same two-process fan-out as
 * the stop: whichever process runs the member's loop owns the key and queues
 * it; the other ignores it.
 */
export function requestDispatchInput(dispatchKey: string, text: string): void {
  if (isDispatchActive(dispatchKey)) enqueueDispatchInput(dispatchKey, text);
  try {
    notifySidecar('state.dispatchInput', { key: dispatchKey, text });
  } catch {
    // Sidecar not up — the in-process queue above is the only one that matters.
  }
}
