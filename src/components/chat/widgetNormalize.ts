/**
 * Pure helpers for HtmlWidgetBlock's inline-widget rendering. No React, no
 * DOM — safe to unit test directly.
 *
 * Why this exists: weaker / BYO models often answer an inline ```html widget
 * with a full document using a scroll-reveal pattern
 * (`.fade-up{opacity:0;transform:translateY(30px)}` flipped to `.visible` by
 * an IntersectionObserver). The streaming sanitizer strips <script> for
 * safety, so the observer never runs and the widget streams in as a
 * permanently blank box.
 *
 * Document handling itself lives in the iframe receiver (see
 * widgetReceiverDom.ts), which uses the platform DOMParser — no string
 * surgery here. This module only provides:
 * - the preview-phase neutralize CSS (universal, no class-name heuristics),
 * - full-document detection + doctype guarantee for the fullscreen path.
 */

/** Body class the RECEIVER_HTML iframe toggles to gate the preview-only
 *  neutralize rules. Set on `widget:update`; kept through `widget:finalize`'s
 *  script chain and removed only after author scripts had their chance to
 *  attach reveal handlers. Exported so HtmlWidgetBlock's receiver template
 *  stays in sync with the CSS built here. */
export const WIDGET_PREVIEW_PHASE_CLASS = 'abu-preview-phase';

/**
 * Universal preview-phase neutralizer, active only while
 * `body.abu-preview-phase` is present. Safe to be blunt here specifically
 * *because* it applies while author scripts have not run yet: no
 * IntersectionObserver (or any other JS-driven reveal/animation) has fired,
 * so forcing everything visible can't defeat an effect that was never going
 * to fire anyway. Covers both opacity and visibility reveal patterns, and
 * the body itself too (`body{opacity:0}` page-fade patterns — a `body.x *`
 * selector doesn't match body). Deliberately does NOT touch `display`
 * (Tailwind's `.hidden` etc. have legitimate uses) and uses no class-name
 * substring heuristics (those false-positive: "chaos" matches
 * [class*="aos"]). Also does NOT touch `transform`: reveal patterns pair
 * transform WITH opacity, so releasing opacity alone already makes content
 * visible (merely offset by ~30px), while translate-based centering
 * (`left:50%; transform:translateX(-50%)`) keeps working during preview and
 * in the blank-fallback end state. Post-finalize stuck-hidden content is
 * the contract layer's job (tool schema + prompt guardrails); the only
 * runtime net is the receiver's whole-widget blank fallback (see
 * widgetReceiverDom.ts).
 */
export function buildPreviewNeutralizeCss(): string {
  return (
    `body.${WIDGET_PREVIEW_PHASE_CLASS} * { opacity: 1 !important; visibility: visible !important; animation: none !important; transition: none !important; }\n` +
    `body.${WIDGET_PREVIEW_PHASE_CLASS} { opacity: 1 !important; visibility: visible !important; }`
  );
}

/**
 * Full-document check for the fullscreen path (a real viewport, where the
 * author's document should render verbatim instead of being wrapped in
 * another document). HTML comments are stripped first so a fragment that
 * merely *mentions* `<html>` inside a comment still gets the base-style
 * wrap.
 */
export function isFullDocument(code: string): boolean {
  const stripped = code.replace(/<!--[\s\S]*?-->/g, '');
  return /<html[\s>]/i.test(stripped) && /<\/html>/i.test(stripped);
}

/**
 * Guarantee a doctype on a full document handed verbatim to a real window —
 * doctype-less author documents would otherwise render in quirks mode.
 */
export function ensureDoctype(code: string): string {
  return /^\s*<!doctype/i.test(code) ? code : `<!DOCTYPE html>\n${code}`;
}
