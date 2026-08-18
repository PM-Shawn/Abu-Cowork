/**
 * ToolSearch — deferred tool loading system.
 *
 * Core tools are always sent with full schema to the LLM.
 * Deferred tools (MCP, rarely-used builtins) only expose name + description.
 * The LLM can call `tool_search` to retrieve full schemas on demand.
 *
 * Once a deferred tool's schema is fetched, it's promoted to "session core"
 * for the rest of the conversation (no repeated search needed).
 */

import type { ToolDefinition } from '../../types';
import { CORE_TOOL_NAMES } from './toolPrefetch';

const DEFAULT_EXPOSURE_SCOPE = '__default__';
const MAX_PROMOTION_SCOPES = 200;
const DEFAULT_SEARCH_RESULTS = 5;
const MAX_SEARCH_RESULTS = 10;

/** Tools promoted to core after being searched, isolated per conversation. */
const promotedToolsByScope = new Map<string, Set<string>>();

function getPromotionSet(scope: string, create: boolean): Set<string> | undefined {
  const existing = promotedToolsByScope.get(scope);
  if (existing || !create) return existing;
  // Sidecar and renderer module state have independent lifetimes. Keep the
  // transient name-only cache bounded even if a deleted conversation cannot
  // notify the other process before it exits. Eviction only means an old
  // conversation may need to search for a schema again.
  if (promotedToolsByScope.size >= MAX_PROMOTION_SCOPES) {
    const oldestScope = promotedToolsByScope.keys().next().value as string | undefined;
    if (oldestScope) promotedToolsByScope.delete(oldestScope);
  }
  const created = new Set<string>();
  promotedToolsByScope.set(scope, created);
  return created;
}

/**
 * Reset session promotions (call on new conversation or session start)
 */
export function resetSessionPromotions(scope?: string): void {
  if (scope) {
    promotedToolsByScope.delete(scope);
    return;
  }
  promotedToolsByScope.clear();
}

/**
 * Promote a tool to session-core so it's included in full schema for subsequent turns.
 */
export function promoteToolToSession(toolName: string, scope = DEFAULT_EXPOSURE_SCOPE): void {
  getPromotionSet(scope, true)!.add(toolName);
}

/**
 * Check if a tool is promoted for this session.
 */
export function isSessionPromoted(toolName: string, scope = DEFAULT_EXPOSURE_SCOPE): boolean {
  return getPromotionSet(scope, false)?.has(toolName) ?? false;
}

/**
 * Resolve tool_search input against a trusted deferred list. Both the
 * shell-executed tool and the sidecar-hosted Agent Loop use this function so a
 * successful search can be promoted without parsing human-readable tool output
 * (which may contain third-party MCP descriptions).
 */
export function resolveDeferredToolSearch(
  input: Record<string, unknown>,
  deferredTools: ToolDefinition[],
): ToolDefinition[] {
  const query = typeof input.query === 'string' ? input.query : '';
  const rawMax = input.max_results;
  const maxResults = typeof rawMax === 'number' && Number.isFinite(rawMax) && rawMax > 0
    ? Math.min(MAX_SEARCH_RESULTS, Math.max(1, Math.floor(rawMax)))
    : DEFAULT_SEARCH_RESULTS;
  return searchTools(query, deferredTools, maxResults);
}

/** Promote the deterministic matches from a successful tool_search call. */
export function promoteSearchedDeferredTools(
  input: Record<string, unknown>,
  deferredTools: ToolDefinition[],
  scope = DEFAULT_EXPOSURE_SCOPE,
): string[] {
  const matched = resolveDeferredToolSearch(input, deferredTools);
  for (const tool of matched) {
    promoteToolToSession(tool.name, scope);
  }
  return matched.map(tool => tool.name);
}

/**
 * Classify tools into core (full schema) and deferred (name + description only).
 *
 * A tool is "core" if:
 * - It's in CORE_TOOL_NAMES (always loaded)
 * - It was prefetched for this turn (keyword match)
 * - It was promoted during this session (previously searched)
 *
 * @param allTools - All resolved tools for this turn
 * @param prefetchedNames - Tool names prefetched via keyword matching
 * @returns { coreTools, deferredTools }
 */
export function classifyTools(
  allTools: ToolDefinition[],
  prefetchedNames: Set<string>,
  scope = DEFAULT_EXPOSURE_SCOPE,
): { coreTools: ToolDefinition[]; deferredTools: ToolDefinition[] } {
  const coreTools: ToolDefinition[] = [];
  const deferredTools: ToolDefinition[] = [];

  for (const tool of allTools) {
    if (
      CORE_TOOL_NAMES.has(tool.name) ||
      prefetchedNames.has(tool.name) ||
      isSessionPromoted(tool.name, scope)
    ) {
      // Keyword-prefetched tools become session-sticky, same as tool_search
      // promotions. Without this the active/deferred split flaps with each
      // turn's input keywords (promoted on a matching turn, demoted on the
      // next), churning both the system prompt's deferred-tools section and
      // the serialized tools list — each flap invalidates the provider-side
      // prompt cache. Promotion is monotonic per conversation: one cache
      // rebuild when a tool first becomes relevant, none when it stops being
      // mentioned. (Verified against real captured request bodies — see
      // docs/abu-token-latency-pass-plan.md §7.)
      if (prefetchedNames.has(tool.name)) promoteToolToSession(tool.name, scope);
      coreTools.push(tool);
    } else {
      deferredTools.push(tool);
    }
  }

  return { coreTools, deferredTools };
}

/**
 * Search deferred tools by query string (fuzzy matching on name + description).
 *
 * @param query - Search query (keywords or tool name fragment)
 * @param allTools - Full tool definitions to search through
 * @param maxResults - Max number of results (default 5)
 * @returns Matched tool definitions with full schema
 */
export function searchTools(
  query: string,
  allTools: ToolDefinition[],
  maxResults: number = 5,
): ToolDefinition[] {
  if (!query.trim()) return [];

  const lowerQuery = query.toLowerCase();
  const queryTerms = lowerQuery.split(/\s+/).filter(Boolean);

  // Score each tool by relevance
  const scored = allTools.map(tool => {
    const name = tool.name.toLowerCase();
    const desc = tool.description.toLowerCase();
    let score = 0;

    // Exact name match — highest priority
    if (name === lowerQuery) {
      score += 100;
    }

    // Name contains query
    if (name.includes(lowerQuery)) {
      score += 50;
    }

    // Term matching
    for (const term of queryTerms) {
      if (name.includes(term)) score += 20;
      if (desc.includes(term)) score += 5;
    }

    // Name starts with a query term
    for (const term of queryTerms) {
      if (name.startsWith(term)) score += 10;
    }

    return { tool, score };
  });

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(s => s.tool);
}

/**
 * Build a compact summary of deferred tools for the system prompt.
 * Format: "- tool_name — description (first line)"
 */
export function buildDeferredToolsSummary(deferredTools: ToolDefinition[]): string {
  if (deferredTools.length === 0) return '';

  const lines = deferredTools.map(t => {
    // Take first sentence or first 80 chars of description
    const desc = t.description.split(/[。\n]/)[0].slice(0, 80);
    return `- ${t.name} — ${desc}`;
  });

  return `## 延迟加载工具\n以下工具可用，但需要先通过 tool_search 获取完整参数后才能调用：\n${lines.join('\n')}`;
}
