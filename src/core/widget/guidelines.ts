/**
 * Widget design guidelines — the authoritative styling/structure rules for
 * `show_widget` output, served to the model via the `read_me` tool.
 *
 * Single source: both `read_me`'s result and any future doc/help surface
 * compose from the section constants below, so the rules never drift between
 * what's documented and what's enforced (the hard rules here mirror the
 * validation in `widgetTools.ts` — keep both in sync when either changes).
 * The design-system section is itself sourced from `designSystem.ts`
 * (`getDesignSystemGuideText()`), which generates its text from the exact
 * same constants that build the CSS shipped to the widget iframe — that's
 * what keeps documented vars/classes from drifting off the runtime CSS.
 *
 * P1 shipped one flat "hard rules" section covering every module uniformly.
 * P2 adds the always-present design-system section (vars/classes/examples)
 * plus keeps the per-module pointers; the `modules` filter parameter and
 * section-map structure exist so per-module growth doesn't require
 * reshaping the call sites in widgetTools.ts.
 *
 * show_widget + this guide is now the single AUTOMATIC visualization router
 * — the four builtin skills that used to compete on the same triggers
 * (html-widget/svg-diagram/mermaid-diagram/infographic) had
 * `disable-auto-invoke: true` set (still user-invocable, just not
 * auto-triggered) once their non-redundant guidance was distilled in here:
 * the `diagram` module's canvas-sizing/arrow-marker tips came from
 * svg-diagram, the `mockup` module's device-frame/icon/multi-screen tips
 * came from html-widget, and the whole `poster` module came from
 * infographic (the layout recipes it uniquely provided). mermaid-diagram
 * needed no fold-in here — mermaid output goes through a ```mermaid fence,
 * not read_me (see agentLoop.ts's carve-out).
 */
import { getDesignSystemGuideText } from './designSystem';

/** Widget guideline module identifiers `read_me` accepts. */
export type WidgetGuidelineModule = 'diagram' | 'chart' | 'interactive' | 'mockup' | 'poster';

export const WIDGET_GUIDELINE_MODULES: readonly WidgetGuidelineModule[] = [
  'diagram',
  'chart',
  'interactive',
  'mockup',
  'poster',
];

/**
 * CDN hosts widgets may load scripts from — the single guidance-layer
 * source, reused by the hard rules below and by agentLoop's two
 * visual-output prompt variants. NOTE: HtmlWidgetBlock's iframe CSP keeps
 * its own deliberately larger list — that is the enforcement boundary (and
 * serves the fence-fallback path); this list is what we TELL models to use.
 */
export const WIDGET_CDN_HOSTS: readonly string[] = [
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
  'unpkg.com',
];

/**
 * One hard-ban rule, documented at two altitudes:
 * - `detail` — the full explanation, used in `HARD_RULES` below (read_me's
 *   detailed guide text).
 * - `brief` — a short phrase. Rules with `inPromptBanList: true` also get
 *   echoed into agentLoop.ts's two visual-output capability-prompt variants
 *   (the always-in-context system prompt, which must stay concise) via
 *   `getWidgetHardBanBriefList()`. Both altitudes come from this one array —
 *   the capability prompt's ban list can't drift from what read_me
 *   documents, because there's no second hand-written copy to drift.
 *
 * `widgetTools.ts`'s `showWidgetTool.execute()` hard-rejects violations of
 * the structural ones (fragment-only, no position:fixed, no
 * localStorage/sessionStorage, no <form>) rather than just documenting them
 * here; `hidden-reveal`/`viewport-sizing`/`theme-aware` are prompt-only (not
 * mechanically checkable) — this is the layer that prevents them, which is
 * why those three (plus fragment-only and position-fixed) are the ones
 * promoted into the capability prompt's own ban list — storage/form
 * violations already get a hard runtime rejection with a clear error, so
 * they don't need to spend prompt budget too.
 */
export interface WidgetHardBanRule {
  readonly id: 'fragment-only' | 'position-fixed' | 'storage' | 'form' | 'hidden-reveal' | 'viewport-sizing' | 'theme-aware';
  readonly detail: string;
  readonly brief: string;
  /** Whether this rule is promoted into agentLoop's capability-prompt ban list. */
  readonly inPromptBanList: boolean;
}

export const WIDGET_HARD_BAN_RULES: readonly WidgetHardBanRule[] = [
  {
    id: 'fragment-only',
    detail: '**Fragment only (inline widget)** — the inline widget is a raw fragment: no `<!DOCTYPE>`, `<html>`, `<head>`, or `<body>` tags; write the inner content only (style + markup + script). (A page saved via write_file is the opposite — a complete self-contained document; see the save section below.)',
    brief: 'inline widget: a raw HTML/SVG fragment — no <!DOCTYPE>/html/head/body (a saved write_file page is the opposite: a complete document)',
    inPromptBanList: true,
  },
  {
    id: 'position-fixed',
    detail: '**No `position: fixed`** — widget height is auto-sized from in-flow content; fixed positioning breaks that measurement.',
    brief: 'no `position: fixed`',
    inPromptBanList: true,
  },
  {
    id: 'storage',
    detail: '**No `localStorage` / `sessionStorage`** — the widget renders in a sandboxed iframe with an opaque origin; storage APIs are unavailable.',
    brief: 'no `localStorage` / `sessionStorage`',
    inPromptBanList: false,
  },
  {
    id: 'form',
    detail: '**No `<form>` elements** — use normal controls (buttons, inputs) with event handlers instead of form submission.',
    brief: 'no `<form>` elements',
    inPromptBanList: false,
  },
  {
    id: 'hidden-reveal',
    detail: '**No initial-hidden reveal animations** — patterns like `opacity: 0` + scroll/IntersectionObserver reveal leave content permanently blank if the observer never fires in the preview context. Content must be visible on first paint; animate other properties (transform, color) if you want motion.',
    brief: 'no initial-hidden reveal (opacity: 0 / visibility: hidden revealed via scroll/observer/DOMContentLoaded) — must be visible on first paint',
    inPromptBanList: true,
  },
  {
    id: 'viewport-sizing',
    detail: '**No `100vh` / viewport-height layouts and no internal scrolling** — the widget grows to fit its content in the conversation flow; it is not a standalone viewport.',
    brief: 'no 100vh/viewport-height sizing or internal scroll containers (auto-sizes to content)',
    inPromptBanList: true,
  },
  {
    id: 'theme-aware',
    detail: '**Theme-aware only** — use the `--w-*` vars / `.w-*` classes (documented in the design-system section below), never hardcode white/black; hardcoded colors break in whichever theme (light/dark) they weren\'t written for.',
    brief: 'theme-aware only — use the `--w-*` vars / `.w-*` classes, never hardcode white/black',
    inPromptBanList: true,
  },
];

/** Compact ban bullets for a system prompt — see `WidgetHardBanRule` docstring. */
export function getWidgetHardBanBriefList(): string {
  return WIDGET_HARD_BAN_RULES.filter((r) => r.inPromptBanList).map((r) => `- ${r.brief}`).join('\n');
}

const HARD_RULES = `## Hard rules (apply to every widget)
${WIDGET_HARD_BAN_RULES.map((r) => `- ${r.detail}`).join('\n')}
- **CDN allowlist** — only load scripts from ${WIDGET_CDN_HOSTS.map((h) => `\`${h}\``).join(', ')}.
- **Size budget** — keep the fragment under ~1MB.
- **Optional \`window.sendPrompt(text)\`** — call this to send a short follow-up into the chat composer (max 500 characters; longer text is truncated). It fills the input box for the user to review, it does NOT auto-send — use it for things like a button that proposes a next question or action, not for anything the widget needs to happen silently.

## Saving a visualization as a real webpage file
To save a visualization as a real webpage the user can keep/reopen (as opposed to the ephemeral in-conversation widget above), write a COMPLETE self-contained HTML document — doctype + html/head/body, inline the CSS/JS or use the CDN allowlist above — via the write_file tool. This is the opposite of the fragment-only rule: a saved page needs the full document wrapper. Once written, the .html can be opened in the side preview panel.`;

/** Per-module guidance — brief, general-purpose pointers. Shared styling
 *  vocabulary (vars/classes) lives in the always-present design-system
 *  section instead of being duplicated per module. */
const MODULE_SECTIONS: Record<WidgetGuidelineModule, string> = {
  diagram: `## Diagrams
- Static structure diagrams (flowchart, tree, sequence, state machine) are better as a \`\`\`mermaid code block outside the widget — prefer that over drawing one here.
- Draw inline SVG in this widget only when you need custom spatial layout, annotations, or interactivity that Mermaid can't express.
- Keep label text legible: minimum ~12px, sufficient contrast against the background.
- Size the canvas to content: set \`viewBox\` height to the lowest element's bottom edge plus a ~40px margin, so nothing clips or leaves dead space.
- Define arrow markers once in \`<defs>\` (an SVG \`<marker>\`) and reuse via \`marker-end="url(#id)"\` on each connecting line, rather than hand-drawing every arrowhead.`,
  chart: `## Charts
- Prefer inline SVG for simple charts (a handful of bars/points) — no library needed.
- For anything data-heavy (multi-series, tooltips, legends), use Chart.js loaded from the CDN allowlist.
- Chart.js needs a bounded container in the auto-sized widget frame: wrap the canvas in a dedicated \`<div style="position:relative;height:360px">\` (a fixed pixel height, the div containing only the canvas), and set \`maintainAspectRatio:false\`. Without a fixed-height container a responsive chart grows unbounded and renders blank.
- Canvas cannot resolve CSS custom properties (\`var(--...)\`) — use hardcoded hex colors for canvas-drawn content. The design-system section below documents fixed hex values for exactly this (\`--w-primary\`/\`--w-series-2..4\`); reuse those (they're chosen mid-tone to stay legible on both light and dark hosts) instead of inventing new ones, and avoid pure black/white extremes for canvas text or axes.`,
  interactive: `## Interactive widgets
- Wire real event handlers (click, input, change) directly on elements — no \`<form>\` submission flow.
- Keep state in-memory (plain JS variables/closures); there is no persistent storage available.`,
  mockup: `## UI mockups
- Build with plain HTML + CSS; avoid framework runtimes unless the user specifically asked for a live interactive prototype.
- Match Abu's light, uncluttered visual style rather than inventing a heavy custom theme.
- Simulating a device (phone/tablet/desktop app UI): use a fixed-width frame (phone ~375px, tablet ~768px, desktop ~1024px), centered, to read as "a real app" rather than a wireframe.
- Prefer Unicode glyphs (\`←\` \`✓\` \`⚙\` \`☆\` \`⋯\`) over hand-drawn SVG icons for nav/tab-bar iconography — cheaper and reads clean at small sizes.
- A multi-screen prototype: keep every screen in the DOM at once as sibling \`<div>\`s, toggle one active with a class + a tiny JS function — don't use iframes or multiple files.`,
  poster: `## Data posters (infographics)
Layout recipes for a poster-style show_widget — structured information presented for reading, not charts. Compose \`.w-card\`/\`.w-stat\`/\`.w-grid\` (design system below) into these shapes:
- **Timeline**: a vertical line with dot nodes; each node's label + description sits to one side. Good for history, milestones, version progression.
- **Process steps**: a numbered-circle badge + title + description per step, divided by hairlines. Good for procedures, onboarding flows.
- **Card grid**: 2-3 column grid of \`.w-card\` tiles, each with a short tinted-label header. Good for SWOT, feature/option comparison, categorized lists.
- **Stat row**: a \`.w-grid\` of \`.w-stat\` blocks (label + large number), optionally with an up/down trend badge. Good for KPI/metric overviews.
- **Ranked list**: horizontal rows, rank number on the left, value on the right. Good for top-N / leaderboards.
- **Pyramid / funnel**: stacked horizontal bands whose width increases or decreases top-to-bottom. Good for hierarchy models, conversion funnels.
- Treat it as a poster, not a page: generous section spacing (32-48px), one accent color, no decorative icons/gradients/shadows — restraint is the whole aesthetic.`,
};

/**
 * Compose the guidelines text for the requested modules (default: all).
 * Unknown module names are ignored rather than erroring — `read_me` treats
 * this as a best-effort filter, not a strict schema.
 */
export function getWidgetGuidelines(modules?: readonly string[]): string {
  const requested = modules && modules.length > 0
    ? WIDGET_GUIDELINE_MODULES.filter((m) => modules.includes(m))
    : WIDGET_GUIDELINE_MODULES;

  const sections = [HARD_RULES, getDesignSystemGuideText(), ...requested.map((m) => MODULE_SECTIONS[m])];
  return sections.join('\n\n');
}
