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

export function wrapSvgAsHtml(code: string): string {
  return `<style>
body {
  margin:0; display:flex; justify-content:center; align-items:center;
  min-height:100vh; background:#fff; padding:16px;
}
svg { max-width:100%; height:auto; }
</style>
${code}`;
}
