/**
 * Keyboard focus for the skill card grid. A card leaves the page while its
 * windows are open or its editor replaces the list, and a deleted skill's card
 * does not come back: the focus then goes to the card of that skill, else the
 * card that took its place, else the one before it, else a control of the page.
 */

const ATTRIBUTE = 'data-skill-entry';

export interface SkillCardPlace {
  name: string;
  /** Where the card sat among the cards when it was noted, or -1. */
  index: number;
}

/** Spread on the element that wraps one card; the skill's name is how the card is found again. */
export function skillEntryProps(name: string): Record<string, string> {
  return { [ATTRIBUTE]: name };
}

function holders(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(`[${ATTRIBUTE}]`));
}

/** The skill's card as it is now, with its place among the cards. */
export function skillCardPlace(root: ParentNode | null, name: string): SkillCardPlace {
  const index = root ? holders(root).findIndex((holder) => holder.getAttribute(ATTRIBUTE) === name) : -1;
  return { name, index };
}

function cardOrNeighbour(root: ParentNode, place: SkillCardPlace): HTMLElement | null {
  const all = holders(root);
  const holder = all.find((item) => item.getAttribute(ATTRIBUTE) === place.name)
    ?? (place.index >= 0 ? all[Math.min(place.index, all.length - 1)] : undefined);
  return holder?.querySelector<HTMLElement>('[role="button"]') ?? null;
}

/**
 * Puts the focus on the skill's card; once that card has gone, on the card that took its place,
 * else the one before it, else the empty shelf's own button, else the page's 「添加」 button.
 */
export function focusSkillCard(root: ParentNode | null, place: SkillCardPlace | null): void {
  const target = (root && place ? cardOrNeighbour(root, place) : null)
    ?? root?.querySelector<HTMLElement>('[data-testid="skills-mine-create"]')
    ?? document.querySelector<HTMLElement>('[data-testid="skill-create-trigger"]');
  target?.focus();
}
