/** The two SOURCES an Extensions tab can show — a marketplace catalog, or the
 *  user's own installed/authored items. This is NOT an install-state filter.
 *
 *  Lives beside {@link SourceSubNav} rather than inside it so the store and the
 *  panels can name a source without importing a component module (and so the
 *  id helper below is not a value export from a `.tsx`). */
export type ExtensionSource = 'market' | 'mine';

/** Default prefix for a sub-nav's per-source `data-testid` and `id`. */
export const DEFAULT_SOURCE_ID_PREFIX = 'extensions-source';

/** `id` of the tab button for `source`. The panel names its ACTIVE tab with
 *  this via `aria-labelledby`, which is the half of the tablist↔tabpanel pair
 *  that `aria-controls` alone does not provide. */
export function sourceTabId(source: ExtensionSource, prefix: string = DEFAULT_SOURCE_ID_PREFIX): string {
  return `${prefix}-${source}`;
}
