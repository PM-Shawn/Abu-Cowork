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
 * Fallback: concatenate all sections into a single string.
 * Used for non-Anthropic providers that don't support cache_control.
 */
export function sectionsToString(sections: PromptSection[]): string {
  return sections.map(s => s.text).join('\n\n');
}
