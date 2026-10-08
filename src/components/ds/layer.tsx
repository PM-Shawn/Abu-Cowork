import { useContext, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { trackKeysDown } from './heldKey';
import { LayerContext, LayerScopeContext, type LayerEntry, type LayerRegistry } from './layer-context';
import { LAYER_FADE_MS } from './styles';

// A new dialog or approval that is held back while the user decides about unsaved input.
interface Waiting {
  entry: LayerEntry;
  // The dialog it would replace, and the dialog that asks: that one, or a dialog opened inside it.
  holderId: string;
  askerId: string;
  withdraw: () => void;
}

// A dialog, an alert or an approval that has left the registry and is still fading out.
interface Fading {
  entry: LayerEntry;
  // Another layer has been shown since: it has the focus.
  taken: boolean;
}

// Keeps at most one dialog and one menu or popover open at a time (spec §6.4, flow 2).
// An alert stacks over an open dialog and belongs to the innermost open one; a newer alert, a
// new dialog, or that dialog closing closes it.
// A layer opened inside another layer is its child and leaves that parent open. Dialogs opened
// inside a dialog are closed with it.
// A new dialog replaces the open one. When the open one, or a dialog opened inside it, holds
// unsaved input, the new dialog is held while the user is asked: Discard closes the open
// dialog and shows the new one, keeping the input closes the new one. A confirmation that was
// open over that dialog is answered with cancel as soon as the new dialog arrives, held or not:
// the discard question has to be the top layer for the user to decide.
//
// An approval is never closed by the registry: no rule below calls close() on one. Only its
// owner answers it, by closing it or by no longer rendering it.
// - One approval is on the page at a time. Another one that arrives is held in a line (an urgent
//   one at the front) and shown when the one before it leaves. One that leaves the line before
//   its turn is forgotten: it is never released nor shown.
// - A dialog that opens while an approval is on the page, or while one asks about unsaved input,
//   is turned away: held, then closed, so it is never on the page. One that is busy is held and
//   not closed: it waits with the dialogs that stepped aside and is shown when no approval is left.
// - An approval that arrives at an open dialog: a dialog that is busy (closing it would cancel
//   its work), alone or inside the open one, steps aside with the dialogs around it and comes
//   back when no approval is left; a dialog with unsaved input asks whether to discard it while
//   the approval is held, and when the user keeps the input the approval waits in the line until
//   that dialog leaves; any other dialog is closed.
// - An alert that is open when an approval arrives steps aside and comes back, unanswered. An
//   alert asked while an approval is on the page stacks over it and is answered with cancel when
//   the approval leaves, like one asked over a dialog.
// - An approval is told when a question is asked over it or a window opens inside it, and when
//   the last such layer has left the page (its fade has ended): it takes no pointer press in
//   between, and holds presses back for a moment afterwards, as it did when it appeared. A press
//   aimed at the layer that was over it must not land on it.
// - What comes back takes nobody's place. Several windows can be off the page for one approval
//   (the one that stepped aside, busy ones that opened under it): they return one at a time, each
//   when the page holds no other window and no question, and none is closed for another.
//
// Also decides which DOM node floating layers portal into.
// `onModalChange` hears whether a dialog, an alert or an approval is on the page (menus and
// popovers do not count), once per change. A layer is on the page from the moment it is shown
// until its fade has ended: it reports that through `left(id)`. When no report comes, the
// registry looks one fade after it closed and counts it as gone once its content is no longer
// painted. The app hides what the page cannot paint over (a native web view) while one is.
// `onDecisionChange` hears whether the user is being asked to decide something: an approval or a
// question (an alert, or a dialog's question about unsaved input) is shown — not one that waits
// its turn, and not one that is fading out — once per change. The app shows one notification
// then, so that none lies over the buttons that answer. Ordinary dialogs do not count.
export function LayerProvider({ children, container, onModalChange, onDecisionChange }: {
  children: ReactNode;
  container?: HTMLElement | null;
  onModalChange?: (open: boolean) => void;
  onDecisionChange?: (asked: boolean) => void;
}) {
  // The layers that are shown.
  const layers = useRef<LayerEntry[]>([]);
  // Approvals that wait their turn, the next one first. All are held.
  const waitingApprovals = useRef<LayerEntry[]>([]);
  // Windows and questions that left the page for an approval, in the order they left. All are held.
  const steppedAside = useRef<LayerEntry[]>([]);
  // The dialogs the line of approvals waits behind after the user chose to keep unsaved input.
  const keptBehind = useRef(new Set<string>());
  // Dialogs, alerts and approvals that are shown or still fading out.
  const painted = useRef(new Set<string>());
  const fadeTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  // Layers that fade out, the one that left first first. A layer shown meanwhile has the page:
  // each of them gives the focus to nobody when its fade ends, and an approval among the newcomers
  // returns focus where the first of them would have, since what it finds focused is leaving.
  const fadingLayers = useRef(new Map<string, Fading>());
  const alive = useRef(true);
  const modalListener = useRef(onModalChange);
  useLayoutEffect(() => { modalListener.current = onModalChange; });
  const modalOpen = useRef(false);
  const decisionListener = useRef(onDecisionChange);
  useLayoutEffect(() => { decisionListener.current = onDecisionChange; });
  const decisionAsked = useRef(false);
  // Dialogs whose own question about unsaved input is on the page. That question is no layer.
  const discardQuestions = useRef(new Set<string>());
  // Alert id → the innermost dialog or approval that was open when the alert was asked. The alert
  // is a question about that layer, so it is answered with cancel when the layer goes away for
  // any reason.
  const askedOver = useRef(new Map<string, string>());
  // Layer id → the approval that layer is over: a question asked over the approval or over a
  // window inside it, or a window opened inside it. The entry stays until that layer has left the
  // page. The approval is told when a layer comes over it and when the last one has left: it takes
  // no pointer press in between, nor for a moment after (LayerEntry.covered).
  const coveredBy = useRef(new Map<string, string>());
  const waiting = useRef<Waiting | null>(null);
  // A provider that leaves reports nothing (below), so a listener can still hold the yes of the
  // provider before this one. On mount each listener hears where this provider starts. A layer
  // that is open in the first commit has registered by now (its effect runs before this one) and
  // has said yes itself.
  useLayoutEffect(() => {
    if (!modalOpen.current) modalListener.current?.(false);
    if (!decisionAsked.current) decisionListener.current?.(false);
  }, []);
  // Layers read which keys were pressed since they were shown (heldKey.ts).
  useLayoutEffect(() => trackKeysDown(), []);
  // The provider is leaving, and every layer in it with it: nothing is closed, released or
  // reported from here on. This cleanup runs before the cleanups of the layers below.
  useLayoutEffect(() => {
    const timers = fadeTimers.current;
    alive.current = true;
    return () => {
      alive.current = false;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);
  const registry = useMemo<LayerRegistry>(() => {
    const isShown = (id: string) => layers.current.some((layer) => layer.id === id);
    const approvalShown = () => layers.current.some((layer) => layer.kind === 'approval');
    const approvalAsking = () => waiting.current?.entry.kind === 'approval';

    // After the registry has settled: one register or unregister can close and reopen others.
    const publish = () => {
      const asked = discardQuestions.current.size > 0 || layers.current.some((layer) => layer.kind === 'approval' || layer.kind === 'alert');
      if (asked !== decisionAsked.current) {
        decisionAsked.current = asked;
        decisionListener.current?.(asked);
      }
      const open = painted.current.size > 0 || layers.current.some((layer) => layer.kind !== 'popover');
      if (open === modalOpen.current) return;
      modalOpen.current = open;
      modalListener.current?.(open);
    };
    const stopFadeTimer = (id: string) => {
      const timer = fadeTimers.current.get(id);
      if (timer === undefined) return;
      clearTimeout(timer);
      fadeTimers.current.delete(id);
    };
    const shownApproval = (ids: readonly string[]) => (
      layers.current.find((layer) => layer.kind === 'approval' && ids.includes(layer.id))
    );
    // The approval on the page that a window or a question is over: the one it was opened inside,
    // or the one its question is about, directly or through a window inside that approval.
    const approvalUnder = (entry: LayerEntry) => {
      const inside = shownApproval(entry.ancestors);
      if (inside || entry.kind !== 'alert') return inside;
      const owner = layers.current.find((layer) => layer.id === askedOver.current.get(entry.id));
      if (!owner) return undefined;
      return owner.kind === 'approval' ? owner : shownApproval(owner.ancestors);
    };
    const cover = (layer: LayerEntry, approval: LayerEntry) => {
      coveredBy.current.set(layer.id, approval.id);
      approval.covered();
    };
    const left = (id: string) => {
      stopFadeTimer(id);
      fadingLayers.current.delete(id);
      // Shown again since it began to fade: it is on the page.
      if (isShown(id)) return;
      painted.current.delete(id);
      // It was over an approval: that approval hears it once nothing else is over it.
      const approvalId = coveredBy.current.get(id);
      if (approvalId === undefined) return;
      coveredBy.current.delete(id);
      if ([...coveredBy.current.values()].includes(approvalId)) return;
      layers.current.find((layer) => layer.id === approvalId)?.uncovered();
    };
    // The layer is no longer shown and fades out. Its own report that the fade has ended is what
    // counts. One fade later the registry looks for itself: a layer whose content is still painted
    // has not left (a fade runs long on a busy main thread), so it looks again one fade later; a
    // layer whose content has gone with no report (its owner left the page) has left.
    const startFade = (layer: LayerEntry) => {
      const { id } = layer;
      if (!painted.current.has(id)) return;
      stopFadeTimer(id);
      const look = () => {
        fadeTimers.current.set(id, setTimeout(() => {
          if (layer.isPainted()) {
            look();
            return;
          }
          left(id);
          publish();
        }, LAYER_FADE_MS));
      };
      look();
    };
    const show = (entry: LayerEntry) => {
      layers.current = [...layers.current.filter((layer) => layer.id !== entry.id), entry];
      if (entry.kind === 'popover') return;
      painted.current.add(entry.id);
      stopFadeTimer(entry.id);
      fadingLayers.current.delete(entry.id);
      // A layer that is still fading out: this one has the page now, and the focus with it.
      for (const fading of fadingLayers.current.values()) {
        if (!fading.taken) {
          fading.taken = true;
          fading.entry.focusTaken();
        }
        // An approval opens by itself, so the control it finds focused is in a layer that is
        // leaving. A dialog or an alert is opened by the user and remembers what they pressed.
        if (entry.kind === 'approval') entry.returnFocus.current ??= fading.entry.returnFocus.current;
      }
    };

    // Ends the wait without deciding: the question is taken back and the dialog is no longer held.
    const stopWaiting = () => {
      const held = waiting.current;
      waiting.current = null;
      if (!held) return;
      held.withdraw();
      held.entry.release();
    };
    // The same for an approval, which stays held: it goes to the line, or it is leaving.
    const withdrawApproval = () => {
      const held = waiting.current;
      waiting.current = null;
      held?.withdraw();
    };
    const queue = (entry: LayerEntry) => {
      if (entry.urgent) waitingApprovals.current = [entry, ...waitingApprovals.current];
      else waitingApprovals.current = [...waitingApprovals.current, entry];
    };
    // Back to the line for an approval that was the next one: before every approval but the urgent ones.
    const queueFirst = (entry: LayerEntry) => {
      const line = waitingApprovals.current;
      const at = entry.urgent ? 0 : line.filter((other) => other.urgent).length;
      waitingApprovals.current = [...line.slice(0, at), entry, ...line.slice(at)];
    };
    // Leaves the page for an approval without being closed.
    const stepAside = (layer: LayerEntry) => {
      layers.current = layers.current.filter((other) => other.id !== layer.id);
      steppedAside.current = [...steppedAside.current, layer];
      layer.hold();
      startFade(layer);
    };
    // What stepped aside returns, and nothing that returns takes another layer's place.
    // - A question about the page, or about a dialog that is on it, returns first.
    // - Then the windows, the one that left last first. A window returns to a page with no other
    //   window and no question on it; with one there it stays aside, and so do the dialogs opened
    //   inside it and the question asked over it. It returns when that layer has left.
    const comeBack = () => {
      const aside = [...steppedAside.current].reverse();
      const wasAside = new Set(aside.map((layer) => layer.id));
      const ownerAside = (layer: LayerEntry) => {
        const owner = layer.kind === 'alert' ? askedOver.current.get(layer.id) : undefined;
        return owner !== undefined && wasAside.has(owner);
      };
      const pageQuestions = aside.filter((layer) => layer.kind === 'alert' && !ownerAside(layer));
      const rest = aside.filter((layer) => !pageQuestions.includes(layer));
      const staying = new Set<string>();
      const stays = (layer: LayerEntry) => {
        if (pageQuestions.includes(layer)) return false;
        if (layer.kind === 'alert') return staying.has(askedOver.current.get(layer.id) ?? '');
        const outer = layer.ancestors.filter((id) => wasAside.has(id));
        // Inside a window that stepped aside with it: they return, or stay, together.
        if (outer.length > 0) return outer.some((id) => staying.has(id));
        return layers.current.some((other) => (
          other.kind === 'alert' || (other.kind === 'dialog' && !layer.ancestors.includes(other.id))
        ));
      };
      for (const layer of [...pageQuestions, ...rest]) {
        // Gone with a layer that returned before it in this pass.
        if (!steppedAside.current.includes(layer)) continue;
        if (stays(layer)) {
          staying.add(layer.id);
          continue;
        }
        steppedAside.current = steppedAside.current.filter((other) => other !== layer);
        layer.release();
        register(layer);
      }
    };
    // Once a change is complete: the next approval in line is shown when none is on the page or
    // asking, and what stepped aside returns when no approval is left to step aside for.
    const settle = () => {
      if (approvalShown() || approvalAsking()) return;
      const next = keptBehind.current.size === 0 ? waitingApprovals.current[0] : undefined;
      if (next) {
        waitingApprovals.current = waitingApprovals.current.slice(1);
        next.release();
        register(next);
        return;
      }
      comeBack();
    };

    const remove = (id: string) => {
      const shown = layers.current.find((layer) => layer.id === id);
      const removed = shown ?? steppedAside.current.find((layer) => layer.id === id);
      // Dialogs opened inside a dialog or an approval go with it.
      const dropped = [...layers.current, ...steppedAside.current].filter((layer) => (
        layer.id !== id && removed !== undefined && (removed.kind === 'dialog' || removed.kind === 'approval')
        && layer.kind === 'dialog' && layer.ancestors.includes(id)
      ));
      const gone = new Set([id, ...dropped.map((layer) => layer.id)]);
      // Whether a layer was shown is read before it is taken off every list the registry keeps.
      const fading = layers.current.filter((layer) => gone.has(layer.id));
      // The removed layer first: a dialog inside it would return focus to a control of it.
      const leaving = [...(shown ? [shown] : []), ...dropped].filter((layer) => layer.kind !== 'popover' && isShown(layer.id));
      const leftInLine = waitingApprovals.current.find((layer) => layer.id === id);
      layers.current = layers.current.filter((layer) => !gone.has(layer.id));
      steppedAside.current = steppedAside.current.filter((layer) => !gone.has(layer.id));
      waitingApprovals.current = waitingApprovals.current.filter((layer) => !gone.has(layer.id));
      for (const key of gone) askedOver.current.delete(key);
      // What was over an approval that leaves is no longer over anything. The approval is told so
      // as it goes: its owner may register it again, and it must not stay held then.
      const overIt = [...coveredBy.current].filter(([, approvalId]) => approvalId === id);
      for (const [key] of overIt) coveredBy.current.delete(key);
      if (overIt.length > 0) removed?.uncovered();
      for (const layer of fading) startFade(layer);
      for (const layer of leaving) fadingLayers.current.set(layer.id, { entry: layer, taken: false });
      // Never shown: what the registry prepared for its turn is dropped with it.
      if (leftInLine) leftInLine.returnFocus.current = null;
      for (const layer of [...layers.current, ...steppedAside.current]) {
        const over = askedOver.current.get(layer.id);
        // Only alerts are asked over a layer, so no approval is closed here.
        if (over !== undefined && gone.has(over)) dismiss(layer);
      }
      // Their owners hear it, so none stays open (or painted) without its outer dialog.
      for (const layer of dropped) layer.close();
      // The line no longer waits behind a dialog that has gone, nor when it is empty.
      if ([...gone].some((key) => keptBehind.current.has(key)) || waitingApprovals.current.length === 0) {
        keptBehind.current.clear();
      }
      const held = waiting.current;
      if (!held) return;
      if (held.entry.id === id) {
        // The held layer went away by itself (its request was withdrawn): nothing left to ask.
        if (held.entry.kind === 'approval') {
          withdrawApproval();
          held.entry.returnFocus.current = null;
        } else stopWaiting();
      } else if (held.holderId === id || held.askerId === id) {
        // What it waited for has gone or changed: decide again against what is open now.
        if (held.entry.kind === 'approval') {
          // It is the next approval again; settle() shows it.
          withdrawApproval();
          queueFirst(held.entry);
        } else {
          stopWaiting();
          register(held.entry);
        }
      }
    };
    // Closes a layer for another one. Never an approval: every caller passes a dialog, an alert
    // or a popover, and this check keeps it that way.
    function dismiss(layer: LayerEntry) {
      if (layer.kind === 'approval') throw new Error('The layer registry never closes an approval');
      remove(layer.id);
      layer.close();
    }
    function register(entry: LayerEntry) {
      // The same layer again (effects run twice under StrictMode): it starts from nothing.
      const known = isShown(entry.id)
        || waitingApprovals.current.some((layer) => layer.id === entry.id)
        || steppedAside.current.some((layer) => layer.id === entry.id)
        || waiting.current?.entry.id === entry.id;
      if (known) remove(entry.id);
      // Layout effects run child-first, so a layer's own descendants may already be
      // registered when it registers; they stay open like its ancestors do.
      const others = layers.current.filter((layer) => (
        layer.id !== entry.id && !entry.ancestors.includes(layer.id) && !layer.ancestors.includes(entry.id)
      ));
      const approvalAhead = others.some((layer) => layer.kind === 'approval') || approvalAsking();
      if (entry.kind === 'dialog' && approvalAhead) {
        // Held first, so it is not on the page for a moment in either case.
        entry.hold();
        if (entry.isBusy()) {
          // Closing it would cancel its work: it waits off the page, never shown over the
          // approval, and is shown when no approval is left, like a busy dialog that was open
          // before the approval. It opens by itself then, so focus returns where the approval's will.
          const ahead = others.find((layer) => layer.kind === 'approval') ?? waiting.current?.entry;
          entry.returnFocus.current ??= ahead?.returnFocus.current ?? null;
          steppedAside.current = [...steppedAside.current, entry];
          return;
        }
        // Turned away.
        entry.close();
        return;
      }
      if (entry.kind === 'approval' && (approvalAhead || keptBehind.current.size > 0)) {
        entry.hold();
        queue(entry);
        return;
      }
      let questionAside: LayerEntry | undefined;
      for (const layer of others) {
        if (layer.kind === 'popover') dismiss(layer);
        else if (layer.kind === 'alert' && entry.kind === 'approval') {
          // An open question waits, unanswered, for the approval to be answered.
          stepAside(layer);
          questionAside ??= layer;
        } else if (layer.kind === 'alert' && entry.kind !== 'popover') {
          // A new alert replaces an older one; a new dialog answers an open alert with cancel.
          dismiss(layer);
        }
      }
      if (entry.kind === 'dialog' || entry.kind === 'approval') {
        const dialogs = others.filter((layer) => layer.kind === 'dialog');
        // The open dialog: the one that is not inside another.
        const current = dialogs.find((dialog) => !dialogs.some((other) => dialog.ancestors.includes(other.id)));
        if (current) {
          // A dialog that was already waiting gives way to the newer one. (An approval that
          // waits is never here: whatever arrives while it asks is turned away or queued above.)
          const earlier = waiting.current;
          if (earlier && earlier.entry.id !== entry.id && earlier.entry.kind !== 'approval') {
            stopWaiting();
            earlier.entry.close();
          }
          // The open dialog with the dialogs opened inside it.
          const group = dialogs.filter((dialog) => dialog.id === current.id || dialog.ancestors.includes(current.id));
          if (entry.kind === 'approval' && group.some((dialog) => dialog.isBusy())) {
            // Closing any of them would cancel work in flight: the whole group waits off the
            // page, innermost first. Focus returns to where it was before the group opened.
            entry.returnFocus.current ??= current.returnFocus.current;
            const innermostFirst = [...group].sort((a, b) => b.ancestors.length - a.ancestors.length);
            for (const dialog of innermostFirst) stepAside(dialog);
          } else {
            // Unsaved input counts wherever it is: in the open dialog or in one opened inside it.
            // The innermost such dialog asks.
            const dirty = [...group].reverse().find((dialog) => dialog.isDirty());
            if (dirty) {
              entry.hold();
              const held: Waiting = { entry, holderId: current.id, askerId: dirty.id, withdraw: () => undefined };
              waiting.current = held;
              held.withdraw = dirty.confirmDiscard(
                // Removing the open dialog releases the held layer and registers it.
                () => { if (waiting.current === held) change(() => dismiss(current)); },
                () => {
                  if (waiting.current !== held) return;
                  change(() => {
                    if (entry.kind === 'approval') {
                      // An approval is not closed: it stays held, the next in line, until this dialog leaves.
                      waiting.current = null;
                      queueFirst(entry);
                      keptBehind.current = new Set([current.id, dirty.id]);
                    } else {
                      stopWaiting();
                      entry.close();
                    }
                  });
                },
              );
              return;
            }
            // The dialog fades out as this layer is shown; show() hands the focus on.
            dismiss(current);
          }
        }
      }
      if (entry.kind === 'alert') {
        // The innermost open dialog or approval: the one registered last.
        const owner = [...layers.current].reverse().find((layer) => layer.kind === 'dialog' || layer.kind === 'approval');
        if (owner) askedOver.current.set(entry.id, owner.id);
      }
      show(entry);
      if (entry.kind === 'approval') {
        // Layout effects run child-first: a window or a question inside the approval can be on
        // the page before the approval is.
        for (const layer of layers.current) {
          if ((layer.kind === 'dialog' || layer.kind === 'alert') && layer.ancestors.includes(entry.id)) cover(layer, entry);
        }
      } else if (entry.kind === 'dialog' || entry.kind === 'alert') {
        const approval = approvalUnder(entry);
        if (approval) cover(entry, approval);
      }
      // The control the approval finds focused is in the question that stepped aside. Should the
      // question be gone when the approval leaves, focus returns to where the question would have sent it.
      if (questionAside) entry.returnFocus.current ??= questionAside.returnFocus.current;
    }
    // One change from outside. Whatever it closes, releases or shows along the way, the line of
    // approvals moves and the app hears about dialogs once, when the change is complete.
    let depth = 0;
    function change(run: () => void) {
      if (!alive.current) return;
      depth += 1;
      try {
        run();
      } finally {
        depth -= 1;
      }
      if (depth > 0) return;
      settle();
      publish();
    }
    return {
      container: container ?? undefined,
      unregister: (id) => change(() => remove(id)),
      register: (entry) => change(() => register(entry)),
      left: (id) => change(() => left(id)),
      discardQuestion: (id, shown) => {
        if (!alive.current) return;
        if (shown) discardQuestions.current.add(id);
        else discardQuestions.current.delete(id);
        publish();
      },
      // The top open layer is the last one opened that has no open layer inside it.
      escapeTop: () => {
        const open = layers.current;
        [...open].reverse().find((layer) => !open.some((other) => other.ancestors.includes(layer.id)))?.escape();
      },
      isOccupied: () => (
        layers.current.some((layer) => layer.kind !== 'popover')
        || waitingApprovals.current.length > 0
        || steppedAside.current.length > 0
        || waiting.current !== null
      ),
    };
  }, [container]);
  return <LayerContext.Provider value={registry}>{children}</LayerContext.Provider>;
}

export function LayerScope({ id, children }: { id: string; children: ReactNode }) {
  const parent = useContext(LayerScopeContext);
  const value = useMemo(() => [...parent, id], [parent, id]);
  return <LayerScopeContext.Provider value={value}>{children}</LayerScopeContext.Provider>;
}
