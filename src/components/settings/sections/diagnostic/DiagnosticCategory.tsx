import { useState, useMemo } from 'react';
import { ChevronDown, ChevronRight, RefreshCw, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n, format as i18nFormat } from '@/i18n';
import { useDiagnosticStore } from '@/stores/diagnosticStore';
import type { CheckCategory, CheckResult } from '@/core/diagnostic/types';
import DiagnosticItem from './DiagnosticItem';

interface Props {
  category: CheckCategory;
  label: string;
  icon: LucideIcon;
  results: CheckResult[];
}

function summarize(results: CheckResult[]): { pass: number; warn: number; fail: number; skip: number } {
  let pass = 0, warn = 0, fail = 0, skip = 0;
  for (const r of results) {
    if (r.status === 'passed') pass++;
    else if (r.status === 'warning') warn++;
    else if (r.status === 'failed') fail++;
    else if (r.status === 'skipped') skip++;
  }
  return { pass, warn, fail, skip };
}

export default function DiagnosticCategory({ category, label, icon: Icon, results }: Props) {
  const { t } = useI18n();
  const runCategory = useDiagnosticStore((s) => s.runCategory);
  const isChecking = useDiagnosticStore((s) => s.isChecking);

  const summary = useMemo(() => summarize(results), [results]);
  const allPassed = results.length > 0 && summary.fail === 0 && summary.warn === 0;
  const allSkipped = results.length > 0 && summary.skip === results.length;
  // Auto-collapse when everything passed (or everything skipped); auto-expand
  // when there's a fail/warning so the user sees what to fix immediately.
  const [collapsed, setCollapsed] = useState<boolean>(allPassed || allSkipped);

  // If state changes from passed → fail (e.g. provider goes down), auto-open
  // the section. We treat user manual collapse as sticky only while same state.
  // Simpler approach: when the data changes drastically, reset.
  // For v1 we keep a basic pattern: explicit toggle wins.

  const summaryText =
    results.length === 0 ? '—' :
    allSkipped ? t.diagnostic.categorySummaryEmpty :
    allPassed ? i18nFormat(t.diagnostic.categorySummaryAllPassed, { n: summary.pass }) :
    i18nFormat(t.diagnostic.categorySummaryMixed, {
      pass: summary.pass,
      warn: summary.warn,
      fail: summary.fail,
    });

  return (
    <section className="border border-[var(--abu-border)] rounded-lg overflow-hidden bg-[var(--abu-bg-base)]">
      <header className="px-4 py-3 flex items-center gap-3 bg-[var(--abu-bg-muted)]">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="flex items-center gap-2 flex-1 text-left"
          aria-expanded={!collapsed}
        >
          {collapsed ? (
            <ChevronRight className="h-3.5 w-3.5 text-[var(--abu-text-muted)] shrink-0" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 text-[var(--abu-text-muted)] shrink-0" />
          )}
          <Icon className="h-4 w-4 text-[var(--abu-text-tertiary)] shrink-0" />
          <h3 className="text-[13px] font-medium text-[var(--abu-text-primary)]">{label}</h3>
          <span className={cn(
            'text-[11px] tabular-nums',
            summary.fail > 0 ? 'text-red-600' :
            summary.warn > 0 ? 'text-amber-600' :
            'text-[var(--abu-text-muted)]'
          )}>
            · {summaryText}
          </span>
        </button>
        <button
          type="button"
          onClick={() => runCategory(category)}
          disabled={isChecking}
          className="text-[11px] text-[var(--abu-text-muted)] hover:text-[var(--abu-clay)] transition-colors flex items-center gap-1 px-2 py-1 rounded-md hover:bg-[var(--abu-bg-hover)] disabled:opacity-50"
          title={t.diagnostic.categoryRecheck}
        >
          <RefreshCw className="h-3 w-3" />
        </button>
      </header>
      {!collapsed && (
        <ul className="divide-y divide-[var(--abu-border-subtle)]">
          {results.length === 0 ? (
            <li className="px-4 py-3 text-[12px] text-[var(--abu-text-muted)]">—</li>
          ) : (
            results.map((r) => <DiagnosticItem key={r.id} result={r} />)
          )}
        </ul>
      )}
    </section>
  );
}
