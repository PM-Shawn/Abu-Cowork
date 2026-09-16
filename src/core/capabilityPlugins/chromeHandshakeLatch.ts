/**
 * Has the Chrome extension ever completed a handshake in THIS PROCESS.
 *
 * It is the one bit that separates "never set up" from "was working and
 * broke", and the difference decides whether the capability card reads as a
 * neutral "not connected" or an amber fault. Getting it wrong in either
 * direction is a lie about the user's machine.
 *
 * Why a module and not component state: the settings surface unmounts every
 * time the dialog closes, and a genuinely lost connection must not turn back
 * into "never connected" because someone closed a dialog. Scope is one
 * process, by construction.
 *
 * Why NOT persisted: it is an observation about the current process, not a
 * user setting. Writing it to disk would let a stale "it once worked" survive
 * a machine where the extension has since been uninstalled, and would make a
 * settings-store field out of something no user ever chose. It must never be
 * added to `settingsStore` or any `partialize`.
 */
let handshaked = false;

export function hasChromeExtensionHandshaked(): boolean {
  return handshaked;
}

/**
 * Latch on a completed handshake, or clear it when the user explicitly
 * disconnects — after that, this is "not connected", not "connection lost".
 */
export function setChromeExtensionHandshaked(value: boolean): void {
  handshaked = value;
}
