import { describe, it, expect } from 'vitest';
import {
  BROWSER_NARRATION_RULES,
  browserNarrationSection,
  rosterHasBrowserTool,
} from './browserNarrationRules';

/**
 * C8 — how the model may TALK about browser work.
 *
 * The rules live here rather than inline in either prompt builder because they
 * have two injection sites that must not drift: `orchestrator.ts`'s
 * `browser-guide` section (main loop) and `subagentLoop.ts`'s own prompt build
 * (delegations, which own browser tabs per run and were getting none of this).
 */
describe('rosterHasBrowserTool', () => {
  it('recognises the built-in browser and the Chrome bridge', () => {
    expect(rosterHasBrowserTool(['read_file', 'abu-browser__get_tabs'])).toBe(true);
    // The bridge prefix is NOT a superstring of the built-in one
    // (`abu-browser-bridge__` vs `abu-browser__`), so it needs its own check.
    expect(rosterHasBrowserTool(['abu-browser-bridge__snapshot'])).toBe(true);
  });

  it('does not fire on a roster with no browser tool', () => {
    expect(rosterHasBrowserTool(['read_file', 'run_command', 'web_search'])).toBe(false);
    expect(rosterHasBrowserTool([])).toBe(false);
  });

  it('does not fire on a lookalike name that is not a browser tool', () => {
    expect(rosterHasBrowserTool(['abu-browserish__click', 'browser_notes'])).toBe(false);
  });
});

describe('browserNarrationSection', () => {
  it('is empty when the run cannot touch a browser at all', () => {
    // A subagent with no browser tools must not pay tokens for rules about a
    // capability it does not have.
    expect(browserNarrationSection(['read_file'])).toBe('');
  });

  it('carries all three rules under a heading when a browser tool is offered', () => {
    const section = browserNarrationSection(['abu-browser__get_tabs']);
    expect(section).toContain('## Browser Operations');
    expect(section).toContain(BROWSER_NARRATION_RULES);
  });
});

describe('BROWSER_NARRATION_RULES', () => {
  it('bans internal identifiers and names what to say instead', () => {
    expect(BROWSER_NARRATION_RULES).toContain('Never repeat internal identifiers to the user');
    expect(BROWSER_NARRATION_RULES).toContain('by its visible title or site');
  });

  it('covers any reasoned refusal, not an enumerated few', () => {
    // The earlier wording listed three reasons (closed tab / user interacting /
    // rate-limited) and so said nothing about the blocked-site denial or the
    // run-stopped cancellation — the D4 case it was written to answer.
    expect(BROWSER_NARRATION_RULES).toContain('explains why an action was refused or cancelled');
    expect(BROWSER_NARRATION_RULES).toContain("do not retry without the user's go-ahead");
    expect(BROWSER_NARRATION_RULES).not.toContain('rate-limiting');
  });

  it('forbids narrating troubleshooting', () => {
    expect(BROWSER_NARRATION_RULES).toContain('Do not narrate your troubleshooting');
  });
});
