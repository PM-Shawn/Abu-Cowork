import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pageHistoryNavigation } from './historyNavigation';

const entries = [
  { key: 'previous', url: 'https://site.example/previous', index: 0 },
  { key: 'current', url: 'https://site.example/current', index: 1 },
  { key: 'next', url: 'https://site.example/next', index: 2 },
];
let navigation: { currentEntry: typeof entries[number]; entries: () => typeof entries; canGoBack: boolean; canGoForward: boolean; traverseTo: ReturnType<typeof vi.fn> };
let reload: ReturnType<typeof vi.fn>;

beforeEach(() => {
  navigation = { currentEntry: { ...entries[1] }, entries: () => entries.map(entry => ({ ...entry })),
    canGoBack: true, canGoForward: true, traverseTo: vi.fn() };
  reload = vi.fn();
  vi.stubGlobal('window', { navigation });
  vi.stubGlobal('location', { href: entries[1].url, reload });
});
afterEach(() => vi.unstubAllGlobals());

describe('Chrome history destination verification', () => {
  it.each(['back', 'forward', 'reload'])('probes and executes %s against the same native entry', action => {
    const pin = pageHistoryNavigation(action, null, null);
    expect(pin).not.toBeNull();
    expect(navigation.traverseTo).not.toHaveBeenCalled();
    expect(pageHistoryNavigation(action, pin, 'https://site.example')).toEqual(pin);
    if (action === 'reload') expect(reload).toHaveBeenCalledOnce();
    else expect(navigation.traverseTo).toHaveBeenCalledWith(action === 'back' ? 'previous' : 'next');
  });

  it('refuses an entry changed while permission was requested', () => {
    const pin = pageHistoryNavigation('back', null, null);
    navigation.entries = () => [{ ...entries[0], key: 'changed', url: 'https://site.example/another' }, entries[1]];
    expect(pageHistoryNavigation('back', pin, 'https://site.example')).toBeNull();
    expect(navigation.traverseTo).not.toHaveBeenCalled();
  });

  it.each(['back', 'forward', 'reload'])('normalizes a trailing hostname dot when authorizing %s', action => {
    const dottedEntries = entries.map(entry => ({ ...entry, url: entry.url.replace('site.example/', 'site.example./') }));
    navigation.currentEntry = dottedEntries[1];
    navigation.entries = () => dottedEntries;
    vi.stubGlobal('location', { href: dottedEntries[1].url, reload });
    const pin = pageHistoryNavigation(action, null, null);
    expect(pin).not.toBeNull();
    expect(pageHistoryNavigation(action, pin, 'https://site.example')).toEqual(pin);
    if (action === 'reload') expect(reload).toHaveBeenCalledOnce();
    else expect(navigation.traverseTo).toHaveBeenCalledOnce();
  });

  it('refuses an unavailable history entry and unsupported Navigation API', () => {
    navigation.entries = () => [entries[1]];
    expect(pageHistoryNavigation('back', null, null)).toBeNull();
    vi.stubGlobal('window', {});
    expect(pageHistoryNavigation('reload', null, null)).toBeNull();
  });

  it('refuses a changed source page or unapproved destination origin', () => {
    const pin = pageHistoryNavigation('back', null, null);
    expect(pageHistoryNavigation('back', pin, 'https://other.example')).toBeNull();
    navigation.currentEntry = entries[2];
    expect(pageHistoryNavigation('back', pin, 'https://site.example')).toBeNull();
    expect(navigation.traverseTo).not.toHaveBeenCalled();
  });
});
