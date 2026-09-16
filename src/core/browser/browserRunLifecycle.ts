import { invoke } from '@tauri-apps/api/core';
import { isTauriEnv } from '@/utils/tauriEnv';

interface ActiveBrowserRun {
  active: boolean;
  registration?: Promise<void>;
}
const activeRuns = new Map<string, ActiveBrowserRun>();
const keyOf = (conversationId: string, runId: string) => `${conversationId}\0${runId}`;

/** Called only by the shell's actual local/sidecar execution lifecycle. */
export function startBrowserRun(conversationId?: string, runId?: string): void {
  if (!conversationId || !runId) return;
  const key = keyOf(conversationId, runId);
  if (activeRuns.has(key)) throw new Error('Browser run already started');
  activeRuns.set(key, { active: true });
}

/** Shared entry for permission probes and real built-in MCP calls. */
export async function ensureBrowserRunRegistered(conversationId?: string, runId?: string): Promise<void> {
  if (!runId || !isTauriEnv()) return;
  const key = keyOf(conversationId || '', runId);
  const record = activeRuns.get(key);
  if (!record?.active) throw new Error('Browser child run has ended or was never started');
  record.registration ??= Promise.resolve(invoke<void>('browser_register_run', { conversationId, runKey: runId }));
  await record.registration;
  // Registration may finish after settlement; that does not permit a call.
  if (!record.active || activeRuns.get(key) !== record) throw new Error('Browser child run ended while registering');
}

/** Revoke synchronously; return ordered host cleanup for the caller to await. */
export async function endBrowserRun(conversationId?: string, runId?: string): Promise<void> {
  if (!conversationId || !runId) return;
  const key = keyOf(conversationId, runId);
  const record = activeRuns.get(key);
  if (record) record.active = false;
  activeRuns.delete(key);
  if (!isTauriEnv()) return;
  // No call can have been sent before this registration settles. Ordering its
  // cleanup afterwards prevents a late register from resurrecting the run.
  try { await record?.registration; } catch { /* still revoke an uncertain registration */ }
  await invoke('browser_dispose_owner', { conversationId, runKey: runId });
}
