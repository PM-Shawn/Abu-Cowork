import { useState, useMemo } from 'react';
import { Button } from '@/components/ds/button';
import { Icon } from '@/components/ds/icon';
import { AppIcons, type AppIconName } from '@/components/ds/icons';
import { Pressable } from '@/components/ds/pressable';
import { cn } from '@/lib/utils';
import { useI18n, format as i18nFormat } from '@/i18n';
import { useDiagnosticStore } from '@/stores/diagnosticStore';
import type { CheckCategory, CheckResult } from '@/core/diagnostic/types';
import DiagnosticItem from './DiagnosticItem';

interface Props {
  category: CheckCategory;
  label: string;
  icon: AppIconName;
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

export default function DiagnosticCategory({ category, label, icon, results }: Props) {
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
    <section className="overflow-hidden rounded-panel border border-separator">
      <header className="flex items-center gap-3 px-4 py-3">
        <Pressable
          onClick={() => setCollapsed((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-control text-left"
          aria-expanded={!collapsed}
        >
          <Icon icon={collapsed ? AppIcons.disclose : AppIcons.expand} size="sm" className="text-label-tertiary" />
          <Icon icon={AppIcons[icon]} className="text-label-secondary" />
          <h3 className="text-ui font-medium text-label">{label}</h3>
          <span className={cn(
            'text-caption tabular-nums',
            summary.fail > 0 ? 'text-danger' :
            summary.warn > 0 ? 'text-warning' :
            'text-label-tertiary'
          )}>
            · {summaryText}
          </span>
        </Pressable>
        <Button
          variant="plain"
          size="sm"
          icon={AppIcons.retry}
          onClick={() => runCategory(category)}
          disabled={isChecking}
          title={t.diagnostic.categoryRecheck}
        />
      </header>
      {!collapsed && (
        <ul className="divide-y divide-separator border-t border-separator">
          {results.length === 0 ? (
            <li className="px-4 py-3 text-ui-sm text-label-tertiary">—</li>
          ) : (
            results.map((r) => <DiagnosticItem key={r.id} result={r} />)
          )}
        </ul>
      )}
    </section>
  );
}
