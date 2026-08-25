import { beforeEach, describe, expect, it } from 'vitest';
import { useImageLightboxStore, type ImageLightboxItem } from './imageLightboxStore';

const ITEMS: ImageLightboxItem[] = [
  { id: 'one', mediaType: 'image/png', data: 'ONE' },
  { id: 'two', mediaType: 'image/jpeg', data: 'TWO' },
  { id: 'three', mediaType: 'image/webp', data: 'THREE' },
];

describe('imageLightboxStore', () => {
  beforeEach(() => {
    useImageLightboxStore.getState().close();
  });

  it('opens at the requested bounded index', () => {
    useImageLightboxStore.getState().open(ITEMS, 99);

    const state = useImageLightboxStore.getState();
    expect(state.isOpen).toBe(true);
    expect(state.items).toEqual(ITEMS);
    expect(state.activeIndex).toBe(2);
  });

  it('moves without looping past either edge', () => {
    useImageLightboxStore.getState().open(ITEMS, 0);

    useImageLightboxStore.getState().previous();
    expect(useImageLightboxStore.getState().activeIndex).toBe(0);

    useImageLightboxStore.getState().next();
    useImageLightboxStore.getState().next();
    useImageLightboxStore.getState().next();
    expect(useImageLightboxStore.getState().activeIndex).toBe(2);
  });

  it('clears bytes and focus state when closed', () => {
    useImageLightboxStore.getState().open(ITEMS, 1, null);
    useImageLightboxStore.getState().close();

    expect(useImageLightboxStore.getState()).toMatchObject({
      isOpen: false,
      items: [],
      activeIndex: 0,
      returnFocus: null,
    });
  });

  it('ignores an empty gallery', () => {
    useImageLightboxStore.getState().open([], 0);

    expect(useImageLightboxStore.getState().isOpen).toBe(false);
  });
});
