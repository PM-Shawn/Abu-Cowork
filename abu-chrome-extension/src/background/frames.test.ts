/**
 * Frame addressing on the Chrome-extension channel.
 *
 * What matters here is not "does it list frames" but the three properties the
 * gate and the locator layer are entitled to rely on:
 *
 * 1. `origin` on an `accessible` frame comes from the BROWSER (the address the
 *    frame's own `location` reported through the extension's isolated world),
 *    never from the `src` the embedding page wrote — the gate authorizes per
 *    frame origin, so this is the whole security story.
 * 2. A handle for a frame that has been REPLACED is refused rather than
 *    silently routed to the new document, because the refs the caller holds
 *    describe content that is gone.
 * 3. A frame that never answered is not in the list at all — a fabricated row
 *    would be an origin nobody read from the browser.
 */

import { describe, expect, it } from 'vitest';
import {
  buildFrameTree,
  chromeFrameIdOf,
  createFrameStore,
  frameRefOf,
  type FrameInjection,
} from './frames.js';

/** The same normalization the origin pin uses — http(s) only, default ports dropped. */
function normalizeOrigin(url: string | undefined): string | null {
  try {
    const parsed = new URL(String(url ?? ''));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const hostname = parsed.hostname.endsWith('.') ? parsed.hostname.slice(0, -1) : parsed.hostname;
    if (!hostname) return null;
    return `${parsed.protocol}//${hostname}${parsed.port ? `:${parsed.port}` : ''}`;
  } catch {
    return null;
  }
}

function row(frameId: number, url: string, documentId = `doc-${frameId}`): FrameInjection {
  return { frameId, documentId, result: { url, title: '' } };
}

/** The same row, for a frame whose element the user cannot see. */
function hiddenRow(frameId: number, url: string, documentId = `doc-${frameId}`): FrameInjection {
  return { frameId, documentId, result: { url, title: '', hidden: true } };
}

describe('frame handles', () => {
  it('numbers frames the way Chrome does, so f0 is the main document', () => {
    expect(frameRefOf(0)).toBe('f0');
    expect(chromeFrameIdOf('f7')).toBe(7);
  });

  it('refuses anything that is not a handle rather than defaulting to the main frame', () => {
    expect(chromeFrameIdOf('main')).toBeNull();
    expect(chromeFrameIdOf('f-1')).toBeNull();
    expect(chromeFrameIdOf(3)).toBeNull();
  });
});

describe('building the tree', () => {
  it('reports each frame the origin its own document reported, not the embedder\'s', () => {
    const tree = buildFrameTree(
      [row(0, 'https://oa.example.com/form'), row(3, 'https://vendor.example.net/widget')],
      normalizeOrigin,
    );

    expect(tree).toEqual([
      {
        frameId: 'f0',
        origin: 'https://oa.example.com',
        url: 'https://oa.example.com/form',
        sameOriginAsTop: true,
        accessible: true,
      },
      {
        frameId: 'f3',
        origin: 'https://vendor.example.net',
        url: 'https://vendor.example.net/widget',
        sameOriginAsTop: false,
        accessible: true,
      },
    ]);
  });

  it('marks a same-origin embedded region as covered by the page\'s own grant', () => {
    const tree = buildFrameTree(
      [row(0, 'https://oa.example.com/form'), row(2, 'https://oa.example.com/form/inner')],
      normalizeOrigin,
    );

    expect(tree[1]).toMatchObject({ frameId: 'f2', sameOriginAsTop: true, accessible: true });
  });

  it('a default port and a trailing dot are the same origin as the plain spelling', () => {
    const tree = buildFrameTree(
      [row(0, 'https://oa.example.com/form'), row(1, 'https://oa.example.com.:443/inner')],
      normalizeOrigin,
    );

    expect(tree[1]).toMatchObject({ origin: 'https://oa.example.com', sameOriginAsTop: true });
  });

  it('never calls a document that is not a web page accessible', () => {
    const tree = buildFrameTree(
      [row(0, 'https://oa.example.com/form'), row(4, 'about:blank')],
      normalizeOrigin,
    );

    expect(tree[1]).toMatchObject({
      frameId: 'f4',
      origin: null,
      accessible: false,
      inaccessibleReason: 'not-a-web-page',
    });
  });

  it('keeps a sandboxed region inaccessible instead of letting its url rescue it', () => {
    // A sandbox with an opaque origin reports the literal string "null". The
    // shared type promises that an `accessible` row's origin came from the
    // browser; reverse-engineering one from the address would break that
    // promise AND put the manufactured origin into the merged grant.
    const tree = buildFrameTree(
      [
        { frameId: 0, documentId: 'doc-0', result: { url: 'https://oa.example.com/apply', origin: 'https://oa.example.com', title: '' } },
        { frameId: 3, documentId: 'doc-3', result: { url: 'https://vendor.example.net/widget', origin: 'null', title: '' } },
      ],
      normalizeOrigin,
    );

    expect(tree[1]).toMatchObject({
      frameId: 'f3', origin: null, accessible: false, inaccessibleReason: 'not-a-web-page',
    });
  });

  it('still derives an origin from the url for a probe that reported none', () => {
    // The field is newer than the probe; an older answer must not become "not
    // a web page" just because it predates it.
    const tree = buildFrameTree(
      [{ frameId: 0, documentId: 'doc-0', result: { url: 'https://oa.example.com/apply', title: '' } }],
      normalizeOrigin,
    );

    expect(tree[0]).toMatchObject({ origin: 'https://oa.example.com', accessible: true });
  });

  it('leaves out a frame that never answered rather than inventing a row for it', () => {
    const tree = buildFrameTree(
      [row(0, 'https://oa.example.com/form'), { frameId: 9, documentId: 'doc-9' }],
      normalizeOrigin,
    );

    expect(tree.map((f) => f.frameId)).toEqual(['f0']);
  });

  it('has nothing to say about a tab whose main frame could not be probed', () => {
    expect(buildFrameTree([row(5, 'https://x.example.com/')], normalizeOrigin)[0])
      .toMatchObject({ frameId: 'f5', sameOriginAsTop: false });
    expect(buildFrameTree([], normalizeOrigin)).toEqual([]);
  });
});

describe('routing to a frame', () => {
  function store(frames: Record<number, FrameInjection[]>, log: number[] = []) {
    return createFrameStore({
      probeFrames: async (tabId) => { log.push(tabId); return frames[tabId] ?? []; },
      normalizeOrigin,
    });
  }

  it('routes the main frame without probing at all', async () => {
    const log: number[] = [];
    await expect(store({}, log).resolve(1, 'f0')).resolves.toBe(0);
    expect(log).toEqual([]);
  });

  it('routes a frame the browser still reports', async () => {
    const frames = { 1: [row(0, 'https://a.example.com/'), row(6, 'https://b.example.com/')] };
    await expect(store(frames).resolve(1, 'f6')).resolves.toBe(6);
  });

  it('refuses a handle for a frame the page no longer has', async () => {
    const frames = { 1: [row(0, 'https://a.example.com/')] };
    await expect(store(frames).resolve(1, 'f6')).rejects.toThrow(/not on this page any more/);
  });

  it('refuses a handle whose frame reloaded, because the refs from it are stale', async () => {
    const frames: Record<number, FrameInjection[]> = {
      1: [row(0, 'https://a.example.com/'), row(6, 'https://b.example.com/', 'doc-first')],
    };
    const s = store(frames);
    await s.tree(1);

    frames[1] = [row(0, 'https://a.example.com/'), row(6, 'https://b.example.com/', 'doc-second')];

    await expect(s.resolve(1, 'f6')).rejects.toThrow(/reloaded, or was removed/);
    // And it recovers: the caller re-reads the tree, and the same handle works
    // again against the document it can now see.
    await expect(s.resolve(1, 'f6')).resolves.toBe(6);
  });

  /**
   * Round-2 F5. A probe that times out or fails answers `[]`, and those are
   * the moments a reload is most likely to be under way — a tab frozen in
   * `alert()`, a document mid-swap. Writing that emptiness over the document
   * table erased the only evidence a reload had happened, so the very next
   * call took the "first time we have seen this frame" branch and accepted a
   * handle minted against the document that is gone.
   */
  it('a failed probe between two reads does not resurrect a stale handle', async () => {
    const frames: Record<number, FrameInjection[]> = {
      1: [row(0, 'https://a.example.com/'), row(6, 'https://b.example.com/', 'doc-first')],
    };
    const s = store(frames);
    await s.tree(1);

    // The tab freezes (or the injection fails): no frame information at all.
    frames[1] = [];
    await s.tree(1);

    // …and comes back on a NEW document. The handle is still stale.
    frames[1] = [row(0, 'https://a.example.com/'), row(6, 'https://b.example.com/', 'doc-second')];
    await expect(s.resolve(1, 'f6')).rejects.toThrow(/reloaded, or was removed/);
  });

  it('does not treat a frame it is seeing for the first time as stale', async () => {
    const frames = { 1: [row(0, 'https://a.example.com/'), row(6, 'https://b.example.com/')] };
    await expect(store(frames).resolve(1, 'f6')).resolves.toBe(6);
  });

  it('forgets a closed tab, so a recycled tab id starts clean', async () => {
    const frames: Record<number, FrameInjection[]> = {
      1: [row(0, 'https://a.example.com/'), row(6, 'https://b.example.com/', 'doc-first')],
    };
    const s = store(frames);
    await s.tree(1);
    s.forget(1);

    frames[1] = [row(0, 'https://a.example.com/'), row(6, 'https://b.example.com/', 'doc-second')];

    await expect(s.resolve(1, 'f6')).resolves.toBe(6);
  });

  it('refuses a malformed handle instead of falling back to the main document', async () => {
    await expect(store({}).resolve(1, 'the-login-frame')).rejects.toThrow(/Invalid frameId/);
  });

  it('lists the other frames for locator resolution, main frame excluded', async () => {
    const frames = {
      1: [row(0, 'https://a.example.com/'), row(2, 'https://b.example.com/'), row(9, 'https://c.example.com/')],
    };
    await expect(store(frames).otherFrameIds(1)).resolves.toEqual([2, 9]);
  });

  /**
   * TESTING §13.1, "隐藏 / 零尺寸 iframe 里塞一份同名控件". `otherFrameIds` is
   * what a locator that named no frame is resolved against, so a hidden decoy
   * carrying the same control would be the unique match and the click would
   * land where nobody can see it.
   */
  it('leaves a hidden region out of locator resolution, but not out of the tree', async () => {
    const frames = {
      1: [row(0, 'https://a.example.com/'), row(2, 'https://b.example.com/'), hiddenRow(9, 'https://c.example.com/')],
    };
    const s = store(frames);

    await expect(s.otherFrameIds(1)).resolves.toEqual([2]);
    // Still listed, still routable when the caller names it on purpose.
    expect((await s.tree(1)).map((f) => [f.frameId, f.hidden])).toEqual([
      ['f0', undefined], ['f2', undefined], ['f9', true],
    ]);
    await expect(s.resolve(1, 'f9')).resolves.toBe(9);
  });

  it('treats a tab that cannot be probed as having no frame information', async () => {
    const s = createFrameStore({
      probeFrames: async () => { throw new Error('Cannot access contents of the page'); },
      normalizeOrigin,
    });

    await expect(s.tree(1)).resolves.toEqual([]);
    await expect(s.otherFrameIds(1)).resolves.toEqual([]);
    await expect(s.resolve(1, 'f2')).rejects.toThrow(/not on this page any more/);
  });
});
