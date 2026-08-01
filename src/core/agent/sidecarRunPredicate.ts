/**
 * Tiny cycle-breaking indirection for P1-3c-1 (see
 * `docs/2026-07-21-phase1-p3c-conversation-authority-design.md` §3).
 *
 * `chatStore.ts`'s `cancelStreaming` needs a SYNCHRONOUS answer to "does
 * `conversationId` currently have a live sidecar-hosted run?" to decide
 * whether the Stop button's decoration is its own job (no sidecar run — the
 * pre-3c direct path, unchanged) or the sidecar's (a run is live there — the
 * shell only signals abort, see chatStore.ts's `cancelStreaming` doc).
 *
 * The real answer is `agentLoopRunner.ts`'s `isConversationRunningInSidecar`
 * (wrapping its `sessions` registry via `findRunSessionForConversation`).
 * But `agentLoopRunner.ts` statically imports `useChatStore` (its
 * push-emitters read/subscribe to it — see that file's own `import {
 * useChatStore } from '../../stores/chatStore'`), so `chatStore.ts`
 * statically importing `agentLoopRunner.ts` back would be a circular module
 * dependency.
 *
 * A dynamic `import()` can't substitute for a plain static import here
 * either: it's inherently asynchronous (resolves no earlier than the next
 * microtask), and `chatStore.test.ts` has several existing regression tests
 * (`cancelStreaming persistence`, "flushes buffered thinking — no lost
 * content", ...) that call `cancelStreaming()` and assert on the mutated
 * message in the SAME synchronous tick, with no `await` in between —
 * deferring the gate decision behind ANY promise would silently break those.
 *
 * So this leaf module (zero imports of its own) sits BELOW both:
 * `agentLoopRunner.ts` registers its real predicate here once, at module
 * load (see the bottom of that file). `chatStore.ts` statically imports ONLY
 * this file, never `agentLoopRunner.ts` directly. Defaults to "always false"
 * (= "no sidecar run" = the pre-3c full-decoration path) until registered —
 * the same safe fallback chatStore.test.ts's fabricated conversation ids
 * naturally get too (a run was never registered for them).
 */
let predicate: (conversationId: string) => boolean = () => false;

/** Registered once by `agentLoopRunner.ts` at module load — not a per-call toggle. */
export function registerSidecarRunPredicate(fn: (conversationId: string) => boolean): void {
  predicate = fn;
}

/** Synchronous — true iff `conversationId` currently has a live sidecar-hosted run. See module doc for why this indirection exists instead of importing agentLoopRunner.ts directly. */
export function isConversationRunningInSidecar(conversationId: string): boolean {
  return predicate(conversationId);
}
