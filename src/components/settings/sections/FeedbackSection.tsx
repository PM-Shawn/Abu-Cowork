import { useState } from 'react';
import { useI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settingsStore';
import type { ProduceResult } from '@/core/diagnostic/bundle';
import { useFeedbackDraftStore } from '@/stores/feedbackDraftStore';
import DiagnosticUpload from './diagnostic/DiagnosticUpload';
import ExportSuccessCard from './diagnostic/ExportSuccessCard';
import SettingsSectionHeader from '@/components/settings/SettingsSectionHeader';

export default function FeedbackSection() {
  const { t } = useI18n();
  const openSystemSettings = useSettingsStore((s) => s.openSystemSettings);
  // Description lives in the session draft store so it survives leaving the
  // settings view and returning (e.g. to grab a screenshot).
  const description = useFeedbackDraftStore((s) => s.description);
  const setDescription = useFeedbackDraftStore((s) => s.setDescription);
  const [exportSuccess, setExportSuccess] = useState<ProduceResult | null>(null);

  return (
    <div className="space-y-6">
      <SettingsSectionHeader title={t.about.feedback} description={t.diagnostic.exportDesc} />

      {/* Upload form */}
      <DiagnosticUpload
        onExportSuccess={setExportSuccess}
        description={description}
        onDescriptionChange={setDescription}
      />
      {exportSuccess && (
        <ExportSuccessCard
          path={exportSuccess.path}
          sizeBytes={exportSuccess.sizeBytes}
          scrubbedTextCount={exportSuccess.scrubbedTextCount}
          fileList={exportSuccess.fileList}
          onDismiss={() => setExportSuccess(null)}
        />
      )}

      {/* The author moved to their own page; keep a way there from here, because
          someone on the feedback page is often someone with a problem. */}
      <p className="pt-2 border-t border-[var(--abu-border)] text-center text-minor text-[var(--abu-text-muted)]">
        {t.author.feedbackLink}
        <button
          type="button"
          onClick={() => openSystemSettings('author')}
          className="ml-1 text-[var(--abu-clay)] font-medium hover:underline"
        >
          {t.author.feedbackLinkAction} →
        </button>
      </p>
    </div>
  );
}
