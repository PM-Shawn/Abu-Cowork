/**
 * Widget design system — the SINGLE SOURCE for the CSS injected into the
 * widget iframe (HtmlWidgetBlock's RECEIVER_HTML) AND for the guide text
 * `read_me` hands the model (guidelines.ts). Both sides read the same
 * `WIDGET_THEME_VARS` / `WIDGET_UTILITY_CLASSES` constants so the shipped CSS
 * and the documented CSS can never drift apart — the failure mode this
 * guards against is WorkBuddy's real bug: a style guide promising classes
 * the runtime CSS never implemented.
 *
 * Deliberately small (~12 vars, ~14 utility classes) — this mirrors the
 * SPIRIT of ChatGPT's visualize.css / WorkBuddy's style guidelines but at a
 * fraction of the size: one semantic color tier (no 9-shade ramps), one
 * surface shape (no squircle/superellipse), one compact utility kit (no
 * per-module CSS packs). The goal is consistent, theme-aware widgets, not a
 * full design system.
 *
 * Theme delivery: `light-dark()` and SSR-safe custom-property color schemes
 * are still an inconsistent-support risk in an arbitrary sandboxed webview,
 * so this ships the safer, well-supported alternative — `:root` light
 * defaults, a `@media (prefers-color-scheme: dark)` override, AND a `.dark`
 * class override (P3 will toggle the class via a `widget:theme` postMessage
 * for live sync; until then the media query alone gets first paint right).
 */

/** One semantic theme variable with its light and dark values. */
interface ThemeVarSpec {
  /** CSS custom property name, e.g. `--w-bg`. */
  readonly name: string;
  /** Short human-readable purpose, used in the guide text's variable table. */
  readonly desc: string;
  readonly light: string;
  readonly dark: string;
}

/**
 * Semantic theme variables. `--w-` prefix — short, unlikely to collide with
 * author CSS (verified: no existing widget/receiver code uses this prefix)
 * or with Abu's own host tokens (`--abu-*`, `--claude-*`, shadcn's
 * `--background`/`--foreground`/etc. — see src/styles/index.css). Values are
 * fixed fallbacks matching Abu's light/dark palette (same source file); P3
 * will later pipe in live host tokens instead of these hardcoded ones.
 */
export const WIDGET_THEME_VARS: readonly ThemeVarSpec[] = [
  { name: '--w-bg', desc: 'Page background', light: '#faf9f5', dark: '#1a1917' },
  { name: '--w-fg', desc: 'Primary text', light: '#141413', dark: '#f0ede8' },
  { name: '--w-card', desc: 'Card/surface background', light: '#ffffff', dark: '#201f1d' },
  { name: '--w-card-fg', desc: 'Text on a card surface', light: '#141413', dark: '#f0ede8' },
  { name: '--w-muted', desc: 'Muted/secondary surface (badges, subtle fills)', light: '#f5f3ee', dark: '#211f1c' },
  { name: '--w-muted-fg', desc: 'Muted/secondary text (captions, labels)', light: '#656358', dark: '#8a8479' },
  { name: '--w-border', desc: 'Hairline borders/dividers', light: '#e8e4dd', dark: '#302e2b' },
  { name: '--w-primary', desc: 'Brand accent — primary buttons, emphasis, chart series 1', light: '#d97757', dark: '#d97757' },
  { name: '--w-primary-fg', desc: 'Text/icon on a primary-filled surface', light: '#ffffff', dark: '#ffffff' },
  { name: '--w-accent', desc: 'Secondary accent surface (hover/active fills)', light: '#f0eee6', dark: '#272522' },
  { name: '--w-series-2', desc: 'Chart series color 2', light: '#5b8dee', dark: '#6f9ff2' },
  { name: '--w-series-3', desc: 'Chart series color 3', light: '#4caf7d', dark: '#5cc08f' },
  { name: '--w-series-4', desc: 'Chart series color 4', light: '#9b7fd4', dark: '#ab8fe0' },
];

/** One compact utility class. `css` is the declaration block body (no selector/braces). */
interface UtilityClassSpec {
  readonly name: string;
  readonly desc: string;
  readonly css: string;
}

/**
 * ~14 utility classes forming one coherent kit: a single surface (`.w-card`),
 * stat/metric display, a responsive grid + row/column flex helpers, badges,
 * buttons, and text-emphasis helpers. Selectors are single class names (no
 * nesting/combinators) so authors can freely combine them
 * (`class="w-card w-stat"`). Namespaced under `w-` for clarity — the CSS only
 * ever reaches the sandboxed widget iframe, but a shared prefix keeps the
 * kit visually identifiable in the guide text and avoids any chance of
 * colliding with an author's own class names.
 */
export const WIDGET_UTILITY_CLASSES: readonly UtilityClassSpec[] = [
  {
    name: 'w-card',
    desc: 'The one surface — bordered, rounded container for grouping content.',
    css: 'background: var(--w-card); color: var(--w-card-fg); border: 1px solid var(--w-border); border-radius: 10px; padding: 16px;',
  },
  {
    name: 'w-stat',
    desc: 'A label+value metric block — stack a `.w-small.w-muted` label above a `.w-stat-value`.',
    css: 'display: flex; flex-direction: column; gap: 4px;',
  },
  {
    name: 'w-stat-value',
    desc: 'Large emphasized number/value inside a `.w-stat`.',
    css: 'font-size: 24px; font-weight: 600; line-height: 1.2; color: var(--w-fg);',
  },
  {
    name: 'w-grid',
    desc: 'Responsive auto-fit grid — wrap `.w-card` items for a dashboard-style layout.',
    css: 'display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px;',
  },
  {
    name: 'w-row',
    desc: 'Horizontal flex layout with sensible gap and vertical centering.',
    css: 'display: flex; align-items: center; gap: 8px;',
  },
  {
    name: 'w-col',
    desc: 'Vertical flex layout with sensible gap.',
    css: 'display: flex; flex-direction: column; gap: 8px;',
  },
  {
    name: 'w-badge',
    desc: 'Small pill label for status/tags.',
    css: 'display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 500; background: var(--w-muted); color: var(--w-muted-fg);',
  },
  {
    name: 'w-badge-primary',
    desc: 'Accent-filled variant of `.w-badge` — pair the two classes together.',
    css: 'background: var(--w-primary); color: var(--w-primary-fg);',
  },
  {
    name: 'w-btn',
    desc: 'Base button — outlined, neutral surface.',
    css: 'display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 6px 14px; border-radius: 8px; border: 1px solid var(--w-border); background: var(--w-card); color: var(--w-fg); font-size: 13px; font-weight: 500; cursor: pointer;',
  },
  {
    name: 'w-btn-primary',
    desc: 'Accent-filled variant of `.w-btn` — pair the two classes together.',
    css: 'background: var(--w-primary); color: var(--w-primary-fg); border-color: var(--w-primary);',
  },
  {
    name: 'w-muted',
    desc: 'De-emphasized text color.',
    css: 'color: var(--w-muted-fg);',
  },
  {
    name: 'w-small',
    desc: 'Smaller caption-sized text.',
    css: 'font-size: 12px;',
  },
  {
    name: 'w-title',
    desc: 'Section heading text.',
    css: 'font-size: 15px; font-weight: 600; color: var(--w-fg); margin-bottom: 4px;',
  },
  {
    name: 'w-divider',
    desc: 'Horizontal rule / section separator.',
    css: 'border: none; border-top: 1px solid var(--w-border); height: 0; margin: 12px 0;',
  },
];

/** One conventional-name → canonical-var alias. */
interface ThemeVarAlias {
  /** The conventional/guessed custom-property name (never documented as the API). */
  readonly name: string;
  /** The canonical `WIDGET_THEME_VARS[].name` this alias resolves to. */
  readonly canonical: string;
}

/**
 * Forgiving aliases for conventional variable names models reach for by
 * muscle memory (shadcn/Tailwind-style `--text-primary`, `--bg-secondary`,
 * etc.) when they skip `read_me` and never see the real (terse) vocabulary.
 * This is NOT part of the documented contract — `getDesignSystemGuideText()`
 * deliberately does not list these; they exist purely so an undefined
 * `var()` reference doesn't silently produce a blank/broken render. Mirrors
 * ChatGPT's visualize.css "legacy aliases — not part of the agent contract"
 * stance. Each alias is just a `var()` indirection to the canonical
 * property, so it inherits that property's light/dark value automatically
 * and only needs to be emitted once (in `:root`), not per-theme.
 *
 * Confirmed root cause (live test, glm-5.2): a model that skipped `read_me`
 * produced an SVG with 34 refs to `var(--w-text-primary)` /
 * `var(--w-text-secondary)` / `var(--w-bg-primary)` / `var(--w-bg-tertiary)`
 * — none of which existed, so the SVG rendered blank. The `--w-*`-prefixed
 * entries below cover exactly those; the non-prefixed entries are a bonus
 * safety net for models that drop the prefix entirely.
 */
export const WIDGET_THEME_VAR_ALIASES: readonly ThemeVarAlias[] = [
  { name: '--w-text-primary', canonical: '--w-fg' },
  { name: '--w-text-secondary', canonical: '--w-muted-fg' },
  { name: '--w-text-muted', canonical: '--w-muted-fg' },
  { name: '--w-bg-primary', canonical: '--w-bg' },
  { name: '--w-bg-secondary', canonical: '--w-card' },
  { name: '--w-bg-tertiary', canonical: '--w-muted' },
  { name: '--w-border-color', canonical: '--w-border' },
  { name: '--w-accent-color', canonical: '--w-accent' },
  { name: '--w-primary-color', canonical: '--w-primary' },
  // Non-prefixed bonus safety net — some models drop the `--w-` prefix too.
  { name: '--text-primary', canonical: '--w-fg' },
  { name: '--text-secondary', canonical: '--w-muted-fg' },
  { name: '--text-muted', canonical: '--w-muted-fg' },
  { name: '--bg-primary', canonical: '--w-bg' },
  { name: '--bg-secondary', canonical: '--w-card' },
  { name: '--bg-tertiary', canonical: '--w-muted' },
  { name: '--border-color', canonical: '--w-border' },
  { name: '--accent-color', canonical: '--w-accent' },
  { name: '--primary-color', canonical: '--w-primary' },
];

/** Render one `{ name: value; ... }` custom-property block body, indented. */
function renderVarBlock(pick: (v: ThemeVarSpec) => string): string {
  return WIDGET_THEME_VARS.map((v) => `  ${v.name}: ${pick(v)};`).join('\n');
}

/** Render the alias block — each entry is a `var()` indirection to its
 *  canonical property, so it's theme-agnostic and emitted once. */
function renderAliasBlock(): string {
  return WIDGET_THEME_VAR_ALIASES.map((a) => `  ${a.name}: var(${a.canonical});`).join('\n');
}

/**
 * Assemble the full design-system CSS: theme variables (light default + dark
 * media query + `.dark` class override) followed by the utility classes and
 * a minimal base reset. Additive by construction — this is a self-contained
 * string meant to be appended to (not replace) HtmlWidgetBlock's existing
 * BASE_STYLES / preview-neutralizer CSS in the receiver's `<style>` tag.
 *
 * The base reset only sets `body` background/text color from the theme vars
 * (so first paint is theme-correct) — it deliberately does NOT touch
 * padding/margin/font-family/display, which BASE_STYLES already owns, so it
 * can't fight the receiver's existing layout.
 */
export function buildWidgetDesignCss(): string {
  const utilityBlock = WIDGET_UTILITY_CLASSES.map((c) => `.${c.name} { ${c.css} }`).join('\n');

  // Theme phasing: P2 DEFAULTS TO LIGHT (`:root`) — no `@media
  // (prefers-color-scheme)` trigger, because the srcdoc iframe can't see
  // Abu's in-app theme, so an OS-scheme trigger would make the widget follow
  // the OS instead of the chat (a dark box in a light chat, and inverse).
  // Pre-P2 the widget was always light, so light-default keeps parity. The
  // `.dark` override block below is the ready-but-dormant hook: P3 wires host
  // theme via a `widget:theme` postMessage that toggles `.dark` on the
  // receiver body, activating these values only when Abu itself is dark.
  return `/* Abu widget design system — semantic theme vars + compact utility kit */
:root {
${renderVarBlock((v) => v.light)}
${renderAliasBlock()}
}

.dark {
${renderVarBlock((v) => v.dark)}
}

body { background: var(--w-bg); color: var(--w-fg); }

${utilityBlock}`;
}

/**
 * Human/LLM-facing documentation of exactly the vars and classes above —
 * generated FROM the same constants `buildWidgetDesignCss()` uses, so the
 * guide text and the shipped CSS can never drift (this is the anti-drift
 * guarantee; see designSystem.test.ts for the assertion that every name
 * documented here also appears in the CSS, and vice versa).
 */
export function getDesignSystemGuideText(): string {
  const varRows = WIDGET_THEME_VARS
    .map((v) => `| \`${v.name}\` | ${v.desc} |`)
    .join('\n');
  const classRows = WIDGET_UTILITY_CLASSES
    .map((c) => `| \`.${c.name}\` | ${c.desc} |`)
    .join('\n');

  // Canvas can't resolve var() — the model needs literal hex for chart series.
  // Derived from the SAME array's light values (single source, no second copy).
  // Series 1 = --w-primary, then --w-series-2..4, in order.
  const lightOf = (name: string): string =>
    WIDGET_THEME_VARS.find((v) => v.name === name)?.light ?? '';
  const seriesHex = ['--w-primary', '--w-series-2', '--w-series-3', '--w-series-4']
    .map(lightOf)
    .join(', ');

  return `## Design system (prefer this over freestyle CSS)
A small set of theme-aware variables and utility classes is already loaded into every widget. Use them instead of hardcoding colors — hardcoded white/black/hex breaks in the other theme (light vs dark).

### Theme variables
| Variable | Purpose |
|---|---|
${varRows}

### Utility classes
| Class | Purpose |
|---|---|
${classRows}

### Usage examples
\`\`\`html
<div class="w-card">
  <div class="w-stat">
    <span class="w-small w-muted">Revenue</span>
    <span class="w-stat-value">$128,400</span>
  </div>
</div>
\`\`\`
\`\`\`html
<div class="w-grid">
  <div class="w-card"><div class="w-title">Users</div><span class="w-stat-value">1,204</span></div>
  <div class="w-card"><div class="w-title">Errors</div><span class="w-stat-value">3</span></div>
</div>
\`\`\`
\`\`\`html
<div class="w-row">
  <span class="w-badge w-badge-primary">Live</span>
  <button class="w-btn w-btn-primary">Refresh</button>
</div>
\`\`\`
### Canvas / chart series colors
Canvas can't read CSS vars — for chart series use these literals (series 1 first): ${seriesHex}. They're chosen mid-tone so they stay legible on both light and dark hosts. Do NOT use \`--w-fg\` (near-black) for canvas text/axes — it disappears on a dark host; use a mid-gray or one of the series colors instead.`;
}
