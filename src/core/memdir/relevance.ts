/**
 * Memdir Relevance — Phase 2 per-turn injection of relevant memory contents.
 *
 * The Phase 1 path (`loadMemoryIndex` injected into the static system prompt)
 * gives the agent awareness that memories exist. This Phase 2 path actually
 * surfaces the *content* of the memories most relevant to the current user
 * message, so the agent doesn't have to call read_memory just to recall a
 * basic fact.
 *
 * Design notes:
 * - **No LLM selector** — Abu users typically have 5-30 memories, so a
 *   simple keyword-overlap score performs comparably to a Sonnet selector
 *   without the per-turn cost. CC uses Sonnet because they face hundreds.
 * - **Private memories never enter the candidate pool** — they're explicitly
 *   excluded from auto-injection. The agent reaches them only via
 *   read_memory, which surfaces them with a restraint reminder.
 * - **Hard byte budgets** — single memory ≤4KB, total turn ≤20KB. Mirrors
 *   CC's MAX_MEMORY_BYTES / 5×4KB caps; prevents Phase 2 from bloating the
 *   prompt when a workspace has many large memories.
 * - **Fallback to recency** — if keyword scoring returns fewer than 3 hits,
 *   fill the rest with the most-recently-updated memories. The agent should
 *   always have *some* context if any memories exist.
 */

import type { MemoryHeader } from './types';
import { scanMemoryFilesCached, readMemoryFile } from './scan';
import { memoryFreshnessText } from './age';

export const MAX_PER_MEMORY_BYTES = 4096;
export const MAX_TURN_BYTES = 20 * 1024;
export const MAX_SELECTED = 5;
const FALLBACK_FLOOR = 3;

export interface RelevantMemory {
  filename: string;
  filePath: string;
  type: string;
  name: string;
  /** Possibly truncated to MAX_PER_MEMORY_BYTES */
  content: string;
  updated: number;
  truncated: boolean;
}

interface ScoredHeader {
  header: MemoryHeader;
  score: number;
}

/**
 * Tokenize a query for scoring. Lowercase, split on whitespace, drop tokens
 * shorter than 2 chars (which match too aggressively in CJK text where
 * single chars like "的" / "了" carry no information).
 */
function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(t => t.length >= 2);
}

/**
 * Score a memory header against the query tokens.
 *
 * Weights:
 *   - name match:        +2 per token
 *   - description match: +1 per token
 *   - recency boost:     +1 / (1 + ageDays)  — same-score tiebreaker
 *
 * Returns 0 when no token matches (caller decides whether to fall back to
 * pure-recency selection).
 */
function scoreMemory(tokens: readonly string[], h: MemoryHeader): number {
  if (tokens.length === 0) return 0;

  const name = h.name.toLowerCase();
  const desc = h.description.toLowerCase();

  let score = 0;
  for (const token of tokens) {
    if (name.includes(token)) score += 2;
    if (desc.includes(token)) score += 1;
  }

  if (score > 0) {
    const ageDays = (Date.now() - h.updated) / 86_400_000;
    score += 1 / (1 + Math.max(0, ageDays));
  }

  return score;
}

/**
 * Decide whether the query is "rich enough" to warrant Phase 2 injection.
 * Single-character or 2-char noise queries ("好", "ok", "继续") would
 * waste the budget on irrelevant matches.
 *
 * Returns null when Phase 2 should skip this turn entirely.
 *
 * CJK note: Chinese queries are typically whitespace-free, so the rule
 * "no whitespace + short" can't gate them. We instead require ≥4 CJK
 * chars OR ≥2 latin tokens.
 */
export function extractQueryText(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length < 4) return null;
  const hasCJK = /[一-鿿]/.test(trimmed);
  const hasWhitespace = /\s/.test(trimmed);
  // Latin-only single short word (no whitespace, <8 chars): not enough signal.
  if (!hasCJK && !hasWhitespace && trimmed.length < 8) return null;
  return trimmed;
}

/**
 * Truncate a memory body to MAX_PER_MEMORY_BYTES at the last newline before
 * the cap, so we don't slice mid-line.
 */
function truncateBody(body: string): { content: string; truncated: boolean } {
  if (body.length <= MAX_PER_MEMORY_BYTES) {
    return { content: body, truncated: false };
  }
  const cut = body.slice(0, MAX_PER_MEMORY_BYTES);
  const lastNewline = cut.lastIndexOf('\n');
  const safeCut = lastNewline > MAX_PER_MEMORY_BYTES * 0.5 ? cut.slice(0, lastNewline) : cut;
  return {
    content: safeCut + '\n\n[内容已截断 — 完整内容可调 read_memory 拉取]',
    truncated: true,
  };
}

/**
 * Find memories most relevant to the current query, scoped to global +
 * the current workspace.
 *
 * Returns at most MAX_SELECTED entries, capped at MAX_TURN_BYTES total.
 * Empty array signals "skip Phase 2 injection this turn" (no candidates,
 * or all filtered out).
 */
export async function findRelevantMemories(
  query: string,
  workspacePath: string | null,
): Promise<RelevantMemory[]> {
  // 1. Scan global + workspace (cached, 5min TTL)
  const [globalHeaders, wsHeaders] = await Promise.all([
    scanMemoryFilesCached(null),
    workspacePath ? scanMemoryFilesCached(workspacePath) : Promise.resolve([]),
  ]);

  // 2. Filter out private — they never enter Phase 2 injection
  const candidates = [...globalHeaders, ...wsHeaders].filter(h => !h.private);
  if (candidates.length === 0) return [];

  // 3. Score against query
  const tokens = tokenize(query);
  const scored: ScoredHeader[] = candidates.map(header => ({
    header,
    score: scoreMemory(tokens, header),
  }));

  // 4. Sort: score desc, then updated desc
  const matched = scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score || b.header.updated - a.header.updated);

  // 5. Build the selection: matched first, then fall back to recency for
  //    floor-up to FALLBACK_FLOOR (so the agent always sees *some* context
  //    if memories exist at all).
  const selected: ScoredHeader[] = matched.slice(0, MAX_SELECTED);
  if (selected.length < FALLBACK_FLOOR) {
    const usedPaths = new Set(selected.map(s => s.header.filePath));
    const recent = candidates
      .filter(h => !usedPaths.has(h.filePath))
      .sort((a, b) => b.updated - a.updated)
      .slice(0, FALLBACK_FLOOR - selected.length);
    selected.push(...recent.map(h => ({ header: h, score: 0 })));
  }

  // 6. Read bodies, truncate, enforce session byte budget
  const result: RelevantMemory[] = [];
  let totalBytes = 0;
  for (const { header } of selected) {
    if (totalBytes >= MAX_TURN_BYTES) break;
    const file = await readMemoryFile(header.filePath);
    if (!file) continue;
    const { content, truncated } = truncateBody(file.content);
    if (totalBytes + content.length > MAX_TURN_BYTES) {
      // Skip this memory — over budget. Don't try to fit a smaller one
      // by greedy reordering; relevance order matters more than byte tetris.
      break;
    }
    result.push({
      filename: header.filename,
      filePath: header.filePath,
      type: header.type,
      name: header.name,
      content,
      updated: header.updated,
      truncated,
    });
    totalBytes += content.length;
  }

  return result;
}

/**
 * Render the relevant-memories section for system prompt injection.
 * Emits one `<memory>` block per entry, with a freshness preamble for
 * stale (60+ days) memories.
 *
 * Format chosen so the agent can clearly see boundaries between memories
 * (vs. interleaving with the rest of the prompt) and so stale warnings
 * stay anchored to the memory they apply to.
 */
export function formatRelevantMemoriesSection(memories: readonly RelevantMemory[]): string {
  if (memories.length === 0) return '';

  const blocks = memories.map(m => {
    const stale = memoryFreshnessText(m.updated);
    const preamble = stale ? `[${stale}]\n\n` : '';
    return (
      `<memory filename="${m.filename}" type="${m.type}" updated="${new Date(m.updated).toISOString().split('T')[0]}">\n` +
      `${preamble}${m.content}\n` +
      `</memory>`
    );
  });

  return (
    '\n## 当前对话相关记忆\n' +
    '以下是与本轮对话最相关的非私密记忆（按相关度排序）。优先使用这里的内容回答，' +
    '无需重复调用 read_memory。\n\n' +
    blocks.join('\n\n')
  );
}
