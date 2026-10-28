/**
 * Deterministic anchor preservation for compaction summaries (labs:
 * `state-preserving-compression`, phase 2).
 *
 * The summary model is asked to carry plan steps, file paths and URLs, but
 * nothing guarantees it does — and recursive re-compaction decays whatever it
 * happened to keep. This module extracts those anchor lines from the compacted
 * steps by pattern, so `compactHistory` can append them to the summary
 * verbatim, independent of the summary model's cooperation. The append block
 * becomes part of the next summary's input, so anchors survive recursion, and
 * it bounds itself (≤10 lines × ≤200 chars) so it cannot grow across rounds.
 *
 * Pure module: no store, no labs import — the gate is read by the caller
 * (`compressionTuning.anchorPreservationEnabled()`) and passed to compaction
 * as `keepAnchors`, so compaction stays sidecar-bundle-safe without one.
 */
import type { Message } from '@/types';

export const KEPT_ANCHORS_HEADER = '[kept anchors]';
export const KEPT_ANCHORS_MAX_LINES = 10;
export const KEPT_ANCHORS_MAX_CHARS = 200;

/**
 * Anchor line patterns (from the pre-#793 implementation): plan-step bullets,
 * markdown headings carrying step titles, Windows/POSIX paths, URLs.
 */
export const ANCHOR_PATTERNS: readonly RegExp[] = [
  /^[-*•]\s*\[[ xX]?\]/, // plan-step bullets: "- [ ] …" / "- [x] …"
  /^#{1,4}\s/, // markdown headings carrying plan/step titles
  /(?:[A-Za-z]:[\\/][^\s]+|\/(?:[\w.-]+\/)+[\w.-]*)/, // windows / posix paths
  /https?:\/\/[^\s)"']+/, // URLs
];

/** The text the summary request sees for one message: its own words. */
function messageText(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  return message.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
}

/**
 * The distinct anchor lines of `messages`, first appearance first, capped at
 * `KEPT_ANCHORS_MAX_LINES` lines of at most `KEPT_ANCHORS_MAX_CHARS` chars.
 */
export function extractAnchorLines(
  messages: Message[],
  patterns: readonly RegExp[] = ANCHOR_PATTERNS,
): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    for (const raw of messageText(message).split('\n')) {
      const line = raw.trim();
      if (!line || seen.has(line)) continue;
      if (!patterns.some((pattern) => pattern.test(line))) continue;
      seen.add(line);
      lines.push(line.length > KEPT_ANCHORS_MAX_CHARS
        ? `${line.slice(0, KEPT_ANCHORS_MAX_CHARS)}…`
        : line);
      if (lines.length >= KEPT_ANCHORS_MAX_LINES) return lines;
    }
  }
  return lines;
}

/** The deterministic append block; empty when there is nothing to keep. */
export function formatKeptAnchors(lines: string[]): string {
  if (lines.length === 0) return '';
  return `\n\n${KEPT_ANCHORS_HEADER}\n${lines.join('\n')}`;
}
