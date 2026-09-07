/**
 * The actions this channel forwards to the content script, as data.
 *
 * Three separate hand-written lists used to answer the same question — the
 * `switch` in `background/index.ts`, the `domActions` set in
 * `electron/browserHost.cjs`, and `BROWSER_TOOL_SUFFIXES` in
 * `src/core/tools/toolPrefetch.ts` — plus a fourth copy re-typed inside
 * `background/index.test.ts` to test the first one. Nothing in the compiler
 * links them, and each failure mode looks like a different bug: a missing
 * routing entry answers `Unknown action: find` (reads as "the tool is
 * broken"), while a missing prefetch entry means the tool is never offered at
 * all (reads as "the tool does not exist").
 *
 * Keeping the list in its own module removes the fourth copy outright — the
 * test now imports the same object the router uses — and gives
 * `src/core/tools/browserToolRouting.test.ts` something to compare against the
 * bridge's REAL registration, so a newly registered tool that nobody routed
 * fails a test instead of shipping.
 *
 * No `chrome.*` access here on purpose: this module has to be importable from
 * a plain Node test process.
 */
export const CONTENT_SCRIPT_ACTIONS: ReadonlySet<string> = new Set([
  'snapshot',
  'find',
  'get_html',
  'click',
  'fill',
  'select',
  'wait_for',
  'extract_text',
  'extract_table',
  'scroll',
  'keyboard',
  'start_recording',
  'stop_recording',
]);
