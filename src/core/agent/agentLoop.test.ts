import { describe, it, expect } from 'vitest';
import {
  escalateMaxOutputTokens,
  shouldContinueTruncatedToolCalls,
  isInteractiveDesktop,
  shouldComputeProposalSignal,
  isIncompleteReason,
  isVisionUnsupportedError,
  getCapabilityPrompt,
} from './agentLoop';

describe('escalateMaxOutputTokens', () => {
  it('does not escalate when recoveryCount is 0', () => {
    const result = escalateMaxOutputTokens(8192, 200000, 0);
    expect(result).toEqual({ maxOutputTokens: 8192, changed: false });
  });

  it('doubles maxOutputTokens on first recovery', () => {
    const result = escalateMaxOutputTokens(8192, 200000, 1);
    expect(result).toEqual({ maxOutputTokens: 16384, changed: true });
  });

  // Bug #5 regression: escalation must STAY escalated across recoveries, not fall
  // back to base after the first. Previously a one-shot `alreadyEscalated` latch
  // made the budget go base → 2x → base → base. Fix: a fixed 2x that persists for
  // every recovery (base → 2x → 2x → 2x) — capped, and aligned with the recovery
  // prompt that tells the model to break remaining work into smaller pieces (so the
  // budget needn't grow unboundedly and can't starve the input-context budget).
  it('stays escalated across later recoveries (regression: was base → 2x → base)', () => {
    expect(escalateMaxOutputTokens(8192, 200000, 2)).toEqual({ maxOutputTokens: 16384, changed: true });
    expect(escalateMaxOutputTokens(8192, 200000, 3)).toEqual({ maxOutputTokens: 16384, changed: true });
  });

  it('caps at contextWindowSize - 1000', () => {
    // contextWindow is 10000, so cap = 9000, doubling 8192 would be 16384 > 9000
    const result = escalateMaxOutputTokens(8192, 10000, 1);
    expect(result).toEqual({ maxOutputTokens: 9000, changed: true });
  });

  it('does not escalate when already at context limit', () => {
    // currentMax=9000, contextWindow=10000, cap=9000 — doubling gives 9000, not > 9000
    const result = escalateMaxOutputTokens(9000, 10000, 1);
    expect(result).toEqual({ maxOutputTokens: 9000, changed: false });
  });

  it('works with large context windows', () => {
    const result = escalateMaxOutputTokens(32768, 1000000, 2);
    expect(result).toEqual({ maxOutputTokens: 65536, changed: true });
  });
});

// Bug #4: a turn cut off by max_tokens AFTER emitting complete tool calls. The
// adapter only emits a tool_use event on content_block_stop, so a call truncated
// mid-JSON is dropped — collected calls are complete. The loop must send their
// results back (continue) instead of discarding them / ending the turn — UNLESS
// every collected call is malformed (_parse_error), which is not real progress:
// continuing on an all-malformed batch would spin a broken model forever in
// agentLoop (no no-progress guard, default unlimited maxTurns).
describe('shouldContinueTruncatedToolCalls', () => {
  const wellFormed = (n: number) => Array.from({ length: n }, () => ({ input: { x: 1 } }));

  it('continues when max_tokens truncated after a well-formed tool call', () => {
    expect(shouldContinueTruncatedToolCalls('max_tokens', wellFormed(2))).toBe(true);
  });

  it('does not continue with no tool calls (pure text truncation → resume path)', () => {
    expect(shouldContinueTruncatedToolCalls('max_tokens', [])).toBe(false);
  });

  it('does not continue when ALL tool calls are malformed (avoids spinning a broken model)', () => {
    expect(shouldContinueTruncatedToolCalls('max_tokens', [{ input: { _parse_error: 'bad json' } }])).toBe(false);
  });

  it('continues if at least one tool call is well-formed among malformed ones', () => {
    expect(shouldContinueTruncatedToolCalls('max_tokens', [
      { input: { _parse_error: 'bad json' } },
      { input: { x: 1 } },
    ])).toBe(true);
  });

  it('does not apply on a clean tool_use stop (normal continuation path)', () => {
    expect(shouldContinueTruncatedToolCalls('tool_use', wellFormed(2))).toBe(false);
  });

  it('does not apply on end_turn', () => {
    expect(shouldContinueTruncatedToolCalls('end_turn', [])).toBe(false);
  });
});

// Task #49 · Gate that protects memory extraction + post-loop proposal
// signal from firing in headless contexts. Regression-critical because
// the bug mode is silent: failing gates leak skill drafts and memories
// into user-invisible directories.
describe('isInteractiveDesktop', () => {
  it('desktop conversation (no imContext, no scheduledTaskId, no triggerId) → true', () => {
    expect(isInteractiveDesktop(undefined, {})).toBe(true);
    expect(isInteractiveDesktop({}, undefined)).toBe(true);
    expect(isInteractiveDesktop({}, {})).toBe(true);
  });

  it('IM headless conversation (imContext set) → false', () => {
    expect(
      isInteractiveDesktop(
        { imContext: { platform: 'dchat', workspacePath: '/ws' } },
        {},
      ),
    ).toBe(false);
  });

  it('scheduled-task conversation → false', () => {
    expect(isInteractiveDesktop({}, { scheduledTaskId: 'task-42' })).toBe(false);
  });

  it('trigger-run conversation → false', () => {
    expect(isInteractiveDesktop({}, { triggerId: 'trigger-7' })).toBe(false);
  });

  it('absent conversation record (shouldn’t happen, defensive) → falls through to options-only check', () => {
    // convRecord may be absent if the conversation was deleted mid-run.
    // The gate should not crash and should rely on options to decide.
    expect(isInteractiveDesktop(undefined, undefined)).toBe(true);
    expect(
      isInteractiveDesktop(
        { imContext: { platform: 'dchat', workspacePath: '/ws' } },
        undefined,
      ),
    ).toBe(false);
  });

  it('any single headless marker is enough to lock the gate', () => {
    // Pathological combo shouldn't accidentally re-open the gate — each
    // marker is an independent "headless" condition.
    expect(
      isInteractiveDesktop(
        { imContext: { channelId: 'c', platform: 'dchat', workspacePath: '/ws' } },
        { scheduledTaskId: 'x', triggerId: 'y' },
      ),
    ).toBe(false);
  });
});

// Task #51 · Stricter gate for post-loop proposal signal. Adds a
// workspace-bound check on top of isInteractiveDesktop — without a
// workspace, skill_manage can't write, AND the next turn's system
// prompt will already carry a workspace-hint telling the agent "don't
// call skill_manage, call request_workspace first". Stacking the
// proposal-signal on top gives contradictory instructions.
describe('shouldComputeProposalSignal (Task #51 gate)', () => {
  const desktopOpts = {};
  const desktopConv = {};

  it('fires on desktop + workspace bound (baseline)', () => {
    expect(shouldComputeProposalSignal(desktopOpts, desktopConv, '/workspace/myapp')).toBe(true);
  });

  it('blocks when no workspace is bound (the Task #51 fix)', () => {
    // Regression guard for the workspace-hint ↔ proposal-signal
    // conflict: without a workspace, the signal would stack on top
    // of the "call request_workspace first" prompt.
    expect(shouldComputeProposalSignal(desktopOpts, desktopConv, null)).toBe(false);
    expect(shouldComputeProposalSignal(desktopOpts, desktopConv, undefined)).toBe(false);
    expect(shouldComputeProposalSignal(desktopOpts, desktopConv, '')).toBe(false);
  });

  it('inherits isInteractiveDesktop blockers — IM context blocks even with workspace', () => {
    expect(
      shouldComputeProposalSignal(
        { imContext: { platform: 'dchat', workspacePath: '/ws' } },
        desktopConv,
        '/workspace/myapp',
      ),
    ).toBe(false);
  });

  it('inherits isInteractiveDesktop blockers — scheduled task + workspace still blocked', () => {
    expect(
      shouldComputeProposalSignal(
        desktopOpts,
        { scheduledTaskId: 'task-1' },
        '/workspace/myapp',
      ),
    ).toBe(false);
  });

  it('inherits isInteractiveDesktop blockers — trigger + workspace still blocked', () => {
    expect(
      shouldComputeProposalSignal(
        desktopOpts,
        { triggerId: 'trigger-1' },
        '/workspace/myapp',
      ),
    ).toBe(false);
  });
});

// C — structured termination reason. Before this, the maxTurns branch routed a
// `done` event with reason 'max_turns' to the UI but still returned
// AgentLoopResult.reason === 'completed', so headless callers (scheduler, trigger)
// could not tell "ran to completion" from "hit the turn cap". isIncompleteReason
// marks the reasons where the loop stopped on a guard rather than finishing.
describe('isIncompleteReason', () => {
  it('is true for max_turns', () => {
    expect(isIncompleteReason('max_turns')).toBe(true);
  });

  it('is true for no_progress', () => {
    expect(isIncompleteReason('no_progress')).toBe(true);
  });

  it('is false for completed', () => {
    expect(isIncompleteReason('completed')).toBe(false);
  });

  it('is false for aborted', () => {
    expect(isIncompleteReason('aborted')).toBe(false);
  });

  it('is false for error', () => {
    expect(isIncompleteReason('error')).toBe(false);
  });
});

describe('getCapabilityPrompt — visual-output variant selection', () => {
  it('instructs show_widget (no fence) by default / for tool-capable models', () => {
    for (const prompt of [getCapabilityPrompt(), getCapabilityPrompt({ supportsTools: true })]) {
      expect(prompt).toContain('call the show_widget tool');
      expect(prompt).toContain('read_me');
      expect(prompt).not.toContain('```html code block');
    }
  });

  it('falls back to the ```html-fence instruction when supportsTools is false (tools=[] models)', () => {
    const prompt = getCapabilityPrompt({ supportsTools: false });
    expect(prompt).toContain('```html code block');
    // Fence fragment discipline retained (rewording is deliberate — the fragment
    // ban is now sourced from the shared WIDGET_HARD_BAN_RULES list, see the
    // consistency describe block below).
    expect(prompt).toContain('<!DOCTYPE>');
    expect(prompt).toContain('raw HTML/SVG fragment');
    expect(prompt).not.toContain('show_widget');
    expect(prompt).not.toContain('read_me');
    // No tools at all in this mode (noTools gate) — the visual-output section
    // must not OFFER a write_file save escalation. (The fragment ban's contrast
    // note "a saved write_file page is the opposite" is fine — it's a clarifying
    // reference, not an escalation the model can take here.) The shared
    // "Editing an already-exported file" section further down is a separate,
    // pre-existing block, out of scope — hence the slice.
    const visualSection = prompt.slice(0, prompt.indexOf('Editing an already-exported file'));
    expect(visualSection).not.toContain('write_file a COMPLETE');
    expect(visualSection).toContain("there's no separate saved-file path");
  });

  it('keeps the shared sections in both variants', () => {
    for (const prompt of [getCapabilityPrompt(), getCapabilityPrompt({ supportsTools: false })]) {
      expect(prompt).toContain('Editing an already-exported file');
      expect(prompt).toContain('Style requirement');
    }
  });

  it('states the three trigger tiers (explicit / proactive / implied-by-noun-phrase) in both variants', () => {
    for (const prompt of [getCapabilityPrompt(), getCapabilityPrompt({ supportsTools: false })]) {
      expect(prompt).toContain('explicit ask');
      expect(prompt).toContain('proactive');
      expect(prompt).toContain('implied by the noun phrase');
      // The noun-phrase tier's whole point: a table is not a substitute for a rendered visual
      expect(prompt).toContain('markdown table');
    }
  });

  it('makes the proactive tier an imperative directive, not a soft descriptive parenthetical (measured — scoped to teaching/how-it-works/compare/architecture, not "always")', () => {
    for (const prompt of [getCapabilityPrompt(), getCapabilityPrompt({ supportsTools: false })]) {
      // Imperative verb + explicit "don't fall back to prose alone" instruction —
      // this is what makes it a directive rather than a descriptive aside.
      expect(prompt).toContain('proactively make a visual');
      expect(prompt).toContain("don't answer in prose alone");
      // Scoped to the clear educational/comparison cases — not "for everything".
      expect(prompt).toContain('how-does-X-work');
      expect(prompt).toContain('teaching');
      expect(prompt).toContain('architecture');
      expect(prompt).toContain('compare A vs B');
      expect(prompt).not.toContain('always make a visual');
    }
  });

  it('states the A/B routing boundary ("is this a file the user wants to keep?") for the tool variant', () => {
    const prompt = getCapabilityPrompt({ supportsTools: true });
    expect(prompt).toContain('is this a file the user wants to keep?');
    expect(prompt).toContain('save, export, download, or keep as a real file');
    // The escalation target: a complete self-contained document via write_file
    expect(prompt).toContain('COMPLETE self-contained');
    // C2: the preview claim is non-absolute — auto-open only fires for the LAST
    // non-image deliverable of the turn (MessageGroup.tsx), so the prompt must
    // not promise it ALWAYS auto-opens.
    expect(prompt).toContain('can then be opened in the side preview panel');
    expect(prompt).not.toContain('opens automatically');
  });

  it('C1: the fragment ban is scoped to the inline widget, and does NOT contradict the saved-page complete-document rule', () => {
    // The fragment-only ban previously read as an unconditional "no doctype/html/head/body",
    // contradicting the routing line that tells the model to write a COMPLETE self-contained
    // .html for a saved page. The ban bullet must now name the inline/widget scope AND flag
    // the saved page as the opposite.
    for (const prompt of [getCapabilityPrompt(), getCapabilityPrompt({ supportsTools: false })]) {
      expect(prompt).toContain('inline widget: a raw HTML/SVG fragment');
      expect(prompt).toContain('a saved write_file page is the opposite: a complete document');
    }
  });

  it('C3: the fence (no-tools) variant enumerates the utility classes inline, since it cannot call read_me', () => {
    const fence = getCapabilityPrompt({ supportsTools: false });
    for (const cls of ['.w-card', '.w-stat', '.w-grid', '.w-row', '.w-badge', '.w-btn']) {
      expect(fence).toContain(cls);
    }
    expect(fence).toContain('--w-*');
    // The tool variant keeps the read_me pointer (those models CAN call read_me),
    // so it does NOT need the inline class enumeration.
    expect(getCapabilityPrompt({ supportsTools: true })).toContain('read_me');
  });

  it('C4: the trigger examples do not invite a bare <form> (validator hard-rejects <form> elements)', () => {
    for (const prompt of [getCapabilityPrompt(), getCapabilityPrompt({ supportsTools: false })]) {
      expect(prompt).not.toContain('signup form mockup');
      // A short note steers form-shaped mockups to plain controls.
      expect(prompt).toContain('never a real <form>');
    }
  });

  it('includes the hard-ban bullets (opacity/position:fixed/100vh/theme-aware/inline-fragment) in both variants', () => {
    for (const prompt of [getCapabilityPrompt(), getCapabilityPrompt({ supportsTools: false })]) {
      expect(prompt).toContain('opacity: 0');
      expect(prompt).toContain('position: fixed');
      expect(prompt).toContain('100vh');
      expect(prompt).toContain('theme-aware only');
      expect(prompt).toContain('never hardcode white/black');
      expect(prompt).toContain('raw HTML/SVG fragment');
    }
  });

  it('Cleanup5: the hard-bans block and the CDN-allowed line are shared verbatim across both variants', () => {
    const tool = getCapabilityPrompt({ supportsTools: true });
    const fence = getCapabilityPrompt({ supportsTools: false });
    // Same generated bans block in both (single constant, can't drift).
    const bansHeader = '**Hard bans** (cause a blank/broken render):';
    expect(tool).toContain(bansHeader);
    expect(fence).toContain(bansHeader);
    // Same CDN-allowed line in both.
    const allowedLine = '**Allowed**: CDN libraries (Chart.js, D3, etc.):';
    expect(tool).toContain(allowedLine);
    expect(fence).toContain(allowedLine);
  });

  it('routes static structure diagrams to ```mermaid without contradicting the show_widget default (tool variant)', () => {
    const prompt = getCapabilityPrompt({ supportsTools: true });
    // The show_widget default is still present and unchanged.
    expect(prompt).toContain('call the show_widget tool');
    // The mermaid carve-out is present, named as a carve-out (scoping down, not replacing).
    expect(prompt).toContain('```mermaid');
    expect(prompt).toContain('STATIC structure');
    expect(prompt).toContain('built-in Mermaid engine');
    expect(prompt).toContain('no sandbox');
    // Explicit non-contradiction language: this narrows the default, doesn't override it.
    expect(prompt).toContain('narrows, not replaces');
    // The carve-out still routes everything else back to show_widget.
    expect(prompt).toContain('show_widget stays the default for everything dynamic, interactive, data-driven, or chart-like');
    // A reading-oriented milestones/history timeline is EXCLUDED from the mermaid
    // carve-out (routes to show_widget's poster-style timeline instead) — it is
    // not node/edge structure, and the model over-generalizes "timeline" ->
    // mermaid's own (underwhelming) `timeline` diagram type without this clause.
    expect(prompt).toContain('reading-oriented timeline of milestones/history');
    expect(prompt).toContain('is not a structure graph');
    expect(prompt).toContain('use show_widget (poster-style timeline)');
    // The distinction is BY PURPOSE, not keyword: a project-scheduling Gantt
    // stays on Mermaid, so the timeline exclusion must NOT contradict it.
    expect(prompt).toContain('Gantt chart (project scheduling — tasks with start/end dates)');
    expect(prompt).toContain('Project-scheduling Gantt charts still use Mermaid');
    // Names concrete static-structure diagram kinds so a weak model can pattern-match.
    // ER diagram / Gantt chart were folded in from the mermaid-diagram builtin skill's
    // type table once that skill's auto-invoke was disabled (see guidelines.ts).
    for (const kind of ['flowchart', 'tree', 'sequence diagram', 'state machine', 'org chart', 'node/edge graph', 'ER diagram', 'Gantt chart']) {
      expect(prompt).toContain(kind);
    }
  });

  it('routes static structure diagrams to ```mermaid without contradicting the ```html default (fence variant)', () => {
    const prompt = getCapabilityPrompt({ supportsTools: false });
    // The ```html default is still present and unchanged.
    expect(prompt).toContain('```html code block');
    // The mermaid carve-out is present, scoped to static structure.
    expect(prompt).toContain('```mermaid');
    expect(prompt).toContain('STATIC structure');
    expect(prompt).toContain('built-in Mermaid engine');
    // A reading-oriented milestones/history timeline is excluded here too, pointed
    // at an ```html poster-style timeline (this mode has no show_widget tool at all).
    expect(prompt).toContain('reading-oriented timeline of milestones/history');
    expect(prompt).toContain('is not a structure graph');
    expect(prompt).toContain('```html poster-style timeline');
    // The project-scheduling Gantt qualifier keeps the two rules non-contradictory.
    expect(prompt).toContain('Gantt chart (project scheduling — tasks with start/end dates)');
    expect(prompt).toContain('Project-scheduling Gantt charts still use Mermaid');
    // Everything else stays on the ```html fragment path (no tools in this mode).
    expect(prompt).toContain('Use an ```html fragment for everything dynamic, interactive, data-driven, or chart-like');
  });
});

// Single-source consistency: the capability prompt's hard-ban bullets must be
// generated FROM guidelines.ts's WIDGET_HARD_BAN_RULES (not a hand-copied
// second list) — this is what stops the prompt-level ban list and read_me's
// detailed guide text from drifting apart over time.
describe('getCapabilityPrompt — hard-ban single source (guidelines.ts)', () => {
  it('every prompt-listed WIDGET_HARD_BAN_RULES brief phrase appears verbatim in both prompt variants', async () => {
    const { WIDGET_HARD_BAN_RULES, getWidgetHardBanBriefList } = await import('../widget/guidelines');
    const toolPrompt = getCapabilityPrompt({ supportsTools: true });
    const fencePrompt = getCapabilityPrompt({ supportsTools: false });
    for (const rule of WIDGET_HARD_BAN_RULES.filter((r) => r.inPromptBanList)) {
      expect(toolPrompt).toContain(rule.brief);
      expect(fencePrompt).toContain(rule.brief);
    }
    // Both variants embed the exact generated bullet list, not a paraphrase.
    const briefList = getWidgetHardBanBriefList();
    expect(toolPrompt).toContain(briefList);
    expect(fencePrompt).toContain(briefList);
  });

  it('storage/form rules stay read_me-only (runtime-enforced by widgetTools.ts, not spent in the always-in-context prompt)', async () => {
    const { WIDGET_HARD_BAN_RULES } = await import('../widget/guidelines');
    const storageRule = WIDGET_HARD_BAN_RULES.find((r) => r.id === 'storage')!;
    const formRule = WIDGET_HARD_BAN_RULES.find((r) => r.id === 'form')!;
    expect(storageRule.inPromptBanList).toBe(false);
    expect(formRule.inPromptBanList).toBe(false);
  });
});

describe('isVisionUnsupportedError', () => {
  it('true when 400 invalid_request with images on a non-vision model', () => {
    expect(isVisionUnsupportedError('invalid_request', 400, true, false)).toBe(true);
  });
  it('false when the model DOES support vision (unrelated 400)', () => {
    expect(isVisionUnsupportedError('invalid_request', 400, true, true)).toBe(false);
  });
  it('false when the conversation has no images', () => {
    expect(isVisionUnsupportedError('invalid_request', 400, false, false)).toBe(false);
  });
  it('false for non-400 / non-invalid_request errors', () => {
    expect(isVisionUnsupportedError('invalid_request', 500, true, false)).toBe(false);
    expect(isVisionUnsupportedError('authentication', 400, true, false)).toBe(false);
  });
});
