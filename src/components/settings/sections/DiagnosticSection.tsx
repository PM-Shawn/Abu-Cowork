import { useEffect, useMemo } from 'react';
import { Bot, FolderLock, Plug, Sparkles, Globe, AppWindow } from 'lucide-react';
import { useI18n } from '@/i18n';
import { useDiagnosticStore } from '@/stores/diagnosticStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { ALL_CATEGORIES } from '@/core/diagnostic/runner';
import type { CheckCategory, CheckResult } from '@/core/diagnostic/types';
import DiagnosticBanner from './diagnostic/DiagnosticBanner';
import DiagnosticCategory from './diagnostic/DiagnosticCategory';
import SettingsSectionHeader from '@/components/settings/SettingsSectionHeader';

const CATEGORY_ICON = {
  'ai-services': Bot,
  'permissions': FolderLock,
  'mcp': Plug,
  'skills': Sparkles,
  'network': Globe,
  'app': AppWindow,
} as const;

export default function DiagnosticSection() {
  const { t } = useI18n();
  const results = useDiagnosticStore((s) => s.results);
  const lastCheckedAt = useDiagnosticStore((s) => s.lastCheckedAt);
  const isChecking = useDiagnosticStore((s) => s.isChecking);
  const runAll = useDiagnosticStore((s) => s.runAll);
  const setActiveSystemTab = useSettingsStore((s) => s.setActiveSystemTab);

  // Auto-run on first visit if no cached results.
  useEffect(() => {
    if (lastCheckedAt === null && !isChecking) {
      runAll();
    }
  // run-once on mount; deps intentionally empty
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const grouped = useMemo<Record<CheckCategory, CheckResult[]>>(() => {
    const out: Record<CheckCategory, CheckResult[]> = {
      'ai-services': [],
      'permissions': [],
      'mcp': [],
      'skills': [],
      'network': [],
      'app': [],
    };
    for (const r of Object.values(results)) {
      out[r.category].push(r);
    }
    return out;
  }, [results]);

  const categoryLabels: Record<CheckCategory, string> = {
    'ai-services': t.diagnostic.categoryAiServices,
    'permissions': t.diagnostic.categoryPermissions,
    'mcp': t.diagnostic.categoryMcp,
    'skills': t.diagnostic.categorySkills,
    'network': t.diagnostic.categoryNetwork,
    'app': t.diagnostic.categoryApp,
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <SettingsSectionHeader title={t.diagnostic.title} description={t.diagnostic.desc} />

      {/* Banner */}
      <DiagnosticBanner />

      {/* Category list */}
      <div className="space-y-3">
        {ALL_CATEGORIES.map((cat) => (
          <DiagnosticCategory
            key={cat}
            category={cat}
            label={categoryLabels[cat]}
            icon={CATEGORY_ICON[cat]}
            results={grouped[cat]}
          />
        ))}
      </div>

      {/* Feedback navigation prompt */}
      <div className="pt-2 border-t border-[var(--abu-border)]">
        <button
          type="button"
          onClick={() => setActiveSystemTab('feedback')}
          className="text-[12px] text-[var(--abu-text-muted)] hover:text-[var(--abu-clay)] transition-colors"
        >
          {t.diagnostic.feedbackPageHint}
        </button>
      </div>

    </div>
  );
}
