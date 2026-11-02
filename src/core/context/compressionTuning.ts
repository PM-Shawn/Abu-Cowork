/**
 * State-preserving compression tuning (labs: `state-preserving-compression`).
 *
 * When the flag is on, long-run context management compresses EARLIER (while
 * task state is still intact) and KEEPS MORE (a larger verbatim tail), trading
 * a few extra summarization calls for far less mid-task state loss. Default
 * off — behavior-sensitive parameters, see docs/2026-10-28-s4-s6-recovery-projects-plan.md §三.
 */
import { isLabsFlagOn } from '../labs/resolve';
import { LABS_STATE_PRESERVING_COMPRESSION } from '../labs/registry';
import { COMPACTION_TRIGGER_RATIO, RETAINED_TAIL_RATIO } from './compaction';

/** Compaction trigger: 0.9 → 0.75 of the input budget with the flag on. */
export function compactionTriggerRatio(): number {
  return isLabsFlagOn(LABS_STATE_PRESERVING_COMPRESSION) ? 0.75 : COMPACTION_TRIGGER_RATIO;
}

/** Verbatim tail share: 0.15 → 0.25 of the input budget with the flag on. */
export function retainedTailRatio(): number {
  return isLabsFlagOn(LABS_STATE_PRESERVING_COMPRESSION) ? 0.25 : RETAINED_TAIL_RATIO;
}

/**
 * Anchor preservation (phase 2): compacted summaries keep plan-step lines,
 * file paths and URLs — the summary instruction names them and compactHistory
 * appends the pattern-extracted `[kept anchors]` block deterministically.
 */
export function anchorPreservationEnabled(): boolean {
  return isLabsFlagOn(LABS_STATE_PRESERVING_COMPRESSION);
}
