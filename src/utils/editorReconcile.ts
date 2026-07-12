/**
 * Editor reconcile — pure decision logic for merging on-disk content changes
 * into an in-progress edit buffer (PreviewPanel's inline CodeMirror editor).
 *
 * Background: PreviewPanel already auto-refreshes on disk changes via
 * `usePreviewFileWatch` bumping `reloadNonce` (see that hook's P2 note). Once
 * the panel itself can write the file (debounced autosave from the editor),
 * every autosave write also fires the same fs watcher — the panel can't tell
 * "this is my own save echoing back" from "an Agent/external editor changed
 * the file underneath me" just by looking at the watch event. Getting this
 * wrong either fights the user's cursor (self-echo overwrites their typing)
 * or silently clobbers external edits (adopting disk content over unsaved
 * work). `reconcileEditorContent` is the pure function that makes this call,
 * kept free of I/O so it can be tested exhaustively without mocking Tauri or
 * CodeMirror.
 */

export interface ReconcileInput {
  /** Freshly re-read content from disk (this reload cycle). */
  diskContent: string;
  /** Current edit buffer — what the user sees / has typed. */
  draft: string;
  /** Content last known to be on disk: either the initial load, or the
   *  content written by our own last successful autosave. */
  lastSaved: string;
  /** True when the caller believes `diskContent` is the echo of our own last
   *  autosave write (e.g. `diskContent === <content we just wrote>`). */
  isSelfEcho: boolean;
}

export interface ReconcileResult {
  /** The draft the editor should show after this reconcile. */
  nextDraft: string;
  /** True when disk changed externally *and* the user has unsaved edits —
   *  the caller should surface a non-blocking "changed externally" notice
   *  without overwriting `nextDraft`. */
  conflict: boolean;
}

/**
 * Decide how to merge a fresh disk read into the current edit buffer.
 *
 * Rules (checked in order):
 * 1. `diskContent === draft` — nothing to reconcile, buffer already matches.
 * 2. `isSelfEcho` — this reload is our own autosave echoing back; keep the
 *    draft as-is (it may already be ahead if the user kept typing).
 * 3. `diskContent === lastSaved` — disk hasn't actually moved since our
 *    baseline (the draft is simply mid-edit and not yet autosaved); nothing
 *    external happened, so don't flag a conflict.
 * 4. Genuine external change (disk differs from both baseline and draft):
 *    adopt it when the user has no unsaved edits (`draft === lastSaved`),
 *    otherwise keep the draft and report a conflict rather than clobbering
 *    the user's in-progress work.
 */
export function reconcileEditorContent({
  diskContent,
  draft,
  lastSaved,
  isSelfEcho,
}: ReconcileInput): ReconcileResult {
  if (diskContent === draft) {
    return { nextDraft: draft, conflict: false };
  }

  if (isSelfEcho) {
    return { nextDraft: draft, conflict: false };
  }

  if (diskContent === lastSaved) {
    return { nextDraft: draft, conflict: false };
  }

  if (draft === lastSaved) {
    return { nextDraft: diskContent, conflict: false };
  }

  return { nextDraft: draft, conflict: true };
}
