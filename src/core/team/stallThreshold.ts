/**
 * Minutes without a new step before the stall watchdog stops a team hand-off.
 * Lives in its own dependency-free module so the leader prompt (bundled into
 * the sidecar) can quote it without pulling the shell-side watchdog in.
 */
export const STALL_STOP_MINUTES = 15;
