// What the agent's question dock asks about the message field before it takes the focus. The dock
// takes it when a question arrives, so that the keyboard can answer; a user who is writing a
// message keeps it, or an Enter meant for the message would answer the question instead.
//
// "Writing a message": the focus is in the message field, and the field holds a draft or a key
// went down in it within the last second. The message field reports both (ChatInput).

export const COMPOSER_TYPING_MS = 1000;

// Time that only moves forward (`performance.now()`), which a test's fake clock moves.
let lastKeyAt = Number.NEGATIVE_INFINITY;
// The message fields on the page that hold a draft, each known by an object of its own.
const drafts = new Set<object>();

/** A key went down in the message field. */
export function noteComposerKey(): void {
  lastKeyAt = performance.now();
}

/** The message field of `owner` holds a draft (text, an attachment, a skill or an expert), or no longer does. */
export function noteComposerDraft(owner: object, holdsDraft: boolean): void {
  if (holdsDraft) drafts.add(owner);
  else drafts.delete(owner);
}

export function userIsWritingAMessage(): boolean {
  // With a skill tag the field is an editable box, and the focus can be on an element inside it.
  if (!document.activeElement?.closest('[data-chat-composer]')) return false;
  return drafts.size > 0 || performance.now() - lastKeyAt < COMPOSER_TYPING_MS;
}
