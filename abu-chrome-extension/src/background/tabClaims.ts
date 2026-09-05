/**
 * Task-level tab claims for the Chrome extension channel.
 *
 * ## Why this exists
 *
 * The bridge has been sending `ownerId` / `runId` on every request since N6
 * (`abu-browser-bridge/src/tools.ts` → `ownerPayloadFromExtra`), but the
 * extension consumed neither: every handler resolved its target from the
 * numeric `payload.tabId`, and a request that carried none fell back to
 * `lastActiveTabId` — the tab the USER most recently looked at. Two tasks could
 * therefore drive the same signed-in page and overwrite each other, and a
 * `query_js` with no `tabId` followed the user around their browser. The
 * ownership pipeline was built end-to-end for the built-in Electron browser
 * (`electron/browserHost.cjs`) and stopped one hop short of this channel.
 *
 * ## Mirrored semantics (deliberately NOT a second ownership model)
 *
 * The owner is the PAIR `{conversationId, runKey}`, exactly as in
 * `electron/browserHost.cjs`:
 *
 * - `conversationId` is `payload.ownerId` (`_meta['abu/conversationId']`).
 * - `runKey` is `payload.runId` (`_meta['abu/runKey']`); absent ⇒ `main`, the
 *   conversation's own loop, so the single-run world is the degenerate case of
 *   the same code rather than a second path.
 * - A request with no `ownerId` at all is `LEGACY_OWNER` — the pre-N6 bridge and
 *   any hand-driven MCP client. It keeps the old behaviour untouched
 *   (see `resolveTargetTab`).
 *
 * The rules this file enforces are the extension-side reading of
 * `findViewByTabId()` + `activeTabIdByOwner`:
 *
 * | situation | host (`browserHost.cjs`) | here |
 * |---|---|---|
 * | tab unowned | drivable, stays legacy | CLAIMED by the first owner to act on it |
 * | tab held by the same owner | allowed | allowed |
 * | tab held by a sibling run of the same conversation | allowed + logged (explicit hand-over) | same |
 * | tab held by another conversation | throws, names the tab | throws, names the tab AND its holder |
 * | tab gone | "tab not found … call get_tabs" | same shape |
 * | no `tabId` given | that owner's current tab (`get_html` only) | same |
 *
 * The one rule that CANNOT be mirrored literally: in the host, a tab the user
 * opened is `LEGACY` and driving it never claims it, because the host owns its
 * own views and the agent's tabs are ones it opened itself. Every tab in this
 * channel is a real tab in the user's Chrome, so "claim on first use" is the
 * only way an owner can ever come to hold one. That difference is in the wire
 * shape, not in the ownership model.
 *
 * Claims are dropped when the tab closes (`chrome.tabs.onRemoved`), when the
 * bridge says the run is over (`{type:'release'}`), and when the socket to the
 * bridge closes — see `background/index.ts`.
 */

// --- Owner identity (mirror of browserHost.cjs's `makeOwner` / `parseOwnerKey`) ---

export const LEGACY_CONVERSATION = 'legacy';
export const MAIN_RUN_KEY = 'main';

/**
 * Separator inside the canonical composite key. NUL for the same reason the
 * host picked it: it cannot appear in any id this app mints (base36 timestamps,
 * `sar-*` run ids) nor be typed into one, and `makeOwner` strips it from both
 * halves, so `{a, b}` and `{a<NUL>b, main}` can never collapse onto one key.
 */
const OWNER_KEY_SEPARATOR = String.fromCharCode(0);

export interface Owner {
  readonly conversationId: string;
  readonly runKey: string;
  /** The canonical composite string every per-owner map is keyed on. */
  readonly key: string;
}

/**
 * The shared pool: any caller that sent no owner. A caller with a `runId` but no
 * conversation folds into it, so a stray run id can never mint a private pool
 * that no release could ever reap.
 */
export const LEGACY_OWNER: Owner = Object.freeze({
  conversationId: LEGACY_CONVERSATION,
  runKey: MAIN_RUN_KEY,
  key: `${LEGACY_CONVERSATION}${OWNER_KEY_SEPARATOR}${MAIN_RUN_KEY}`,
});

function sanitizeOwnerPart(value: unknown): string {
  return typeof value === 'string' ? value.split(OWNER_KEY_SEPARATOR).join('').trim() : '';
}

/** The one place a composite owner key is built. */
export function makeOwner(conversationId: unknown, runKey?: unknown): Owner {
  const conversation = sanitizeOwnerPart(conversationId);
  if (!conversation || conversation === LEGACY_CONVERSATION) return LEGACY_OWNER;
  const run = sanitizeOwnerPart(runKey) || MAIN_RUN_KEY;
  return Object.freeze({
    conversationId: conversation,
    runKey: run,
    key: `${conversation}${OWNER_KEY_SEPARATOR}${run}`,
  });
}

export function isLegacyOwner(owner: Owner): boolean {
  return owner.conversationId === LEGACY_CONVERSATION;
}

/**
 * The ONE place a wire payload becomes an owner record — `ownerId` carries the
 * conversation, `runId` the subagent run.
 */
export function ownerFromPayload(payload: Record<string, unknown>): Owner {
  return makeOwner(payload.ownerId, payload.runId);
}

// --- Claim table ---

export interface ClaimRecord {
  readonly tabId: number;
  readonly owner: Owner;
  readonly claimedAt: number;
}

export interface TabClaimStore {
  /** Who holds `tabId`, or `null` when no task has claimed it. */
  holderOf(tabId: number): Owner | null;
  /** `owner`'s most recently acted-on tab, or `null`. */
  currentTabOf(owner: Owner): number | null;
  /** Record `owner` as the holder of `tabId` (first use wins). */
  claim(tabId: number, owner: Owner, claimedAt: number): void;
  /** Point `owner`'s "current tab" at `tabId` without changing who holds it. */
  touch(tabId: number, owner: Owner): void;
  /** Forget one tab entirely — it closed, or it turned out not to exist. */
  releaseTab(tabId: number): void;
  /**
   * Drop everything one owner holds. `runKey === undefined` means the whole
   * conversation (every run), the same scope
   * `browser_dispose_owner {conversationId}` has in the host.
   * @returns how many claims were dropped.
   */
  releaseOwner(conversationId: string, runKey?: string): number;
  /** Drop every claim — the connection that minted them is gone. */
  releaseAll(): void;
  /** Diagnostics / tests. */
  entries(): ClaimRecord[];
}

export function createTabClaimStore(): TabClaimStore {
  /** tabId -> the owner that claimed it. */
  const claims = new Map<number, ClaimRecord>();
  /** owner key -> that owner's most recently acted-on tab. */
  const currentTabByOwner = new Map<string, number>();

  function inScope(owner: Owner, conversationId: string, runKey?: string): boolean {
    if (owner.conversationId !== conversationId) return false;
    return runKey === undefined || owner.runKey === runKey;
  }

  return {
    holderOf(tabId) {
      return claims.get(tabId)?.owner ?? null;
    },
    currentTabOf(owner) {
      return currentTabByOwner.get(owner.key) ?? null;
    },
    claim(tabId, owner, claimedAt) {
      if (isLegacyOwner(owner)) return;
      if (!claims.has(tabId)) claims.set(tabId, { tabId, owner, claimedAt });
    },
    touch(tabId, owner) {
      if (isLegacyOwner(owner)) return;
      currentTabByOwner.set(owner.key, tabId);
    },
    releaseTab(tabId) {
      claims.delete(tabId);
      // A tab that is gone must not stay anyone's fallback target, including a
      // sibling run that only ever touched it.
      for (const [ownerKey, current] of currentTabByOwner) {
        if (current === tabId) currentTabByOwner.delete(ownerKey);
      }
    },
    releaseOwner(conversationId, runKey) {
      let dropped = 0;
      for (const [tabId, record] of claims) {
        if (inScope(record.owner, conversationId, runKey)) {
          claims.delete(tabId);
          dropped += 1;
        }
      }
      for (const ownerKey of Array.from(currentTabByOwner.keys())) {
        if (inScope(parseOwnerKey(ownerKey), conversationId, runKey)) {
          currentTabByOwner.delete(ownerKey);
        }
      }
      return dropped;
    },
    releaseAll() {
      claims.clear();
      currentTabByOwner.clear();
    },
    entries() {
      return Array.from(claims.values());
    },
  };
}

/** The one place a composite owner key is taken apart. */
function parseOwnerKey(key: string): Owner {
  const at = key.indexOf(OWNER_KEY_SEPARATOR);
  if (at < 0) return makeOwner(key, MAIN_RUN_KEY);
  return makeOwner(key.slice(0, at), key.slice(at + 1));
}

// --- Target resolution ---

/**
 * Actions a LEGACY (no `ownerId`) caller may issue without a `tabId`, falling
 * back to the user's last active tab. This is exactly the set that behaved that
 * way before task-level claims existed — the content-script action group — and
 * it is frozen here as a compatibility path, not extended.
 */
const LEGACY_LAST_ACTIVE_ACTIONS = new Set([
  'snapshot',
  'get_html',
  'click',
  'fill',
  'select',
  'wait_for',
  'extract_text',
  'extract_table',
  'scroll',
  'keyboard',
  'start_recording',
  'stop_recording',
]);

/**
 * Actions an OWNED request may issue without a `tabId`, falling back to that
 * owner's own current tab — never to the user's active tab.
 *
 * Only `get_html`, mirroring `browserHost.cjs`'s single `payload.tabId ===
 * undefined && action === 'get_html'` branch. It is not a policy choice in
 * either place: every other tool's schema makes `tabId` required
 * (`abu-browser-bridge/src/tools.ts`), so `get_html` — reached from `query_js`,
 * whose `tabId` is optional — is the only tabId-less request that can arrive.
 */
const OWNER_CURRENT_TAB_ACTIONS = new Set(['get_html']);

export interface TabResolutionDeps {
  /** Resolves `true` while the tab is still open. */
  tabExists(tabId: number): Promise<boolean>;
  /** The user's most recently active tab — read on the LEGACY path only. */
  lastActiveTabId(): number | null;
  now(): number;
  log?(message: string): void;
}

/** Pre-N6 message, kept verbatim so the legacy path reads exactly as before. */
export const NO_ACTIVE_TAB_MESSAGE =
  'No active browser tab is available. Call get_tabs and pass tabId.';

export function staleTabMessage(tabId: number): string {
  return (
    `Browser tab ${tabId} is no longer open — it was closed, or the id is not a live tab. ` +
    'Call get_tabs to see the tabs you have now.'
  );
}

export function crossConversationMessage(tabId: number, holder: Owner): string {
  return (
    `Browser tab ${tabId} belongs to another conversation's task (${holder.conversationId}). ` +
    'Call get_tabs to see the tabs you have now, and act on one this task already uses.'
  );
}

export const NO_CLAIMED_TAB_MESSAGE =
  'This task has not acted on any browser tab yet, so there is no tab to fall back on. ' +
  'Call get_tabs and pass an explicit tabId.';

export function missingTabIdMessage(action: string): string {
  return `Missing tabId for browser action "${action}". Call get_tabs and pass the target tabId.`;
}

/**
 * Read `payload.tabId` the way the host reads it: `Number()` then an integer
 * check, so a stringified id still works and anything else counts as absent.
 * `null` is rejected explicitly — `Number(null)` is `0`, which would otherwise
 * look like a (nonexistent) tab 0 rather than a missing field.
 */
function explicitTabId(payload: Record<string, unknown>): number | undefined {
  const raw = payload.tabId;
  if (raw === undefined || raw === null || raw === '') return undefined;
  const numeric = Number(raw);
  return Number.isInteger(numeric) ? numeric : undefined;
}

/**
 * Decide which tab this request acts on, claiming it for the caller when it is
 * the caller's first use of it.
 *
 * Throws — fail-loud, with a next-step hint — rather than silently retargeting,
 * for every case the host also refuses: another conversation's tab, a tab that
 * is gone, and an owner with nothing to fall back on. Nothing is written to the
 * store on a refusal.
 */
export async function resolveTargetTab(
  store: TabClaimStore,
  action: string,
  payload: Record<string, unknown>,
  deps: TabResolutionDeps,
): Promise<number> {
  const owner = ownerFromPayload(payload);
  const explicit = explicitTabId(payload);

  // --- Compatibility path: a caller that sent no ownerId (a pre-N6 bridge, or
  // a hand-driven MCP client). Behaviour is exactly what it was before claims
  // existed: no claim, no ownership check, and the last-active-tab fallback.
  // Claims only exist when the current bridge is in use, and that bridge sends
  // an ownerId on every request, so the two worlds do not overlap in practice.
  if (isLegacyOwner(owner)) {
    if (explicit !== undefined) return explicit;
    if (!LEGACY_LAST_ACTIVE_ACTIONS.has(action)) throw new Error(missingTabIdMessage(action));
    const fallback = deps.lastActiveTabId();
    if (fallback === null) throw new Error(NO_ACTIVE_TAB_MESSAGE);
    return fallback;
  }

  if (explicit !== undefined) {
    if (!(await deps.tabExists(explicit))) throw new Error(staleTabMessage(explicit));
    const holder = store.holderOf(explicit);
    if (!holder) {
      store.claim(explicit, owner, deps.now());
    } else if (holder.key !== owner.key) {
      if (holder.conversationId !== owner.conversationId) {
        throw new Error(crossConversationMessage(explicit, holder));
      }
      // A sibling run of the same conversation: allowed, because the caller
      // named the tab EXPLICITLY and an explicit id is how a parent hands a tab
      // to a child. Recorded rather than silent — it is the one place a run
      // touches a page it did not claim. Ownership does NOT move.
      deps.log?.(
        `cross-run tab access: run ${owner.runKey} acting on tab ${explicit} ` +
          `owned by run ${holder.runKey} of the same conversation (explicit tabId hand-over)`,
      );
    }
    store.touch(explicit, owner);
    return explicit;
  }

  if (!OWNER_CURRENT_TAB_ACTIONS.has(action)) throw new Error(missingTabIdMessage(action));
  const current = store.currentTabOf(owner);
  if (current === null) throw new Error(NO_CLAIMED_TAB_MESSAGE);
  if (!(await deps.tabExists(current))) {
    store.releaseTab(current);
    throw new Error(staleTabMessage(current));
  }
  return current;
}

// --- Inbound message classification ---

/**
 * The bridge sends two shapes over the same socket: `BridgeRequest` (no `type`)
 * and control messages that carry one. Before this split, EVERY message was
 * parsed as a request, so `{type:'cancel'}` was answered with
 * `Unknown action: undefined` — harmless only because the bridge had already
 * dropped that request id.
 *
 * A message WITHOUT a `type` still takes the request path unchanged, including
 * a malformed one: this split adds the control lane, it does not re-police the
 * request lane.
 */
export type BridgeInbound =
  | { kind: 'request' }
  | { kind: 'cancel'; requestId: string }
  | { kind: 'release'; ownerId: string; runId?: string }
  | { kind: 'unknown'; type: string };

export function classifyInbound(raw: unknown): BridgeInbound {
  const message = (raw ?? {}) as Record<string, unknown>;
  if (typeof message.type !== 'string') return { kind: 'request' };
  if (message.type === 'cancel') {
    return { kind: 'cancel', requestId: String(message.requestId ?? '') };
  }
  if (message.type === 'release' && typeof message.ownerId === 'string') {
    return {
      kind: 'release',
      ownerId: message.ownerId,
      runId: typeof message.runId === 'string' ? message.runId : undefined,
    };
  }
  return { kind: 'unknown', type: message.type };
}
