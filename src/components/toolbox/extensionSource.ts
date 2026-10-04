/** The two SOURCES an Extensions tab can show — a catalog somebody else
 *  offers, or the user's own installed/authored items. This is NOT an
 *  install-state filter.
 *
 *  「市场」 names whoever is offering: Abu's own catalog in an unbound client,
 *  and the organization's catalog in a bound one. 「我的」 means the same thing
 *  either way — what this user wrote or installed by hand. Every tab is split
 *  the same way whether or not the client is bound; the surfaces that consume
 *  this (ToolboxModal, TeamView) render the organization mount when the shelf
 *  is 「市场」 and a binding exists.
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
