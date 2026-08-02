/**
 * Sidecar-local replacement for `src/core/memdir/extractor.ts`.
 *
 * P1-3d-2: real forwarding shim, superseding the P1-3b THROW stub this file
 * used to be (memory extraction was explicitly out of scope for that batch —
 * design doc §6 "本期明确不做"). The three blockers that made the real module
 * unsafe to bundle are now individually fixed (P1-3D design doc §4 / scout
 * report §3):
 *   1. `extractor.ts`'s LLM call now goes through `selectChatAdapter` (already
 *      sidecar-ized, P1-1) instead of constructing `ClaudeAdapter`/
 *      `OpenAICompatibleAdapter` directly.
 *   2. `extractor.ts`'s settings reads now go through the pure
 *      `utils/settingsSelectors.ts` module instead of the forbidden
 *      `stores/settingsStore.ts`, and its message read now always goes
 *      through `loadMessages` (already shimmed as `conversationStorageRun.ts`,
 *      which this batch extended with a real `loadMessages` — see that file)
 *      instead of the forbidden `stores/chatStore.ts`.
 *   3. `memdir/write.ts` (the `writeMemory`/`deleteMemory` implementation
 *      `extractor.ts` dynamically imports) turned out to need NO new dedicated
 *      shim: its three `@tauri-apps/plugin-fs` calls (readTextFile/remove/
 *      exists) are already covered by the EXISTING global bare-specifier
 *      redirect (`TAURI_PLUGIN_FS_SHIM` → `pluginFsRun.ts`, matched on the
 *      specifier string regardless of importer) — build-sidecar.mjs's
 *      `bundleGraphGuardPlugin` never even sees the real `@tauri-apps/*`
 *      import because `shimPlugin` (registered first) already redirected it.
 *      What DID need fixing (found empirically, not anticipated by the design
 *      doc's 3-item list — see P1-3D-2-REPORT for the full trace):
 *        - `write.ts`'s `atomicWrite()` calls go through `@tauri-apps/api/core`
 *          `invoke('atomic_write_text', ...)` (a DIFFERENT mechanism than
 *          plugin-fs — a reverse `native.invoke` RPC to the shell, allowlisted
 *          server-side). `atomic_write_text` has been added to
 *          `NATIVE_INVOKE_ALLOWLIST` in `agentLoopRunner.ts` so the round trip
 *          actually succeeds instead of failing closed with "not
 *          allowlisted".
 *        - `write.ts` imports `invalidateScanCache`/`_resetScanCache` from
 *          `./scan`, which resolves (via the existing `core/memdir/scan.ts` →
 *          `memdirScan.ts` SHIM_TARGETS entry) to THIS batch's `memdirScan.ts`
 *          shim — which only had `scanMemoryFiles`/`loadMemoryIndex`/
 *          `scanMemoryFilesCached`/`readMemoryFile` before. Both are now
 *          added there, operating on the same in-shim `scanCache` Map.
 *
 * `getMemoryDir` (via `memdir/paths.ts` → the existing `memdirPaths.ts` shim)
 * already resolves the IDENTICAL directory the shell would — same
 * `homedir()`-rooted `~/.abu/memory` / `~/.abu/projects/<key>/memory` logic,
 * byte-for-byte ported — so sidecar writes and shell reads (and vice versa)
 * land in the same place.
 *
 * Reachability unchanged from the stub's own doc: ONLY via `agentLoop.ts`'s
 * and `channelRouter.ts`'s dynamic `import('../memdir/extractor').then(...).
 * catch(() => {})` call sites, both firing only after the source turn/session
 * has fully completed (messages already flushed to disk by then).
 */
export { extractMemoriesFromConversation } from '@/core/memdir/extractor';
