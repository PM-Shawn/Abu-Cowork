/**
 * Keyboard focus for the card grids of the extensions page. A card can leave
 * while the focus is on it or on a window it opened: an uninstall or a delete
 * removes it, an install replaces it with another kind of card, an editor takes
 * the place of the list. The focus then goes to that card, else the card that
 * took its place, else the one before it, else to a control of the page, so it
 * never ends up on the window.
 */

export type CardKind = 'plugin-mine' | 'plugin-market' | 'plugin-orphan' | 'skill' | 'connector' | 'expert' | 'team';

const ATTRIBUTE: Record<CardKind, string> = {
  'plugin-mine': 'data-plugin-mine-card',
  'plugin-market': 'data-plugin-market-card',
  'plugin-orphan': 'data-plugin-orphan-card',
  skill: 'data-skill-entry',
  connector: 'data-connector-card',
  expert: 'data-expert-card',
  team: 'data-team-card',
};

export interface CardPlace {
  id: string;
  /** Where the card sat among the cards of its kind when it was noted, or -1. */
  index: number;
}

/** Spread on the element that wraps one card; `id` is how the card is found again. */
export function cardProps(kind: CardKind, id: string): Record<string, string> {
  return { [ATTRIBUTE[kind]]: id };
}

function holders(root: ParentNode, kind: CardKind): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(`[${ATTRIBUTE[kind]}]`));
}

/** Where the card with this id sits among the cards of its kind, or -1. */
export function cardIndex(root: ParentNode | null, kind: CardKind, id: string): number {
  return root ? holders(root, kind).findIndex((holder) => holder.getAttribute(ATTRIBUTE[kind]) === id) : -1;
}

/** The card as it is now, with its place among the cards of its kind. */
export function cardPlace(root: ParentNode | null, kind: CardKind, id: string): CardPlace {
  return { id, index: cardIndex(root, kind, id) };
}

/** The card with this id; once it has gone, the card now at `index`, else the last one. */
export function cardOrNeighbour(root: ParentNode, kind: CardKind, id: string, index: number): HTMLElement | null {
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

/** A control of the page, by its test id: where the focus goes when no card is left to take it. */
export function focusByTestId(testId: string, root: ParentNode = document): boolean {
  const target = root.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  target?.focus();
  return target !== null;
}
