/**
 * Frame addressing for the Chrome-extension channel.
 *
 * The worker injects the DOM runtime with `allFrames: true`, so every frame of
 * a tab already runs a copy — but it then broadcast every message with
 * `chrome.tabs.sendMessage(tabId, …)` and no frame id, which delivers to ALL
 * of them and keeps whichever answers FIRST. "Injected into every frame" is
 * not the same thing as "aimed at one", and the difference showed up twice:
 *
 * - a locator that only exists in an iframe worked by accident, because the
 *   frame holding it happened to answer before the frames that were about to
 *   say "Element not found" — a race, decided by scheduling;
 * - nothing could deliberately target a frame at all, so a form in a
 *   cross-origin embedded region was unreachable even though its own copy of
 *   the runtime was sitting right there.
 *
 * So frames get handles. `f<chromeFrameId>` — Chrome's own per-tab numbering,
 * which is browser-authoritative, stable while the frame lives, and 0 for the
 * main frame (hence `f0`, the handle an absent `frameId` already means).
 *
 * Origins come from `location.href` read INSIDE each frame in the extension's
 * isolated world. That is the frame's real current document address: `location`
 * is unforgeable, and the isolated world is out of the page's reach entirely.
 * It is emphatically not the `src` attribute, which the embedding page writes
 * and the frame can navigate away from — the gate authorizes per frame origin,
 * so where that origin comes from is the whole security story.
 *
 * No `chrome.*` access here on purpose: every browser call is a dependency, so
 * this module is testable in a plain Node process (same shape as `tabClaims`).
 */

import type { FrameRef, FrameTree } from '../shared/types.js';
import { MAIN_FRAME_REF, frameGoneMessage, isFrameRef } from '../shared/types.js';

/** How many frames one tab reports. A page with more is an ad farm. */
export const MAX_FRAMES = 40;

/** What the injected probe reports back from inside one frame. */
export interface FrameProbeResult {
  url: string;
  /**
   * `location.origin` read inside the frame. Preferred over deriving one from
   * `url` because it is what a browser reports for an `about:blank` /
   * `about:srcdoc` region, which INHERITS the embedder's origin — deriving
   * from the url would call a region that is plainly part of the page "not a
   * web page". Opaque origins (a sandboxed frame) report the string `"null"`,
   * which normalizes to null and stays inaccessible, as it should.
   */
  origin?: string;
  title: string;
  /**
   * The frame element is not visible in the document embedding it — see
   * `FrameNode.hidden`. Measured inside the frame from `window.frameElement`
   * (reachable when the parent is same-origin, which is the direction that
   * needs it), falling back to the frame's own viewport size. Absent means
   * "not known to be hidden", never "known to be visible".
   */
  hidden?: true;
}

/** One row of `chrome.scripting.executeScript`'s per-frame results. */
export interface FrameInjection {
  frameId: number;
  documentId: string;
  result?: FrameProbeResult;
}

export interface FrameStoreDeps {
  /** `chrome.scripting.executeScript({target:{tabId, allFrames:true}, func})`. */
  probeFrames: (tabId: number) => Promise<FrameInjection[]>;
  /** Shared with the origin pin, so one spelling of an origin everywhere. */
  normalizeOrigin: (url: string | undefined) => string | null;
}

/**
 * How long a frame probe is given before it is treated as "no frame
 * information".
 *
 * A tab held open by a native `alert()` cannot be scripted at all and Chrome
 * simply never settles the injection — the same hang `runInPageWorld` carries
 * a deadline for. Without one here a page with a dialog up would wedge every
 * snapshot, because the frame list is computed on the way out of one.
 */
export const FRAME_PROBE_TIMEOUT_MS = 2_000;

export function frameRefOf(chromeFrameId: number): FrameRef {
  return `f${chromeFrameId}`;
}

/** The Chrome frame id a handle names, or null when it is not a handle. */
export function chromeFrameIdOf(ref: unknown): number | null {
  if (!isFrameRef(ref)) return null;
  const id = Number((ref as string).slice(1));
  return Number.isSafeInteger(id) && id >= 0 ? id : null;
}

/**
 * Turn one tab's per-frame probe results into the tree the model reads.
 *
 * The main frame (Chrome frame id 0) is always first when it answered; a tab
 * whose main frame did not answer has nothing addressable and comes back
 * empty, which every caller treats as "no frame information" rather than as
 * "no frames".
 *
 * The list is FLAT: `executeScript` results carry no parent link, and inventing
 * one from url similarity would be a guess. `FrameNode.parentFrameId` is
 * documented as optional for exactly this reason.
 */
export function buildFrameTree(
  injections: FrameInjection[],
  normalizeOrigin: (url: string | undefined) => string | null,
): FrameTree {
  /**
   * A frame's origin, from what the frame itself reported.
   *
   * `origin` WINS OUTRIGHT when the probe sent one — the url is a fallback for
   * a probe that predates the field, not a second opinion. A sandboxed frame
   * reports the string `"null"`, which normalizes to null and must STAY null:
   * letting the url rescue it would hand an opaque-origin document an
   * `accessible: true` row, and the shared type promises that such a row's
   * origin is browser-authoritative — which of an opaque origin it is not. It
   * would also put that origin into the merged grant.
   */
  const originOf = (result: FrameProbeResult | undefined): string | null =>
    result?.origin !== undefined ? normalizeOrigin(result.origin) : normalizeOrigin(result?.url);
  const answered = injections.filter((row) => row.result !== undefined);
  const main = answered.find((row) => row.frameId === 0);
  const topOrigin = main ? originOf(main.result) : null;
  const ordered = [
    ...(main ? [main] : []),
    ...answered.filter((row) => row.frameId !== 0).sort((a, b) => a.frameId - b.frameId),
  ].slice(0, MAX_FRAMES);

  return ordered.map((row) => {
    const url = row.result?.url ?? '';
    const origin = originOf(row.result);
    return {
      frameId: frameRefOf(row.frameId),
      origin,
      ...(url ? { url } : {}),
      sameOriginAsTop: origin !== null && origin === topOrigin,
      // A frame that answered the probe is running our runtime and can be
      // messaged, cross-origin included: this channel injects into every frame
      // rather than reaching across a document boundary. `accessible` here is
      // therefore a real capability claim, and (per the shared type's contract)
      // it is also the promise that `origin` came from the browser.
      accessible: origin !== null,
      ...(row.result?.hidden ? { hidden: true as const } : {}),
      ...(origin === null ? { inaccessibleReason: 'not-a-web-page' as const } : {}),
    };
  });
}

export interface FrameStore {
  /** The tab's frame tree, and the document ids that go with it. */
  tree: (tabId: number) => Promise<FrameTree>;
  /**
   * The Chrome frame id to route an action to, or a refusal.
   *
   * Refuses a handle for a frame that is gone, and a handle whose frame has
   * been REPLACED since the caller last saw the tree — a reload gives the
   * frame a new document, so refs from the old one are stale and acting on the
   * strength of them would touch content the caller never read. Same wording
   * as a stale ref, because it is the same failure.
   */
  resolve: (tabId: number, ref: unknown) => Promise<number>;
  /**
   * Every VISIBLE frame of the tab except the main one, for locator
   * resolution.
   *
   * Hidden regions are left out on purpose: this list is what a locator that
   * named no frame is resolved against, and a page that plants a same-named
   * control in a 0×0 or off-screen iframe would otherwise get a unique match
   * there. They stay listed in `tree` and reachable by naming their frameId.
   */
  otherFrameIds: (tabId: number) => Promise<number[]>;
  /** Drop a closed tab's bookkeeping. */
  forget: (tabId: number) => void;
}

export function createFrameStore(deps: FrameStoreDeps): FrameStore {
  /** tabId → (chrome frame id → the document id last reported for it). */
  const seenDocuments = new Map<number, Map<number, string>>();

  const probe = async (tabId: number): Promise<FrameInjection[]> => {
    try {
      return await Promise.race([
        deps.probeFrames(tabId),
        new Promise<FrameInjection[]>((resolve) => {
          setTimeout(() => resolve([]), FRAME_PROBE_TIMEOUT_MS);
        }),
      ]);
    } catch {
      // A tab that cannot be injected (a chrome:// page, a tab that just
      // closed) has no frame information — never a fabricated main frame.
      return [];
    }
  };

  /**
   * Record what each frame's document is NOW, and hand back what it was.
   *
   * An EMPTY result is never written. `probe()` answers `[]` for a failed or
   * timed-out injection — a tab frozen inside `alert()`, one mid-navigation —
   * and those are exactly the moments a reload is most likely to be in flight.
   * Overwriting the table with nothing made the next `resolve()` see no
   * previous document id and take the "first time we have seen this frame"
   * branch, so a handle minted against the OLD document was accepted against
   * the new one: one failed probe turned a refusal into a fail-open (round-2
   * F5). Keeping the last known table costs nothing — a frame that really did
   * go away is refused by `resolve()`'s own "not in this listing" branch.
   */
  const remember = (tabId: number, injections: FrameInjection[]): Map<number, string> => {
    const previous = seenDocuments.get(tabId) ?? new Map<number, string>();
    const current = new Map<number, string>();
    for (const row of injections) {
      if (row.result === undefined) continue;
      current.set(row.frameId, row.documentId);
    }
    if (current.size > 0) seenDocuments.set(tabId, current);
    return previous;
  };

  return {
    async tree(tabId) {
      const injections = await probe(tabId);
      remember(tabId, injections);
      return buildFrameTree(injections, deps.normalizeOrigin);
    },

    async resolve(tabId, ref) {
      const wanted = chromeFrameIdOf(ref);
      if (wanted === null) {
        throw new Error(
          `Invalid frameId ${JSON.stringify(ref)}. Frame handles come from a snapshot's \`frames\` `
          + 'list (or get_tabs) and look like "f0", "f3". Omit it to act on the main document.',
        );
      }
      if (wanted === 0) return 0;
      const injections = await probe(tabId);
      const previous = remember(tabId, injections);
      const row = injections.find((r) => r.frameId === wanted && r.result !== undefined);
      if (!row) throw new Error(frameGoneMessage(ref as FrameRef));
      const before = previous.get(wanted);
      // Only a CHANGE counts. A frame seen for the first time is not stale —
      // refusing it would make the very first action against a freshly listed
      // frame fail for no reason the caller could act on.
      if (before !== undefined && before !== row.documentId) {
        throw new Error(frameGoneMessage(ref as FrameRef));
      }
      return wanted;
    },

    async otherFrameIds(tabId) {
      const injections = await probe(tabId);
      remember(tabId, injections);
      return injections
        .filter((row) => row.result !== undefined && row.frameId !== 0 && row.result.hidden !== true)
        .map((row) => row.frameId)
        .sort((a, b) => a - b)
        .slice(0, MAX_FRAMES);
    },

    forget(tabId) {
      seenDocuments.delete(tabId);
    },
  };
}

/**
 * How an action that named no frame is told the element is in one.
 *
 * Two frames holding the same locator is the frame-level shape of the
 * ambiguity the locator layer already refuses inside one document: acting on
 * whichever one the scheduler favoured is a wrong, irreversible action
 * reported as a success.
 */
export function ambiguousFrameMessage(tree: FrameTree, frameIds: number[]): string {
  const described = frameIds.map((id) => {
    const node = tree.find((f) => f.frameId === frameRefOf(id));
    return `  ${frameRefOf(id)} (${node?.origin ?? node?.url ?? 'unknown region'})`;
  });
  return (
    `That locator matches an element in ${frameIds.length} different embedded regions of this page, `
    + 'so it does not identify one. Nothing was clicked or changed. Pass `frameId` to say which:\n'
    + described.join('\n')
  );
}

/** The handle for a Chrome frame id, for stamping onto a routed message. */
export function hostFrameStamp(chromeFrameId: number): FrameRef {
  return chromeFrameId === 0 ? MAIN_FRAME_REF : frameRefOf(chromeFrameId);
}
