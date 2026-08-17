/**
 * Prompt Section System — enables per-section cache control for Anthropic API.
 *
 * System prompt is split into sections, each marked as cacheable or volatile.
 * Cacheable sections (persona, planning instructions, project rules, safety)
 * get `cache_control: { type: 'ephemeral' }` — reused across turns within
 * the 5-minute TTL window, saving ~50% input token cost.
 *
 * Volatile sections (current time, MCP capabilities, active skills) change
 * every turn and are sent without cache_control.
 *
 * For non-Anthropic providers that don't support cache_control, sections
 * are simply concatenated into a plain string via `sectionsToString()`.
 */

export interface PromptSection {
  /** Human-readable name for debugging */
  name: string;
  /** The text content of this section */
  text: string;
  /**
   * Whether this section's content is stable across turns.
   * true = content changes rarely (persona, rules, safety) → gets cache_control
   * false = content changes every turn (time, MCP, skills) → no cache_control
   */
  cacheable: boolean;
  /**
   * Pin this section to the absolute end of the prompt, after the volatile
   * tail. Used by the safety anchor: recency bias makes the last-read
   * instructions weigh most, so the safety rules must follow everything —
   * including per-turn volatile content. A pinned section must also be
   * `cacheable: false`: it sits after volatile content, so including it in
   * the cached prefix would embed per-turn bytes and break the cache.
   */
  pinToEnd?: boolean;
}

/**
 * Merge adjacent sections with the same cacheability to minimize
 * the number of TextBlock params sent to the API.
 *
 * Example: [cacheable, cacheable, volatile, cacheable] → [cacheable, volatile, cacheable]
 */
export function mergeSections(sections: PromptSection[]): PromptSection[] {
  if (sections.length === 0) return [];

  const merged: PromptSection[] = [];
  let current = { ...sections[0] };

  for (let i = 1; i < sections.length; i++) {
    const next = sections[i];
    if (next.cacheable === current.cacheable) {
      // Same cacheability — merge text
      current.text += '\n\n' + next.text;
      current.name += '+' + next.name;
    } else {
      merged.push(current);
      current = { ...next };
    }
  }
  merged.push(current);
  return merged;
}

/**
 * Stable-partition sections for prompt caching: cacheable sections first
 * (original relative order), then volatile sections, then pinned-to-end
 * sections (each group keeps its original relative order).
 *
 * Prompt caching is a byte-prefix match on every provider (Anthropic caches up
 * to the last cache_control breakpoint; DeepSeek/OpenAI auto-cache the longest
 * matching prefix). A volatile section in the middle of the prompt — e.g. a
 * minute-granularity timestamp — therefore invalidates every cacheable section
 * after it on every turn. Moving all volatile content behind the last cacheable
 * section keeps the cached prefix byte-stable across turns.
 *
 * The pinned tail (see PromptSection.pinToEnd) lets the safety anchor stay the
 * literal last thing the model reads even though volatile sections exist.
 */
export function orderSectionsForCaching(sections: PromptSection[]): PromptSection[] {
  const cacheable = sections.filter(s => s.cacheable && !s.pinToEnd);
  const volatile = sections.filter(s => !s.cacheable && !s.pinToEnd);
  const pinned = sections.filter(s => s.pinToEnd);
  return [...cacheable, ...volatile, ...pinned];
}

/**
 * Fallback: concatenate all sections into a single string.
 * Used for non-Anthropic providers that don't support cache_control.
 */
export function sectionsToString(sections: PromptSection[]): string {
  return sections.map(s => s.text).join('\n\n');
}
