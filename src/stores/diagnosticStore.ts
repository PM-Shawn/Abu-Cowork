/**
 * Diagnostic store — persists the most recent online-diagnostic results
 * so the page can show them instantly on next open instead of forcing a
 * 5-second loading state every visit.
 *
 * Persists `results` + `lastCheckedAt` only. `isChecking` and
 * `exportInProgress` are intentionally ephemeral — never persist a "still
 * running" flag (would falsely block the UI on next launch if the user
 * force-quit mid-check).
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { ALL_CATEGORIES, runCategoryChecks } from '@/core/diagnostic/runner';
import type { CheckCategory, CheckResult, OverallStatus } from '@/core/diagnostic/types';

interface DiagnosticState {
  /** Most recent results, keyed by CheckResult.id. */
  results: Record<string, CheckResult>;
  /** Epoch ms of the last full-run completion. null = never run. */
  lastCheckedAt: number | null;
  /** A full-run is in flight. */
  isChecking: boolean;
  /** Per-id flag for items currently re-running individually. */
  reRunning: Record<string, boolean>;
  /** Export bundle in progress. */
  exportInProgress: boolean;
  /** Last successful export path. */
  lastExportPath: string | null;
  /** "Include raw text" checkbox state, persisted. */
  includeRawText: boolean;
}

interface DiagnosticActions {
  runAll: () => Promise<void>;
  runCategory: (cat: CheckCategory) => Promise<void>;
  runItem: (id: string) => Promise<void>;
  setIncludeRawText: (v: boolean) => void;
  setExportInProgress: (v: boolean) => void;
  setLastExportPath: (path: string | null) => void;
  clearResults: () => void;
}

type DiagnosticStore = DiagnosticState & DiagnosticActions;

export const useDiagnosticStore = create<DiagnosticStore>()(
  persist(
    (set, get) => ({
      results: {},
      lastCheckedAt: null,
      isChecking: false,
      reRunning: {},
      exportInProgress: false,
      lastExportPath: null,
      includeRawText: false,

      runAll: async () => {
        if (get().isChecking) return;
        // Clear previous results so quick checks visibly stream in instead
        // of starting from a stale snapshot — incremental writes below keep
        // the UI alive while the slow AI-services check is still pending.
        set({ isChecking: true, results: {} });
        try {
          // Fire all categories in parallel but write each into the store
          // independently as it resolves. Promise.allSettled at the end is
          // only used to flip `isChecking` once everything's done.
          const tasks = ALL_CATEGORIES.map((cat) =>
            runCategoryChecks(cat).then((rows) => {
              set((s) => {
                const next = { ...s.results };
                for (const r of rows) next[r.id] = r;
                return { results: next };
              });
            }),
          );
          await Promise.allSettled(tasks);
          set({ lastCheckedAt: Date.now(), isChecking: false });
        } catch (e) {
          console.error('[diagnostic] runAll failed:', e);
          set({ isChecking: false });
        }
      },

      runCategory: async (cat) => {
        const results = await runCategoryChecks(cat);
        set((s) => {
          const next = { ...s.results };
          // Drop existing rows for this category, then insert new ones
          for (const id of Object.keys(next)) {
            if (next[id].category === cat) delete next[id];
          }
          for (const r of results) next[r.id] = r;
          return { results: next, lastCheckedAt: Date.now() };
        });
      },

      runItem: async (id) => {
        const existing = get().results[id];
        if (!existing) return;
        set((s) => ({ reRunning: { ...s.reRunning, [id]: true } }));
        try {
          // Re-running a single item piggy-backs on the category runner — it's
          // the simplest way to recompute the value with the same code path
          // the full run uses. We then pluck the matching result back out.
          const fresh = await runCategoryChecks(existing.category);
          const updated = fresh.find((r) => r.id === id);
          set((s) => {
            const next = { ...s.results };
            if (updated) next[id] = updated;
            const reRunning = { ...s.reRunning };
            delete reRunning[id];
            return { results: next, reRunning };
          });
        } catch (e) {
          console.error('[diagnostic] runItem failed:', id, e);
          set((s) => {
            const reRunning = { ...s.reRunning };
            delete reRunning[id];
            return { reRunning };
          });
        }
      },

      setIncludeRawText: (v) => set({ includeRawText: v }),
      setExportInProgress: (v) => set({ exportInProgress: v }),
      setLastExportPath: (path) => set({ lastExportPath: path }),
      clearResults: () => set({ results: {}, lastCheckedAt: null }),
    }),
    {
      name: 'abu-diagnostic-store',
      version: 1,
      partialize: (s) => ({
        results: s.results,
        lastCheckedAt: s.lastCheckedAt,
        includeRawText: s.includeRawText,
        lastExportPath: s.lastExportPath,
      }),
    }
  )
);

// ─── Selectors ──────────────────────────────────────────────────────────

export function getOverallStatus(s: DiagnosticState): OverallStatus {
  if (s.isChecking) return 'checking';
  const arr = Object.values(s.results);
  if (arr.length === 0) return 'no-data';
  if (arr.some((r) => r.status === 'failed')) return 'has-failures';
  if (arr.some((r) => r.status === 'warning')) return 'has-warnings';
  return 'all-passed';
}

export function getResultsByCategory(s: DiagnosticState, cat: CheckCategory): CheckResult[] {
  return Object.values(s.results).filter((r) => r.category === cat);
}
