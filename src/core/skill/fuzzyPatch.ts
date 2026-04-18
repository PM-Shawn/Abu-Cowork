/**
 * Fuzzy find-and-replace for skill content patches.
 *
 * Ported from NousResearch/hermes-agent `tools/fuzzy_match.py`, but
 * deliberately trimmed: we keep the first three strategies (exact,
 * line-trimmed, whitespace-normalized) which cover the common LLM
 * formatting drift (trailing spaces, tab↔space, per-line trim). The
 * heavier strategies (indentation-flexible, block-anchor, context-aware)
 * are skipped for the skill-patch use case — agents usually patch text
 * they just read via `skill_view`, so the drift is small.
 *
 * Semantics:
 *   - Strategies are tried in order; the first to find any match wins.
 *   - On match, all occurrences under that strategy are located.
 *   - If multiple matches exist and `replaceAll` is false → error (same
 *     as Hermes: "make it unique or pass replace_all=true").
 *   - If the first-winning strategy finds N matches and `replaceAll` is
 *     true, we replace all N. We do NOT keep searching lower strategies
 *     once a higher one matches.
 *
 * Returns a structured result so skill_manage can bubble up `closest_match`
 * and `file_structure` hints on failure (see PRD 2.4 / module E).
 */

// ── Public API ──────────────────────────────────────────────────────────

export type FuzzyStrategy = 'exact' | 'line_trimmed' | 'whitespace_normalized';

export interface FuzzyPatchResult {
  /** Content after replacement (or the original, unchanged, on failure). */
  newContent: string;
  /** Number of replacements applied (0 on failure). */
  matchCount: number;
  /** Which strategy produced the match, or null if none matched. */
  strategy: FuzzyStrategy | null;
  /** Human-readable error on failure, else null. */
  error: string | null;
}

/**
 * Find and replace `oldString` with `newString` in `content`, trying three
 * increasingly-tolerant strategies. First strategy to match wins.
 *
 * @param replaceAll If true, replace every occurrence found by the winning
 *   strategy. If false (default), require uniqueness under that strategy
 *   and return an error if multiple matches exist.
 */
export function fuzzyFindAndReplace(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): FuzzyPatchResult {
  if (oldString === '') {
    return {
      newContent: content,
      matchCount: 0,
      strategy: null,
      error: 'old_string cannot be empty',
    };
  }
  if (oldString === newString) {
    return {
      newContent: content,
      matchCount: 0,
      strategy: null,
      error: 'old_string and new_string are identical',
    };
  }

  const strategies: Array<{ name: FuzzyStrategy; find: typeof findExact }> = [
    { name: 'exact', find: findExact },
    { name: 'line_trimmed', find: findLineTrimmed },
    { name: 'whitespace_normalized', find: findWhitespaceNormalized },
  ];

  for (const { name, find } of strategies) {
    const matches = find(content, oldString);
    if (matches.length === 0) continue;

    if (matches.length > 1 && !replaceAll) {
      return {
        newContent: content,
        matchCount: 0,
        strategy: null,
        error:
          `Found ${matches.length} matches for old_string using '${name}' strategy. ` +
          `Provide more surrounding context to make the match unique, or pass replace_all=true.`,
      };
    }

    const newContent = applyReplacements(content, matches, newString);
    return { newContent, matchCount: matches.length, strategy: name, error: null };
  }

  return {
    newContent: content,
    matchCount: 0,
    strategy: null,
    error: 'Could not find a match for old_string in the file (tried exact, line-trimmed, whitespace-normalized).',
  };
}

// ── Internal: replacement application ───────────────────────────────────

interface MatchRange {
  /** Start offset in original `content`, inclusive. */
  start: number;
  /** End offset in original `content`, exclusive. */
  end: number;
}

/**
 * Apply replacements at the given ranges, from last to first so earlier
 * match positions stay valid during iteration.
 */
function applyReplacements(
  content: string,
  matches: ReadonlyArray<MatchRange>,
  replacement: string,
): string {
  const sorted = [...matches].sort((a, b) => b.start - a.start);
  let out = content;
  for (const { start, end } of sorted) {
    out = out.slice(0, start) + replacement + out.slice(end);
  }
  return out;
}

// ── Strategy 1: exact match ─────────────────────────────────────────────

function findExact(content: string, pattern: string): MatchRange[] {
  const matches: MatchRange[] = [];
  let start = 0;
  while (true) {
    const idx = content.indexOf(pattern, start);
    if (idx === -1) break;
    matches.push({ start: idx, end: idx + pattern.length });
    // Move past this match. Using idx+1 would allow overlapping matches;
    // idx+pattern.length avoids double-counting for patterns like "aa" in "aaa".
    start = idx + pattern.length;
  }
  return matches;
}

// ── Strategy 2: line-trimmed match ──────────────────────────────────────

/**
 * Match when the pattern's lines equal content's lines after per-line
 * trim. Maps back to the original content range so surrounding whitespace
 * (the part we "ignored" to match) is preserved correctly in the output.
 *
 * Handles trailing-newline quirks: a pattern ending in `\n` and a content
 * region ending in `\n` are both split into the same trailing-empty-line
 * structure by String.split('\n'), so they compare equal.
 */
function findLineTrimmed(content: string, pattern: string): MatchRange[] {
  const contentLines = content.split('\n');
  const patternLines = pattern.split('\n');

  // Trim each line independently for comparison.
  const contentTrimmed = contentLines.map((l) => l.trim());
  const patternTrimmed = patternLines.map((l) => l.trim());

  // Optimization: if strategy 1 (exact) already matches, line-trimmed would
  // too — but we've already bailed out of strategy 1 by the time we're here,
  // so this is a real fuzzy match. Skip if trimmed pattern is identical to
  // pattern (no drift → no new info to find).
  if (
    contentLines.length === contentTrimmed.length &&
    pattern === patternLines.join('\n') &&
    contentLines.every((l, i) => l === contentTrimmed[i]) &&
    patternLines.every((l, i) => l === patternTrimmed[i])
  ) {
    // Already tried as exact, no drift to find
    return [];
  }

  // Pre-compute original-content line offsets: lineStart[i] = start offset,
  // lineEnd[i] = end offset (before the trailing \n, or end of content).
  const lineStart: number[] = new Array(contentLines.length);
  const lineEnd: number[] = new Array(contentLines.length);
  let pos = 0;
  for (let i = 0; i < contentLines.length; i++) {
    lineStart[i] = pos;
    pos += contentLines[i].length;
    lineEnd[i] = pos;
    pos += 1; // skip the \n (the last line has no \n but this is past-the-end, not used)
  }

  const matches: MatchRange[] = [];
  const patLen = patternTrimmed.length;
  if (patLen === 0) return [];

  outer: for (let i = 0; i + patLen <= contentTrimmed.length; i++) {
    for (let j = 0; j < patLen; j++) {
      if (contentTrimmed[i + j] !== patternTrimmed[j]) {
        continue outer;
      }
    }
    // Match starts at content line i, spans patLen lines.
    const start = lineStart[i];
    // For the end, we want to include the last matched line up through
    // its trailing \n if the pattern had one (so replacements naturally
    // consume the newline). Heuristic: if the original pattern had a
    // trailing newline AND the corresponding content position also has one,
    // extend end past the \n.
    let end = lineEnd[i + patLen - 1];
    const patEndsWithNewline = pattern.endsWith('\n');
    const contentHasTrailingNewline =
      i + patLen - 1 < contentLines.length - 1; // not the last line of content
    if (patEndsWithNewline && contentHasTrailingNewline) {
      end += 1; // consume the \n
    }
    matches.push({ start, end });
  }

  return matches;
}

// ── Strategy 3: whitespace-normalized match ─────────────────────────────

/**
 * Collapse runs of `[ \t]+` to a single space (newlines preserved) in both
 * content and pattern. Build a position map from normalized → original so
 * matches in normalized space can be replayed in original coordinates.
 *
 * Useful for drift like `foo   bar` vs `foo bar`, or tab vs space runs.
 */
function findWhitespaceNormalized(content: string, pattern: string): MatchRange[] {
  const nc = normalizeWhitespace(content);
  const np = normalizeWhitespace(pattern);

  // No drift — same as exact. We've already tried exact, so no work.
  if (nc.text === content && np.text === pattern) return [];

  const matches: MatchRange[] = [];
  let start = 0;
  while (true) {
    const idx = nc.text.indexOf(np.text, start);
    if (idx === -1) break;
    // Map normalized range → original range.
    //   original start = origPos[idx]  (first char of the match in original)
    //   original end   = origPos[idx + np.text.length - 1] + 1
    //                    (end of the last matched char in original, +1 for exclusive)
    const origStart = nc.origPos[idx];
    const lastNormIdx = idx + np.text.length - 1;
    const origEnd =
      lastNormIdx < nc.origPos.length ? nc.origPos[lastNormIdx] + 1 : content.length;
    matches.push({ start: origStart, end: origEnd });
    start = idx + np.text.length;
  }
  return matches;
}

/**
 * Normalize runs of ` ` and `\t` to a single ` `; preserve newlines and
 * other characters. Return the normalized text plus a map where
 * `origPos[i]` is the original offset that produced `normalized[i]`.
 */
function normalizeWhitespace(s: string): { text: string; origPos: number[] } {
  const out: string[] = [];
  const origPos: number[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s.charCodeAt(i);
    if (ch === 32 /* space */ || ch === 9 /* tab */) {
      out.push(' ');
      origPos.push(i);
      i++;
      while (i < s.length) {
        const c = s.charCodeAt(i);
        if (c === 32 || c === 9) i++;
        else break;
      }
    } else {
      out.push(s[i]);
      origPos.push(i);
      i++;
    }
  }
  return { text: out.join(''), origPos };
}
