'use strict';

const { isHighRiskUrl } = require('../abu-browser-shared/highRiskSites.mjs');

const POPUP_BLOCKED = 'Popup blocked. The destination needs a separate browsing approval. Preserve the source page; do not replay a form submission as a GET or retry it automatically. Manual popup retries on this AI-controlled page are also blocked.';

// Native window-open callbacks have no trustworthy initiating-frame/user-input
// field. Authorization is an explicit, one-use lease, not input attribution or
// a page's claim that its script is a user gesture.
function createBrowserPopupPolicy({ originOf, onBlocked = () => {} }) {
  const driven = new WeakSet();
  const blocked = new WeakSet();
  const epochs = new WeakMap();
  const actions = new WeakMap();
  const children = new Map();
  const groups = new WeakMap();
  function group(contents) {
    if (!groups.has(contents)) {
      groups.set(contents, new Set([contents]));
      contents.once('destroyed', () => {
        groups.get(contents)?.delete(contents);
        groups.delete(contents);
        children.delete(contents.id);
      });
    }
    return groups.get(contents);
  }
  function markDriven(contents) {
    // A same-origin opener can execute code in an existing manual child.
    // Mark the entire native opener family, not just the calling WebContents.
    for (const member of group(contents)) {
      driven.add(member);
      const child = children.get(member.id);
      if (child && !child.guarded) {
        child.guarded = true;
        child.origin = originOf(member.getURL());
      }
    }
  }

  function documentChanged(contents) {
    epochs.set(contents, (epochs.get(contents) || 0) + 1);
  }

  function beginAction(contents, { owner, origin, signal, isCurrent }) {
    markDriven(contents);
    const entries = actions.get(contents) || new Set();
    const entry = {
      owner, origin, signal, isCurrent, epoch: epochs.get(contents) || 0,
      used: false, active: true, blocked: false,
    };
    entries.add(entry);
    actions.set(contents, entries);
    return {
      get blocked() { return entry.blocked; },
      get message() { return entry.blockedMessage || POPUP_BLOCKED; },
      end() {
        entry.active = false;
        entries.delete(entry);
        if (!entries.size) actions.delete(contents);
      },
    };
  }

  function valid(contents, entry) {
    return entry.active && !entry.signal?.aborted && !contents.isDestroyed()
      && entry.epoch === (epochs.get(contents) || 0)
      && entry.origin && originOf(contents.getURL()) === entry.origin
      && entry.isCurrent();
  }

  function reject(contents, message = POPUP_BLOCKED) {
    for (const entry of actions.get(contents) || []) { entry.blocked = true; entry.blockedMessage ||= message; }
    if (!blocked.has(contents)) {
      blocked.add(contents);
      onBlocked(contents);
    }
    return null;
  }

  function request(contents, url, manualOwner) {
    const origin = originOf(url);
    if (!origin) return reject(contents);
    const entries = [...(actions.get(contents) || [])];
    // Legacy pages may also have been driven by AI. Once driven, the absence
    // of an active lease must never turn a delayed script into a manual popup.
    if (!driven.has(contents) && manualOwner) {
      return { source: contents, owner: manualOwner, origin: null, valid: () => !contents.isDestroyed() };
    }
    if (entries.length !== 1) return reject(contents);
    const entry = entries[0];
    if (entry.used || !valid(contents, entry)) return reject(contents);
    entry.used = true;
    if (entry.origin !== origin || isHighRiskUrl(url)) return reject(contents);
    return { source: contents, owner: entry.owner, origin, signal: entry.signal, valid: () => valid(contents, entry) };
  }

  function attach(contents, ticket) {
    if (children.get(contents.id)?.cancelled || !ticket.valid()) throw new Error(POPUP_BLOCKED);
    const family = group(ticket.source);
    for (const member of group(contents)) { family.add(member); groups.set(member, family); }
    children.set(contents.id, { contents, origin: ticket.origin, signal: ticket.signal, guarded: !!ticket.origin });
    if ([...family].some((member) => driven.has(member))) markDriven(contents);
  }

  function rejectChild(contents) {
    group(contents);
    driven.add(contents);
    children.set(contents.id, { contents, guarded: true, cancelled: true });
    contents.on('will-navigate', (event) => event.preventDefault());
    contents.setWindowOpenHandler?.(() => ({ action: 'deny' }));
  }

  // Called by the session's main-frame onBeforeRequest, including redirects.
  // Refusing before dispatch is necessary for 307/308: did-navigate is too
  // late and would already have sent the POST body to an unapproved origin.
  function permitsRequest(contentsId, url, resourceType = 'mainFrame') {
    const entry = children.get(contentsId);
    if (entry?.cancelled) return false;
    if (resourceType !== 'mainFrame') return true;
    if (!entry || !entry.guarded) return true;
    const allowed = !entry.signal?.aborted && originOf(url) === entry.origin
      && (!isHighRiskUrl(url) || url === entry.explicitUrl);
    if (!allowed) reject(entry.contents);
    return allowed;
  }

  // Only trusted, approved navigation (or a real address-bar command) may
  // replace a child's navigation boundary. Native page/opener scripts cannot.
  function approvedNavigation(contents, url) {
    blocked.delete(contents);
    const entry = children.get(contents.id);
    if (entry) {
      entry.guarded = true;
      entry.origin = originOf(url);
      entry.explicitUrl = url;
      entry.signal = undefined;
    }
  }

  function canActivate(contents) {
    const entries = [...(actions.get(contents) || [])];
    return entries.length === 1 && !entries[0].used && valid(contents, entries[0]);
  }
  return { documentVersion: (contents) => epochs.get(contents) || 0, familyFor: group, deny: reject, rejectChild, canActivate, markDriven, beginAction, documentChanged, request, attach, permitsRequest, approvedNavigation, wasBlocked: (contents) => blocked.has(contents) };
}

module.exports = { createBrowserPopupPolicy, POPUP_BLOCKED };
