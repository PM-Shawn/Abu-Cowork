/**
 * C8 — narration discipline for browser work.
 *
 * Three observed breaks, one each:
 *  - the model relayed an internal identifier to the user ("the tab id changed
 *    from 2 to 3") because the refusal it read had nothing else in it;
 *  - it reported a refusal with no reason at all ("the action was cancelled"),
 *    though the tool result carried one;
 *  - it narrated its own retries instead of reporting the outcome.
 *
 * The text lives in this module, not inline in a prompt builder, because it has
 * TWO injection sites that must not drift: `orchestrator.ts`'s `browser-guide`
 * section (the main loop) and `subagentLoop.ts`'s own prompt build. Subagent
 * browser work is first-class — tabs are owned per RUN — so a delegation
 * driving a page needs the same discipline as the loop that spawned it.
 *
 * Rule ② is deliberately phrased over ANY reasoned refusal rather than an
 * enumerated list: the browser domain refuses for at least six reasons (reclaim
 * window, takeover backoff, HTTP 429, run stopped, blocked site, cross-
 * conversation tab), and an enumeration silently excuses the model from the
 * ones it forgot to mention.
 */
export const BROWSER_NARRATION_RULES = `- Never repeat internal identifiers to the user — tab or view ids, tool and runtime names, raw error text. Refer to a page by its visible title or site
- When a browser tool result explains why an action was refused or cancelled, relay that reason plainly and do not retry without the user's go-ahead
- Do not narrate your troubleshooting; report what happened and the one question or next step that follows from it`;

/** Both browser runtimes, by tool-name prefix (see `toolPrefetch.ts`). */
const BROWSER_TOOL_PREFIXES = ['abu-browser__', 'abu-browser-bridge__'];

/**
 * Does this run's tool roster contain a browser tool at all? Prefix-matched
 * rather than enumerated, so a tool added to either runtime does not silently
 * stop counting as browser work.
 */
export function rosterHasBrowserTool(toolNames: Iterable<string>): boolean {
  for (const name of toolNames) {
    if (BROWSER_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix))) return true;
  }
  return false;
}

/**
 * The rules as a standalone prompt section, or `''` when the run holds no
 * browser tool — a roster that cannot reach a page must not pay tokens for
 * rules about pages.
 *
 * The main loop does NOT use this: its `browser-guide` section already exists
 * and appends `BROWSER_NARRATION_RULES` into it, so the guidance stays one
 * heading rather than two.
 */
export function browserNarrationSection(toolNames: Iterable<string>): string {
  if (!rosterHasBrowserTool(toolNames)) return '';
  return `\n\n## Browser Operations\n${BROWSER_NARRATION_RULES}`;
}
