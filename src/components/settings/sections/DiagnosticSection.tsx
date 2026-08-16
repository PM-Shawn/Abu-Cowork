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
import { Toggle } from '@/components/ui/toggle';

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
  const refreshApp = useDiagnosticStore((s) => s.refreshApp);
  const setActiveSystemTab = useSettingsStore((s) => s.setActiveSystemTab);
  const telemetryOptOut = useSettingsStore((s) => s.telemetryOptOut);
  const setTelemetryOptOut = useSettingsStore((s) => s.setTelemetryOptOut);

  // First visit (no cached results): run the full suite. Otherwise the panel
  // renders the persisted snapshot instantly, but that snapshot can be stale —
  // notably the app version froze at whatever build ran the last full check, so
  // an in-place update kept showing the old version + "已是最新". The app check
  // is cheap and always-current, so refresh just that item on every open.
  useEffect(() => {
    if (lastCheckedAt === null && !isChecking) {
      runAll();
    } else {
      refreshApp();
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

      {/* Anonymous reporting opt-out. Sits at the bottom with the other
          send-data affordances: most people never touch it, so it should not
          outrank the diagnostic results this page exists to show. Personal
          installs previously had no way to turn reporting off at all — only a
          build-time constant and, for enterprise, a server-side flag. */}
      <div className="pt-2 border-t border-[var(--abu-border)] flex items-center justify-between gap-4">
        <div className="flex-1">
          <p className="text-minor text-[var(--abu-text-primary)]">{t.diagnostic.telemetryOptOut}</p>
          <p className="text-minor text-[var(--abu-text-muted)] mt-0.5">{t.diagnostic.telemetryOptOutDesc}</p>
        </div>
        <Toggle
          checked={!telemetryOptOut}
          onChange={() => setTelemetryOptOut(!telemetryOptOut)}
          size="sm"
        />
      </div>

      {/* Feedback navigation prompt */}
      <div className="pt-2 border-t border-[var(--abu-border)]">
        <button
          type="button"
          onClick={() => setActiveSystemTab('feedback')}
          className="text-minor text-[var(--abu-text-muted)] hover:text-[var(--abu-clay)] transition-colors"
        >
          {t.diagnostic.feedbackPageHint}
        </button>
      </div>

    </div>
  );
}
