/**
 * Sandbox-violation class, read back from annotated stderr.
 *
 * Kept free of store/i18n imports so it can be used from the sidecar too
 * (`recovery.ts` is replaced by a forwarding shim there).
 */

/** Prefix `annotateSandboxViolations` (electron/commandHost.cjs) puts on stderr. */
const SANDBOX_BLOCKED_MARKER = '[sandbox-blocked] ';

export type SandboxBlockClass = 'exec' | 'read' | 'write' | 'network' | 'unclassified';

/**
 * Read the sandbox-violation class out of an annotated stderr.
 *
 * The host writes one `[sandbox-blocked] <reasons>` line; this maps those
 * reasons back to a class so callers can react per class instead of treating
 * every block as a blocked write. Returns `null` when stderr carries no
 * annotation at all.
 */
export function sandboxBlockClass(stderr: string): SandboxBlockClass | null {
  const start = (stderr || '').indexOf(SANDBOX_BLOCKED_MARKER);
  if (start < 0) return null;

  const reasons = stderr.slice(start + SANDBOX_BLOCKED_MARKER.length).split('\n')[0].toLowerCase();
  if (reasons.includes('(exec)')) return 'exec';
  if (reasons.includes('file write blocked by sandbox policy')) return 'write';
  if (reasons.includes('file read blocked by sandbox policy')) return 'read';
  if (reasons.includes('network')) return 'network';
  return 'unclassified';
}
