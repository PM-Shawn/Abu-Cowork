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
 *   lexical overlap score (latin word tokens + CJK character bigrams, with
 *   stopword pairs and a ≥2-bigram noise gate — see tokenize/scoreMemory)
 *   performs comparably to a Sonnet selector without the per-turn cost. CC
 *   uses Sonnet because they face hundreds.
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
 * Query tokens for scoring, in two channels:
 *   - `words`: latin/ASCII tokens (length ≥2) — whitespace-delimited languages
 *   - `bigrams`: adjacent-character pairs from CJK runs — Chinese queries are
 *     whitespace-free, so the old whitespace split treated "帮我看看火山方舟"
 *     as ONE token and substring-matched it against nothing. Bigrams are the
 *     standard CJK fallback tokenization (SQLite FTS5, ES/Lucene CJKAnalyzer).
 */
interface QueryTokens {
  words: readonly string[];
  bigrams: readonly string[];
}

/**
 * Function-word bigrams that appear in almost any Chinese query and carry no
 * topical signal. Without this, "帮我看看…" would match every memory whose
 * description happens to contain 帮我/看看.
 */
const BIGRAM_STOPWORDS = new Set([
  '我们', '你们', '他们', '我的', '你的', '这个', '那个', '什么', '怎么', '怎样',
  '可以', '现在', '一下', '帮我', '请问', '一个', '不是', '没有', '就是', '如果',
  '因为', '所以', '但是', '还是', '应该', '觉得', '知道', '时候', '东西', '看看',
  '这样', '那样', '这里', '那里', '的话', '是不', '有没', '能不', '多少', '哪些',
  '哪个', '今天', '昨天', '明天',
]);

const CJK_RUN_RE = /[一-鿿]+/g;
const LATIN_WORD_RE = /[a-z0-9][a-z0-9_./+-]*/g;

function tokenize(query: string): QueryTokens {
  const lower = query.toLowerCase();
  const words = new Set((lower.match(LATIN_WORD_RE) ?? []).filter(t => t.length >= 2));
  const bigrams = new Set<string>();
  for (const run of lower.match(CJK_RUN_RE) ?? []) {
    for (let i = 0; i + 1 < run.length; i++) {
      const bg = run.slice(i, i + 2);
      if (!BIGRAM_STOPWORDS.has(bg)) bigrams.add(bg);
    }
  }
  return { words: [...words], bigrams: [...bigrams] };
}

/**
 * Score a memory header against the query tokens.
 *
 * Weights:
 *   - word in name:        +2      | bigram in name:        +1
 *   - word in description: +1      | bigram in description: +0.5
 *   - recency boost:       +1 / (1 + ageDays)  — same-score tiebreaker
 *
 * Bigrams are half-weighted because a single shared character pair is far
 * weaker evidence than a shared word. On top of that, a memory matched ONLY
 * by bigrams needs ≥2 distinct matching bigrams — one shared pair (e.g. 数据)
 * is noise, two (数据 + 备份) is topical overlap.
 *
 * Returns 0 when nothing matches (caller decides whether to fall back to
 * pure-recency selection).
 */
function scoreMemory(tokens: QueryTokens, h: MemoryHeader): number {
  if (tokens.words.length === 0 && tokens.bigrams.length === 0) return 0;

  const name = h.name.toLowerCase();
  const desc = h.description.toLowerCase();

  let score = 0;
  for (const word of tokens.words) {
    if (name.includes(word)) score += 2;
    if (desc.includes(word)) score += 1;
  }

  let bigramScore = 0;
  let bigramMatches = 0;
  for (const bg of tokens.bigrams) {
    const inName = name.includes(bg);
    const inDesc = desc.includes(bg);
    if (inName) bigramScore += 1;
    if (inDesc) bigramScore += 0.5;
    if (inName || inDesc) bigramMatches++;
  }
  if (score > 0 || bigramMatches >= 2) score += bigramScore;

  if (score > 0) {
    const ageDays = (Date.now() - h.updated) / 86_400_000;
    score += 1 / (1 + Math.max(0, ageDays));
  }

  return score;
}

/**
 * Detect whether the user's message shows "recall intent" — i.e. explicitly
 * references past conversation, prior tasks, or remembered facts. Used to
 * gate the FALLBACK_FLOOR recency fill in findRelevantMemories so that
 * normal queries ("你好", "介绍你自己") don't trigger 3-5k of memory
 * injection by default.
 *
 * The fallback fill is the largest single contributor to Abu's baseline
 * overhead — for a user with 30+ memories it can easily inject 5k tokens
 * of unrelated content into every turn. Score-matched memories still flow
 * through; we only skip the recency-only floor.
 *
 * Trigger keywords intentionally conservative — better to over-trigger
 * than miss a "我之前提到的那个" intent. The model can still call the
 * `recall` tool explicitly when this heuristic misses.
 */
const RECALL_INTENT_RE = /上次|之前|那个|记得|你说过|跟你说过|刚才|忘了|还记得|提到过|聊过|讲过|昨天|前几天|我们/;

export function hasRecallIntent(query: string): boolean {
  return RECALL_INTENT_RE.test(query);
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
  //    floor-up to FALLBACK_FLOOR — but ONLY when the user shows recall
  //    intent (上次/之前/记得 etc). Normal queries like "你好" / "介绍你
  //    自己" no longer trigger the recency fill, which used to silently
  //    inject 3-5k tokens of unrelated context every turn.
  //
  //    Trade-off: users who want recall-like behavior on a query that
  //    doesn't keyword-match any memory now need to phrase their question
  //    with explicit intent words, OR the model can call the `recall` tool.
  const selected: ScoredHeader[] = matched.slice(0, MAX_SELECTED);
  if (selected.length < FALLBACK_FLOOR && hasRecallIntent(query)) {
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
