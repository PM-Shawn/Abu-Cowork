// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeMatchMedia } from '@/test/fakeMatchMedia';
import {
  APPEARANCE_ATTRIBUTES,
  currentAppearanceFlags,
  installAppearanceAttributes,
  resetAppearanceOverrides,
  setAppearanceOverride,
} from './appearance';

const CONTRAST = '(prefers-contrast: more)';
const TRANSPARENCY = '(prefers-reduced-transparency: reduce)';
const MOTION = '(prefers-reduced-motion: reduce)';

describe('appearance attributes', () => {
  let uninstall: (() => void) | null = null;
  const root = document.documentElement;

  afterEach(() => {
    uninstall?.();
    uninstall = null;
    resetAppearanceOverrides();
    for (const [name] of Object.values(APPEARANCE_ATTRIBUTES)) root.removeAttribute(name);
    vi.restoreAllMocks();
  });

  it('writes the system settings onto <html> at install', () => {
    const media = fakeMatchMedia({ [CONTRAST]: true });
    vi.spyOn(window, 'matchMedia').mockImplementation(media.matchMedia);
    uninstall = installAppearanceAttributes(root);
    expect(root.getAttribute('data-contrast')).toBe('more');
    expect(root.hasAttribute('data-transparency')).toBe(false);
    expect(root.hasAttribute('data-motion')).toBe(false);
  });

  it('follows a system change without reinstalling', () => {
    const media = fakeMatchMedia({});
    vi.spyOn(window, 'matchMedia').mockImplementation(media.matchMedia);
    uninstall = installAppearanceAttributes(root);
    media.change(TRANSPARENCY, true);
    expect(root.getAttribute('data-transparency')).toBe('reduced');
    media.change(TRANSPARENCY, false);
    expect(root.hasAttribute('data-transparency')).toBe(false);
  });

  it('lets an override win until it is cleared', () => {
    const media = fakeMatchMedia({ [MOTION]: true });
    vi.spyOn(window, 'matchMedia').mockImplementation(media.matchMedia);
    uninstall = installAppearanceAttributes(root);
    setAppearanceOverride('motion', false);
    expect(root.hasAttribute('data-motion')).toBe(false);
    expect(currentAppearanceFlags().motion).toBe(false);
    setAppearanceOverride('motion', null);
    expect(root.getAttribute('data-motion')).toBe('reduced');
    setAppearanceOverride('contrast', true);
    resetAppearanceOverrides();
    expect(root.hasAttribute('data-contrast')).toBe(false);
  });

  it('stops listening after uninstall', () => {
    const media = fakeMatchMedia({});
    vi.spyOn(window, 'matchMedia').mockImplementation(media.matchMedia);
    uninstall = installAppearanceAttributes(root);
    expect(media.listenerCount()).toBe(3);
    uninstall();
    uninstall = null;
    expect(media.listenerCount()).toBe(0);
  });

  it('has nothing to reset when no flag was forced', () => {
    expect(() => resetAppearanceOverrides()).not.toThrow();
  });
});
