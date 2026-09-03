/**
 * Consecutive browser-authorization denial counter for ONE run.
 *
 * A model that keeps asking for browser actions the user keeps refusing is
 * not going to converge — it either misread the task or is looping on the
 * refusal. After `BROWSER_DENIAL_ABORT_THRESHOLD` refusals in a row the run
 * stops and hands the floor back to the user with a closing message, instead
 * of burning turns and dialogs.
 *
 * Only BROWSER authorization refusals count (the gate in registry.ts calls
 * `reportDenial` at its own deny sites and nowhere else); an unrelated file or
 * command refusal never touches this counter. Any single allowed browser
 * action resets it — "in a row" is literal.
 *
 * The tracker is pure state: whoever owns the run (the shell-side RunSession
 * for a sidecar-hosted loop, agentLoop.ts for the in-process fallback) passes
 * the abort action in and exposes ONLY the two report functions on the tool
 * context — never the AbortController itself.
 */

export const BROWSER_DENIAL_ABORT_THRESHOLD = 2;

/** Machine-readable cause recorded on the run result when the threshold trips. */
export type BrowserDenialAbortCause = 'consecutive_browser_denials';
export const BROWSER_DENIAL_ABORT_CAUSE: BrowserDenialAbortCause = 'consecutive_browser_denials';

export interface BrowserDenialTracker {
  /** A browser authorization refusal happened. May trigger the abort action. */
  reportDenial(): void;
  /** A browser action passed the gate — resets the streak. */
  reportAllow(): void;
  /** Current streak length (test/diagnostic seam). */
  readonly consecutiveDenials: number;
  /** True once the threshold fired; the abort action runs at most once. */
  readonly tripped: boolean;
}

export function createBrowserDenialTracker(
  onThreshold: () => void,
  threshold: number = BROWSER_DENIAL_ABORT_THRESHOLD,
): BrowserDenialTracker {
  let consecutiveDenials = 0;
  let tripped = false;
  return {
    reportDenial(): void {
      if (tripped) return;
      consecutiveDenials += 1;
      if (consecutiveDenials >= threshold) {
        tripped = true;
        onThreshold();
      }
    },
    reportAllow(): void {
      if (tripped) return;
      consecutiveDenials = 0;
    },
    get consecutiveDenials(): number {
      return consecutiveDenials;
    },
    get tripped(): boolean {
      return tripped;
    },
  };
}
