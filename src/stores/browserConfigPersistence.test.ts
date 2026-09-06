import { describe, expect, it } from 'vitest';
import {
  BROWSER_CONFIG_FIELDS,
  INITIAL_BROWSER_CONFIG_REVISIONS,
  browserConfigWasStored,
  mergeBrowserConfigForWrite,
  nextBrowserConfigRevision,
  parsePersistedSettings,
  readBrowserConfigRevisions,
  type PersistedSettingsBlob,
} from './browserConfigPersistence';

function blob(
  state: Record<string, unknown>,
  revisions?: Partial<Record<string, number>>,
): PersistedSettingsBlob {
  return {
    state: {
      ...state,
      ...(revisions
        ? { browserConfigRevisions: { ...INITIAL_BROWSER_CONFIG_REVISIONS, ...revisions } }
        : {}),
    },
    version: 47,
  };
}

describe('readBrowserConfigRevisions', () => {
  it('reads a well-formed map', () => {
    expect(readBrowserConfigRevisions({
      browserConfigRevisions: {
        browserOperationPolicy: 3,
        browserSitePermissions: 7,
        allowUnattendedBrowser: 1,
      },
    })).toEqual({
      browserOperationPolicy: 3,
      browserSitePermissions: 7,
      allowUnattendedBrowser: 1,
    });
  });

  /*
    Clamping to 0 is safe in the direction that matters: it makes THIS side look
    older, so a live write wins over a corrupt file rather than a corrupt file
    freezing the field forever.
  */
  it.each([
    ['absent', {}],
    ['not an object', { browserConfigRevisions: 'nope' }],
    ['negative', { browserConfigRevisions: { browserSitePermissions: -4 } }],
    ['not a number', { browserConfigRevisions: { browserSitePermissions: '9' } }],
    ['NaN', { browserConfigRevisions: { browserSitePermissions: Number.NaN } }],
    ['Infinity', { browserConfigRevisions: { browserSitePermissions: Number.POSITIVE_INFINITY } }],
  ])('clamps an unusable counter (%s) to zero', (_label, state) => {
    expect(readBrowserConfigRevisions(state).browserSitePermissions).toBe(0);
  });
});

describe('parsePersistedSettings', () => {
  it('returns null for absent, unparseable, or wrongly-shaped storage', () => {
    expect(parsePersistedSettings(null)).toBeNull();
    expect(parsePersistedSettings('{{{')).toBeNull();
    expect(parsePersistedSettings('[]')).toBeNull();
    expect(parsePersistedSettings('{"version":47}')).toBeNull();
  });

  it('keeps state and version', () => {
    expect(parsePersistedSettings('{"state":{"a":1},"version":47}'))
      .toEqual({ state: { a: 1 }, version: 47 });
  });
});

describe('nextBrowserConfigRevision', () => {
  // The point of reading disk: a window that has been open a while is behind,
  // and bumping only its own counter would leave every edit it makes looking
  // like old news to the merge below.
  it('goes past BOTH copies, not just the one in memory', () => {
    expect(nextBrowserConfigRevision(
      'browserSitePermissions',
      { ...INITIAL_BROWSER_CONFIG_REVISIONS, browserSitePermissions: 2 },
      { ...INITIAL_BROWSER_CONFIG_REVISIONS, browserSitePermissions: 9 },
    )).toBe(10);
  });

  it('still advances when memory is ahead of disk', () => {
    expect(nextBrowserConfigRevision(
      'browserSitePermissions',
      { ...INITIAL_BROWSER_CONFIG_REVISIONS, browserSitePermissions: 9 },
      INITIAL_BROWSER_CONFIG_REVISIONS,
    )).toBe(10);
  });
});

describe('mergeBrowserConfigForWrite', () => {
  it('writes the outgoing blob unchanged when storage is empty', () => {
    const outgoing = blob({ allowUnattendedBrowser: true });
    expect(mergeBrowserConfigForWrite(outgoing, null)).toEqual({ merged: outgoing, adopted: [] });
  });

  /**
   * The bug this whole module exists for. Window A blocks a site; window B —
   * open since before that, so holding the old verdict map — changes an
   * operation row. Without the merge, B's write silently removes A's block and
   * the gate goes on allowing the site the user thought they had stopped.
   */
  it('keeps a field another window wrote more recently', () => {
    const windowB = blob(
      {
        browserSitePermissions: {},
        browserOperationPolicy: { readOnly: 'allow', interactive: 'ask', scripting: 'ask' },
        allowUnattendedBrowser: false,
      },
      { browserOperationPolicy: 5 },
    );
    const onDisk = blob(
      {
        browserSitePermissions: { 'https://bank.example.com': 'denied' },
        browserOperationPolicy: { readOnly: 'allow', interactive: 'allow', scripting: 'ask' },
        allowUnattendedBrowser: false,
      },
      { browserSitePermissions: 4 },
    );

    const { merged, adopted } = mergeBrowserConfigForWrite(windowB, onDisk);

    // A's block survives...
    expect(merged.state.browserSitePermissions).toEqual({ 'https://bank.example.com': 'denied' });
    // ...and B's own edit still lands.
    expect(merged.state.browserOperationPolicy).toEqual({
      readOnly: 'allow', interactive: 'ask', scripting: 'ask',
    });
    expect(adopted).toEqual(['browserSitePermissions']);
  });

  /**
   * Round-2 R2-C-②. `browserSiteGrantViaEmbed` has no revision of its own —
   * it is always written in the same `set` as the verdicts it qualifies. What
   * must not happen is for it to stay behind when its owner is adopted: the
   * merge would then pair the OTHER window's grants with THIS window's marks,
   * and a marked grant read as unmarked is a grant an automatic run may act
   * on.
   */
  it('carries the via-embed marks with the verdicts they qualify', () => {
    const windowB = blob(
      {
        browserSitePermissions: { 'https://old.example.com': 'allowed' },
        browserSiteGrantViaEmbed: {},
      },
      {},
    );
    const onDisk = blob(
      {
        browserSitePermissions: { 'https://vendor.example.net': 'allowed' },
        browserSiteGrantViaEmbed: { 'https://vendor.example.net': true },
      },
      { browserSitePermissions: 4 },
    );

    const { merged } = mergeBrowserConfigForWrite(windowB, onDisk);

    expect(merged.state.browserSitePermissions)
      .toEqual({ 'https://vendor.example.net': 'allowed' });
    expect(merged.state.browserSiteGrantViaEmbed)
      .toEqual({ 'https://vendor.example.net': true });
  });

  it('drops a mark the adopted copy does not carry, rather than keeping a stale one', () => {
    const windowB = blob(
      {
        browserSitePermissions: { 'https://vendor.example.net': 'allowed' },
        browserSiteGrantViaEmbed: { 'https://vendor.example.net': true },
      },
      {},
    );
    // A store that predates the mark: its grants are unmarked by its own
    // account, and saying otherwise would be this window's opinion.
    const onDisk = blob(
      { browserSitePermissions: { 'https://vendor.example.net': 'allowed' } },
      { browserSitePermissions: 4 },
    );

    const { merged } = mergeBrowserConfigForWrite(windowB, onDisk);

    expect(merged.state.browserSiteGrantViaEmbed).toBeUndefined();
  });

  it('leaves the marks alone when the writer keeps its own verdicts', () => {
    const windowB = blob(
      {
        browserSitePermissions: { 'https://vendor.example.net': 'allowed' },
        browserSiteGrantViaEmbed: { 'https://vendor.example.net': true },
      },
      { browserSitePermissions: 9 },
    );
    const onDisk = blob(
      { browserSitePermissions: {}, browserSiteGrantViaEmbed: {} },
      { browserSitePermissions: 4 },
    );

    const { merged } = mergeBrowserConfigForWrite(windowB, onDisk);

    expect(merged.state.browserSiteGrantViaEmbed)
      .toEqual({ 'https://vendor.example.net': true });
  });

  it('reports each field it had to adopt, so the loser can be corrected on screen', () => {
    const outgoing = blob(
      { browserSitePermissions: {}, allowUnattendedBrowser: false },
      {},
    );
    const onDisk = blob(
      { browserSitePermissions: { 'https://a.example.com': 'allowed' }, allowUnattendedBrowser: true },
      { browserSitePermissions: 2, allowUnattendedBrowser: 3 },
    );

    expect(mergeBrowserConfigForWrite(outgoing, onDisk).adopted)
      .toEqual(['browserSitePermissions', 'allowUnattendedBrowser']);
  });

  // Equal revisions mean neither side has newer news, so the writer keeps its
  // own value. Anything else would make a write a no-op against a stale peer.
  it('lets the writer win a tie', () => {
    const outgoing = blob({ allowUnattendedBrowser: false }, { allowUnattendedBrowser: 3 });
    const onDisk = blob({ allowUnattendedBrowser: true }, { allowUnattendedBrowser: 3 });
    const { merged, adopted } = mergeBrowserConfigForWrite(outgoing, onDisk);
    expect(merged.state.allowUnattendedBrowser).toBe(false);
    expect(adopted).toEqual([]);
  });

  it('does not adopt a field the stored blob does not actually carry', () => {
    const outgoing = blob({ allowUnattendedBrowser: false }, {});
    const onDisk = blob({}, { allowUnattendedBrowser: 9 });
    const { merged, adopted } = mergeBrowserConfigForWrite(outgoing, onDisk);
    expect(merged.state.allowUnattendedBrowser).toBe(false);
    expect(adopted).toEqual([]);
  });

  it('leaves everything outside the browser fields to the writer', () => {
    const outgoing = blob({ theme: 'dark', allowUnattendedBrowser: false }, {});
    const onDisk = blob({ theme: 'light', allowUnattendedBrowser: true }, { allowUnattendedBrowser: 9 });
    const { merged } = mergeBrowserConfigForWrite(outgoing, onDisk);
    expect(merged.state.theme).toBe('dark');
    expect(merged.state.allowUnattendedBrowser).toBe(true);
  });

  it('carries the merged revisions forward so the next write can order itself', () => {
    const outgoing = blob({ allowUnattendedBrowser: false }, { browserOperationPolicy: 2 });
    const onDisk = blob({ allowUnattendedBrowser: true }, { allowUnattendedBrowser: 8 });
    const { merged } = mergeBrowserConfigForWrite(outgoing, onDisk);
    expect(merged.state.browserConfigRevisions).toEqual({
      browserOperationPolicy: 2,
      browserSitePermissions: 0,
      allowUnattendedBrowser: 8,
    });
  });
});

describe('browserConfigWasStored', () => {
  const intended = blob({
    browserOperationPolicy: { readOnly: 'allow', interactive: 'allow', scripting: 'ask' },
    browserSitePermissions: { 'https://a.example.com': 'allowed' },
    allowUnattendedBrowser: true,
  });

  it('confirms a write that really landed', () => {
    expect(browserConfigWasStored(intended, JSON.stringify(intended))).toBe(true);
  });

  /*
    A `setItem` that returns without throwing is not evidence. This is the
    difference between 「已保存」 and a green tick with nothing behind it.
  */
  it('refuses to confirm when storage came back empty', () => {
    expect(browserConfigWasStored(intended, null)).toBe(false);
  });

  it('refuses to confirm when storage still holds the OLD value', () => {
    const stale = blob({
      browserOperationPolicy: { readOnly: 'allow', interactive: 'allow', scripting: 'ask' },
      browserSitePermissions: {},
      allowUnattendedBrowser: true,
    });
    expect(browserConfigWasStored(intended, JSON.stringify(stale))).toBe(false);
  });

  it('checks every browser field, not just the first', () => {
    for (const field of BROWSER_CONFIG_FIELDS) {
      const partial = blob({ ...intended.state, [field]: undefined });
      expect(browserConfigWasStored(intended, JSON.stringify(partial))).toBe(false);
    }
  });

  it('refuses to confirm when the via-embed marks did not land with the verdicts', () => {
    const marked = blob({
      ...intended.state,
      browserSiteGrantViaEmbed: { 'https://a.example.com': true },
    });
    // The verdicts stored; the mark did not. A grant that reads as unmarked is
    // wider than the one that was meant to be saved, so this is not a success.
    expect(browserConfigWasStored(marked, JSON.stringify(intended))).toBe(false);
  });

  it('ignores changes outside the browser fields — another pane save is not this one failing', () => {
    const withOtherEdit = blob({ ...intended.state, theme: 'light' });
    expect(browserConfigWasStored(intended, JSON.stringify(withOtherEdit))).toBe(true);
  });
});
