/**
 * Pending attachments queue (Phase C).
 *
 * When the pet window drops files or sends from its mini input, the main
 * window's ChatInput may not be mounted yet (welcome view transition).
 * This module-level queue buffers the paths until ChatInput consumes
 * them on its next mount / activeConversation change.
 */

let queue: string[] = [];

export function setPendingAttachments(paths: string[]): void {
  // Replace, not append — each pet event is authoritative for its session.
  queue = [...paths];
}

export function consumePendingAttachments(): string[] {
  if (queue.length === 0) return [];
  const snap = queue;
  queue = [];
  return snap;
}

export function hasPendingAttachments(): boolean {
  return queue.length > 0;
}
