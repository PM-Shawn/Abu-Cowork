/**
 * Keyboard focus for the plugin card grids. A card can leave while the focus is
 * on it or on a window it opened: an uninstall removes its row, an install
 * replaces it with another kind of card. The focus then goes to the card that
 * took its place, else the one before it, else to a control of the page, so it
 * never ends up on the window.
 */

export type PluginCardKind = 'mine' | 'market' | 'orphan';

const ATTRIBUTE: Record<PluginCardKind, string> = {
  mine: 'data-plugin-mine-card',
  market: 'data-plugin-market-card',
  orphan: 'data-plugin-orphan-card',
};

/** Spread on the element that wraps one card; `id` is how the card is found again. */
export function pluginCardProps(kind: PluginCardKind, id: string): Record<string, string> {
  return { [ATTRIBUTE[kind]]: id };
}

function holders(root: ParentNode, kind: PluginCardKind): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(`[${ATTRIBUTE[kind]}]`));
}

/** Where the card with this id sits among the cards of its kind, or -1. */
export function pluginCardIndex(root: ParentNode, kind: PluginCardKind, id: string): number {
  return holders(root, kind).findIndex((holder) => holder.getAttribute(ATTRIBUTE[kind]) === id);
}

/** The card with this id; once it has gone, the card now at `index`, else the last one. */
export function pluginCardOrNeighbour(root: ParentNode, kind: PluginCardKind, id: string, index: number): HTMLElement | null {
  const all = holders(root, kind);
  const holder = all.find((item) => item.getAttribute(ATTRIBUTE[kind]) === id)
    ?? (index >= 0 ? all[Math.min(index, all.length - 1)] : undefined);
  return holder?.querySelector<HTMLElement>('[role="button"]') ?? null;
}

/** True when no control has the keyboard focus: it sits on the page body, or on an element that has left the page. */
export function focusIsOnWindow(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || !active.isConnected;
}

/** The page's 「添加」 button: where the focus goes when no card is left to take it. */
export function focusAddButton(): void {
  document.querySelector<HTMLElement>('[data-testid="plugin-create-trigger"]')?.focus();
}
