/**
 * Global registry of RegistryAdapters.
 *
 * Module-scoped Map acts as the in-memory registry. Bootstrap code
 * (a callsite in App initialization, not in this file) calls
 * `registerAdapter()` for each adapter the build wants shipped.
 * Tests register mocks via the same entry point.
 *
 * Separation of concerns:
 *   - `types.ts`     — what an adapter looks like
 *   - `index.ts`     — who tracks them (this file)
 *   - `<name>.ts`    — individual adapters (CLAWhub, SkillsHub, …)
 *   - `bootstrap.ts` — which adapters this build ships with
 *
 * We deliberately don't export a `getAdapter()` by id that throws —
 * UI code consistently does "show if present" rather than "crash if
 * absent", so `getAdapter` returns `undefined`.
 */

import type { RegistryAdapter } from './types';

const adapters = new Map<string, RegistryAdapter>();

/**
 * Register an adapter. Idempotent: calling with the same id replaces
 * the existing one (useful for hot-reload + tests; less surprising
 * than silently rejecting duplicates).
 */
export function registerAdapter(adapter: RegistryAdapter): void {
  adapters.set(adapter.id, adapter);
}

/** Remove an adapter. Returns true if one was actually removed. */
export function unregisterAdapter(id: string): boolean {
  return adapters.delete(id);
}

/** Get all registered adapters in insertion order. */
export function listAdapters(): RegistryAdapter[] {
  return [...adapters.values()];
}

/** Look up a single adapter by id. */
export function getAdapter(id: string): RegistryAdapter | undefined {
  return adapters.get(id);
}

/** Test helper — wipes the registry. Don't call from production code. */
export function __resetAdaptersForTests(): void {
  adapters.clear();
}

export type { RegistryAdapter, SkillListItem, RegistryCapabilities } from './types';
