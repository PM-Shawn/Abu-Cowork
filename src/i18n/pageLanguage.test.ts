// @vitest-environment happy-dom
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLanguageSetting, initLanguage, setLanguage, type LanguageSetting } from './index';
import { followPageLanguage } from './pageLanguage';

// <html lang> tells assistive technology and the browser which language the interface is
// written in. It carries the resolved interface locale, from the start and after every switch.
describe('the page language', () => {
  const root = document.documentElement;
  let settingBefore: LanguageSetting;
  let langBefore: string | null;
  let stop: (() => void) | undefined;

  beforeEach(() => {
    settingBefore = getLanguageSetting();
    langBefore = root.getAttribute('lang');
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    vi.unstubAllGlobals();
    initLanguage(settingBefore);
    if (langBefore === null) root.removeAttribute('lang');
    else root.setAttribute('lang', langBefore);
  });

  it.each(['zh-CN', 'en-US'] as const)('is %s from the start when that is the interface language', (locale) => {
    initLanguage(locale);
    root.removeAttribute('lang');
    stop = followPageLanguage();
    expect(root.getAttribute('lang')).toBe(locale);
  });

  it('follows a switch in settings, both ways', () => {
    initLanguage('zh-CN');
    stop = followPageLanguage();
    expect(root.getAttribute('lang')).toBe('zh-CN');
    setLanguage('en-US');
    expect(root.getAttribute('lang')).toBe('en-US');
    setLanguage('zh-CN');
    expect(root.getAttribute('lang')).toBe('zh-CN');
  });

  it.each([
    ['zh-CN', 'zh-CN'],
    ['zh-TW', 'zh-CN'],
    ['en-GB', 'en-US'],
    ['fr-FR', 'en-US'],
  ])('with the setting on "system" and a %s system it is %s', (system, expected) => {
    vi.stubGlobal('navigator', { language: system });
    initLanguage('system');
    stop = followPageLanguage();
    expect(root.getAttribute('lang')).toBe(expected);
  });

  it('follows a switch to "system" and away from it', () => {
    vi.stubGlobal('navigator', { language: 'zh-CN' });
    initLanguage('en-US');
    stop = followPageLanguage();
    expect(root.getAttribute('lang')).toBe('en-US');
    setLanguage('system');
    expect(root.getAttribute('lang')).toBe('zh-CN');
    setLanguage('en-US');
    expect(root.getAttribute('lang')).toBe('en-US');
  });

  // The stored setting can arrive after the entry point has run (settingsStore's hydration
  // calls initLanguage).
  it('takes the stored setting when it arrives after the start', () => {
    initLanguage('system');
    stop = followPageLanguage();
    expect(root.getAttribute('lang')).toBe('en-US');
    initLanguage('zh-CN');
    expect(root.getAttribute('lang')).toBe('zh-CN');
  });

  it('sets the element it is given', () => {
    const element = document.createElement('html');
    initLanguage('zh-CN');
    stop = followPageLanguage(element);
    expect(element.getAttribute('lang')).toBe('zh-CN');
  });

  it('stops following once told to', () => {
    initLanguage('zh-CN');
    const stopFollowing = followPageLanguage();
    stopFollowing();
    setLanguage('en-US');
    expect(root.getAttribute('lang')).toBe('zh-CN');
  });

  // No constant in the HTML is right for both interface languages, so the two pages name none
  // and the entry script of each sets it.
  it.each(['index.html', 'pet.html'])('%s names no language of its own', (file) => {
    const html = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
    const page = new DOMParser().parseFromString(html, 'text/html');
    expect(page.documentElement.hasAttribute('lang')).toBe(false);
  });
});
