// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cardIndex, cardOrNeighbour, cardPlace, cardProps, focusByTestId, focusIsOnWindow } from './cardFocus';

/** A grid of cards of one kind, each wrapped the way the pages wrap them. */
function grid(kind: Parameters<typeof cardProps>[0], ids: string[]): HTMLElement {
  const root = document.createElement('div');
  for (const id of ids) {
    const holder = document.createElement('div');
    for (const [name, value] of Object.entries(cardProps(kind, id))) holder.setAttribute(name, value);
    const card = document.createElement('div');
    card.setAttribute('role', 'button');
    card.tabIndex = 0;
    card.textContent = id;
    holder.append(card);
    root.append(holder);
  }
  document.body.append(root);
  return root;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('cardFocus', () => {
  it('keeps the attribute each grid has always carried', () => {
    expect(cardProps('plugin-mine', 'a')).toEqual({ 'data-plugin-mine-card': 'a' });
    expect(cardProps('plugin-market', 'a')).toEqual({ 'data-plugin-market-card': 'a' });
    expect(cardProps('plugin-orphan', 'a')).toEqual({ 'data-plugin-orphan-card': 'a' });
    expect(cardProps('skill', 'a')).toEqual({ 'data-skill-entry': 'a' });
    expect(cardProps('connector', 'a')).toEqual({ 'data-connector-card': 'a' });
  });

  it('finds a card among the cards of its own kind only', () => {
    const root = grid('skill', ['one', 'two', 'three']);
    expect(cardIndex(root, 'skill', 'two')).toBe(1);
    expect(cardIndex(root, 'connector', 'two')).toBe(-1);
    expect(cardIndex(null, 'skill', 'two')).toBe(-1);
    expect(cardPlace(root, 'skill', 'three')).toEqual({ id: 'three', index: 2 });
  });

  it('gives the card itself while it is there', () => {
    const root = grid('connector', ['one', 'two', 'three']);
    expect(cardOrNeighbour(root, 'connector', 'two', 0)?.textContent).toBe('two');
  });

  it('gives the card that took the place, else the one before it, once the card has gone', () => {
    const root = grid('connector', ['one', 'three']);
    expect(cardOrNeighbour(root, 'connector', 'two', 1)?.textContent).toBe('three');
    expect(cardOrNeighbour(root, 'connector', 'four', 2)?.textContent).toBe('three');
  });

  it('gives nothing when the place was never noted or no card is left', () => {
    expect(cardOrNeighbour(grid('connector', ['one']), 'connector', 'two', -1)).toBeNull();
    expect(cardOrNeighbour(grid('connector', []), 'connector', 'two', 0)).toBeNull();
  });

  it('says whether a control has the keyboard focus', () => {
    const root = grid('skill', ['one']);
    expect(focusIsOnWindow()).toBe(true);
    const card = cardOrNeighbour(root, 'skill', 'one', 0);
    card?.focus();
    expect(focusIsOnWindow()).toBe(false);
    root.remove();
    expect(focusIsOnWindow()).toBe(true);
  });

  it('focuses a control of the page by its test id and says whether it found one', () => {
    const add = document.createElement('div');
    add.tabIndex = 0;
    add.setAttribute('data-testid', 'page-add');
    document.body.append(add);
    expect(focusByTestId('page-add')).toBe(true);
    expect(document.activeElement).toBe(add);
    expect(focusByTestId('not-on-the-page')).toBe(false);
    expect(focusByTestId('page-add', grid('skill', []))).toBe(false);
  });
});
