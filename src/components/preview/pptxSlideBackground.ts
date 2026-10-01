/** Matches unset/empty or pure-black inline background-color values (any format, any alpha). */
const BLACK_BG_PATTERN = /^(#000(000)?|rgba?\(\s*0\s*,\s*0\s*,\s*0\s*(,\s*[\d.]+\s*)?\))$/i;

/**
 * pptx-preview@1.0.7 defaults a slide's inline background to black when the source
 * .pptx has no explicit <p:bg> (slide/layout/master) — PowerPoint itself renders this
 * as white (the theme's `lt1`). This walks the rendered slide wrappers and normalizes
 * only an unset/pure-black slide-level background to white, leaving any other color
 * (including intentional dark shapes/text inside a slide) untouched.
 */
export function normalizeSlideBackgrounds(container: HTMLElement): void {
  const wrappers = container.querySelectorAll('[class*="pptx-preview-slide-wrapper"]');
  if (wrappers.length === 0) {
    console.warn('[PptxPreview] no slide wrappers matched for bg normalization');
    return;
  }

  let normalized = 0;
  wrappers.forEach((el) => {
    if (!(el instanceof HTMLElement)) return;
    const bg = el.style.backgroundColor.trim();
    if (bg === '' || BLACK_BG_PATTERN.test(bg)) {
      el.style.backgroundColor = '#ffffff';
      normalized += 1;
    }
  });

  if (normalized > 0) {
    console.log(`[PptxPreview] normalized ${normalized} slide background(s) black→white`);
  }
}
