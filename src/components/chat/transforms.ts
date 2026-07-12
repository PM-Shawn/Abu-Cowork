/**
 * DSL-to-HTML transform functions for HtmlWidgetBlock.
 *
 * Wraps domain-specific languages into self-contained HTML pages loaded
 * in HtmlWidgetBlock's sandboxed iframe. Used for formats that benefit
 * from iframe isolation or CDN-loaded libraries.
 *
 * NOTE: Mermaid uses a dedicated MermaidBlock renderer (bundled library,
 * no CDN, no iframe) for better streaming behavior and offline support.
 *
 * Adding a new visual format:
 * 1. Write a wrapXxxAsHtml(code) pure function here
 * 2. Create a 5-line wrapper component (see SvgHtmlBlock.tsx)
 * 3. Register it in codeBlockRenderers.ts
 */

// ---------------------------------------------------------------------------
// SVG — static SVG images, illustrations, and SMIL/CSS animations
// ---------------------------------------------------------------------------

/**
 * Wraps a raw `<svg>...</svg>` in a centered layout. Two failure modes this
 * guards against (confirmed live-test bug, glm-5.2 REST-vs-GraphQL widget):
 * 1. A viewBox-only SVG (no `width`/`height` attributes) has no CSS width to
 *    scale against, so it collapses to the tiny CSS "default object size"
 *    instead of filling the container — hence the explicit `svg { width:
 *    100% }` rule (not just `max-width`, which does nothing without a width
 *    to constrain).
 * 2. `min-height:100vh` is itself one of the widget's own hard-banned
 *    patterns (see WIDGET_HARD_BAN_RULES — "no 100vh/viewport-height
 *    sizing") — the auto-sizing widget iframe is not a standalone viewport,
 *    so this must not use it either. Content should size to the SVG, not
 *    the viewport; a small floor just avoids a zero-height flash before the
 *    SVG paints.
 * Background is transparent (not a hardcoded `#fff`) so the design system's
 * own `body { background: var(--w-bg) }` rule (HtmlWidgetBlock's injected
 * design CSS, loaded earlier in the receiver's <head>) shows through instead
 * of this rule fighting it — keeps the SVG themed instead of always-white.
 */
export function wrapSvgAsHtml(code: string): string {
  return `<style>
body {
  margin:0; display:flex; justify-content:center; align-items:center;
  min-height:120px; background:transparent; padding:16px;
}
svg { width:100%; height:auto; max-width:900px; display:block; }
</style>
${code}`;
}
