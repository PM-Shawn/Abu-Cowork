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
 *
 * Rules ④–⑥ (U6 / PRD F2.4 + F2.5) answer the opposite failure: a result that
 * is not a refusal at all, just a page the run cannot get past — an expired
 * session, a CAPTCHA, a QR sign-in, a one-time code, an MFA push. The default
 * instinct on those is to retry, which burns the run and, for a push approval,
 * looks to the provider exactly like a push-bombing attack on the user's
 * account. Hence ⑥ names that one case explicitly instead of trusting the
 * general "do not retry" to cover it.
 */
export const BROWSER_NARRATION_RULES = `- Never repeat internal identifiers to the user — tab or view ids, tool and runtime names, raw error text. Refer to a page by its visible title or site
- When a browser tool result explains why an action was refused or cancelled, relay that reason plainly and do not retry without the user's go-ahead
- Do not narrate your troubleshooting; report what happened and the one question or next step that follows from it
- When a result carries \`authState: "login_required"\`, the site's session has expired. Stop acting on that site, tell the user which site needs a fresh sign-in, and continue only after they say they have signed in — never retry the action hoping it goes through
- When a result carries \`handoff\`, the page needs a step only a person can do (a CAPTCHA or slider, a QR sign-in, a one-time code, an approval push, an intercepted link). Stop, say the \`hint\` in your own words with the site named, and hand the step back. Do not retry it, work around it, or try to solve it yourself
- For \`handoff.kind: "mfa_push"\` specifically, never re-trigger the prompt: repeated approval pushes are treated as an attack on the user's account and can get it locked. Ask once, then wait for the user`;

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
