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

const REFERENCE_FIELDS = ['path', 'file_path', 'input_path', 'output_path', 'save_path', 'savePath', 'url', 'href', 'moveTo'] as const;
const REFERENCE_COLLECTIONS = ['files', 'operations', 'urls', 'paths'] as const;
const MAX_SOURCE_CHARS = 16_384;

/** Read known reference fields without retaining code, credentials or media. */
function* inputReferences(input: Record<string, unknown>): Generator<string> {
  for (const key of REFERENCE_FIELDS) {
    const value = input[key];
    if (typeof value === 'string') yield value.slice(0, MAX_SOURCE_CHARS);
  }
  for (const key of REFERENCE_COLLECTIONS) {
    const values = input[key];
    if (!Array.isArray(values)) continue;
    for (const value of values.slice(0, KEPT_ANCHORS_MAX_LINES)) {
      if (typeof value === 'string') yield value.slice(0, MAX_SOURCE_CHARS);
      else if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const field of REFERENCE_FIELDS) {
          const reference = (value as Record<string, unknown>)[field];
          if (typeof reference === 'string') yield reference.slice(0, MAX_SOURCE_CHARS);
        }
      }
    }
  }
}

function* anchorSources(message: Message): Generator<string> {
  yield messageText(message);
  for (const calls of [message.toolCalls, message.toolCallsForContext]) {
    for (const call of calls ?? []) {
      yield* inputReferences(call.input);
      if (typeof call.result === 'string') yield call.result.slice(0, MAX_SOURCE_CHARS);
      for (const block of call.resultContent ?? []) {
        if (block.type === 'text') yield block.text.slice(0, MAX_SOURCE_CHARS);
      }
    }
  }
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
    for (const source of anchorSources(message)) {
      for (const raw of source.slice(0, MAX_SOURCE_CHARS).split('\n')) {
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
  }
  return lines;
}

/** The deterministic append block; empty when there is nothing to keep. */
export function formatKeptAnchors(lines: string[]): string {
  if (lines.length === 0) return '';
  return `\n\n${KEPT_ANCHORS_HEADER}\n${lines.join('\n')}`;
}
